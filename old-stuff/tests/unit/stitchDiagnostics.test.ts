import { describe, expect, test } from 'vitest';
import { assignN } from '../../src/lib/stitch/autoLayout';
import type { AutoLayout, PlacementEdge } from '../../src/lib/stitch/autoLayout';
import { classifyLayout } from '../../src/lib/stitch/diagnostics';
import { smartImportFiles } from '../../src/lib/stitch/smartImport';
import { buildGrayRaster } from '../helpers/smartMap';
import type { AnalysisRaster } from '../../src/lib/stitch/analysis';

// Fixture labels only — `buildGrayRaster` uses these purely to pick default
// synthetic-content origins; they have no relationship to `assignN`'s own
// (dynamic, index-based) output slot ids.
const ALL_SLOTS = ['upper-left', 'upper-right', 'lower-left', 'lower-right'] as const;

function fileOf(name: string): File {
	return new File([new Uint8Array(8).fill(1)], name, { type: 'image/png' });
}

function decodedOf(widthPx: number, heightPx: number) {
	return {
		image: {} as HTMLImageElement,
		widthPx,
		heightPx
	};
}

type Slot2x2 = (typeof ALL_SLOTS)[number];

function rastersFor(
	origins: Record<Slot2x2, { x: number; y: number }> | null,
	extra: Partial<
		Record<Slot2x2, { unrelated?: boolean; repetitive?: boolean; chromeTop?: number; chromeBottom?: number }>
	> = {}
): AnalysisRaster[] {
	// `assignN` in production only ever sees matcher rasters built from the
	// cropped interior (see smartImport.ts's matcherRegionFromCrop), so these
	// fixtures must be chrome-free by default too. The identical chrome band on
	// every tile carries no positional information but is a strong dark outlier
	// that distorts normalized cross-correlation scores (see smartImport.test.ts
	// for the same fix). Per-slot `extra` overrides still win when a test
	// deliberately wants chrome present.
	return ALL_SLOTS.map((slot) =>
		buildGrayRaster(slot, { chromeTop: 0, chromeBottom: 0, ...extra[slot], origin: origins ? origins[slot] : undefined })
	);
}

/** The output slot id assigned to raster index `fileIndex`, in a resolved `AutoLayout`. */
function slotForIndex(layout: AutoLayout, fileIndex: number): string {
	const entry = Object.entries(layout.assignment).find(([, index]) => index === fileIndex);
	if (!entry) throw new Error(`no slot assigned to raster index ${fileIndex}`);
	return entry[0];
}

function edge(from: string, to: string, score: number): PlacementEdge {
	return { from, to, orientation: 'left-right', score, dxPx: 150, dyPx: 0 };
}

