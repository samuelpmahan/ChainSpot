/**
 * ChainSpot Stitch Map pairwise overlap analysis (P1-001).
 *
 * Analyzes one ordered pair of screenshots for the plausible translation that
 * best aligns their overlapping content under ChainSpot's documented capture
 * protocol: same device, zoom, and orientation, with roughly 20–30% intended
 * horizontal and vertical overlap. The analysis runs on a temporary downscaled
 * grayscale representation; committed `dx`/`dy` values are rounded back to
 * original-image pixels so preview scale never affects geometry.
 *
 * The search is deliberately bounded: for a horizontal hypothesis the second
 * tile is placed to the right within a primary-axis band (the wider internal
 * search band around the intended overlap), with a small cross-axis window for
 * capture drift. The vertical hypothesis is the transpose. Both hypotheses are
 * scored with mean absolute difference over the overlap region, higher scores
 * are better, and ties resolve to the earliest candidate in scan order (a
 * documented stable rule for determinism).
 *
 * This is a direct bounded image comparison, not a general feature/descriptor
 * framework: no RANSAC, no neural models, no network.
 */
export interface AnalysisRaster {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly gray: Uint8Array;
	/**
	 * Original-image pixels per analysis pixel. A single factor because the
	 * downscale preserves aspect ratio; committed values multiply by this.
	 */
	readonly scale: number;
}

export type PairOrientation = 'left-right' | 'top-bottom';

export interface PairEstimate {
	readonly orientation: PairOrientation;
	/** Original-image pixel translation of the second tile relative to the first. */
	readonly dxPx: number;
	readonly dyPx: number;
	/** Match strength in [0, 1]: 1 - mean-absolute-difference / 255. */
	readonly score: number;
	/** Shared overlap width/height as a fraction of the tile dimension. */
	readonly overlapFractionPx: number;
	/**
	 * Best score among candidates clearly displaced from the winner along the
	 * primary axis (see RUNNER_UP_MIN_OFFSET_FRACTION). A runner-up close to the
	 * winner means repeated imagery offers an ambiguous alternative; feeds
	 * P1-002 confidence.
	 */
	readonly runnerUpScore: number;
}

export interface PairAnalysisOptions {
	/** Intended minimum overlap band, default 0.15 (internal search tolerance). */
	searchMinOverlapFraction?: number;
	/** Intended maximum overlap band, default 0.40 (internal search tolerance). */
	searchMaxOverlapFraction?: number;
	/** Cross-axis drift window as a fraction of the cross dimension, default 0.06. */
	crossAxisWindowFraction?: number;
}

export const DEFAULT_MAX_ANALYSIS_DIM = 240;
export const DEFAULT_SEARCH_MIN_OVERLAP = 0.15;
export const DEFAULT_SEARCH_MAX_OVERLAP = 0.4;
export const DEFAULT_CROSS_AXIS_WINDOW = 0.06;
/**
 * The runner-up used for confidence must be a genuinely different placement, not
 * a smooth-gradient neighbor of the winner. Candidates whose primary-axis offset
 * is closer than this fraction of the tile dimension never count as the
 * runner-up, so repeated imagery (a real ambiguous alternative) surfaces instead
 * of ordinary sub-pixel gradient similarity.
 */
export const RUNNER_UP_MIN_OFFSET_FRACTION = 0.04;

/**
 * Builds a downscaled grayscale raster from a decoded image. Canvas access is
 * browser-only; deterministic unit tests feed synthetic rasters directly.
 */
export function toAnalysisRaster(
	image: HTMLImageElement,
	maxDim: number = DEFAULT_MAX_ANALYSIS_DIM
): AnalysisRaster {
	const widthPx = image.naturalWidth;
	const heightPx = image.naturalHeight;
	const scaleFactor = Math.min(1, maxDim / Math.max(widthPx, heightPx));
	const scaledWidth = Math.max(1, Math.round(widthPx * scaleFactor));
	const scaledHeight = Math.max(1, Math.round(heightPx * scaleFactor));
	const canvas = document.createElement('canvas');
	canvas.width = scaledWidth;
	canvas.height = scaledHeight;
	const context = canvas.getContext('2d');
	if (!context) {
		throw new Error('toAnalysisRaster: canvas 2D context unavailable');
	}
	context.drawImage(image, 0, 0, scaledWidth, scaledHeight);
	const data = context.getImageData(0, 0, scaledWidth, scaledHeight).data;
	const gray = new Uint8Array(scaledWidth * scaledHeight);
	for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
		gray[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114 + 0.5) | 0;
	}
	return {
		widthPx: scaledWidth,
		heightPx: scaledHeight,
		gray,
		scale: widthPx / scaledWidth
	};
}

/** Mean-absolute-difference match of one candidate placement, higher is better. */
function overlapScore(
	a: AnalysisRaster,
	b: AnalysisRaster,
	orientation: PairOrientation,
	primary: number,
	cross: number,
	stride: number
): number {
	const px = orientation === 'left-right' ? primary : cross;
	const py = orientation === 'left-right' ? cross : primary;
	const w = a.widthPx;
	const h = a.heightPx;
	const x0 = Math.max(0, px);
	const x1 = Math.min(w, px + w);
	const y0 = Math.max(0, py);
	const y1 = Math.min(h, py + h);
	if (x1 <= x0 || y1 <= y0) return 0;
	let sum = 0;
	let count = 0;
	for (let y = y0; y < y1; y += stride) {
		const aRow = y * w;
		const bRow = (y - py) * w;
		for (let x = x0; x < x1; x += stride) {
			const diff = Math.abs(a.gray[aRow + x] - b.gray[bRow + (x - px)]);
			sum += diff;
			count += 1;
		}
	}
	if (count === 0) return 0;
	const mad = sum / count;
	return 1 - mad / 255;
}

