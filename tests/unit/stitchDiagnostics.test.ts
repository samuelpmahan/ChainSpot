import { describe, expect, test } from 'vitest';
import { assignFour } from '../../src/lib/stitch/autoLayout';
import { classifyLayout } from '../../src/lib/stitch/diagnostics';
import { proposeCropDetailed } from '../../src/lib/stitch/autoCrop';
import { buildGrayRaster } from '../helpers/smartMap';
import type { AnalysisRaster } from '../../src/lib/stitch/analysis';
import type { TileSlot } from '../../src/lib/stitch/geometry';

const ALL_SLOTS: readonly TileSlot[] = ['upper-left', 'upper-right', 'lower-left', 'lower-right'];

function rastersFor(
	origins: Record<TileSlot, { x: number; y: number }> | null,
	extra: Partial<
		Record<TileSlot, { unrelated?: boolean; repetitive?: boolean; chromeTop?: number; chromeBottom?: number }>
	> = {}
): AnalysisRaster[] {
	return ALL_SLOTS.map((slot) =>
		buildGrayRaster(slot, { ...extra[slot], origin: origins ? origins[slot] : undefined })
	);
}

describe('P1-002 confidence/consistency classification (case 1)', () => {
	test('strong fixture classifies as strong with no warnings and high crop confidence', () => {
		const rasters = rastersFor(null);
		const layout = assignFour(rasters);
		const diagnostic = classifyLayout(layout, rasters);
		expect(diagnostic.category).toBe('strong');
		expect(diagnostic.warnings).toEqual([]);

		const crop = proposeCropDetailed(rasters);
		expect(crop.insets).toEqual({ topPx: 4, rightPx: 0, bottomPx: 3, leftPx: 0 });
		expect(crop.confidence).toBe('high');
	});

	test('weak-but-recoverable fixture loads as review with a weak-overlap warning', () => {
		// Reduced 17.5% overlap: every pair still matches, but below the intended
		// 20-30% band, so the result must not claim strong.
		const weak = {
			'upper-left': { x: 0, y: 0 },
			'upper-right': { x: 165, y: 0 },
			'lower-left': { x: 0, y: 165 },
			'lower-right': { x: 165, y: 165 }
		};
		const rasters = rastersFor(weak);
		const layout = assignFour(rasters);
		const diagnostic = classifyLayout(layout, rasters);
		expect(diagnostic.category).toBe('review');
		expect(diagnostic.warnings.map((warning) => warning.kind)).toContain('weak-overlap');
	});

	test('incompatible fixture detects inconsistent steps as mixed zoom', () => {
		// Every pairwise match is credible and the lower-right paths reconcile,
		// but the lower-right tile is displaced 10px vertically, so the vertical
		// steps disagree -> the capture is not one coherent same-zoom 2×2.
		const incompatible = {
			'upper-left': { x: 0, y: 0 },
			'upper-right': { x: 150, y: 0 },
			'lower-left': { x: 0, y: 150 },
			'lower-right': { x: 150, y: 140 }
		};
		const rasters = rastersFor(incompatible);
		const layout = assignFour(rasters);
		expect(layout.steps.columnDeltaPx).toBeGreaterThan(8);

		const diagnostic = classifyLayout(layout, rasters);
		expect(diagnostic.category).toBe('uncertain');
		expect(diagnostic.warnings.map((warning) => warning.kind)).toContain('mixed-zoom');
	});

	test('a tile unrelated to the other three is surfaced, never trusted, and exposes the contradictory lower-right', () => {
		const rasters = rastersFor(null, { 'lower-right': { unrelated: true } });
		const layout = assignFour(rasters);
		const diagnostic = classifyLayout(layout, rasters);
		expect(diagnostic.category).toBe('uncertain');
		const kinds = diagnostic.warnings.map((warning) => warning.kind);
		expect(kinds).toContain('unrelated-tile');
		// The unrelated tile's garbage right-column/bottom-row estimates disagree
		// wildly, so the contradictory lower-right path is surfaced too.
		expect(kinds).toContain('contradictory-lower-right');
	});

	test('repeated imagery cannot receive a strong state even with high local scores', () => {
		// A periodic y-stripe field makes every horizontal translation equally
		// plausible, so the locally high matches are ambiguous.
		const repetitive = ALL_SLOTS.map((slot) =>
			buildGrayRaster(slot, { repetitive: true, chromeTop: 0, chromeBottom: 0 })
		);
		const layout = assignFour(repetitive);
		// One local edge is still a near-perfect match...
		expect(layout.edgeScores['upper-left>upper-right']).toBeGreaterThan(0.9);
		const diagnostic = classifyLayout(layout, repetitive);
		// ...yet the arrangement must not claim strong.
		expect(diagnostic.category).toBe('uncertain');
		expect(diagnostic.warnings.map((warning) => warning.kind)).toContain(
			'ambiguous-repeated-imagery'
		);
	});

	test('classification is deterministic for identical rasters and options', () => {
		const first = rastersFor(null);
		const second = rastersFor(null);
		const a = classifyLayout(assignFour(first), first);
		const b = classifyLayout(assignFour(second), second);
		expect(a).toEqual(b);
	});
});

describe('P1-002 crop-confidence hardening (assertions within case 1)', () => {
	test('crop confidence is high only when all four tiles agree on every proposed side', () => {
		const rasters = rastersFor(null);
		const crop = proposeCropDetailed(rasters);
		expect(crop.confidence).toBe('high');
		expect(crop.perSide.top).toEqual([4, 4, 4, 4]);
		expect(crop.perSide.bottom).toEqual([3, 3, 3, 3]);
	});

	test('partial edge evidence lowers crop confidence and drops the conflicting side', () => {
		const rasters = rastersFor(null, { 'lower-left': { chromeTop: 0 } });
		const crop = proposeCropDetailed(rasters);
		expect(crop.insets).toEqual({ topPx: 0, rightPx: 0, bottomPx: 3, leftPx: 0 });
		expect(crop.confidence).toBe('low');
	});

	test('uniform but content-like edge bands are never proposed as chrome', () => {
		// Each tile has an equally deep uniform top band, but with a different
		// luminance per tile: identical-looking chrome, no; natural content, yes.
		const rasters = rastersFor(null).map((raster, index) => {
			const gray = raster.gray.slice();
			const value = 20 + index * 25;
			for (let x = 0; x < raster.widthPx; x += 1) {
				gray[x] = value;
			}
			return { ...raster, gray };
		});
		const crop = proposeCropDetailed(rasters);
		expect(crop.insets).not.toBeNull();
		if (crop.insets) {
			expect(crop.insets.topPx).toBe(0);
		}
		expect(crop.confidence).toBe('low');
	});

	test('a capture with no shared band gets no crop proposal and absent confidence', () => {
		const rasters = rastersFor(null, {
			'upper-left': { chromeTop: 0, chromeBottom: 0 },
			'upper-right': { chromeTop: 0, chromeBottom: 0 },
			'lower-left': { chromeTop: 0, chromeBottom: 0 },
			'lower-right': { chromeTop: 0, chromeBottom: 0 }
		});
		const crop = proposeCropDetailed(rasters);
		expect(crop.insets).toBeNull();
		expect(crop.confidence).toBe('absent');
	});
});
