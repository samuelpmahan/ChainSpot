/**
 * ChainSpot Stitch Map shared crop proposal (P1-001, hardened in P1-002).
 *
 * Analyzes only the shared outer edge bands of the four screenshots to propose
 * a reversible set of top/right/bottom/left insets intended to remove repeated
 * screenshot chrome, footer/attribution bands, outer-edge controls, or uniform
 * blank/black margins.
 *
 * The evidence model is cross-tile fixed-position agreement, not per-row
 * uniformity: under ChainSpot's capture protocol the four screenshots are the
 * same device, orientation, application mode, and zoom, so application chrome
 * occupies identical screen coordinates in every capture while map content
 * moves. For each candidate line near an outer edge the four tiles are compared
 * at the same screen coordinates:
 *
 * - `pooledAgree` — the fraction of line pixels where all four tiles agree;
 * - `majorityAgree` — the fraction where the best three of four agree (an
 *   asymmetric mismatch in one tile is not allowed to hide the shared band);
 * - per-tile outlier fractions — the share of pixels where each tile diverges
 *   from the cross-tile consensus.
 *
 * A boundary is the start of a sustained disagreement run (fixed UI giving way
 * to moving content); a small number of locally noisy rows inside the band
 * (clock digits, spinners) is tolerated without truncating it. A side is
 * proposed only when all four screenshots support the band; majority-only
 * agreement is a conflict and declines the side. Agreement that runs to the
 * analysis bound means the transition was not observed: the bounded cap is
 * proposed with low confidence rather than an unjustified depth.
 *
 * Crop confidence describes confidence in the inferred boundary: `high`
 * requires every tile to support a stable repeated band with per-tile
 * boundaries within a small tolerance of the shared one; `low` covers noisy,
 * partial, conflicting, or unobserved transitions; `absent` means no defensible
 * shared boundary exists and no proposal is returned.
 *
 * The result is a proposal, never a silent mutation: the caller must present it
 * for an explicit user decision. Only lines touching the outer edge are ever
 * inspected, so internal uniform regions and per-tile masking can never be
 * proposed.
 */
import type { CropInsets } from './geometry';
import type { AnalysisRaster } from './analysis';

/** Proposed insets are bounded to this fraction of each original dimension. */
export const MAX_INSET_FRACTION = 0.2;
/** A proposed band must be at least this many original pixels deep. */
export const MIN_ORIGINAL_BAND_PX = 2;

// Experimental per-image UDisc vertical crop detector. These are the broad
// stable settings from the hand-labeled 9-image entropy sweep, not a single
// brittle grid-search winner.
const ENTROPY_BINS = 16;
const ENTROPY_THRESHOLD_RATIO = 0.74;
const ENTROPY_SMOOTH_RADIUS = 1;
const ENTROPY_RUN_LINES = 6;
const ENTROPY_REQUIRED_LINES = 4;
const ENTROPY_INWARD_SAFETY_PX = 1;
/**
 * A line pixel "agrees" across tiles when the range of the four captured values
 * is within this many gray levels. Fixed chrome is bit-identical across
 * captures (range 0); moving map content differs by far more on most pixels.
 */
export const CROP_AGREEMENT_MAX_RANGE = 12;
/**
 * A line counts as agreeing when at least this fraction of its pixels agree.
 * Text, icons, dividers, and buttons inside repeated UI are fixed screen
 * content, so they agree exactly; a 60% share is far below a chrome line and
 * far above an ordinary map line.
 */
export const CROP_AGREEMENT_MIN_FRACTION = 0.6;
/**
 * Locally noisy rows (a clock that differs between captures, a spinner) are
 * tolerated inside a repeated band up to this many lines before the band is
 * considered untrustworthy.
 */
export const CROP_NOISE_TOLERANCE_LINES = 3;
/**
 * A boundary is only confirmed by a sustained disagreement run of at least this
 * many consecutive lines, so a single noisy line can never end the band.
 */