describe('P1-002 confidence/consistency classification (case 1)', () => {
	// This one consolidated case runs several full pairwise analyses on 200x200
	// rasters; under parallel unit-suite load it can exceed the default 5s
	// limit, so it declares its own generous timeout.
	test(
		'distinguishes ok from review layouts by correlation score alone',
		async () => {
			// The strong fixture classifies ok with no warnings.
			const strong = rastersFor(null);
			const strongDiagnostic = classifyLayout(await assignN(strong));
			expect(strongDiagnostic.category).toBe('ok');
			expect(strongDiagnostic.warnings).toEqual([]);

			// Reduced 17.5% overlap: every pair still matches well above
			// `WEAK_EDGE_MAX_SCORE`, and overlap fraction is no longer its own signal
			// (cut deliberately — one correlation-score threshold is enough), so this
			// classifies ok too: reduced-but-real overlap is not itself a defect.
			const weak = rastersFor({
				'upper-left': { x: 0, y: 0 },
				'upper-right': { x: 165, y: 0 },
				'lower-left': { x: 0, y: 165 },
				'lower-right': { x: 165, y: 165 }
			});
			const weakDiagnostic = classifyLayout(await assignN(weak));
			expect(weakDiagnostic.category).toBe('ok');
			expect(weakDiagnostic.warnings).toEqual([]);

			// A real hand-held capture never overlaps identically on every edge: here
			// the fourth tile is displaced 10px vertically relative to what a perfect
			// rectangle would predict. Every pairwise match is still credible on its
			// own, so this must classify ok, not review — irregular per-pair overlap
			// is normal, not a defect.
			const irregular = rastersFor({
				'upper-left': { x: 0, y: 0 },
				'upper-right': { x: 150, y: 0 },
				'lower-left': { x: 0, y: 150 },
				'lower-right': { x: 150, y: 140 }
			});
			const irregularLayout = await assignN(irregular);
			const irregularDiagnostic = classifyLayout(irregularLayout);
			expect(irregularDiagnostic.category).toBe('ok');
			expect(irregularDiagnostic.warnings).toEqual([]);

			// A tile unrelated to the other three is surfaced and never trusted: its
			// edges score far below `WEAK_EDGE_MAX_SCORE`, firing the weak-neighbor-
			// match warning (naming whichever slot the arrangement placed it at) and
			// landing in review.
			const unrelatedIndex = ALL_SLOTS.indexOf('lower-right');
			const unrelatedRasters = rastersFor(null, { 'lower-right': { unrelated: true } });
			const unrelatedLayout = await assignN(unrelatedRasters);
			const unrelatedDiagnostic = classifyLayout(unrelatedLayout);
			expect(unrelatedDiagnostic.category).toBe('review');
			const unrelatedSlot = slotForIndex(unrelatedLayout, unrelatedIndex);
			expect(unrelatedDiagnostic.warnings.some((warning) => warning.includes(unrelatedSlot))).toBe(
				true
			);

			// Repeated/periodic imagery (a y-invariant stripe field) still scores
			// near-perfect on every expected edge (score alone cannot tell a
			// confidently-placed genuine match from a confidently-placed ambiguous
			// one), so this classifies ok — a known, accepted trade-off of relying on
			// a single physically-meaningful signal instead of a second taxonomy.
			const repetitive = ALL_SLOTS.map((slot) =>
				buildGrayRaster(slot, { repetitive: true, chromeTop: 0, chromeBottom: 0 })
			);
			const repetitiveLayout = await assignN(repetitive);
			expect(repetitiveLayout.placementEdges.every((e) => e.score > 0.9)).toBe(true);
			const repetitiveDiagnostic = classifyLayout(repetitiveLayout);
			expect(repetitiveDiagnostic.category).toBe('ok');
			expect(repetitiveDiagnostic.warnings).toEqual([]);

			// Classification is deterministic for identical rasters and options.
			const first = rastersFor(null);
			const second = rastersFor(null);
			expect(classifyLayout(await assignN(first))).toEqual(classifyLayout(await assignN(second)));

			// The same "every edge ties/repeats" imagery (x-periodic stripes, constant
			// along y) also classifies ok end-to-end through the real pipeline, for
			// the same reason as the synthetic `repetitive` case above.
			const xStripes = ALL_SLOTS.map((slot) => {
				const raster = buildGrayRaster(slot, { chromeTop: 0, chromeBottom: 0 });
				const gray = new Uint8Array(raster.gray.length);
				for (let y = 0; y < raster.heightPx; y += 1) {
					for (let x = 0; x < raster.widthPx; x += 1) {
						gray[y * raster.widthPx + x] = Math.floor(x / 40) % 2 === 0 ? 120 : 225;
					}
				}
				return { ...raster, gray };
			});
			const pipelineLayout = await assignN(xStripes);
			expect(pipelineLayout.score).toBeGreaterThan(3 * 0.9);
			const pipelineDiagnostic = classifyLayout(pipelineLayout);
			expect(pipelineDiagnostic.category).toBe('ok');
			expect(pipelineDiagnostic.warnings).toEqual([]);

			// Crop evidence is independent of layout confidence: whatever crop
			// evidence `autoCrop.ts` finds is surfaced as-is regardless of the layout
			// diagnostic. These rasters overlap by only 4%, yet every expected edge
			// still matches strongly, so the layout classifies ok — consistent with
			// overlap fraction having been cut as its own signal (see the 17.5% case
			// above). What this case demonstrates is that the crop proposal is
			// computed and gated purely on its own evidence: identical rasters,
			// opposite crop outcomes, same layout.
			const uncertainOrigins = {
				'upper-left': { x: 0, y: 0 },
				'upper-right': { x: 192, y: 0 },
				'lower-left': { x: 0, y: 192 },
				'lower-right': { x: 192, y: 192 }
			};
			const files = ['a.png', 'b.png', 'c.png', 'd.png'].map((name) => fileOf(name));
			const importWith = async (rasters: AnalysisRaster[]) => {
				let index = 0;
				return smartImportFiles(files, {
					decode: async () => decodedOf(200, 200),
					// This case exercises the raw detected boundary, not the separate
					// safety-margin feature.
					applyCropMargin: false,
					buildRaster: () => rasters[index++ % rasters.length],
					buildCropRaster: () => rasters[index++ % rasters.length]
				});
			};
			// Weak/no shared chrome: crop evidence is absent, regardless of layout.
			const weakCrop = await importWith(
				ALL_SLOTS.map((slot) =>
					buildGrayRaster(slot, {
						origin: uncertainOrigins[slot],
						chromeTop: 0,
						chromeBottom: 0
					})
				)
			);
			if (!weakCrop.ok) throw new Error('expected a successful import');
			expect(weakCrop.diagnostic.category).toBe('ok');
			expect(weakCrop.cropProposal).toBeNull();
			expect(weakCrop.crop.confidence).toBe('absent');

			// Independently strong crop evidence (shared chrome): the proposal is
			// shown regardless of the layout diagnostic's own category.
			const strongCrop = await importWith(
				ALL_SLOTS.map((slot) => buildGrayRaster(slot, { origin: uncertainOrigins[slot] }))
			);
			if (!strongCrop.ok) throw new Error('expected a successful import');
			expect(strongCrop.diagnostic.category).toBe('ok');
			expect(strongCrop.cropProposal).toEqual({ topPx: 4, rightPx: 0, bottomPx: 3, leftPx: 0 });
			expect(strongCrop.crop.confidence).toBe('high');
		},
		40000
	);

	// `assignN` no longer assumes a fixed topology, so there is no longer a
	// "required orientation" a winning hypothesis can point away from — the
	// old direction-mismatch diagnostic was retired for exactly this reason
	// (see diagnostics.ts's module doc comment). `classifyLayout`'s contract is
	// now just "any placement edge scoring below WEAK_EDGE_MAX_SCORE warns and
	// lands in review" — exercised directly here against hand-built edges,
	// independent of the matcher.
	test('classifies directly from placementEdges: any weak edge warns and lands in review', () => {
		const strongOnly: AutoLayout = {
			order: ['tile-0', 'tile-1', 'tile-2'],
			assignment: { 'tile-0': 0, 'tile-1': 1, 'tile-2': 2 },
			placements: {},
			neighbors: {},
			placementEdges: [edge('tile-0', 'tile-1', 0.97), edge('tile-0', 'tile-2', 0.95)],
			score: 1.92,
			estimates: {}
		};
		const strongDiagnostic = classifyLayout(strongOnly);
		expect(strongDiagnostic.category).toBe('ok');
		expect(strongDiagnostic.warnings).toEqual([]);

		const oneWeak: AutoLayout = {
			...strongOnly,
			placementEdges: [edge('tile-0', 'tile-1', 0.97), edge('tile-0', 'tile-2', 0.03)]
		};
		const weakDiagnostic = classifyLayout(oneWeak);
		expect(weakDiagnostic.category).toBe('review');
		expect(
			weakDiagnostic.warnings.some(
				(warning) => warning.startsWith('Weak neighbor match') && warning.includes('tile-0–tile-2')
			)
		).toBe(true);
	});
});
