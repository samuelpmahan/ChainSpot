/**
 * The create-graphics route's graphics/export mode, isolated behind a module
 * boundary (teardown §10 step 5): which color-style preset is selected, the
 * per-hole graphic plans derived from the current alignment + annotated
 * holes, and in-flight PNG/zip export state. The route's alignment/
 * correspondence, NAIP acquisition, and persistence concerns stay in
 * `+page.svelte` on purpose (teardown §11 — no wholesale route decomposition);
 * this module only knows the inputs it's handed via `GraphicsModeInputs`.
 *
 * This is also the seam a future Workstudio docks into (teardown §8): it
 * will be an editor over a new persisted `PresentationStyle` object (schema
 * v6 — PR #11's Course Memory work already spent v4 on
 * `HoleNumberBadgeAnchor`, and v5 went to the annotated round's walking
 * path), whose output feeds `buildHoleGraphicMarkup` unchanged and whose
 * live preview is the same markup rendered in the DOM instead of
 * rasterized. Nothing here builds that yet; it just names the boundary so
 * the next engineer knows why it exists.
 */
import {
	DEFAULT_HOLE_FRAMING,
	DEFAULT_HOLE_GRAPHIC_LAYERS,
	planHoleGraphic,
	renderHoleGraphicPng,
	zipHoleGraphics
} from '$lib/holeGraphics';
import type { HoleGraphicLayers, HoleGraphicPlan } from '$lib/holeGraphics';
import { DEFAULT_GRAPHIC_STYLE, findGraphicStyle } from '$lib/graphics/style';
import type { GraphicStyle } from '$lib/graphics/style';
import type { AnnotatedHole, SourcePoint } from '$lib/domain/annotatedRound';
import type { SerializableTransform } from '$lib/alignment/types';
import { buildElevationProfile, renderElevationProfile } from '$lib/elevationProfile';
import type { GeoRasterReference } from '$lib/elevationProfile';

export interface GraphicsModeTargetSize {
	readonly widthPx: number;
	readonly heightPx: number;
}

/**
 * Everything the graphics mode reads from the rest of the route. Deliberately
 * narrow and read-only — the route's alignment/annotation/NAIP state stays
 * owned by the route; this module never reaches back into it directly.
 */
export interface GraphicsModeInputs {
	holes(): readonly AnnotatedHole[];
	/** The current alignment transform, or null before alignment resolves. */
	transform(): SerializableTransform | null;
	/** The clean target image's own pixel dimensions, or null before it's loaded. */
	targetSize(): GraphicsModeTargetSize | null;
	/** The target image's blob URL, reused directly as the SVG `<image href>`, or null. */
	targetImageHref(): string | null;
	/** Feet-per-pixel for the current target image, only when it has a known ground scale. */
	feetPerPixel(): number | undefined;
	/** UDisc's walking route (round-level, not per-hole); undefined when not annotated. */
	walkingPath(): readonly SourcePoint[] | undefined;
	/**
	 * WGS84 georeference for the committed target image, or null whenever it's
	 * unknown (an uploaded image, or a committed path that doesn't retain its
	 * fetch geometry). Gates the elevation-profile action the same way
	 * `feetPerPixel` gates real-world distances: never estimated, never guessed.
	 */
	geoReference(): GeoRasterReference | null;
}

/** Climb/descent summary for one hole's built elevation profile, in the profile's own units (feet by default). */
export interface ElevationProfileSummary {
	readonly totalClimb: number;
	readonly totalDescent: number;
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
	const objectUrl = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = objectUrl;
	anchor.download = fileName;
	anchor.click();
	URL.revokeObjectURL(objectUrl);
}

/** Graphics/export-mode state for one create-graphics page instance. */
export class GraphicsMode {
	#inputs: GraphicsModeInputs;

	styleId = $state(DEFAULT_GRAPHIC_STYLE.id);
	/** Optional overlay toggles (see `HoleGraphicLayers`) — bound directly from the workspace's visibility checkboxes, same pattern as `styleId`. */
	layers = $state<HoleGraphicLayers>({ ...DEFAULT_HOLE_GRAPHIC_LAYERS });
	/**
	 * The workspace's active hole, by `AnnotatedHole.id` — set explicitly via
	 * `selectHole`, never inferred. A hole with no placed points yet is a
	 * valid selection (its plan is simply absent); this never substitutes a
	 * different hole's graphic just because the selected one has nothing to
	 * show, since that would silently show the wrong hole.
	 */
	selectedHoleId = $state<string | null>(null);
	downloading = $state<Set<string>>(new Set());
	zipping = $state(false);
	error = $state<string | null>(null);

	/** Hole IDs with an elevation-profile build/render/download in flight. */
	elevationBuilding = $state<Set<string>>(new Set());
	/**
	 * Per-hole failure messages from elevation-profile builds; EPQS is a flaky
	 * public service, so failures are expected. Keyed by hole id like
	 * `elevationBuilding`/`elevationStats` so a failure on one hole can never be
	 * misattributed to another hole's concurrent build.
	 */
	elevationErrors = $state<Map<string, string>>(new Map());
	/** Climb/descent summary per hole, kept after a successful build so it stays visible next to the button. */
	elevationStats = $state<Map<string, ElevationProfileSummary>>(new Map());