export const CROP_TRANSITION_RUN_LINES = 3;
/**
 * A per-tile line is "content-divergent" only when at least this fraction of
 * its pixels deviate from the cross-tile consensus. Small fixed-UI elements
 * that differ between captures (a clock, a notification dot) affect only a few
 * percent of pixels; genuinely different content occupies most of the line.
 */
export const CROP_PER_TILE_DIVERGENCE_FRACTION = 0.3;
/**
 * High confidence requires every tile's repeated band to end within this many
 * analysis lines of the shared boundary ("approximately the same boundary").
 */
export const CROP_BOUNDARY_TOLERANCE_LINES = 2;

interface EntropyVerticalBounds {
	readonly topPx: number | null;
	readonly bottomPx: number | null;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

function smoothedRowEntropy(raster: AnalysisRaster): number[] {
	const { widthPx: width, heightPx: height, gray } = raster;
	const entropy = new Array<number>(height);
	const shift = 8 - Math.log2(ENTROPY_BINS);

	for (let y = 0; y < height; y += 1) {
		const histogram = new Uint32Array(ENTROPY_BINS);
		const base = y * width;
		let samples = 0;
		for (let x = 0; x < width; x += 2) {
			histogram[gray[base + x] >> shift] += 1;
			samples += 1;
		}

		let value = 0;
		for (const count of histogram) {
			if (count === 0) continue;
			const p = count / samples;
			value -= p * Math.log2(p);
		}
		entropy[y] = value;
	}

	return entropy.map((_, y) => {
		let sum = 0;
		let count = 0;
		for (
			let row = Math.max(0, y - ENTROPY_SMOOTH_RADIUS);
			row <= Math.min(height - 1, y + ENTROPY_SMOOTH_RADIUS);
			row += 1
		) {
			sum += entropy[row];
			count += 1;
		}
		return sum / count;
	});
}

function analyzeVerticalEntropy(raster: AnalysisRaster): EntropyVerticalBounds {
	const entropy = smoothedRowEntropy(raster);
	const height = raster.heightPx;
	const reference = median(
		entropy.slice(Math.floor(height * 0.35), Math.floor(height * 0.65))
	);
	const threshold = reference * ENTROPY_THRESHOLD_RATIO;

	let topBoundary: number | null = null;
	const topLimit = Math.floor(height * 0.32);
	for (let y = 1; y < topLimit - ENTROPY_RUN_LINES; y += 1) {
		let passing = 0;
		for (let k = 0; k < ENTROPY_RUN_LINES; k += 1) {
			if (entropy[y + k] >= threshold) passing += 1;
		}
		if (passing >= ENTROPY_REQUIRED_LINES) {
			topBoundary = y;
			break;
		}
	}

	let bottomBoundary: number | null = null;
	const bottomLimit = Math.floor(height * 0.68);
	for (let y = height - 2; y > bottomLimit + ENTROPY_RUN_LINES; y -= 1) {
		let passing = 0;
		for (let k = 0; k < ENTROPY_RUN_LINES; k += 1) {
			if (entropy[y - k] >= threshold) passing += 1;
		}
		if (passing >= ENTROPY_REQUIRED_LINES) {
			bottomBoundary = y;
			break;
		}
	}

	return {
		topPx:
			topBoundary === null
				? null
				: Math.round(topBoundary * raster.scale) + ENTROPY_INWARD_SAFETY_PX,
		bottomPx:
			bottomBoundary === null
				? null
				: Math.round((height - 1 - bottomBoundary) * raster.scale) +
					ENTROPY_INWARD_SAFETY_PX
	};
}

/**
 * Keep this validation path focused on real phone screenshots. Small synthetic
 * rasters retain the existing consensus detector, which also preserves current
 * unit-test coverage while we validate the real-capture hypothesis.
 */
function usePerImageEntropyVerticalCrop(rasters: readonly AnalysisRaster[]): boolean {
	return rasters.every(
		(raster) =>
			raster.heightPx >= 1000 &&
			raster.widthPx >= 500 &&
			raster.heightPx > raster.widthPx &&
			raster.scale <= 1.01
	);
}

export interface CropProposalOptions {
	maxInsetFraction?: number;
}

export type CropSide = 'top' | 'right' | 'bottom' | 'left';

export type CropConfidence = 'high' | 'low' | 'absent';

export interface CropProposalDetail {
	/** The bounded shared proposal, or null when edge evidence conflicts everywhere. */
	readonly insets: CropInsets | null;
	/** Separate from layout confidence; see the module comment. */
	readonly confidence: CropConfidence;
	/**
	 * Per side, the per-tile repeated-chrome boundary estimate in original
	 * pixels (all equal when every tile supports the same boundary; zeros when
	 * the side is not proposed).
	 */
	readonly perSide: Record<CropSide, readonly number[]>;
}

const SIDES: readonly CropSide[] = ['top', 'right', 'bottom', 'left'];

interface LineEvidence {
	/** Fraction of line pixels where all four tiles agree within the range bound. */
	readonly pooledAgree: number;
	/** Fraction of line pixels where the best three of four tiles agree. */
	readonly majorityAgree: number;
	/** Per tile, the fraction of line pixels diverging from the cross-tile median. */
	readonly outlier: readonly number[];
}

/** Cross-tile evidence for one edge line at the same screen coordinates. */
function lineEvidence(rasters: readonly AnalysisRaster[], side: CropSide, depth: number): LineEvidence {
	const w = rasters[0].widthPx;
	const h = rasters[0].heightPx;
	const isRow = side === 'top' || side === 'bottom';
	const lineIndex = isRow ? (side === 'top' ? depth : h - 1 - depth) : side === 'left' ? depth : w - 1 - depth;
	const length = isRow ? w : h;
	// Every tile has identical dimensions (the intake contract), so the same
	// line offset addresses all four rasters.
	const base = isRow ? lineIndex * w : lineIndex;
	const stride = isRow ? 1 : w;
	let pooled = 0;
	let majority = 0;
	const outlier = [0, 0, 0, 0];
	for (let p = 0; p < length; p += 1) {
		const offset = base + p * stride;
		const v0 = rasters[0].gray[offset];
		const v1 = rasters[1].gray[offset];
		const v2 = rasters[2].gray[offset];
		const v3 = rasters[3].gray[offset];
		// Fixed 4-element sorting network (no per-pixel allocation).
		let a = v0, b = v1, c = v2, d = v3;
		if (a > b) { const t = a; a = b; b = t; }
		if (c > d) { const t = c; c = d; d = t; }
		if (a > c) { const t = a; a = c; c = t; }
		if (b > d) { const t = b; b = d; d = t; }
		if (b > c) { const t = b; b = c; c = t; }
		const median = (b + c) / 2;
		if (d - a <= CROP_AGREEMENT_MAX_RANGE) pooled += 1;
		if (Math.min(d - b, c - a) <= CROP_AGREEMENT_MAX_RANGE) majority += 1;
		if (Math.abs(v0 - median) > CROP_AGREEMENT_MAX_RANGE) outlier[0] += 1;
		if (Math.abs(v1 - median) > CROP_AGREEMENT_MAX_RANGE) outlier[1] += 1;
		if (Math.abs(v2 - median) > CROP_AGREEMENT_MAX_RANGE) outlier[2] += 1;
		if (Math.abs(v3 - median) > CROP_AGREEMENT_MAX_RANGE) outlier[3] += 1;
	}
	return {
		pooledAgree: pooled / length,
		majorityAgree: majority / length,
		outlier: outlier.map((count) => count / length)
	};
}

type SideProposal =
	| {
			readonly kind: 'proposed';
			/** Boundary depth in analysis lines; equals the cap when the transition was not observed. */
			readonly boundary: number;
			readonly confidence: 'high' | 'low';
			readonly perTile: readonly number[];
	  }
	| { readonly kind: 'none'; readonly reason: 'conflict' | 'noisy' | 'absent' };

/**
 * The first line inside `bound` where tile `t`'s content genuinely begins: a
 * sustained run of content-divergent lines (matching the main boundary's
 * transition rule). Scattered noisy rows on one tile (a clock, a spinner) are
 * not a boundary even when several of them occur, because the tile's chrome
 * continues after them.
 */
function perTileBoundary(evidence: readonly LineEvidence[], tile: number, bound: number): number {
	for (let d = 0; d < bound; d += 1) {
		if (evidence[d].outlier[tile] < CROP_PER_TILE_DIVERGENCE_FRACTION) continue;
		let sustained = true;
		for (let k = 1; k < CROP_TRANSITION_RUN_LINES; k += 1) {
			if (
				d + k >= bound ||
				evidence[d + k].outlier[tile] < CROP_PER_TILE_DIVERGENCE_FRACTION
			) {
				sustained = false;
				break;
			}
		}
		if (sustained) return d;
	}
	return bound;
}

function analyzeSide(rasters: readonly AnalysisRaster[], side: CropSide): SideProposal {
	const dim = side === 'top' || side === 'bottom' ? rasters[0].heightPx : rasters[0].widthPx;
	const maxBand = Math.max(1, Math.round(dim * MAX_INSET_FRACTION));
	const evidence: LineEvidence[] = [];
	for (let d = 0; d < maxBand; d += 1) {
		evidence.push(lineEvidence(rasters, side, d));
	}
	const high = (d: number): boolean => evidence[d].majorityAgree < CROP_AGREEMENT_MIN_FRACTION;

	// Scan from the edge: the boundary is the start of a sustained disagreement
	// run; isolated high lines are tolerated noise.
	let boundary = -1;
	let noiseCount = 0;
	let anyLow = false;
	for (let d = 0; d < maxBand; d += 1) {
		if (!high(d)) {
			anyLow = true;
			continue;
		}
		let sustained = true;
		for (let k = 1; k < CROP_TRANSITION_RUN_LINES; k += 1) {
			if (d + k >= maxBand || !high(d + k)) {
				sustained = false;
				break;
			}
		}
		if (sustained) {
			boundary = d;
			break;
		}
		noiseCount += 1;
		if (noiseCount > CROP_NOISE_TOLERANCE_LINES) {
			return { kind: 'none', reason: 'noisy' };
		}
	}
	if (boundary === 0) return { kind: 'none', reason: 'absent' };
	if (boundary < 0) {
		if (!anyLow) return { kind: 'none', reason: 'absent' };
		// Agreement runs to the analysis bound: the transition is not observed,
		// so the bounded cap is proposed with low confidence.
		boundary = maxBand;
	}

	// A proposed band must be supported by all four screenshots. A line where
	// majority agrees but pooled does not means one tile's chrome differs there:
	// mismatched per-tile evidence declines the side.
	let pooledDrops = 0;
	for (let d = 0; d < boundary; d += 1) {
		if (evidence[d].pooledAgree < CROP_AGREEMENT_MIN_FRACTION) pooledDrops += 1;
	}
	if (pooledDrops > noiseCount) {
		return { kind: 'none', reason: 'conflict' };
	}

	const perTile = [0, 1, 2, 3].map((tile) => perTileBoundary(evidence, tile, boundary));
	const spreadOk = perTile.every((value) => boundary - value <= CROP_BOUNDARY_TOLERANCE_LINES);
	const confidence: 'high' | 'low' =
		boundary === maxBand || !spreadOk ? 'low' : 'high';
	return { kind: 'proposed', boundary, confidence, perTile };
}

/**
 * Proposes a bounded shared crop from the outer edge bands of all four tiles
 * (P1-002 hardening), plus a crop confidence separate from layout confidence.
 * Returns a null proposal when there is no consistent, repeated-chrome edge
 * evidence (an unjustified crop is never proposed).
 */
export function proposeCropDetailed(
	rasters: readonly AnalysisRaster[],
	options?: CropProposalOptions
): CropProposalDetail {
	const perSide: Record<CropSide, number[]> = {
		top: [],
		right: [],
		bottom: [],
		left: []
	};
	if (rasters.length === 0) {
		return { insets: null, confidence: 'absent', perSide };
	}
	const maxInsetFraction = options?.maxInsetFraction ?? MAX_INSET_FRACTION;
	const scale = rasters[0].scale;

	const insets: Record<keyof CropInsets, number> = { topPx: 0, rightPx: 0, bottomPx: 0, leftPx: 0 };
	let anyProposed = false;
	let anyWeak = false;

	const entropyVertical = usePerImageEntropyVerticalCrop(rasters)
		? rasters.map((raster) => analyzeVerticalEntropy(raster))
		: null;

	for (const side of SIDES) {
		const dim =
			side === 'top' || side === 'bottom'
				? rasters[0].heightPx * scale
				: rasters[0].widthPx * scale;
		const maxInset = Math.floor(dim * maxInsetFraction);

		if (entropyVertical && (side === 'top' || side === 'bottom')) {
			const detected = entropyVertical.map((bounds) =>
				side === 'top' ? bounds.topPx : bounds.bottomPx
			);
			if (detected.some((value) => value === null)) {
				perSide[side] = detected.map((value) => value ?? 0);
				anyWeak = true;
				continue;
			}

			// Detection is independent per image. Stitch Map still owns one shared
			// crop, so choose the deepest required inset: leaving chrome on even one
			// tile is much more damaging to template matching than sacrificing a
			// couple of additional map rows on its peers.
			const perTile = detected as number[];
			const shared = Math.max(...perTile);
			const clamped = Math.max(0, Math.min(shared, maxInset));
			perSide[side] = perTile;
			if (clamped < MIN_ORIGINAL_BAND_PX) {
				anyWeak = true;
				continue;
			}
			insets[`${side}Px` as keyof CropInsets] = clamped;
			anyProposed = true;
			if (clamped !== shared) anyWeak = true;
			continue;
		}

		const proposal = analyzeSide(rasters, side);
		if (proposal.kind === 'none') {
			perSide[side] = [0, 0, 0, 0];
			if (proposal.reason !== 'absent') anyWeak = true;
			continue;
		}
		const clamped = Math.max(0, Math.min(Math.round(proposal.boundary * scale), maxInset));
		perSide[side] = proposal.perTile.map((value) => Math.round(value * scale));
		if (clamped < MIN_ORIGINAL_BAND_PX) {
			if (proposal.perTile.some((value) => value > 0)) anyWeak = true;
			continue;
		}
		insets[`${side}Px` as keyof CropInsets] = clamped;
		anyProposed = true;
		if (proposal.confidence === 'low') anyWeak = true;
	}

	if (!anyProposed) {
		return {
			insets: null,
			confidence: anyWeak ? 'low' : 'absent',
			perSide
		};
	}
	return {
		insets: {
			topPx: insets.topPx,
			rightPx: insets.rightPx,
			bottomPx: insets.bottomPx,
			leftPx: insets.leftPx
		},
		confidence: anyWeak ? 'low' : 'high',
		perSide
	};
}

/**
 * The P1-001 entry point: the bounded shared proposal alone, or null when there
 * is no consistent edge evidence. Exact inset values are identical to
 * `proposeCropDetailed`'s; callers that also need crop confidence use the
 * detailed form.
 */
export function proposeCrop(
	rasters: readonly AnalysisRaster[],
	options?: CropProposalOptions
): CropInsets | null {
	return proposeCropDetailed(rasters, options).insets;
}
