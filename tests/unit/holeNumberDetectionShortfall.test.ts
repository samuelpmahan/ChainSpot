import { describe, expect, it } from 'vitest';
import { detectHoleNumberBadges } from '../../src/lib/autoAnnotation/holeNumberDetection';
import type {
	HoleNumberCvModule,
	HoleNumberCvMat,
	HoleNumberRaster,
	HoleNumberTemplate
} from '../../src/lib/autoAnnotation/holeNumberDetection';

/**
 * Reproduces (with a synthetic, photo-free raster) the exact collapse
 * measured live against the shipped demo dataset
 * (`static/resources/demo/dashs-track/`, see `docs/cv-demo-zero-ready.md`):
 * `assignedCandidates` in `holeNumberDetection.ts` used to require the
 * number of physical badge-body clusters found on the source image to
 * *exactly* equal the number of supplied templates (18) before it would
 * label anything. When the real image only yields 16 physical candidates
 * (two badges did not survive the same-size clustering step -- see the doc
 * for the real measurement), the labeler did not label the 16 it *did*
 * find; it aborted for all 18 and returned `labeling: 'candidate-only'`
 * with every candidate's `label` left `undefined`.
 *
 * The fix (Hungarian assignment padded with dummy rows/columns -- see
 * `withDummyRowsAndColumns` in holeNumberDetection.ts) means glyph scoring
 * now genuinely runs even on a shortfall, so this suite needs a `cv` that
 * can really tell two glyph crops apart -- a mock that ignores its inputs
 * (as the old total-collapse test's mock did) can no longer stand in.
 * `realNccCv()` below is a small brute-force TM_CCOEFF_NORMED
 * implementation; it isn't fast, but every Mat here is a few dozen pixels
 * across, so it's cheap.
 */

function hash32(value: number): number {
	let x = value | 0;
	x = (x ^ 61) ^ (x >>> 16);
	x = (x + (x << 3)) | 0;
	x = x ^ (x >>> 4);
	x = Math.imul(x, 0x27d4eb2d);
	x = x ^ (x >>> 15);
	return x >>> 0;
}

/** A real (if brute-force) TM_CCOEFF_NORMED so glyph-content differences actually matter. */
function realNccCv(): HoleNumberCvModule {
	class FakeMat implements HoleNumberCvMat {
		rows: number;
		cols: number;
		data: Uint8Array;
		data32F?: Float32Array;
		constructor(rows = 0, cols = 0) {
			this.rows = rows;
			this.cols = cols;
			this.data = new Uint8Array(Math.max(0, rows * cols));
		}
		delete(): void {}
	}
	return {
		Mat: FakeMat as unknown as HoleNumberCvModule['Mat'],
		CV_8UC1: 0,
		TM_CCOEFF_NORMED: 0,
		matchTemplate(image, template, result): void {
			const iw = image.cols;
			const ih = image.rows;
			const tw = template.cols;
			const th = template.rows;
			const iData = image.data as Uint8Array;
			const tData = template.data as Uint8Array;
			const rw = Math.max(0, iw - tw + 1);
			const rh = Math.max(0, ih - th + 1);
			const out = new Float32Array(rw * rh);

			let templateMean = 0;
			for (let index = 0; index < tData.length; index += 1) templateMean += tData[index];
			templateMean /= tData.length || 1;
			let templateVariance = 0;
			for (let index = 0; index < tData.length; index += 1) {
				const delta = tData[index] - templateMean;
				templateVariance += delta * delta;
			}

			for (let y = 0; y < rh; y += 1) {
				for (let x = 0; x < rw; x += 1) {
					let windowMean = 0;
					for (let ty = 0; ty < th; ty += 1) {
						const rowStart = (y + ty) * iw + x;
						for (let tx = 0; tx < tw; tx += 1) windowMean += iData[rowStart + tx];
					}
					windowMean /= tw * th;

					let numerator = 0;
					let windowVariance = 0;
					for (let ty = 0; ty < th; ty += 1) {
						const rowStart = (y + ty) * iw + x;
						for (let tx = 0; tx < tw; tx += 1) {
							const imageDelta = iData[rowStart + tx] - windowMean;
							const templateDelta = tData[ty * tw + tx] - templateMean;
							numerator += imageDelta * templateDelta;
							windowVariance += imageDelta * imageDelta;
						}
					}
					const denominator = Math.sqrt(windowVariance * templateVariance);
					out[y * rw + x] = denominator > 1e-6 ? numerator / denominator : 0;
				}
			}

			const resultMat = result as unknown as FakeMat;
			resultMat.rows = rh;
			resultMat.cols = rw;
			resultMat.data32F = out;
		}
	};
}

const GRID_COLS = 4;
const GRID_ROWS = 3;
const GRID_CELLS = GRID_COLS * GRID_ROWS;
/** Exactly this many of the 12 grid cells are bright, for every label -- a fixed
 *  bright/dark balance (rather than an independent coin flip per cell) so no
 *  label can randomly land a fill ratio that fails `plausibleBadgeBody`. */
