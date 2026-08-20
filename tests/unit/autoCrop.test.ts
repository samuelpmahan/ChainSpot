import { describe, expect, test } from 'vitest';
import {
	DEFAULT_CROP_SAFETY_MARGIN_PX,
	MAX_INSET_FRACTION,
	MIN_ORIGINAL_BAND_PX,
	proposeCrop,
	proposeSingleImageCrop
} from '../../src/lib/stitch/autoCrop';
import { buildGrayRaster, TILE_H } from '../helpers/smartMap';
import type { AnalysisRaster } from '../../src/lib/stitch/analysis';

/**
 * A synthetic "phone screenshot" raster: uniform (zero-entropy) bands of
 * `chromeDepth` rows at the top and bottom, and a full-range, per-pixel-varying
 * (high-entropy) region in between, standing in for real map content. Sized to
 * satisfy the per-image entropy detector's real-capture gate (height >= 1000,
 * width >= 500, height > width, scale <= 1.01 — see `usePerImageEntropyVerticalCrop`).
 */
function buildScreenshotRaster(
	widthPx: number,
	heightPx: number,
	chromeDepth: number,
	options?: { scale?: number }
): AnalysisRaster {
	const gray = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y += 1) {
		const inChrome = y < chromeDepth || y >= heightPx - chromeDepth;
		for (let x = 0; x < widthPx; x += 1) {
			gray[y * widthPx + x] = inChrome ? 40 : (x * 37 + y * 91) % 256;
		}
	}
	return { widthPx, heightPx, gray, scale: options?.scale ?? 1 };
}

describe('single-image vertical crop proposal (annotate-course / annotate-round uploads)', () => {
	test('proposes a top/bottom-only crop matching the uniform chrome bands of a qualifying phone screenshot', () => {
		const raster = buildScreenshotRaster(600, 1200, 100);
		const proposal = proposeSingleImageCrop(raster);
		expect(proposal).toEqual({
			insets: { topPx: 100, rightPx: 0, bottomPx: 100, leftPx: 0 },
			confidence: 'high'
		});
	});

	test('never proposes a crop for a landscape image, even with the same chrome pattern', () => {
		const raster = buildScreenshotRaster(1200, 600, 100);
		const proposal = proposeSingleImageCrop(raster);
		expect(proposal.insets).toBeNull();
		expect(proposal.confidence).toBe('absent');
	});

	test('never proposes a crop for a portrait image below the real-capture size gate', () => {
		const raster = buildScreenshotRaster(400, 900, 100);
		const proposal = proposeSingleImageCrop(raster);
		expect(proposal.insets).toBeNull();
		expect(proposal.confidence).toBe('absent');
	});

	test('never proposes a crop for a downscaled analysis raster (scale > 1.01)', () => {
		const raster = buildScreenshotRaster(600, 1200, 100, { scale: 1.5 });
		const proposal = proposeSingleImageCrop(raster);
		expect(proposal.insets).toBeNull();
		expect(proposal.confidence).toBe('absent');
	});
});

describe('single-image crop safety margin (marginPx option)', () => {
	test('a clean, unclamped detection stays high confidence with the margin applied', () => {
		const raster = buildScreenshotRaster(600, 1200, 100);
		const proposal = proposeSingleImageCrop(raster, { marginPx: DEFAULT_CROP_SAFETY_MARGIN_PX });
		expect(proposal.insets).toEqual({
			topPx: 100 + DEFAULT_CROP_SAFETY_MARGIN_PX,
			rightPx: 0,
			bottomPx: 100 + DEFAULT_CROP_SAFETY_MARGIN_PX,
			leftPx: 0
		});
		expect(proposal.confidence).toBe('high');
	});

	test('a detection the bounded-inset rule clamps stays low confidence with the margin applied', () => {
		// chromeDepth 300 exceeds maxInset (floor(1200 * MAX_INSET_FRACTION) =
		// 240), so the raw detection itself -- independent of the margin --
		// gets clamped down to the bound.
		const raster = buildScreenshotRaster(600, 1200, 300);
		const maxInset = Math.floor(1200 * MAX_INSET_FRACTION);
		const proposal = proposeSingleImageCrop(raster, { marginPx: DEFAULT_CROP_SAFETY_MARGIN_PX });
		expect(proposal.insets).toEqual({
			topPx: maxInset,
			rightPx: 0,
			bottomPx: maxInset,
			leftPx: 0
		});
		expect(proposal.confidence).toBe('low');
	});
});

const ALL_SLOTS = ['upper-left', 'upper-right', 'lower-left', 'lower-right'] as const;