	/** Every hole with at least one placed point, with a padded crop framed against the current alignment. */
	plans: HoleGraphicPlan[] = $derived.by(() => {
		const transform = this.#inputs.transform();
		const target = this.#inputs.targetSize();
		if (!transform || !target) return [];
		const walkingPath = this.#inputs.walkingPath() ?? [];
		const result: HoleGraphicPlan[] = [];
		for (const hole of this.#inputs.holes()) {
			const plan = planHoleGraphic(
				hole,
				transform,
				target.widthPx,
				target.heightPx,
				DEFAULT_HOLE_FRAMING,
				walkingPath
			);
			if (plan) result.push(plan);
		}
		return result;
	});

	style: GraphicStyle = $derived(findGraphicStyle(this.styleId));

	/**
	 * The selected hole's plan, or null when nothing is selected yet or the
	 * selected hole has no placed points. Deliberately does not fall back to
	 * a different hole — see `selectedHoleId`'s docstring.
	 */
	selectedPlan: HoleGraphicPlan | null = $derived.by(() => {
		if (!this.selectedHoleId) return null;
		return this.plans.find((plan) => plan.holeId === this.selectedHoleId) ?? null;
	});

	/** How many of `plans` are out-of-bounds and therefore excluded from `downloadAll` — surfaced so a skip is never silent. */
	outOfBoundsCount: number = $derived.by(() => this.plans.filter((plan) => plan.outOfBounds).length);

	constructor(inputs: GraphicsModeInputs) {
		this.#inputs = inputs;
	}

	selectHole(holeId: string): void {
		this.selectedHoleId = holeId;
	}

	async downloadOne(plan: HoleGraphicPlan): Promise<void> {
		const href = this.#inputs.targetImageHref();
		if (!href || plan.outOfBounds || this.downloading.has(plan.holeId)) return;
		this.downloading = new Set(this.downloading).add(plan.holeId);
		this.error = null;
		try {
			const blob = await renderHoleGraphicPng(
				href,
				plan,
				undefined,
				this.style,
				this.#inputs.feetPerPixel(),
				this.layers
			);
			triggerBlobDownload(blob, `hole-${plan.number}.png`);
		} catch (err) {
			this.error = err instanceof Error ? err.message : 'Could not render the hole graphic.';
		} finally {
			const next = new Set(this.downloading);
			next.delete(plan.holeId);
			this.downloading = next;
		}
	}

	/** Whether `plan` can offer an elevation profile: a real routing path and a known target georeference. */
	elevationEligible(plan: HoleGraphicPlan): boolean {
		return plan.centerline.length >= 2 && this.#inputs.geoReference() !== null;
	}

	/**
	 * Builds one hole's elevation profile (EPQS lookups over its centerline),
	 * renders the broadcast PNG, and downloads it — mirrors `downloadOne`'s busy/
	 * error handling, kept separate because a failed EPQS lookup is expected
	 * (public service, no key, occasionally flaky) rather than exceptional.
	 */
	async buildAndDownloadElevation(plan: HoleGraphicPlan): Promise<void> {
		const reference = this.#inputs.geoReference();
		if (!reference || !this.elevationEligible(plan) || this.elevationBuilding.has(plan.holeId)) return;
		this.elevationBuilding = new Set(this.elevationBuilding).add(plan.holeId);
		const cleared = new Map(this.elevationErrors);
		cleared.delete(plan.holeId);
		this.elevationErrors = cleared;
		try {
			const profile = await buildElevationProfile(plan.centerline, reference);
			const blob = await renderElevationProfile(profile, { title: `Hole ${plan.number} — Elevation` });
			triggerBlobDownload(blob, `hole-${plan.number}-elevation.png`);
			const next = new Map(this.elevationStats);
			next.set(plan.holeId, { totalClimb: profile.totalClimb, totalDescent: profile.totalDescent });
			this.elevationStats = next;
		} catch {
			// EPQS network hiccups and no-coverage points are normal, not a bug to surface in detail.
			const failed = new Map(this.elevationErrors);
			failed.set(
				plan.holeId,
				'Elevation lookup failed. The USGS elevation service can be flaky — try again.'
			);
			this.elevationErrors = failed;
		} finally {
			const next = new Set(this.elevationBuilding);
			next.delete(plan.holeId);
			this.elevationBuilding = next;
		}
	}

	/**
	 * Zips every in-bounds plan. Out-of-bounds holes are excluded rather than
	 * zipped with a truncated crop — `outOfBoundsCount` is how the workspace
	 * surfaces that exclusion instead of it being a silent skip.
	 */
	async downloadAll(): Promise<void> {
		const exportablePlans = this.plans.filter((plan) => !plan.outOfBounds);
		const href = this.#inputs.targetImageHref();
		if (exportablePlans.length === 0 || !href || this.zipping) return;
		this.zipping = true;
		this.error = null;
		try {
			const style = this.style;
			const feetPerPixel = this.#inputs.feetPerPixel();
			const layers = this.layers;
			const entries: { number: number; blob: Blob }[] = [];
			for (const plan of exportablePlans) {
				const blob = await renderHoleGraphicPng(href, plan, undefined, style, feetPerPixel, layers);
				entries.push({ number: plan.number, blob });
			}
			const zip = await zipHoleGraphics(entries);
			triggerBlobDownload(zip, 'hole-graphics.zip');
		} catch (err) {
			this.error = err instanceof Error ? err.message : 'Could not build the hole graphics zip.';
		} finally {
			this.zipping = false;
		}
	}
}
