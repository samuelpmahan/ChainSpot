import { describe, expect, test } from 'vitest';
import { MAX_INSET_FRACTION, MIN_ORIGINAL_BAND_PX, proposeCrop } from '../../src/lib/stitch/autoCrop';
import { buildGrayRaster, TILE_H } from '../helpers/smartMap';
import type { AnalysisRaster } from '../../src/lib/stitch/analysis';
import type { TileSlot } from '../../src/lib/stitch/geometry';

const ALL_SLOTS: readonly TileSlot[] = ['upper-left', 'upper-right', 'lower-left', 'lower-right'];

describe('P1-001 shared outer-band crop proposal (case 3)', () => {
	test('proposes bounded common outer insets for shared chrome bands', () => {
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
	});

	test('declines a side whose evidence conflicts on a single tile', () => {
		// Lower-left lacks the top chrome band: the top edge evidence conflicts,
		// so the top inset must not be proposed for any tile.
		const rasters = [
			buildGrayRaster('upper-left'),
			buildGrayRaster('upper-right'),
			buildGrayRaster('lower-left', { chromeTop: 0 }),
			buildGrayRaster('lower-right')
		];
		const proposal = proposeCrop(rasters);
		expect(proposal).toEqual({ topPx: 0, rightPx: 0, bottomPx: 3, leftPx: 0 });
	});

	test('returns no proposal at all when every side has conflicting evidence', () => {
		const rasters = [
			buildGrayRaster('upper-left', { chromeTop: 0, chromeBottom: 0 }),
			buildGrayRaster('upper-right', { chromeTop: 0, chromeBottom: 0 }),
			buildGrayRaster('lower-left', { chromeTop: 0, chromeBottom: 0 }),
			buildGrayRaster('lower-right', { chromeTop: 0, chromeBottom: 0 })
		];
		expect(proposeCrop(rasters)).toBeNull();
	});

	test('bounds proposed insets so they cannot remove nearly all content', () => {
		// A very deep uniform band must be capped by the bounded inset rule.
		const rasters = [
			buildGrayRaster('upper-left', { chromeTop: 40 }),
			buildGrayRaster('upper-right', { chromeTop: 40 }),
			buildGrayRaster('lower-left', { chromeTop: 40 }),
			buildGrayRaster('lower-right', { chromeTop: 40 })
		];
		const proposal = proposeCrop(rasters);
		expect(proposal).not.toBeNull();
		if (!proposal) return;
		const maxInset = Math.floor(TILE_H * MAX_INSET_FRACTION);
		expect(proposal.topPx).toBe(maxInset);
		expect(proposal.topPx).toBeLessThan(TILE_H);
	});

	test('never proposes internal uniform regions or bands below the minimum depth', () => {
		// Interior uniform bands (rows 50-59) must be ignored: only outer edge
		// lines are ever inspected, so an interior masking region never appears.
		const rasters = ALL_SLOTS.map((slot) => {
			const raster = buildGrayRaster(slot, { chromeTop: 0, chromeBottom: 0 });
			const gray = raster.gray.slice();
			for (let y = 50; y < 60; y += 1) {
				for (let x = 0; x < raster.widthPx; x += 1) {
					gray[y * raster.widthPx + x] = 100;
				}
			}
			return { ...raster, gray };
		});
		expect(proposeCrop(rasters)).toBeNull();

		// A band narrower than the documented minimum is not proposed either.
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
	});

	test('returns null for an empty set', () => {
		expect(proposeCrop([] as AnalysisRaster[])).toBeNull();
	});
});
