// Minimal 2-tile translation-only stitch search. Pure — no DOM.
//
// The capture protocol fixes device/zoom, so tile B relates to tile A by a
// pure translation. Coarse-to-fine: score every offset on downsampled rasters
// (mean absolute luma difference over the overlap, lower = better), then
// refine at full resolution around the coarse winner.

import type { GrayRaster } from '$lib/raster';

export interface StitchOffset {
	/** Position of raster B's origin relative to raster A's origin, in A's pixels. */
	readonly dx: number;
	readonly dy: number;
	/** Mean absolute luma difference over the overlap (0 = identical). */
	readonly score: number;
}

/** Fraction of the smaller image that must overlap for an offset to count. */
const MIN_OVERLAP_FRACTION = 0.08;
const COARSE_TARGET_DIM = 128;
const REFINE_RADIUS_FACTOR = 1.5;

export function downsample(r: GrayRaster, factor: number): GrayRaster {
	if (factor <= 1) return r;
	const w = Math.max(1, Math.floor(r.widthPx / factor));
	const h = Math.max(1, Math.floor(r.heightPx / factor));
	const gray = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let sum = 0;
			for (let sy = 0; sy < factor; sy++) {
				const row = (y * factor + sy) * r.widthPx + x * factor;
				for (let sx = 0; sx < factor; sx++) sum += r.gray[row + sx];
			}
			gray[y * w + x] = sum / (factor * factor);
		}
	}
	return { widthPx: w, heightPx: h, gray };
}

function scoreOffset(
	a: GrayRaster,
	b: GrayRaster,
	dx: number,
	dy: number,
	rowStride = 1
): number | null {
	const x0 = Math.max(0, dx);
	const y0 = Math.max(0, dy);
	const x1 = Math.min(a.widthPx, dx + b.widthPx);
	const y1 = Math.min(a.heightPx, dy + b.heightPx);
	const ow = x1 - x0;
	const oh = y1 - y0;
	const minArea =
		Math.min(a.widthPx * a.heightPx, b.widthPx * b.heightPx) * MIN_OVERLAP_FRACTION;
	if (ow <= 0 || oh <= 0 || ow * oh < minArea) return null;

	let sum = 0;
	let rows = 0;
	for (let y = y0; y < y1; y += rowStride) {
		let ai = y * a.widthPx + x0;
		let bi = (y - dy) * b.widthPx + (x0 - dx);
		for (let x = 0; x < ow; x++) sum += Math.abs(a.gray[ai++] - b.gray[bi++]);
		rows++;
	}
	return sum / (ow * rows);
}

function searchRange(
	a: GrayRaster,
	b: GrayRaster,
	dxMin: number,
	dxMax: number,
	dyMin: number,
	dyMax: number,
	step: number,
	rowStride = 1
): StitchOffset | null {
	let best: StitchOffset | null = null;
	for (let dy = dyMin; dy <= dyMax; dy += step) {
		for (let dx = dxMin; dx <= dxMax; dx += step) {
			const score = scoreOffset(a, b, dx, dy, rowStride);
			if (score !== null && (best === null || score < best.score)) {
				best = { dx, dy, score };
			}
		}
	}
	return best;
}

/** Find the best translation placing B relative to A. Null when no offset overlaps enough. */
export function findBestTranslation(a: GrayRaster, b: GrayRaster): StitchOffset | null {
	const factor = Math.max(
		1,
		Math.floor(Math.min(a.widthPx, a.heightPx, b.widthPx, b.heightPx) / COARSE_TARGET_DIM)
	);
	const ca = downsample(a, factor);
	const cb = downsample(b, factor);

	const coarse = searchRange(ca, cb, -cb.widthPx + 1, ca.widthPx - 1, -cb.heightPx + 1, ca.heightPx - 1, 1);
	if (coarse === null) return null;
	if (factor === 1) return coarse;

	// refine through a mid level so the full-res pass only sweeps a few px;
	// sampled rows (stride 4) keep the mean-abs-diff ranking intact at ~4x speed
	const mid = Math.max(1, Math.floor(factor / 4));
	let cx = coarse.dx * factor;
	let cy = coarse.dy * factor;
	if (mid > 1) {
		const ma = downsample(a, mid);
		const mb = downsample(b, mid);
		const rm = Math.ceil((factor / mid) * REFINE_RADIUS_FACTOR);
		const mx = Math.round(cx / mid);
		const my = Math.round(cy / mid);
		const midBest = searchRange(ma, mb, mx - rm, mx + rm, my - rm, my + rm, 1, 2);
		if (midBest) {
			cx = midBest.dx * mid;
			cy = midBest.dy * mid;
		}
	}
	const r = Math.ceil(mid * REFINE_RADIUS_FACTOR);
	return searchRange(a, b, cx - r, cx + r, cy - r, cy + r, 1, 4);
}