const BRIGHT_CELLS_PER_LABEL = 4;

/** Deterministic per-label subset of grid cell indexes to mark bright, always exactly `BRIGHT_CELLS_PER_LABEL` of them. */
function brightCellIndexes(label: number): Set<number> {
	const indexes = Array.from({ length: GRID_CELLS }, (_, index) => index);
	let seed = hash32(label * 2654435761);
	for (let i = indexes.length - 1; i > 0; i -= 1) {
		seed = hash32(seed + 0x9e3779b9);
		const j = seed % (i + 1);
		const swap = indexes[i];
		indexes[i] = indexes[j];
		indexes[j] = swap;
	}
	return new Set(indexes.slice(0, BRIGHT_CELLS_PER_LABEL));
}

/**
 * Paints a badge body: a dark (0) rounded-rect-ish box like the real UDisc
 * badge background, with a small label-specific bright/dark cell pattern in
 * the box's middle 76% (well inside where `interior()` extracts its glyph
 * crop, confirmed against the margin math in holeNumberDetection.ts) so two
 * different labels' badges are genuinely distinguishable by NCC. Exactly
 * `BRIGHT_CELLS_PER_LABEL` of the 12 grid cells are bright for every label
 * (never more, never fewer), so the box's overall fill ratio -- and thus
 * whether `plausibleBadgeBody` accepts it as a badge at all -- never depends
 * on which label happened to hash to more bright cells.
 */
function paintLabeledBox(
	data: Uint8Array,
	rasterWidthPx: number,
	box: { x: number; y: number; w: number; h: number },
	label: number
): void {
	const marginFrac = 0.12;
	const spanFrac = 1 - marginFrac * 2;
	const bright = brightCellIndexes(label);
	for (let y = box.y; y < box.y + box.h; y += 1) {
		const yFrac = (y - box.y) / box.h;
		for (let x = box.x; x < box.x + box.w; x += 1) {
			const xFrac = (x - box.x) / box.w;
			let value = 0;
			if (xFrac >= marginFrac && xFrac < 1 - marginFrac && yFrac >= marginFrac && yFrac < 1 - marginFrac) {
				const cellX = Math.min(GRID_COLS - 1, Math.floor(((xFrac - marginFrac) / spanFrac) * GRID_COLS));
				const cellY = Math.min(GRID_ROWS - 1, Math.floor(((yFrac - marginFrac) / spanFrac) * GRID_ROWS));
				value = bright.has(cellY * GRID_COLS + cellX) ? 210 : 15;
			}
			data[y * rasterWidthPx + x] = value;
		}
	}
}

function templatePack(count: number): HoleNumberTemplate[] {
	// 60x45 outer / 47x35 body matches the canonical badge-body size measured
	// directly against the real bundled hole-01.png..hole-18.png pack.
	const templates: HoleNumberTemplate[] = [];
	for (let label = 1; label <= count; label += 1) {
		const data = new Uint8Array(60 * 45).fill(255);
		paintLabeledBox(data, 60, { x: 6, y: 5, w: 47, h: 35 }, label);
		templates.push({ label, raster: { format: 'gray', widthPx: 60, heightPx: 45, data } });
	}
	return templates;
}

/** 16 consistently-sized, well-separated badge-shaped boxes, each carrying its intended label's pattern -- the exact physical-candidate count measured on the real stitched demo course map. */
function sixteenLabeledCandidatesRaster(): HoleNumberRaster {
	const widthPx = 400;
	const heightPx = 400;
	const data = new Uint8Array(widthPx * heightPx).fill(255);
	for (let index = 0; index < 16; index += 1) {
		const box = {
			x: 20 + (index % 4) * 90,
			y: 20 + Math.floor(index / 4) * 90,
			w: 37,
			h: 27
		};
		paintLabeledBox(data, widthPx, box, index + 1);
	}
	return { format: 'gray', widthPx, heightPx, data };
}

describe('detectHoleNumberBadges: physical-candidate shortfall', () => {
	it('16 physical badges found against 18 templates now labels most of them instead of collapsing to zero', () => {
		const source = sixteenLabeledCandidatesRaster();
		const result = detectHoleNumberBadges(realNccCv(), source, templatePack(18));

		// The 16 real, well-formed physical candidates were found either way --
		// the bug was never about finding them, only about labeling them.
		expect(result.candidates).toHaveLength(16);

		// Before the fix this was 0 (`labeling: 'candidate-only'`): the
		// clusters.length !== templates.length gate aborted labeling for all
		// 18 templates before a single glyph match ran. The fix runs a
		// partial (dummy-padded Hungarian) assignment instead, so most of the
		// 16 physically-found badges should still get labeled.
		const labeledCount = result.candidates.filter((candidate) => candidate.label !== undefined).length;
		expect(labeledCount).toBeGreaterThanOrEqual(14);
	});
});
