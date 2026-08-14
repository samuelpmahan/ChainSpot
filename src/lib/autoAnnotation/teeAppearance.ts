/**
 * Pancake 1 (tee family only): cheap rotation-normalized appearance check.
 *
 * `rawObjectMask.ts`'s tee family is selected purely by blob size/aspect/
 * fill bounds -- geometry that on-screen UI chrome (map-toggle button text,
 * attribution-watermark letters) can also satisfy. This module adds a
 * second, independent gate: does the candidate's own pixel appearance,
 * rotated into a canonical upright frame using its own PCA orientation,
 * resemble a real tee-pad rather than a text glyph?
 *
 * `TEE_TEMPLATE_BANK` (teeAppearanceTemplates.ts) is a small, fixed set of
 * canonical patches extracted offline from real tee-pad detections on one
 * course fixture (AlexClarkSet) -- see that file's header for provenance.
 * Cross-course validation (a different course's real tees, held fully out
 * of the bank, scored against it) found real tees score 0.39-0.79 and the
 * known false-positive family (UI text) scores 0.24-0.51 -- overlapping in
 * a narrow band, not a clean split. `TEE_APPEARANCE_THRESHOLD` sits below
 * every held-out real tee observed, trading some false-positive rejection
 * for zero observed real-tee loss; see docs/benchmarks for the full
 * cross-validation writeup and the two-course sample-size caveat.
 */

import { TEE_TEMPLATE_BANK, TEE_TEMPLATE_BANK_180, TEE_TEMPLATE_PATCH_SIZE } from './teeAppearanceTemplates';

export const TEE_APPEARANCE_CANONICAL_SIZE = TEE_TEMPLATE_PATCH_SIZE;
export const TEE_APPEARANCE_CONTEXT_SCALE = 2.75;
/**
 * Every real GoldenTeeSet tee scores >= 0.3869 against this bank (the
 * single lowest score belongs to its own extreme-rotation tee, the same
 * candidate that also sat at the edge of every earlier blob-statistic
 * filter). 0.38 sits just below that observed floor -- not tuned against
 * false-positive scores, tuned against the one number that must never be
 * crossed on the held-out course.
 */
export const TEE_APPEARANCE_THRESHOLD = 0.38;

export interface TeeAppearanceCandidate {
	readonly xPx: number;
	readonly yPx: number;
	readonly orientationDeg: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface TeeAppearanceRaster {
	readonly rgba: Uint8Array | Uint8ClampedArray;
	readonly widthPx: number;
	readonly heightPx: number;
}

function sampleBrightnessBilinear(raster: TeeAppearanceRaster, xf: number, yf: number): number {
	const x = Math.min(Math.max(xf, 0), raster.widthPx - 1.001);
	const y = Math.min(Math.max(yf, 0), raster.heightPx - 1.001);
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const x1 = x0 + 1;
	const y1 = y0 + 1;
	const fx = x - x0;
	const fy = y - y0;

	const at = (xi: number, yi: number): number => {
		const off = (yi * raster.widthPx + xi) * 4;
		const r = raster.rgba[off];
		const g = raster.rgba[off + 1];
		const b = raster.rgba[off + 2];
		return r > g ? (r > b ? r : b) : g > b ? g : b;
	};

	const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
	const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
	return top * (1 - fy) + bottom * fy;
}

/**
 * Rotation-normalized canonical patch, backward-mapped: for each output
 * pixel, rotate its offset from the candidate center by +orientationDeg to
 * find the corresponding source-frame location (undoing the "rotate by
 * -orientationDeg to make upright" normalization), then bilinear-sample.
 */
export function extractCanonicalTeePatch(
	raster: TeeAppearanceRaster,
	candidate: TeeAppearanceCandidate,
	canonicalSize: number = TEE_APPEARANCE_CANONICAL_SIZE
): Float64Array {
	const cropPx = Math.max(candidate.widthPx, candidate.heightPx) * TEE_APPEARANCE_CONTEXT_SCALE;
	const theta = (candidate.orientationDeg * Math.PI) / 180;
	const cos = Math.cos(theta);
	const sin = Math.sin(theta);

	const out = new Float64Array(canonicalSize * canonicalSize);
	for (let py = 0; py < canonicalSize; py += 1) {
		const ny = (py + 0.5) / canonicalSize - 0.5;
		const oy = ny * cropPx;
		for (let px = 0; px < canonicalSize; px += 1) {
			const nx = (px + 0.5) / canonicalSize - 0.5;
			const ox = nx * cropPx;
			const sx = ox * cos - oy * sin;
			const sy = ox * sin + oy * cos;
			out[py * canonicalSize + px] = sampleBrightnessBilinear(raster, candidate.xPx + sx, candidate.yPx + sy);
		}
	}
	return out;
}

function normalizedCrossCorrelation(a: Float64Array, b: readonly number[]): number {
	const n = a.length;
	let meanA = 0;
	let meanB = 0;
	for (let i = 0; i < n; i += 1) {
		meanA += a[i];
		meanB += b[i];
	}
	meanA /= n;
	meanB /= n;
	let num = 0;
	let denA = 0;
	let denB = 0;
	for (let i = 0; i < n; i += 1) {
		const da = a[i] - meanA;
		const db = b[i] - meanB;
		num += da * db;
		denA += da * da;
		denB += db * db;
	}
	const den = Math.sqrt(denA * denB);
	return den < 1e-9 ? 0 : num / den;
}

/**
 * Best NCC score against the template bank, checked in both orientations.
 * The upstream PCA axis (`orientationDeg`, mod 180) rectifies a candidate's
 * axis but not which end is "up" -- a real tee can legitimately land
 * upright or 180-degrees-rotated in canonical frame relative to a template
 * instance. This corrects that known ambiguity; it is not tuned per course.
 */
export function bestTeeTemplateScore(patch: Float64Array): number {
	let best = -Infinity;
	for (let i = 0; i < TEE_TEMPLATE_BANK.length; i += 1) {
		const s0 = normalizedCrossCorrelation(patch, TEE_TEMPLATE_BANK[i]);
		const s1 = normalizedCrossCorrelation(patch, TEE_TEMPLATE_BANK_180[i]);
		if (s0 > best) best = s0;
		if (s1 > best) best = s1;
	}
	return best;
}

export function passesTeeAppearanceCheck(raster: TeeAppearanceRaster, candidate: TeeAppearanceCandidate): boolean {
	const patch = extractCanonicalTeePatch(raster, candidate);
	return bestTeeTemplateScore(patch) >= TEE_APPEARANCE_THRESHOLD;
}
