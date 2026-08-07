/**
 * ChainSpot Stitch Map translation matching, backed by OpenCV (P1-002, fifth
 * round).
 *
 * Replaces the hand-rolled mean-absolute-difference block matcher. Two defects
 * in that matcher, both confirmed against the real capture, motivated the
 * change:
 *
 * 1. **The search space excluded the correct answer.** Cross-axis drift was
 *    bounded to +/-6% of a tile dimension (+/-77px on a 1290px-wide capture),
 *    on the assumption that a user pans in near-straight lines. The real
 *    capture drifts -246px horizontally while panning down, which is ordinary
 *    hand-held behaviour. The true offset was never a candidate, so the matcher
 *    returned the best of a set of wrong placements. No scoring change can fix
 *    a search that cannot see the answer.
 * 2. **Mean absolute difference is a weak metric for aerial imagery.** Large
 *    low-contrast regions (grass, pavement, tree canopy) dominate the average
 *    and flatten the optimum.
 *
 * Both are addressed by `cv.matchTemplate` with `TM_CCOEFF_NORMED`
 * (zero-mean normalized cross-correlation). Verified against ground truth
 * established independently in `tests/helpers/realCapture.js`: all four
 * expected edges of the real capture are recovered within 2px per axis.
 *
 * A THIRD defect surfaced once the search space was fixed and is addressed
 * here too: a template sized so its reachable range only *barely* misses the
 * true answer is exactly the same class of bug as defect (1) above, just
 * smaller. See `MIN_PRIMARY_OVERLAP_FRACTION` / `MAX_CROSS_DRIFT_FRACTION`
 * below for the fix: the template's dimensions are *derived from* the range we
 * intend to guarantee, not chosen ad hoc and checked after the fact.
 *
 * Performance is handled with a coarse-to-fine search (see `matchTranslation`
 * doc comment): a cheap full-image pass at low resolution finds the
 * approximate offset with no range assumptions, then a fast full-resolution
 * pass refines it within a small window. Full-resolution full-image search
 * alone was measured at ~13s for a single edge, which is unworkable for a
 * pipeline that needs ~12 pairwise evaluations for tile assignment plus 4
 * final refinements.
 *
 * OpenCV is loaded lazily so its WASM payload never sits on the critical path;
 * callers are async and the module is only fetched when an arrangement is
 * actually being computed.
 *
 * P1-002 1b also moves the manual-correction "Snap" assist here
 * (`matchTranslationNear`/`snapAlign`), replacing a hand-rolled
 * mean-absolute-difference local search that lived in `analysis.ts`. That
 * search had a real quantization/directional tie-break bug at the 512px-capped
 * raster it ran on (scale ~4.16, so `Math.round(dxPx / scale)` mapped several
 * consecutive original-pixel offsets onto one raster offset, and the strict
 * `>` comparison always kept whichever tied candidate was hit first). Snap now
 * reuses this module's own proven `matchTemplate`-backed matcher instead of a
 * second, independently-scored search: `matchTranslationNear` skips the coarse
 * full-image pass (Snap already starts from a roughly-correct position) and
 * goes straight to `finePass`, seeded with the caller's own start offset
 * instead of a computed coarse estimate, searched at full resolution
 * (`scale ~= 1`) so the old rounding degeneracy cannot recur.
 */
import type { AnalysisRaster } from './analysis';
import type { PairOrientation } from './analysis';

// The OpenCV build is loaded dynamically; its surface is used through a narrow
// structural type so this module never depends on ambient globals.
type CvMat = {
	data: Uint8Array;
	delete(): void;
	roi(rect: unknown): CvMat;
};
type CvModule = {
	Mat: new (rows?: number, cols?: number, type?: number) => CvMat;
	Rect: new (x: number, y: number, width: number, height: number) => unknown;
	CV_8UC1: number;
	TM_CCOEFF_NORMED: number;
	matchTemplate(image: CvMat, templ: CvMat, result: CvMat, method: number): void;
	minMaxLoc(src: CvMat): {
		minVal: number;
		maxVal: number;
		minLoc: { x: number; y: number };
		maxLoc: { x: number; y: number };
	};
};

let cvPromise: Promise<CvModule> | null = null;

