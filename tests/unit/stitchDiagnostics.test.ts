import { describe, expect, test } from 'vitest';
import { assignFour } from '../../src/lib/stitch/autoLayout';
import type { AutoLayout } from '../../src/lib/stitch/autoLayout';
import { classifyLayout } from '../../src/lib/stitch/diagnostics';
import { smartImportFiles } from '../../src/lib/stitch/smartImport';
import { buildGrayRaster } from '../helpers/smartMap';
import type { AnalysisRaster, PairEstimate } from '../../src/lib/stitch/analysis';
import type { TileSlot } from '../../src/lib/stitch/geometry';

const ALL_SLOTS: readonly TileSlot[] = ['upper-left', 'upper-right', 'lower-left', 'lower-right'];

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

function rastersFor(
	origins: Record<TileSlot, { x: number; y: number }> | null,
	extra: Partial<
		Record<TileSlot, { unrelated?: boolean; repetitive?: boolean; chromeTop?: number; chromeBottom?: number }>
	> = {}
): AnalysisRaster[] {
	// `assignFour` in production only ever sees matcher rasters built from the
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

/**
 * A minimal coherent layout whose only distinguishing feature is one edge's
 * wrong winning direction. `requiredEdgeScore` is how well that edge matches in
 * the orientation the 2×2 layout actually requires, which is what decides
 * whether the mismatch is worth telling anyone about.
 */
function layoutWithOneDirectionMismatch(requiredEdgeScore: number): AutoLayout {
	const directional = (
		orientation: 'left-right' | 'top-bottom',
		score: number
	): PairEstimate => ({
		orientation,
		dxPx: 0,
		dyPx: 0,
		score,
		overlapFractionPx: 0.25,
		runnerUpScore: 0
	});
	// upper-left>upper-right is expected left-right, but the top-bottom
	// hypothesis wins for that pair with a near-perfect score.
	const estimates = {
		'0>1': {
			'left-right': directional('left-right', requiredEdgeScore),
			'top-bottom': directional('top-bottom', 0.99),
			orientation: 'top-bottom' as const
		},
		'0>2': {
			'left-right': directional('left-right', 0.6),
			'top-bottom': directional('top-bottom', 0.99),
			orientation: 'top-bottom' as const
		},
		'1>3': {
			'left-right': directional('left-right', 0.6),
			'top-bottom': directional('top-bottom', 0.99),
			orientation: 'top-bottom' as const
		},
		'2>3': {
			'left-right': directional('left-right', 0.99),
			'top-bottom': directional('top-bottom', 0.6),
			orientation: 'left-right' as const
		}
	};
	return {
		assignment: {
			'upper-left': 0,
			'upper-right': 1,
			'lower-left': 2,
			'lower-right': 3
		},
		placements: {
			'upper-left': { xPx: 0, yPx: 0, visible: true },
			'upper-right': { xPx: 150, yPx: 0, visible: true },
			'lower-left': { xPx: 0, yPx: 150, visible: true },
			'lower-right': { xPx: 150, yPx: 150, visible: true }
		},
		score: 3.95,
		estimates
	};
}

describe('P1-002 confidence/consistency classification (case 1)', () => {
	// This one consolidated case runs several full 24-permutation analyses on
	// 200x200 rasters; under parallel unit-suite load it can exceed the default
	// 5s limit, so it declares its own generous timeout.
	test(
		'distinguishes ok from review layouts by correlation score alone, and never trusts a wrong direction',
		async () => {
		// The strong fixture classifies ok with no warnings.
		const strong = rastersFor(null);
		const strongDiagnostic = classifyLayout(await assignFour(strong));
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
		const weakDiagnostic = classifyLayout(await assignFour(weak));
		expect(weakDiagnostic.category).toBe('ok');
		expect(weakDiagnostic.warnings).toEqual([]);

		// A real hand-held capture never overlaps identically on every edge: here
		// lower-right is displaced 10px vertically relative to what a perfect
		// rectangle would predict (its two paths, via upper-right and via
		// lower-left, disagree by 10px). Every pairwise match is still credible
		// on its own, so this must classify ok, not review — irregular per-pair
		// overlap is normal, not a defect, and each tile is placed from its own
		// direct measurement rather than being pulled toward a rectangle.
		const irregular = rastersFor({
			'upper-left': { x: 0, y: 0 },
			'upper-right': { x: 150, y: 0 },
			'lower-left': { x: 0, y: 150 },
			'lower-right': { x: 150, y: 140 }
		});
		const irregularLayout = await assignFour(irregular);
		// Upper-right and lower-left are trusted exactly as measured; lower-right
		// lands on its true (irregular) position, not a rectangle-corrected one.
		expect(irregularLayout.placements['upper-right']).toEqual({ xPx: 150, yPx: 0, visible: true });
		expect(irregularLayout.placements['lower-left']).toEqual({ xPx: 0, yPx: 150, visible: true });
		expect(irregularLayout.placements['lower-right']).toEqual({ xPx: 150, yPx: 140, visible: true });
		const irregularDiagnostic = classifyLayout(irregularLayout);
		expect(irregularDiagnostic.category).toBe('ok');
		expect(irregularDiagnostic.warnings).toEqual([]);

		// A tile unrelated to the other three is surfaced and never trusted: its
		// two edges score far below `WEAK_EDGE_MAX_SCORE`, firing the one
		// surviving weak-neighbor-match warning and landing in review.
		const unrelatedRasters = rastersFor(null, { 'lower-right': { unrelated: true } });
		const unrelatedLayout = await assignFour(unrelatedRasters);
		const unrelatedDiagnostic = classifyLayout(unrelatedLayout);
		expect(unrelatedDiagnostic.category).toBe('review');
		expect(unrelatedDiagnostic.warnings.some((warning) => warning.includes('lower-right'))).toBe(
			true
		);

		// Repeated/periodic imagery (a y-invariant stripe field) is no longer its
		// own detected failure mode: the dedicated ambiguity signal (separation,
		// runner-up margin) was cut along with the rest of the re-tuned taxonomy,
		// leaving only the one correlation-score threshold. A periodic field still
		// scores near-perfect on every expected edge (score alone cannot tell a
		// confidently-placed genuine match from a confidently-placed ambiguous
		// one), so this now classifies ok — a known, accepted trade-off of relying
		// on a single physically-meaningful signal instead of a second taxonomy.
		const repetitive = ALL_SLOTS.map((slot) =>
			buildGrayRaster(slot, { repetitive: true, chromeTop: 0, chromeBottom: 0 })
		);
		const repetitiveLayout = await assignFour(repetitive);
		const a = repetitiveLayout.assignment;
		const repetitiveUlUrScore =
			repetitiveLayout.estimates[`${a['upper-left']}>${a['upper-right']}`]?.['left-right']?.score ?? 0;
		expect(repetitiveUlUrScore).toBeGreaterThan(0.9);
		const repetitiveDiagnostic = classifyLayout(repetitiveLayout);
		expect(repetitiveDiagnostic.category).toBe('ok');
		expect(repetitiveDiagnostic.warnings).toEqual([]);

		// Classification is deterministic for identical rasters and options.
		const first = rastersFor(null);
		const second = rastersFor(null);
		expect(classifyLayout(await assignFour(first))).toEqual(classifyLayout(await assignFour(second)));

		// A wrong winning direction on an edge that nevertheless matches strongly
		// in the orientation the layout requires is not reported. Generous
		// neighbor overlap is a supported capture style, and the more content two
		// tiles share, the more readily the losing hypothesis also explains that
		// shared region — so the careful user who overlapped most gets the tie,
		// and warning them would cost their confidence in a placement committed
		// from a near-perfect direct measurement they could not improve on.
		const overlappedDiagnostic = classifyLayout(layoutWithOneDirectionMismatch(0.98));
		expect(overlappedDiagnostic.category).toBe('ok');
		expect(overlappedDiagnostic.warnings).toEqual([]);

		// The same mismatch on an edge that is genuinely weak in the required
		// orientation is real, actionable evidence about why that edge is weak,
		// and is still reported alongside the weak-neighbor warning.
		const mismatchedDiagnostic = classifyLayout(layoutWithOneDirectionMismatch(0.2));
		expect(mismatchedDiagnostic.category).toBe('review');
		expect(
			mismatchedDiagnostic.warnings.some(
				(warning) => warning.startsWith('Direction mismatch') && warning.includes('upper-left')
			)
		).toBe(true);

		// The same "every edge ties/repeats" imagery (x-periodic stripes, constant
		// along y) that used to trip the dedicated ambiguity signal now also
		// classifies ok end-to-end through the real pipeline, for the same reason
		// as the synthetic `repetitive` case above: a y-invariant field lets both
		// orientation hypotheses reach a near-perfect score for every edge, and
		// with the ambiguity signal cut, a high score alone is trusted. The
		// narrower "wrong-direction-actually-wins" mechanism itself is still
		// covered directly, independent of matcher behavior, by
		// `layoutWithOneDirectionMismatch()` above.
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
		const pipelineLayout = await assignFour(xStripes);
		expect(pipelineLayout.score).toBeGreaterThan(3.9);
		const pipelineDiagnostic = classifyLayout(pipelineLayout);
		expect(pipelineDiagnostic.category).toBe('ok');
		expect(pipelineDiagnostic.warnings).toEqual([]);

		// Crop evidence is independent of layout confidence (the coupling was
		// cut along with the `uncertain` category it gated on): whatever crop
		// evidence `autoCrop.ts` finds is surfaced as-is regardless of the
		// layout diagnostic. These rasters overlap by only 4%, yet every expected
		// edge still matches strongly in its required orientation, so the layout
		// classifies ok — consistent with overlap fraction having been cut as its
		// own signal (see the 17.5% case above). What this case demonstrates is
		// that the crop proposal is computed and gated purely on its own
		// evidence: identical rasters, opposite crop outcomes, same layout.
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
});