describe('P1-001 shared outer-band crop proposal (case 3)', () => {
	test('proposes bounded common outer insets, declines conflicting or unsupported evidence, and bounds insets', () => {
		// Shared chrome bands on every tile produce one bounded common proposal.
		const rasters = [
			buildGrayRaster('upper-left'),
			buildGrayRaster('upper-right'),
			buildGrayRaster('lower-left'),
			buildGrayRaster('lower-right')
		];
		const proposal = proposeCrop(rasters);
		if (!proposal) throw new Error('expected a crop proposal');
		expect(proposal).toEqual({ topPx: 4, rightPx: 0, bottomPx: 3, leftPx: 0 });
		for (const [field, value] of Object.entries(proposal)) {
			expect(Number.isInteger(value)).toBe(true);
			expect(value).toBeGreaterThanOrEqual(0);
		}

		// A single conflicting tile declines the whole side.
		const conflicting = [
			buildGrayRaster('upper-left'),
			buildGrayRaster('upper-right'),
			buildGrayRaster('lower-left', { chromeTop: 0 }),
			buildGrayRaster('lower-right')
		];
		expect(proposeCrop(conflicting)).toEqual({ topPx: 0, rightPx: 0, bottomPx: 3, leftPx: 0 });

		// Every side conflicting means no proposal at all (no unjustified crop).
		const allConflicting = ALL_SLOTS.map((slot) =>
			buildGrayRaster(slot, { chromeTop: 0, chromeBottom: 0 })
		);
		expect(proposeCrop(allConflicting)).toBeNull();

		// Very deep uniform bands are capped by the bounded-inset rule.
		const deep = ALL_SLOTS.map((slot) => buildGrayRaster(slot, { chromeTop: 40 }));
		const capped = proposeCrop(deep);
		expect(capped).not.toBeNull();
		if (!capped) return;
		const maxInset = Math.floor(TILE_H * MAX_INSET_FRACTION);
		expect(capped.topPx).toBe(maxInset);
		expect(capped.topPx).toBeLessThan(TILE_H);

		// Interior uniform regions and bands below the minimum depth are never
		// proposed as chrome: only outer edge lines are inspected.
		const interior = ALL_SLOTS.map((slot) => {
			const raster = buildGrayRaster(slot, { chromeTop: 0, chromeBottom: 0 });
			const gray = raster.gray.slice();
			for (let y = 50; y < 60; y += 1) {
				for (let x = 0; x < raster.widthPx; x += 1) {
					gray[y * raster.widthPx + x] = 100;
				}
			}
			return { ...raster, gray };
		});
		expect(proposeCrop(interior)).toBeNull();

		const thin = ALL_SLOTS.map((slot) => {
			const raster = buildGrayRaster(slot, { chromeTop: 1, chromeBottom: 0 });
			const gray = raster.gray.slice();
			for (let x = 0; x < raster.widthPx; x += 1) {
				gray[x] = 12;
			}
			return { ...raster, gray };
		});
		expect(MIN_ORIGINAL_BAND_PX).toBeGreaterThan(1);
		expect(proposeCrop(thin)).toBeNull();

		// An empty set returns null rather than failing.
		expect(proposeCrop([] as AnalysisRaster[])).toBeNull();
	});
});

describe('P1-001 crop safety margin (marginPx option)', () => {
	test('adds the margin only to sides that were actually proposed, clamped to the same bound detection itself respects', () => {
		const rasters = [
			buildGrayRaster('upper-left'),
			buildGrayRaster('upper-right'),
			buildGrayRaster('lower-left'),
			buildGrayRaster('lower-right')
		];
		// No margin: the exact detected boundary (matches the case-3 fixture above).
		const exact = proposeCrop(rasters, { marginPx: 0 });
		expect(exact).toEqual({ topPx: 4, rightPx: 0, bottomPx: 3, leftPx: 0 });

		// The default suggested margin is added to every proposed side (top,
		// bottom) but never invents a crop on a side with no evidence (right,
		// left stay 0, not 0 + margin).
		const margined = proposeCrop(rasters, { marginPx: DEFAULT_CROP_SAFETY_MARGIN_PX });
		expect(margined).toEqual({
			topPx: 4 + DEFAULT_CROP_SAFETY_MARGIN_PX,
			rightPx: 0,
			bottomPx: 3 + DEFAULT_CROP_SAFETY_MARGIN_PX,
			leftPx: 0
		});

		// A single conflicting tile declines that side outright (see the case-3
		// fixture above); margin must not resurrect it.
		const conflicting = [
			buildGrayRaster('upper-left'),
			buildGrayRaster('upper-right'),
			buildGrayRaster('lower-left', { chromeTop: 0 }),
			buildGrayRaster('lower-right')
		];
		expect(proposeCrop(conflicting, { marginPx: DEFAULT_CROP_SAFETY_MARGIN_PX })).toEqual({
			topPx: 0,
			rightPx: 0,
			bottomPx: 3 + DEFAULT_CROP_SAFETY_MARGIN_PX,
			leftPx: 0
		});

		// A very deep band is already capped at the bounded-inset rule; a large
		// margin must not push it past that same bound.
		const deep = ALL_SLOTS.map((slot) => buildGrayRaster(slot, { chromeTop: 40 }));
		const maxInset = Math.floor(TILE_H * MAX_INSET_FRACTION);
		const cappedWithMargin = proposeCrop(deep, { marginPx: 1000 });
		expect(cappedWithMargin?.topPx).toBe(maxInset);
	});
});