/**
 * Lazily loads the OpenCV WASM module, once per process/worker. Returns the
 * same promise on every call, so concurrent callers share one initialization
 * rather than racing to instantiate the runtime.
 */
export function loadCv(): Promise<CvModule> {
	if (!cvPromise) {
		// Indirected through `cvRuntime` so the awaited namespace is one this
		// codebase controls; see that module for why importing the OpenCV package
		// directly here would break.
		cvPromise = import('./cvRuntime').then(({ getCv }) => getCv() as Promise<CvModule>);
	}
	return cvPromise;
}

/**
 * Fire-and-forget warm-up for any one-time `matchTemplate` compile/lazy-init
 * cost on top of `loadCv()`'s module-load cost (P1-002 1c). The roadmap
 * entering this phase carried a measurement from 1b's verification session (a
 * temporary timing probe, not left in the tree) attributing roughly 10-12s to
 * a *separate* first-call JIT/lazy-compile tax, distinct from and in addition
 * to the WASM module load `loadCv()` already warms. This session re-measured
 * that claim directly (fresh Node processes; fresh, uncached Playwright
 * browser contexts; both tiny synthetic Mats and Mats sized to this module's
 * actual coarse-pass dimensions; including under this machine's own heavy
 * background load, ~30 on a 4-core box, consistent with contention this
 * ticket's history already documents elsewhere) and could not reproduce a
 * distinct post-module-load tax: every `matchTemplate` call observed, first
 * or subsequent, completed in single-digit milliseconds once `loadCv()` had
 * resolved. The most likely explanation is that the original measurement
 * captured module-load time itself (which does swing from ~1s browser-cached
 * to ~12s cold/uncached, and further with machine contention) rather than a
 * second phenomenon.
 *
 * The warm-up call is kept anyway, per the roadmap's explicit instruction and
 * because it is cheap and safe either way: if some browser/hardware
 * combination this session didn't test does carry a real first-call cost, an
 * idle no-op `matchTemplate` here pays it before the user ever clicks Snap;
 * if it doesn't, this call costs a few milliseconds during an already-async
 * warm-up nobody is waiting on. The Mats' contents are irrelevant — only
 * exercising the compiled `matchTemplate` code path matters — so they are
 * left at whatever `cv.Mat`'s own allocation gives them, and are freed
 * immediately after per this codebase's manual-WASM-memory convention (see
 * `coarsePass`/`finePass` below).
 */
export function warmMatchTemplate(cv: CvModule): void {
	const image = new cv.Mat(8, 8, cv.CV_8UC1);
	const template = new cv.Mat(4, 4, cv.CV_8UC1);
	const result = new cv.Mat();
	try {
		cv.matchTemplate(image, template, result, cv.TM_CCOEFF_NORMED);
	} finally {
		image.delete();
		template.delete();
		result.delete();
	}
}

/**
 * The least neighbour overlap we support along the *matching* (primary) axis,
 * as a fraction of the tile dimension. The template is anchored flush against
 * the edge that should fall inside the overlap (`tx`/`ty` = 0) and sized to
 * this fraction of the tile, so the reachable primary offset spans
 * `0 .. (1 - MIN_PRIMARY_OVERLAP_FRACTION) * tileDim`. At 0.12 that is 88% of
 * the tile: on the real capture's 2132px-tall tiles that is 0..1876px, which
 * comfortably covers the ground-truth 1693px vertical offset that a 0.22
 * fraction (giving only 0..1663px) silently excluded. This bug was the same
 * shape as the cross-axis bug the old matcher shipped with: a search range
 * that cannot represent the correct answer, just discovered later and by a
 * smaller margin. Do not shrink this without re-deriving the reachable range.
 */
const MIN_PRIMARY_OVERLAP_FRACTION = 0.12;

/**
 * How far the user may drift *perpendicular* to the intended pan direction,
 * as a fraction of the tile dimension, that this matcher guarantees it can
 * still find. The template is centred on the cross axis and sized to
 * `(1 - 2 * MAX_CROSS_DRIFT_FRACTION)` of the tile, so the reachable cross
 * offset is `+/-MAX_CROSS_DRIFT_FRACTION * tileDim` in either direction. At
 * 0.25 that is +/-25% of the tile; the real capture's diagonal pan needs
 * 246/1290 = 19%, so this has headroom rather than being fit to the one known
 * sample.
 */
