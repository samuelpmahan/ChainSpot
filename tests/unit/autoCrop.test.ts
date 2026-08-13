import { describe, expect, test } from 'vitest';
import {
	DEFAULT_CROP_SAFETY_MARGIN_PX,
	MAX_INSET_FRACTION,
	MIN_ORIGINAL_BAND_PX,
	proposeCrop
} from '../../src/lib/stitch/autoCrop';
import { buildGrayRaster, TILE_H } from '../helpers/smartMap';
import type { AnalysisRaster } from '../../src/lib/stitch/analysis';

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