/**
 * Searches one orientation hypothesis over the bounded band with a coarse pass
 * followed by a fine pass around the best candidate. Ties keep the earliest
 * candidate in scan order (stable, deterministic).
 */
function scoreHypothesis(
	a: AnalysisRaster,
	b: AnalysisRaster,
	orientation: PairOrientation,
	options?: PairAnalysisOptions
): PairEstimate {
	const w = a.widthPx;
	const h = a.heightPx;
	const primaryDim = orientation === 'left-right' ? w : h;
	const crossDim = orientation === 'left-right' ? h : w;
	const minOverlap = options?.searchMinOverlapFraction ?? DEFAULT_SEARCH_MIN_OVERLAP;
	const maxOverlap = options?.searchMaxOverlapFraction ?? DEFAULT_SEARCH_MAX_OVERLAP;
	const crossWindow = Math.max(
		1,
		Math.round((options?.crossAxisWindowFraction ?? DEFAULT_CROSS_AXIS_WINDOW) * crossDim)
	);
	const primaryMin = Math.max(1, Math.round(primaryDim * (1 - maxOverlap)));
	const primaryMax = Math.max(primaryMin, Math.round(primaryDim * (1 - minOverlap)));

	// Every scored candidate is collected so the winner and the best *distinct*
	// alternative (primary-axis offset at least RUNNER_UP_MIN_OFFSET_FRACTION
	// away) can be derived in one deterministic pass. Ties keep the earliest
	// candidate in scan order (stable, deterministic).
	const candidates: Array<{ primary: number; cross: number; score: number }> = [];

	const consider = (primary: number, cross: number, score: number): void => {
		candidates.push({ primary, cross, score });
	};

	// Coarse pass over the full band; the fine pass then refines around the best
	// so far.
	const coarseStep = 2;
	for (let primary = primaryMin; primary <= primaryMax; primary += coarseStep) {
		for (let cross = -crossWindow; cross <= crossWindow; cross += coarseStep) {
			consider(primary, cross, overlapScore(a, b, orientation, primary, cross, 2));
		}
	}
	let bestScore = -Infinity;
	let bestPrimary = primaryMin;
	let bestCross = 0;
	for (const candidate of candidates) {
		if (candidate.score > bestScore) {
			bestScore = candidate.score;
			bestPrimary = candidate.primary;
			bestCross = candidate.cross;
		}
	}
	const fineRadius = 3;
	const finePrimaryMin = Math.max(primaryMin, bestPrimary - fineRadius);
	const finePrimaryMax = Math.min(primaryMax, bestPrimary + fineRadius);
	const fineCrossMin = Math.max(-crossWindow, bestCross - fineRadius);
	const fineCrossMax = Math.min(crossWindow, bestCross + fineRadius);
	for (let primary = finePrimaryMin; primary <= finePrimaryMax; primary += 1) {
		for (let cross = fineCrossMin; cross <= fineCrossMax; cross += 1) {
			consider(primary, cross, overlapScore(a, b, orientation, primary, cross, 1));
		}
	}

	bestScore = -Infinity;
	bestPrimary = primaryMin;
	bestCross = 0;
	for (const candidate of candidates) {
		if (candidate.score > bestScore) {
			bestScore = candidate.score;
			bestPrimary = candidate.primary;
			bestCross = candidate.cross;
		}
	}

	// The runner-up is the best candidate clearly displaced from the winner along
	// the primary axis, so a repeated-pattern alternative is visible while an
	// adjacent smooth-gradient candidate is not.
	const minOffset = Math.max(1, Math.round(primaryDim * RUNNER_UP_MIN_OFFSET_FRACTION));
	let runnerUpScore = -Infinity;
	for (const candidate of candidates) {
		if (candidate.primary === bestPrimary && candidate.cross === bestCross) continue;
		if (Math.abs(candidate.primary - bestPrimary) < minOffset) continue;
		if (candidate.score > runnerUpScore) runnerUpScore = candidate.score;
	}

	const scale = a.scale;
	const dxPx =
		orientation === 'left-right' ? Math.round(bestPrimary * scale) : Math.round(bestCross * scale);
	const dyPx =
		orientation === 'left-right' ? Math.round(bestCross * scale) : Math.round(bestPrimary * scale);
	const overlapFractionPx =
		orientation === 'left-right'
			? (w * scale - dxPx) / (w * scale)
			: (h * scale - dyPx) / (h * scale);
	return {
		orientation,
		dxPx,
		dyPx,
		score: bestScore,
		overlapFractionPx,
		runnerUpScore
	};
}

/**
 * Estimates the translation of the second raster relative to the first. Both
 * orientation hypotheses are scored; the stronger one wins (ties prefer
 * `left-right`).
 */
export function estimatePair(
	a: AnalysisRaster,
	b: AnalysisRaster,
	options?: PairAnalysisOptions
): PairEstimate {
	const horizontal = scoreHypothesis(a, b, 'left-right', options);
	const vertical = scoreHypothesis(a, b, 'top-bottom', options);
	return horizontal.score >= vertical.score ? horizontal : vertical;
}