const MAX_CROSS_DRIFT_FRACTION = 0.25;

/**
 * A candidate is only credited as a distinct alternative when its peak sits at
 * least this fraction of the result map away from the winner, so an adjacent
 * near-tie on the same correlation peak is not mistaken for a rival placement.
 */
const RUNNER_UP_MIN_SEPARATION_FRACTION = 0.05;

/**
 * Downsample factor for the coarse pass, on rasters large enough to afford it.
 * Chosen deliberately aggressive: the coarse pass exists only to localize the
 * answer to within a small window, not to resolve it to the pixel, and
 * OpenCV's FFT-backed `matchTemplate` cost grows steeply with image area.
 * Full-image search at this factor on the real capture's 1290x2132 tiles
 * (working on ~161x266px rasters) completes in well under a second once the
 * WASM runtime is warm, versus ~13s at full resolution. `FINE_SEARCH_MARGIN_PX`
 * below must comfortably exceed the localization error this introduces
 * (bounded by roughly one coarse pixel, i.e. this factor, of slack) for the
 * fine pass to be guaranteed to see the true answer inside its window. This is
 * a *cap*, not the factor actually used on every call — see
 * `MIN_COARSE_SHORT_EDGE_PX` for why small rasters use a smaller factor.
 */
const COARSE_DOWNSAMPLE_FACTOR = 8;

/**
 * The smallest extent, in downsampled-raster pixels, a template's primary or
 * cross dimension is ever allowed to shrink to. Below this, `matchTemplate`'s
 * correlation surface is too small to carry a meaningful peak (noise and
 * quantization dominate), so this floor exists independent of the
 * fraction-derived sizing in `templateGeometry`.
 */
const MIN_TEMPLATE_EXTENT_PX = 8;

/**
 * Downsampling by `COARSE_DOWNSAMPLE_FACTOR` unconditionally is only safe when
 * the resulting raster is large relative to `MIN_TEMPLATE_EXTENT_PX`. On a
 * small raster the floor stops being a rarely-hit safety net and starts being
 * the actual template size: e.g. this codebase's own 200x200 synthetic test
 * fixtures downsample by 8 to 25x25, where `MIN_PRIMARY_OVERLAP_FRACTION`'s
 * 12%-of-tile template would be ~3px but is floored to 8px -- more than
 * double the intended size. That shrinks the guaranteed-reachable primary
 * range from ~22 downsampled px (176 original px) to 17 (136 original px),
 * which sits *below* that fixture's actual 150px neighbor offset: the exact
 * "search space excludes the answer" defect this matcher was written to fix
 * (see the module doc comment), reintroduced by an over-aggressive coarse
 * downsample on a small image rather than by an under-sized search band.
 *
 * `coarseDownsampleFactor` below picks the largest factor up to
 * `COARSE_DOWNSAMPLE_FACTOR` that keeps the downsampled short edge at or above
 * this many pixels, so `MIN_TEMPLATE_EXTENT_PX`'s floor stays a rare safety
 * net rather than the dominant term. The real capture's tiles (short edge
 * 1290px) comfortably clear this at the full factor of 8 (161px downsampled),
 * so production accuracy and timing are unaffected; only small rasters back
 * off to a gentler downsample.
 */
const MIN_COARSE_SHORT_EDGE_PX = 100;

/**
 * The downsample factor to use for the coarse pass on this specific pair,
 * adaptive so small rasters (see `MIN_COARSE_SHORT_EDGE_PX`) don't downsample
 * so aggressively that the search range guarantee collapses. Both rasters are
 * considered (not just `a`) since `downsampleRaster` is applied to both and
 * the template is cut from whichever is smaller.
 */
function coarseDownsampleFactor(a: AnalysisRaster, b: AnalysisRaster): number {
	const shortEdgePx = Math.min(a.widthPx, a.heightPx, b.widthPx, b.heightPx);
	return Math.max(
		1,
		Math.min(COARSE_DOWNSAMPLE_FACTOR, Math.floor(shortEdgePx / MIN_COARSE_SHORT_EDGE_PX))
	);
}

