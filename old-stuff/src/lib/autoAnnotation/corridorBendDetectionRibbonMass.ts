/**
 * Second, EVALUATION-ONLY corridor-bend substrate: the same "propose zero or
 * more bend points between a hole's confirmed tee and basket" contract as
 * `corridorBendDetection.ts`'s `detectCorridorBends`, but with the "what
 * counts as open fairway" step built on the whole-course ribbon-mass
 * segmentation (`ribbonMass.ts`) instead of a local per-hole color heuristic.
 *
 * This module exists ONLY to let `scripts/benchmark-corridor-bend-detection.ts`
 * compare the two substrates head-to-head on real course imagery. Nothing in
 * `src/routes` imports it, and it must stay that way: `ribbonMass.ts` and
 * `ribbonMassShadowRun.ts`'s own doc comments declare that pipeline must
 * never gate a production decision, and this module's only caller is a
 * benchmark script, not the live approve flow.
 *
 * Pathfinding and simplification are NOT reimplemented here — `traceShortestOpenPath`
 * and `simplifyPolylineRDP` are imported unchanged from `corridorBendDetection.ts`
 * and used exactly as the shipped detector uses them. The only thing that
 * differs is how the binary "open" mask each hole's path is traced through
 * gets built:
 *
 * - The shipped detector crops a small region around one hole's tee/basket
 *   and classifies each pixel as open/closed by Euclidean RGB distance to
 *   color swatches sampled next to the tee and basket themselves — cheap,
 *   local, self-calibrating per hole, no knowledge of the rest of the image.
 * - This module instead takes an already-computed `RibbonMassSegmentation` —
 *   a whole-course connected-component label map from `segmentRibbonMass()`
 *   (LANCZOS downscale → LAB lightness → box-mean subtraction → grey opening
 *   → threshold → 8-connected components, at `params.scale`-downscaled
 *   evidence-map resolution, default 1 evidence px per 3 source px) — and
 *   asks a much narrower question per hole: which components does *this
 *   hole's own* tee and basket touch? It plants the hole's tee as a `'badge'`
 *   seed and its basket as a `'basket'` seed (the same seed vocabulary
 *   `ribbonMassShadowRun.ts` plants from production badge/basket detections)
 *   and takes `recommendedKeptLabels` — texture-admitted components union
 *   whatever component(s) those two seeds land in/near — as the "open" set.
 *   A small window around tee/basket (the same margin geometry
 *   `cropSourceRasterAroundHole` uses) is sliced out of the label map and
 *   turned into a binary mask by testing label membership in that kept set,
 *   then handed to the same `traceShortestOpenPath` + `simplifyPolylineRDP`
 *   pipeline the shipped detector uses.
 *
 * Cost shape, deliberately not hidden by this module's API: `segmentRibbonMass`
 * (whole-course: LANCZOS downscale, box-mean, grey opening, connected
 * components over the ENTIRE image) is NOT called here — the caller computes
 * it once and passes the result in. Everything in this module (seed
 * placement, windowing, pathfinding, RDP) is per-hole and cheap, bounded by
 * the crop window, not the course. That split is what lets the benchmark
 * script honestly report both "segmentation recomputed per hole" and
 * "segmentation computed once per course, reused per hole" costs instead of
 * conflating them.
 *
 * Same output contract as the shipped detector: a plain `SourcePoint[]`,
 * ordered tee-to-basket. No confidence/provenance field is ever attached
 * (see `annotatedRound.ts`'s provenance rule) — this module is not wired
 * into `applyDetectedCorridorBends` or any live editing flow, so that rule
 * is mostly moot here, but the output type stays interchangeable with the
 * shipped detector's on purpose, so the benchmark can call both identically.
 */
import type { SourcePoint } from '../domain/annotatedRound';
import { simplifyPolylineRDP, traceShortestOpenPath } from './corridorBendDetection';
import { placeSeeds, recommendedKeptLabels } from './ribbonMass';
import type { RibbonMassSeed, RibbonMassSegmentation } from './ribbonMass';

