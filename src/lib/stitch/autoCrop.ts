/**
 * ChainSpot Stitch Map shared crop proposal (P1-001, hardened in P1-002).
 *
 * Analyzes only the shared outer edge bands of the four screenshots to propose
 * a reversible set of top/right/bottom/left insets intended to remove repeated
 * screenshot chrome, footer/attribution bands, outer-edge controls, or uniform
 * blank/black margins.
 *
 * The rule is deliberately minimal: for each side, a line is "uniform" when the
 * standard deviation of its grayscale values is below a small threshold, and the
 * band depth is the number of consecutive uniform lines starting at that edge.
 * A side's proposal is the common depth across all four tiles, rounded to
 * original pixels and bounded so it can never remove nearly all content. A side
 * with conflicting evidence gets zero. If no side has any common band, no
 * proposal is returned at all.
 *
 * P1-002 hardening:
 * - A uniform band is treated as chrome only when its mean luminance agrees
 *   across all four tiles within a small tolerance (chrome is identical across
 *   screenshots; naturally similar map content near an edge varies). Otherwise
 *   the side is rejected and no crop is proposed there.
 * - Crop confidence is surfaced separately from layout confidence:
 *   `high` when every tile contributes the same band depth on every proposed
 *   side, `low` when band evidence is partial or conflicts, `absent` when no
 *   proposal exists.
 *
 * Because only lines touching the outer edge are ever inspected, internal
 * uniform regions and per-tile masking can never be proposed. The result is a
 * proposal, never a silent mutation: the caller must present it for an explicit
 * user decision.
 */
import type { CropInsets } from './geometry';
import type { AnalysisRaster } from './analysis';

/** Proposed insets are bounded to this fraction of each original dimension. */
export const MAX_INSET_FRACTION = 0.15;
/** A proposed band must be at least this many original pixels deep. */
export const MIN_ORIGINAL_BAND_PX = 2;
/** Grayscale standard deviation below this counts as a uniform edge line. */
export const UNIFORM_STDDEV_THRESHOLD = 6;
/**
 * Chrome band means must agree across all four tiles within this many gray
 * levels. Identical chrome produces a near-zero delta; naturally similar map
 * content near an edge differs by more. Fixture "strong" chrome is a flat band
 * (delta 0) on every tile.
 */
export const BAND_MEAN_AGREEMENT_MAX_DELTA = 8;

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
	/** Per side, the per-tile uniform band depth in original pixels. */
	readonly perSide: Record<CropSide, readonly number[]>;
}

const SIDES: readonly CropSide[] = ['top', 'right', 'bottom', 'left'];

function lineStandardDeviation(raster: AnalysisRaster, side: CropSide, depth: number): number {
	const w = raster.widthPx;
	const h = raster.heightPx;
	const gray = raster.gray;
	let sum = 0;
	let sumSquares = 0;
	let count = 0;
	if (side === 'top' || side === 'bottom') {
		const row = side === 'top' ? depth : h - 1 - depth;
		if (row < 0 || row >= h) return Infinity;
		for (let x = 0; x < w; x += 1) {
			const value = gray[row * w + x];
			sum += value;
			sumSquares += value * value;
			count += 1;
		}
	} else {
		const col = side === 'left' ? depth : w - 1 - depth;
		if (col < 0 || col >= w) return Infinity;
		for (let y = 0; y < h; y += 1) {
			const value = gray[y * w + col];
			sum += value;
			sumSquares += value * value;
			count += 1;
		}
	}
	if (count === 0) return Infinity;
	const mean = sum / count;
	const variance = sumSquares / count - mean * mean;
	return Math.sqrt(Math.max(0, variance));
}

/** The number of consecutive uniform lines starting from one edge, in raster px. */
function bandDepth(raster: AnalysisRaster, side: CropSide): number {
	const w = raster.widthPx;
	const h = raster.heightPx;
	const dim = side === 'top' || side === 'bottom' ? h : w;
	const maxBand = Math.max(1, Math.round(dim * MAX_INSET_FRACTION));
	let depth = 0;
	while (depth < maxBand) {
		if (lineStandardDeviation(raster, side, depth) >= UNIFORM_STDDEV_THRESHOLD) break;
		depth += 1;
	}
	return depth;
}

/** Mean grayscale over the edge band region of `depth` lines on one tile. */
function bandMean(raster: AnalysisRaster, side: CropSide, depth: number): number {
	const w = raster.widthPx;
	const h = raster.heightPx;
	const gray = raster.gray;
	let sum = 0;
	let count = 0;
	for (let i = 0; i < depth; i += 1) {
		if (side === 'top' || side === 'bottom') {
			const row = side === 'top' ? i : h - 1 - i;
			if (row < 0 || row >= h) return Infinity;
			for (let x = 0; x < w; x += 1) {
				sum += gray[row * w + x];
				count += 1;
			}
		} else {
			const col = side === 'left' ? i : w - 1 - i;
			if (col < 0 || col >= w) return Infinity;
			for (let y = 0; y < h; y += 1) {
				sum += gray[y * w + col];
				count += 1;
			}
		}
	}
	if (count === 0) return Infinity;
	return sum / count;
}

/**
 * Proposes a bounded shared crop from the outer edge bands of all four tiles
 * (P1-002 hardening), plus a crop confidence separate from layout confidence.
 * Returns a null proposal when there is no consistent, chrome-like edge evidence
 * (an unjustified crop is never proposed).
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
	let confidence: CropConfidence = 'high';
	let anyProposed = false;
	let sawConflict = false;

	for (const side of SIDES) {
		const depths = rasters.map((raster) => bandDepth(raster, side));
		const depthsPx = depths.map((depth) => Math.round(depth * scale));
		perSide[side] = depthsPx;

		const common = Math.min(...depths);
		const original = Math.round(common * scale);
		const dim =
			side === 'top' || side === 'bottom'
				? rasters[0].heightPx * scale
				: rasters[0].widthPx * scale;
		const maxInset = Math.floor(dim * maxInsetFraction);
		const field = `${side}Px` as keyof CropInsets;

		if (original < MIN_ORIGINAL_BAND_PX) {
			// Too thin to be a credible band: nothing is proposed for this side.
			// A band present on some tiles but not others is still a conflict.
			if (depthsPx.some((depth) => depth > 0)) sawConflict = true;
			continue;
		}
		if (maxInset < MIN_ORIGINAL_BAND_PX) {
			if (depthsPx.some((depth) => depth > 0)) sawConflict = true;
			continue;
		}
		// Chrome-vs-content rule: the band must look like the same chrome on all
		// four tiles. Different means mean naturally similar content near an
		// edge, which must not be cropped.
		const means = rasters.map((raster) => bandMean(raster, side, common));
		const meanDelta = Math.max(...means) - Math.min(...means);
		if (meanDelta > BAND_MEAN_AGREEMENT_MAX_DELTA) {
			sawConflict = true;
			continue;
		}
		const proposed = Math.max(0, Math.min(original, maxInset));
		insets[field] = proposed;
		anyProposed = true;
		// High confidence requires every tile to agree on the exact band depth.
		if (new Set(depthsPx).size > 1) confidence = 'low';
	}

	if (!anyProposed) {
		return {
			insets: null,
			confidence: sawConflict ? 'low' : 'absent',
			perSide
		};
	}
	if (sawConflict) confidence = 'low';
	return {
		insets: { topPx: insets.topPx, rightPx: insets.rightPx, bottomPx: insets.bottomPx, leftPx: insets.leftPx },
		confidence,
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