/**
 * Half-width, in ORIGINAL image pixels, of the window the fine pass searches
 * around the coarse estimate. Must exceed the coarse pass's worst-case
 * localization error (bounded by `COARSE_DOWNSAMPLE_FACTOR` original pixels,
 * i.e. 8px here) by a wide margin, since the box-average downsample and the
 * correlation peak can each shift the coarse estimate by a few coarse pixels.
 * 32px gives 4x that bound. A larger margin costs fine-pass time roughly
 * quadratically (it grows the searched window on both axes), so this is kept
 * as tight as the safety margin allows rather than generously large.
 */
const FINE_SEARCH_MARGIN_PX = 32;

export type MatchMode = 'coarse' | 'refine';

export interface MatchTranslationOptions {
	/**
	 * 'coarse' (cheap): full-image search at `COARSE_DOWNSAMPLE_FACTOR`
	 * downsample only. Good enough for scoring which tiles go where during
	 * assignment, where ~12 pairwise evaluations must stay fast and
	 * pixel-exactness does not matter yet.
	 *
	 * 'refine' (default): coarse pass followed by a full-resolution pass
	 * windowed around the coarse result, for the handful of edges that are
	 * actually placed in the final layout and need exact pixels.
	 */
	readonly mode?: MatchMode;
}

export interface TranslationMatch {
	/** Offset of `b` relative to `a`, in original image pixels. */
	readonly dxPx: number;
	readonly dyPx: number;
	/** Correlation peak in [-1, 1]; 1 means structurally identical. */
	readonly score: number;
	/** Best clearly-displaced alternative peak, for ambiguity detection. */
	readonly runnerUpScore: number;
	/** Overlap along the matching axis, as a fraction of the tile dimension. */
	readonly overlapFraction: number;
}

function toMat(cv: CvModule, raster: AnalysisRaster): CvMat {
	const mat = new cv.Mat(raster.heightPx, raster.widthPx, cv.CV_8UC1);
	mat.data.set(raster.gray);
	return mat;
}

/**
 * Box-downsamples a raster by an integer factor (averaging, so it is a
 * genuine low-pass step rather than nearest-neighbour decimation, which would
 * alias fine map detail into noise right when the coarse pass most needs a
 * clean correlation peak). Composes with any downsampling the raster already
 * carries: the returned `scale` is the original-px-per-output-px factor, so
 * callers never need to reason about compounded scales themselves.
 */
function downsampleRaster(raster: AnalysisRaster, factor: number): AnalysisRaster {
	if (factor <= 1) return raster;
	const widthPx = Math.max(1, Math.floor(raster.widthPx / factor));
	const heightPx = Math.max(1, Math.floor(raster.heightPx / factor));
	const gray = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y += 1) {
		for (let x = 0; x < widthPx; x += 1) {
			let sum = 0;
			for (let dy = 0; dy < factor; dy += 1) {
				const row = (y * factor + dy) * raster.widthPx + x * factor;
				for (let dx = 0; dx < factor; dx += 1) sum += raster.gray[row + dx];
			}
			gray[y * widthPx + x] = Math.round(sum / (factor * factor));
		}
	}
	return { widthPx, heightPx, gray, scale: raster.scale * factor };
}

interface TemplateGeometry {
	readonly tw: number;
	readonly th: number;
	readonly tx: number;
	readonly ty: number;
}

/**
 * Derives the template rectangle cut from `b`'s expected-overlap edge, sized
 * so the reachable search range is exactly what `MIN_PRIMARY_OVERLAP_FRACTION`
 * and `MAX_CROSS_DRIFT_FRACTION` promise (see those constants for the
 * reasoning). This is computed fresh for whatever resolution `raster` is at,
 * so the same guarantee holds whether it's called on the full-resolution tile
 * or a downsampled one for the coarse pass.
 */