/** The slice of `RibbonMassSegmentation` this module actually reads — lets tests build a segmentation by hand instead of running the full LANCZOS/box-mean/opening pipeline (mirrors how `corridorBendDetection.test.ts` uses synthetic rasters, not real images). */
export type RibbonMassSegmentationForBends = Pick<
	RibbonMassSegmentation,
	'labels' | 'widthEv' | 'heightEv' | 'scale' | 'textureKeptLabels'
>;

// ---------------------------------------------------------------------------
// Small geometry helpers — NOT the pathfinding/RDP-simplification logic
// (that is imported above, unchanged, from `corridorBendDetection.ts`). These
// are the same tiny turn-angle/detour-ratio conservatism pieces the shipped
// detector also carries. They are re-declared here, not imported, because
// they are private (unexported) in that module and this module must not
// modify it to add exports.
// ---------------------------------------------------------------------------

function polylineLength(points: readonly SourcePoint[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i += 1) {
		total += Math.hypot(points[i].xPx - points[i - 1].xPx, points[i].yPx - points[i - 1].yPx);
	}
	return total;
}

function turnAngleDeg(a: SourcePoint, b: SourcePoint, c: SourcePoint): number {
	const v1x = b.xPx - a.xPx;
	const v1y = b.yPx - a.yPx;
	const v2x = c.xPx - b.xPx;
	const v2y = c.yPx - b.yPx;
	const len1 = Math.hypot(v1x, v1y);
	const len2 = Math.hypot(v2x, v2y);
	if (len1 === 0 || len2 === 0) return 0;
	const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
	return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
}

/** Drops any interior (non-endpoint) point whose turn is gentler than `minTurnAngleDeg` — a second, independent conservatism pass on top of RDP's own epsilon. */
function filterByTurnAngle(simplified: readonly SourcePoint[], minTurnAngleDeg: number): SourcePoint[] {
	const interior = simplified.slice(1, -1);
	const kept: SourcePoint[] = [];
	for (let i = 0; i < interior.length; i += 1) {
		const prev = i === 0 ? simplified[0] : interior[i - 1];
		const current = interior[i];
		const next = i === interior.length - 1 ? simplified[simplified.length - 1] : interior[i + 1];
		if (turnAngleDeg(prev, current, next) >= minTurnAngleDeg) kept.push(current);
	}
	return kept;
}

// ---------------------------------------------------------------------------
// Seeding: which components does this hole's own tee/basket touch?
// ---------------------------------------------------------------------------

/**
 * Plants `teeSrcPx` as a `'badge'` seed and `basketSrcPx` as a `'basket'`
 * seed (the same seed vocabulary `ribbonMassShadowRun.ts` plants from
 * production badge/basket detections, `holeNumber` is arbitrary here since
 * only one hole is ever being asked about) and returns the recommended
 * kept-label set for this hole: texture-admitted components (whole-course,
 * anchor-independent) union whatever component(s) the tee/basket seeds land
 * in or near (`recommendedKeptLabels` — see `ribbonMass.ts`'s doc comment on
 * why that is a union, not an intersection).
 */
export function keptLabelsForHole(
	segmentation: RibbonMassSegmentationForBends,
	teeSrcPx: SourcePoint,
	basketSrcPx: SourcePoint,
	seedRadiusPx: number
): Set<number> {
	const seeds: RibbonMassSeed[] = [
		{ seedId: 'tee', kind: 'badge', holeNumber: 0, xPx: teeSrcPx.xPx, yPx: teeSrcPx.yPx },
		{ seedId: 'basket', kind: 'basket', holeNumber: 0, xPx: basketSrcPx.xPx, yPx: basketSrcPx.yPx }
	];
	const placements = placeSeeds(segmentation, seeds, seedRadiusPx);
	return recommendedKeptLabels(segmentation, placements);
}

// ---------------------------------------------------------------------------
// Windowing: slice a local open/closed mask out of the whole-course label map.
// ---------------------------------------------------------------------------

