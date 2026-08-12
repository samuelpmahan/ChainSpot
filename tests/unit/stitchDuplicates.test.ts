/**
 * Duplicate-screenshot rejection, and its deliberate boundary against heavy
 * overlap.
 *
 * The pair of behaviors matters more than either alone: generous overlap must
 * always be accepted, because that is what a careful capture looks like, while
 * the same screenshot supplied twice must be named and refused, because no 2×2
 * exists and any arrangement would silently drop a quarter of the course.
 */
import { describe, expect, it } from 'vitest';
import { findDuplicateRasters } from '../../src/lib/stitch/duplicates';
import { smartImportFiles } from '../../src/lib/stitch/smartImport';
import { buildGrayRaster, SLOT_ORIGINS } from '../helpers/smartMap';
import type { AnalysisRaster } from '../../src/lib/stitch/analysis';

// This file always exercises the fixed 2x2 corner layout — the four literal
// corner names, not the broader `TileSlot` union geometry.ts now exports for
// 1x2/2x1 layouts — so `buildGrayRaster`'s narrower `SlotKey` param accepts
// every element without a cast.
const ALL_SLOTS = ['upper-left', 'upper-right', 'lower-left', 'lower-right'] as const;

function fileOf(name: string): File {
	return new File([new Uint8Array(8).fill(1)], name, { type: 'image/png' });
}

/** Runs the real smart-import pipeline over supplied rasters, without a browser. */
async function importRasters(
	rasters: readonly AnalysisRaster[],
	names: readonly string[]
): Promise<Awaited<ReturnType<typeof smartImportFiles>>> {
	let index = 0;
	return smartImportFiles(
		names.map((name) => fileOf(name)),
		{
			decode: async () => ({ image: {} as HTMLImageElement, widthPx: 200, heightPx: 200 }),
			buildRaster: () => rasters[index++ % rasters.length],
			buildCropRaster: () => rasters[index++ % rasters.length]
		}
	);
}

function tiles(overlapPx: number): AnalysisRaster[] {
	const step = 200 - overlapPx;
	const origins: Record<(typeof ALL_SLOTS)[number], { x: number; y: number }> = {
		'upper-left': { x: 0, y: 0 },
		'upper-right': { x: step, y: 0 },
		'lower-left': { x: 0, y: step },
		'lower-right': { x: step, y: step }
	};
	return ALL_SLOTS.map((slot) =>
		buildGrayRaster(slot, { origin: origins[slot], chromeTop: 0, chromeBottom: 0 })
	);
}

describe('findDuplicateRasters', () => {
	it('reports nothing for four distinct captures, however generously they overlap', () => {
		expect(findDuplicateRasters(tiles(50))).toBeNull();
		// 90% overlap: a user panning in very small steps. Still four distinct
		// captures, so still not a duplicate.
		expect(findDuplicateRasters(tiles(180))).toBeNull();
	});

	it('reports the first identical pair in index order, ignoring how it was produced', () => {
		const distinct = tiles(50);
		const cloned = [...distinct];
		// A re-saved screenshot: a different object with identical pixels.
		cloned[3] = { ...distinct[1], gray: Uint8Array.from(distinct[1].gray) };

		expect(findDuplicateRasters(cloned)).toEqual({ firstIndex: 1, duplicateIndex: 3 });
	});

	it('does not treat rasters that differ by a single pixel as duplicates', () => {
		const rasters = tiles(50);
		const nudged = Uint8Array.from(rasters[0].gray);
		nudged[0] = nudged[0] === 0 ? 1 : nudged[0] - 1;
		const almost = [rasters[0], { ...rasters[0], gray: nudged }, rasters[2], rasters[3]];

		expect(findDuplicateRasters(almost)).toBeNull();
	});
});

describe('smart import duplicate rejection', () => {
	it('rejects the same screenshot selected twice, naming it, and leaves the session unchanged', async () => {
		const rasters = tiles(50);
		const result = await importRasters(
			[rasters[0], rasters[1], rasters[2], rasters[0]],
			['ul.png', 'ur.png', 'll.png', 'ul.png']
		);

		expect(result.ok).toBe(false);
		if (result.ok || !('reason' in result)) throw new Error('expected a file rejection');
		expect(result.reason).toBe('duplicate-image');
		expect(result.fileName).toBe('ul.png');
		expect(result.message).toContain('selected twice');
	});

	it('rejects two differently named files holding the same image, naming both', async () => {
		const rasters = tiles(50);
		const copy = { ...rasters[1], gray: Uint8Array.from(rasters[1].gray) };
		const result = await importRasters(
			[rasters[0], rasters[1], rasters[2], copy],
			['ul.png', 'ur.png', 'll.png', 'ur-copy.png']
		);

		expect(result.ok).toBe(false);
		if (result.ok || !('reason' in result)) throw new Error('expected a file rejection');
		expect(result.reason).toBe('duplicate-image');
		expect(result.message).toContain('ur-copy.png');
		expect(result.message).toContain('ur.png');
	});

	it('accepts heavily overlapping distinct captures without warning about the overlap', async () => {
		const result = await importRasters(tiles(180), ['a.png', 'b.png', 'c.png', 'd.png']);

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('expected a successful import');
		expect(result.diagnostic.warnings).toEqual([]);
		expect(result.diagnostic.category).toBe('ok');
		expect(new Set(Object.values(result.assignment)).size).toBe(4);
	});
});

describe('smartMap fixture assumptions', () => {
	it('keeps the shared 25% origins the other stitch fixtures rely on', () => {
		expect(SLOT_ORIGINS['upper-left']).toEqual({ x: 0, y: 0 });
	});
});