function templateGeometry(raster: AnalysisRaster, orientation: PairOrientation): TemplateGeometry {
	const horizontal = orientation === 'left-right';
	const primaryDim = horizontal ? raster.widthPx : raster.heightPx;
	const crossDim = horizontal ? raster.heightPx : raster.widthPx;

	// Anchored at 0 along the primary axis: reachable primary offset is then
	// 0 .. (primaryDim - primaryExtent) = 0 .. (1 - MIN_PRIMARY_OVERLAP_FRACTION) * primaryDim.
	const primaryExtent = Math.max(
		MIN_TEMPLATE_EXTENT_PX,
		Math.round(primaryDim * MIN_PRIMARY_OVERLAP_FRACTION)
	);
	// Centred along the cross axis: reachable cross offset is then
	// +/-(crossDim - crossExtent) / 2 = +/-MAX_CROSS_DRIFT_FRACTION * crossDim.
	const crossExtent = Math.max(
		MIN_TEMPLATE_EXTENT_PX,
		Math.round(crossDim * (1 - 2 * MAX_CROSS_DRIFT_FRACTION))
	);

	const tw = horizontal ? primaryExtent : crossExtent;
	const th = horizontal ? crossExtent : primaryExtent;
	const tx = horizontal ? 0 : Math.round((raster.widthPx - tw) / 2);
	const ty = horizontal ? Math.round((raster.heightPx - th) / 2) : 0;
	return { tw, th, tx, ty };
}

/**
 * Best clearly-displaced alternative peak on a correlation surface, read off
 * the same `matchTemplate` result used for the winner. This is what makes
 * repeated imagery visible: if a different placement scores nearly as well,
 * the winner is not trustworthy no matter how high it is.
 */
function runnerUpScoreOf(
	result: CvMat,
	mapWidth: number,
	mapHeight: number,
	bestLoc: { x: number; y: number }
): number {
	const scores = result as unknown as { data32F: Float32Array };
	if (!scores.data32F || scores.data32F.length < mapWidth * mapHeight) return -1;
	const separation = Math.max(
		1,
		Math.round(RUNNER_UP_MIN_SEPARATION_FRACTION * Math.max(mapWidth, mapHeight))
	);
	let runnerUp = -1;
	for (let y = 0; y < mapHeight; y += 1) {
		for (let x = 0; x < mapWidth; x += 1) {
			if (Math.abs(x - bestLoc.x) < separation && Math.abs(y - bestLoc.y) < separation) continue;
			const value = scores.data32F[y * mapWidth + x];
			if (value > runnerUp) runnerUp = value;
		}
	}
	return runnerUp;
}

function overlapFractionOf(
	orientation: PairOrientation,
	tileWidthPx: number,
	tileHeightPx: number,
	dxPx: number,
	dyPx: number
): number {
	const horizontal = orientation === 'left-right';
	const overlap = horizontal
		? (tileWidthPx - Math.abs(dxPx)) / tileWidthPx
		: (tileHeightPx - Math.abs(dyPx)) / tileHeightPx;
	return Math.max(0, Math.min(1, overlap));
}

const ZERO_MATCH: TranslationMatch = {
	dxPx: 0,
	dyPx: 0,
	score: 0,
	runnerUpScore: -1,
	overlapFraction: 0
};

/**
 * Coarse pass: full-image `matchTemplate` search at (up to)
 * `COARSE_DOWNSAMPLE_FACTOR` downsample, with no range assumptions beyond the
 * ones `MIN_PRIMARY_OVERLAP_FRACTION` / `MAX_CROSS_DRIFT_FRACTION` guarantee.
 * This is the step that makes the matcher robust: it can find the answer
 * anywhere in that range, cheaply, before anything narrows the search. The
 * actual factor is adaptive (see `coarseDownsampleFactor`) so small rasters
 * don't downsample themselves out of the guaranteed search range.
 */
async function coarsePass(
	cv: CvModule,
	a: AnalysisRaster,
	b: AnalysisRaster,
	orientation: PairOrientation,
	tileWidthPx: number,
	tileHeightPx: number
): Promise<TranslationMatch> {
	const factor = coarseDownsampleFactor(a, b);
	const aC = downsampleRaster(a, factor);
	const bC = downsampleRaster(b, factor);
	const aMat = toMat(cv, aC);
	const bMat = toMat(cv, bC);
	let template: CvMat | null = null;
	let result: CvMat | null = null;

	try {
		const geom = templateGeometry(bC, orientation);
		if (geom.tw > aC.widthPx || geom.th > aC.heightPx) {
			return ZERO_MATCH;
		}

		template = bMat.roi(new cv.Rect(geom.tx, geom.ty, geom.tw, geom.th));
		result = new cv.Mat();
		cv.matchTemplate(aMat, template, result, cv.TM_CCOEFF_NORMED);
		const best = cv.minMaxLoc(result);

		const mapWidth = aC.widthPx - geom.tw + 1;
		const mapHeight = aC.heightPx - geom.th + 1;
		const runnerUpScore = runnerUpScoreOf(result, mapWidth, mapHeight, best.maxLoc);

		const dxPx = Math.round((best.maxLoc.x - geom.tx) * aC.scale);
		const dyPx = Math.round((best.maxLoc.y - geom.ty) * aC.scale);
		const overlapFraction = overlapFractionOf(orientation, tileWidthPx, tileHeightPx, dxPx, dyPx);

		return { dxPx, dyPx, score: best.maxVal, runnerUpScore, overlapFraction };
	} finally {
		template?.delete();
		result?.delete();
		aMat.delete();
		bMat.delete();
	}
}