/** A small binary "open" window sliced out of a whole-course label map, plus enough to map its cells back to source-image pixels — the ribbon-mass analog of `CorridorBendRaster`. */
export interface RibbonMassOpenWindow {
	readonly widthPx: number;
	readonly heightPx: number;
	/** Top-left corner of this window, in source-image pixels. */
	readonly originXPx: number;
	readonly originYPx: number;
	/** Source pixels per window cell — the segmentation's own evidence-map downscale factor. */
	readonly scale: number;
	readonly open: Uint8Array;
}

export interface RibbonMassCropOptions {
	/** Padding around the tee/basket bounding box, as a fraction of their straight-line distance. */
	readonly marginFraction: number;
	readonly minMarginPx: number;
	readonly maxMarginPx: number;
}

/** Mirrors `cropSourceRasterAroundHole`'s DEFAULT_CROP_OPTIONS margin numbers exactly (that constant isn't exported, so it is re-declared here rather than modifying the shipped module) — same physical crop size in source px, so a comparison between the two detectors isn't also a comparison of two different window geometries. */
export const DEFAULT_RIBBON_MASS_CROP_OPTIONS: RibbonMassCropOptions = {
	marginFraction: 0.4,
	minMarginPx: 40,
	maxMarginPx: 260
};

/**
 * Slices a local open/closed window (evidence-map resolution) around
 * `teeSrcPx`/`basketSrcPx` out of `segmentation.labels`, marking a cell open
 * when its label is in `kept`. Returns null when the window would be
 * degenerate (fewer than 2 cells in either dimension) — mirrors
 * `cropSourceRasterAroundHole`'s own degenerate-crop guard.
 */
export function cropRibbonMassOpenWindow(
	segmentation: Pick<RibbonMassSegmentationForBends, 'labels' | 'widthEv' | 'heightEv' | 'scale'>,
	kept: ReadonlySet<number>,
	teeSrcPx: SourcePoint,
	basketSrcPx: SourcePoint,
	options: RibbonMassCropOptions = DEFAULT_RIBBON_MASS_CROP_OPTIONS
): RibbonMassOpenWindow | null {
	const { labels, widthEv, heightEv, scale } = segmentation;
	const distance = Math.hypot(basketSrcPx.xPx - teeSrcPx.xPx, basketSrcPx.yPx - teeSrcPx.yPx);
	const margin = Math.min(options.maxMarginPx, Math.max(options.minMarginPx, distance * options.marginFraction));
	const x0Src = Math.min(teeSrcPx.xPx, basketSrcPx.xPx) - margin;
	const y0Src = Math.min(teeSrcPx.yPx, basketSrcPx.yPx) - margin;
	const x1Src = Math.max(teeSrcPx.xPx, basketSrcPx.xPx) + margin;
	const y1Src = Math.max(teeSrcPx.yPx, basketSrcPx.yPx) + margin;

	const x0 = Math.max(0, Math.floor(x0Src / scale));
	const y0 = Math.max(0, Math.floor(y0Src / scale));
	const x1 = Math.min(widthEv, Math.ceil(x1Src / scale));
	const y1 = Math.min(heightEv, Math.ceil(y1Src / scale));
	const width = x1 - x0;
	const height = y1 - y0;
	if (width < 2 || height < 2) return null;

	const open = new Uint8Array(width * height);
	for (let y = 0; y < height; y += 1) {
		const rowBase = (y0 + y) * widthEv;
		for (let x = 0; x < width; x += 1) {
			const label = labels[rowBase + x0 + x];
			open[y * width + x] = label !== 0 && kept.has(label) ? 1 : 0;
		}
	}
	return { widthPx: width, heightPx: height, originXPx: x0 * scale, originYPx: y0 * scale, scale, open };
}

function toLocal(window: RibbonMassOpenWindow, point: SourcePoint): SourcePoint {
	return { xPx: (point.xPx - window.originXPx) / window.scale, yPx: (point.yPx - window.originYPx) / window.scale };
}

