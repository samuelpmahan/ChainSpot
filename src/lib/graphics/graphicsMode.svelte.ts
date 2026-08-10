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
 * v5 — PR #11's Course Memory work already spent v4 on
 * `HoleNumberBadgeAnchor`), whose output feeds `buildHoleGraphicMarkup`
 * unchanged and whose live preview is the same markup rendered in the DOM
 * instead of rasterized. Nothing here builds that yet; it just names the
 * boundary so the next engineer knows why it exists.
 */
import { planHoleGraphic, renderHoleGraphicPng, zipHoleGraphics } from '$lib/holeGraphics';
import type { HoleGraphicPlan } from '$lib/holeGraphics';
import { DEFAULT_GRAPHIC_STYLE, findGraphicStyle } from '$lib/graphics/style';
import type { GraphicStyle } from '$lib/graphics/style';
import type { AnnotatedHole } from '$lib/domain/annotatedRound';
import type { SerializableTransform } from '$lib/alignment/types';

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
	downloading = $state<Set<string>>(new Set());
	zipping = $state(false);
	error = $state<string | null>(null);

	/** Every hole with at least one placed point, with a padded crop framed against the current alignment. */
	plans: HoleGraphicPlan[] = $derived.by(() => {
		const transform = this.#inputs.transform();
		const target = this.#inputs.targetSize();
		if (!transform || !target) return [];
		const result: HoleGraphicPlan[] = [];
		for (const hole of this.#inputs.holes()) {
			const plan = planHoleGraphic(hole, transform, target.widthPx, target.heightPx);
			if (plan) result.push(plan);
		}
		return result;
	});

	style: GraphicStyle = $derived(findGraphicStyle(this.styleId));

	constructor(inputs: GraphicsModeInputs) {
		this.#inputs = inputs;
	}

	async downloadOne(plan: HoleGraphicPlan): Promise<void> {
		const href = this.#inputs.targetImageHref();
		if (!href || this.downloading.has(plan.holeId)) return;
		this.downloading = new Set(this.downloading).add(plan.holeId);
		this.error = null;
		try {
			const blob = await renderHoleGraphicPng(href, plan, undefined, this.style, this.#inputs.feetPerPixel());
			triggerBlobDownload(blob, `hole-${plan.number}.png`);
		} catch (err) {
			this.error = err instanceof Error ? err.message : 'Could not render the hole graphic.';
		} finally {
			const next = new Set(this.downloading);
			next.delete(plan.holeId);
			this.downloading = next;
		}
	}

	async downloadAll(): Promise<void> {
		const plans = this.plans;
		const href = this.#inputs.targetImageHref();
		if (plans.length === 0 || !href || this.zipping) return;
		this.zipping = true;
		this.error = null;
		try {
			const style = this.style;
			const feetPerPixel = this.#inputs.feetPerPixel();
			const entries: { number: number; blob: Blob }[] = [];
			for (const plan of plans) {
				const blob = await renderHoleGraphicPng(href, plan, undefined, style, feetPerPixel);
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