/**
 * Fine pass: full-resolution `matchTemplate`, but with the search image
 * cropped to a small window (`searchMarginPx` around the coarse estimate,
 * `FINE_SEARCH_MARGIN_PX` by default) instead of the whole tile. Small search
 * area is what keeps this fast despite running at full resolution — the whole
 * point is exact pixels without paying for a full-resolution full-image
 * search. `matchTranslationNear` below overrides `searchMarginPx` with Snap's
 * own (larger) search radius and feeds a synthetic "coarse" estimate built
 * from its caller's start offset, so this same windowed search doubles as
 * Snap's local search with no second implementation.
 *
 * Returns `null` when the template cannot fit `a` at all (degenerate raster
 * sizes); the caller falls back to the coarse result in that case.
 */
async function finePass(
	cv: CvModule,
	a: AnalysisRaster,
	b: AnalysisRaster,
	orientation: PairOrientation,
	coarse: TranslationMatch,
	searchMarginPx: number = FINE_SEARCH_MARGIN_PX
): Promise<{ dxPx: number; dyPx: number; score: number } | null> {
	const aMat = toMat(cv, a);
	const bMat = toMat(cv, b);
	let searchRoi: CvMat | null = null;
	let template: CvMat | null = null;
	let result: CvMat | null = null;

	try {
		const geom = templateGeometry(b, orientation);
		if (geom.tw > a.widthPx || geom.th > a.heightPx) {
			return null;
		}

		// Where the template is expected to land in `a`, in `a`'s own pixel
		// units, per the coarse estimate (already in original px; `a.scale`
		// converts back to `a`'s raster units in case `a` itself is not
		// full-resolution).
		const expectedX = geom.tx + coarse.dxPx / a.scale;
		const expectedY = geom.ty + coarse.dyPx / a.scale;
		const marginPx = Math.max(1, Math.round(searchMarginPx / a.scale));

		let windowW = Math.min(geom.tw + 2 * marginPx, a.widthPx);
		let windowH = Math.min(geom.th + 2 * marginPx, a.heightPx);
		let xStart = Math.round(expectedX - marginPx);
		let yStart = Math.round(expectedY - marginPx);
		// Clamp into bounds rather than fail: a coarse estimate near a tile edge
		// still deserves refinement with whatever window fits, even if it's not
		// centred on the expected location.
		xStart = Math.max(0, Math.min(xStart, a.widthPx - windowW));
		yStart = Math.max(0, Math.min(yStart, a.heightPx - windowH));

		searchRoi = aMat.roi(new cv.Rect(xStart, yStart, windowW, windowH));
		template = bMat.roi(new cv.Rect(geom.tx, geom.ty, geom.tw, geom.th));
		result = new cv.Mat();
		cv.matchTemplate(searchRoi, template, result, cv.TM_CCOEFF_NORMED);
		const best = cv.minMaxLoc(result);

		const bestX = xStart + best.maxLoc.x;
		const bestY = yStart + best.maxLoc.y;
		const dxPx = Math.round((bestX - geom.tx) * a.scale);
		const dyPx = Math.round((bestY - geom.ty) * a.scale);

		return { dxPx, dyPx, score: best.maxVal };
	} finally {
		searchRoi?.delete();
		template?.delete();
		result?.delete();
		aMat.delete();
		bMat.delete();
	}
}