function inBounds(window: RibbonMassOpenWindow, point: SourcePoint): boolean {
	return point.xPx >= 0 && point.xPx < window.widthPx && point.yPx >= 0 && point.yPx < window.heightPx;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface DetectCorridorBendsRibbonMassParams {
	/** Source px radius `placeSeeds` may search for a nearby component when a seed doesn't land directly on one — passed straight through to `keptLabelsForHole`. */
	readonly seedRadiusPx: number;
	readonly marginFraction: number;
	readonly minMarginPx: number;
	readonly maxMarginPx: number;
	/** RDP epsilon, in SOURCE-image pixels — same validated ~10px the shipped detector uses. */
	readonly rdpEpsilonPx: number;
	readonly minTurnAngleDeg: number;
	readonly maxDetourRatio: number;
	readonly maxBends: number;
	/** Source px radius `traceShortestOpenPath` may search for an open cell near tee/basket. */
	readonly searchRadiusPx: number;
}

/** Numeric values mirror `DEFAULT_CORRIDOR_BEND_PARAMS` / ribbon-mass's own `seedRadiusPx` default wherever the two substrates share a concept, so a difference in the benchmark's numbers reflects the substrate, not a tuning mismatch. */
export const DEFAULT_RIBBON_MASS_CORRIDOR_BEND_PARAMS: DetectCorridorBendsRibbonMassParams = {
	seedRadiusPx: 40,
	marginFraction: 0.4,
	minMarginPx: 40,
	maxMarginPx: 260,
	rdpEpsilonPx: 10,
	minTurnAngleDeg: 12,
	maxDetourRatio: 1.6,
	maxBends: 3,
	searchRadiusPx: 20
};

/**
 * Proposes zero or more corridor bend points between `teeSrcPx` and
 * `basketSrcPx`, in source-image pixels, ordered tee-to-basket — the
 * ribbon-mass-substrate sibling of `detectCorridorBends`. `segmentation`
 * must already be computed (`segmentRibbonMass`, once per course); this
 * function never re-runs it.
 */
export function detectCorridorBendsRibbonMass(
	segmentation: RibbonMassSegmentationForBends,
	teeSrcPx: SourcePoint,
	basketSrcPx: SourcePoint,
	params: DetectCorridorBendsRibbonMassParams = DEFAULT_RIBBON_MASS_CORRIDOR_BEND_PARAMS
): SourcePoint[] {
	const kept = keptLabelsForHole(segmentation, teeSrcPx, basketSrcPx, params.seedRadiusPx);
	const window = cropRibbonMassOpenWindow(segmentation, kept, teeSrcPx, basketSrcPx, params);
	if (!window) return [];

	const teeLocal = toLocal(window, teeSrcPx);
	const basketLocal = toLocal(window, basketSrcPx);
	if (!inBounds(window, teeLocal) || !inBounds(window, basketLocal)) return [];

	const searchRadiusLocalPx = Math.max(1, Math.round(params.searchRadiusPx / window.scale));
	const path = traceShortestOpenPath(window.open, window.widthPx, window.heightPx, teeLocal, basketLocal, searchRadiusLocalPx);
	if (!path || path.length < 2) return [];

	const straightDistance = Math.hypot(basketLocal.xPx - teeLocal.xPx, basketLocal.yPx - teeLocal.yPx);
	if (straightDistance <= 0) return [];
	const detourRatio = polylineLength(path) / straightDistance;
	if (detourRatio > params.maxDetourRatio) return [];

	const simplified = simplifyPolylineRDP(path, params.rdpEpsilonPx / window.scale);
	if (simplified.length <= 2) return [];

	const bends = filterByTurnAngle(simplified, params.minTurnAngleDeg).slice(0, params.maxBends);
	if (bends.length === 0) return [];

	return bends.map((point) => ({
		xPx: point.xPx * window.scale + window.originXPx,
		yPx: point.yPx * window.scale + window.originYPx
	}));
}