/**
 * Estimates the translation of `b` relative to `a` under one orientation
 * hypothesis, by locating a template taken from `b`'s expected-overlap edge
 * within `a`. Returned offsets are in original image pixels (scaled up by
 * each raster's own `scale`), so callers never deal in analysis-raster units.
 *
 * Runs as coarse-to-fine (see `coarsePass` / `finePass`):
 *
 * 1. A full-image search at low resolution finds the approximate offset with
 *    no range assumptions beyond `MIN_PRIMARY_OVERLAP_FRACTION` /
 *    `MAX_CROSS_DRIFT_FRACTION` — this is what makes the matcher robust.
 * 2. Unless `options.mode === 'coarse'`, a full-resolution search *windowed*
 *    around that estimate resolves it to the exact pixel — this is what keeps
 *    it fast, since the window is a small fraction of the tile.
 *
 * `runnerUpScore` always comes from the coarse pass: the fine pass's window is
 * far too small to contain a meaningful rival placement, so a "runner-up"
 * found there would only ever be a false negative for ambiguity detection.
 */
export async function matchTranslation(
	a: AnalysisRaster,
	b: AnalysisRaster,
	orientation: PairOrientation,
	options: MatchTranslationOptions = {}
): Promise<TranslationMatch> {
	const cv = await loadCv();
	const mode = options.mode ?? 'refine';
	const tileWidthPx = a.widthPx * a.scale;
	const tileHeightPx = a.heightPx * a.scale;

	const coarse = await coarsePass(cv, a, b, orientation, tileWidthPx, tileHeightPx);
	if (mode === 'coarse') return coarse;

	const fine = await finePass(cv, a, b, orientation, coarse);
	if (!fine) return coarse;

	const overlapFraction = overlapFractionOf(
		orientation,
		tileWidthPx,
		tileHeightPx,
		fine.dxPx,
		fine.dyPx
	);

	return {
		dxPx: fine.dxPx,
		dyPx: fine.dyPx,
		score: fine.score,
		runnerUpScore: coarse.runnerUpScore,
		overlapFraction
	};
}

/**
 * Manual-correction "Snap" assist's bounded local search radius, in
 * original-image pixels, around the tile's current placement. Sized to
 * comfortably correct an ordinary "roughly dragged into place by eye"
 * residual without growing large enough to risk locking onto a different
 * repeated-pattern alignment. Formerly lived in `analysis.ts` alongside the
 * old hand-rolled search; moved here with the search itself (P1-002 1b).
 */
export const DEFAULT_SNAP_SEARCH_RADIUS_PX = 120;

/**
 * Snap's counterpart to `matchTranslation`: skips the coarse full-image pass
 * entirely and goes straight to `finePass`, seeded with the caller's own
 * `(startDxPx, startDyPx)` instead of a computed coarse estimate. This is
 * exactly right for Snap, which only ever starts from an already-roughly-
 * correct position (a manual drag/nudge, or the automatic reconciled
 * placement) and needs a local refinement, not a fresh global search.
 *
 * `radiusPx` overrides `finePass`'s default `FINE_SEARCH_MARGIN_PX` window,
 * since Snap's search radius (`DEFAULT_SNAP_SEARCH_RADIUS_PX`, much larger
 * than the coarse-to-fine handoff margin) is a different, larger tolerance:
 * it must absorb a real manual placement error, not just coarse-pass
 * downsample jitter.
 *
 * `runnerUpScore` is always -1 here (no meaningful notion of "runner up" for
 * a small local window); `score` is the raw correlation peak in [-1, 1], same
 * scale as `matchTranslation`.
 */
export async function matchTranslationNear(
	a: AnalysisRaster,
	b: AnalysisRaster,
	orientation: PairOrientation,
	startDxPx: number,
	startDyPx: number,
	radiusPx: number = DEFAULT_SNAP_SEARCH_RADIUS_PX
): Promise<TranslationMatch> {
	const cv = await loadCv();
	const tileWidthPx = a.widthPx * a.scale;
	const tileHeightPx = a.heightPx * a.scale;

	// A synthetic "coarse" estimate built directly from the caller's start
	// offset: `finePass` only ever reads `coarse.dxPx`/`coarse.dyPx` to center
	// its search window, so this is a genuine reuse of that pass, not a
	// parallel implementation.
	const syntheticCoarse: TranslationMatch = {
		dxPx: startDxPx,
		dyPx: startDyPx,
		score: 0,
		runnerUpScore: -1,
		overlapFraction: overlapFractionOf(orientation, tileWidthPx, tileHeightPx, startDxPx, startDyPx)
	};

	const fine = await finePass(cv, a, b, orientation, syntheticCoarse, radiusPx);
	if (!fine) {
		return { ...ZERO_MATCH, dxPx: startDxPx, dyPx: startDyPx };
	}

	return {
		dxPx: fine.dxPx,
		dyPx: fine.dyPx,
		score: fine.score,
		runnerUpScore: -1,
		overlapFraction: overlapFractionOf(orientation, tileWidthPx, tileHeightPx, fine.dxPx, fine.dyPx)
	};
}

export interface SnapNeighbor {
	readonly raster: AnalysisRaster;
	/** The neighbor's own current absolute placement, same coordinate space as `startXPx`/`startYPx`. */
	readonly xPx: number;
	readonly yPx: number;
}

export interface SnapResult {
	/** Absolute placement Snap resolved the tile to. */
	readonly xPx: number;
	readonly yPx: number;
	/** Mean match strength across neighbors, in [-1, 1] (see `TranslationMatch.score`). */
	readonly score: number;
}

/**
 * Manual-correction "Snap" assist (P1-002 1b): the direct replacement for
 * `analysis.ts`'s old `snapAlign`, now backed by this module's proven
 * `matchTemplate` matcher instead of a hand-rolled mean-absolute-difference
 * search. For each neighbor, locates the tile via `matchTranslationNear` and
 * converts that neighbor-relative offset into an absolute placement estimate
 * for the tile; a tile with more than one loaded neighbor (e.g. lower-right,
 * checked against both upper-right and lower-left) averages every neighbor's
 * estimate with equal weight — the same two-measurement-fusion convention
 * `autoLayout.ts`'s `reconcilePlacements` already uses for lower-right, not a
 * new weighting scheme.
 *
 * Orientation and which tile plays which role in the `matchTranslation`
 * a/b convention (`a` is whichever tile sits first along the primary axis,
 * left or top; the template is always cut from `b`'s near edge — see
 * `templateGeometry`) are both inferred from the tile's approximate starting
 * position relative to each neighbor, since neighbors are passed as plain
 * placements with no slot label attached: the axis with the larger separation
 * is the primary (overlap) axis, and whichever of the two sits further along
 * that axis is `b`.
 */
export async function snapAlign(
	tileRaster: AnalysisRaster,
	neighbors: readonly SnapNeighbor[],
	startXPx: number,
	startYPx: number,
	radiusPx: number = DEFAULT_SNAP_SEARCH_RADIUS_PX
): Promise<SnapResult> {
	if (neighbors.length === 0) {
		return { xPx: startXPx, yPx: startYPx, score: 0 };
	}

	let sumX = 0;
	let sumY = 0;
	let sumScore = 0;
	for (const neighbor of neighbors) {
		const dx = startXPx - neighbor.xPx;
		const dy = startYPx - neighbor.yPx;
		const orientation: PairOrientation = Math.abs(dx) >= Math.abs(dy) ? 'left-right' : 'top-bottom';
		// Whichever tile sits further along the primary axis is `b` in the
		// matchTranslation convention.
		const tileIsB = orientation === 'left-right' ? dx >= 0 : dy >= 0;
		const a = tileIsB ? neighbor.raster : tileRaster;
		const b = tileIsB ? tileRaster : neighbor.raster;
		const startDxPx = tileIsB ? dx : -dx;
		const startDyPx = tileIsB ? dy : -dy;

		const match = await matchTranslationNear(a, b, orientation, startDxPx, startDyPx, radiusPx);

		// Convert the neighbor-relative offset back into an absolute placement
		// estimate for the tile being snapped.
		sumX += tileIsB ? neighbor.xPx + match.dxPx : neighbor.xPx - match.dxPx;
		sumY += tileIsB ? neighbor.yPx + match.dyPx : neighbor.yPx - match.dyPx;
		sumScore += match.score;
	}

	const n = neighbors.length;
	return {
		xPx: Math.round(sumX / n),
		yPx: Math.round(sumY / n),
		score: sumScore / n
	};
}
