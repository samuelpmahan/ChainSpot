import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { describe, expect, test } from 'vitest';
import type { AnalysisRaster, PairOrientation } from '../../src/lib/stitch/analysis';
import { loadCv, matchTranslation } from '../../src/lib/stitch/cvMatch';
import {
	renderSemanticLandmarkOverlaySvg,
	renderSemanticTranslationOverlaySvg
} from '../../src/lib/stitch/semanticDiagnostics';
import {
	detectSemanticLandmarkBatch,
	type SemanticLandmark,
	type SemanticRaster,
	type SemanticSourceLandmarks
} from '../../src/lib/stitch/semanticLandmarks';
import { voteSemanticTranslation } from '../../src/lib/stitch/semanticTranslation';
import {
	available,
	loadCroppedTiles,
	REAL_CAPTURE_CROP,
	REAL_CAPTURE_FILES,
	REAL_CAPTURE_GROUND_TRUTH
} from '../helpers/realCapture.js';

type Slot2x2 = 'upper-left' | 'upper-right' | 'lower-left' | 'lower-right';
type EdgeKey = keyof typeof REAL_CAPTURE_GROUND_TRUTH.edges;

interface EdgeSpec {
	readonly key: EdgeKey;
	readonly a: Slot2x2;
	readonly b: Slot2x2;
	readonly orientation: PairOrientation;
}

const EDGE_SPECS: readonly EdgeSpec[] = [
	{ key: 'upper-left>upper-right', a: 'upper-left', b: 'upper-right', orientation: 'left-right' },
	{ key: 'lower-left>lower-right', a: 'lower-left', b: 'lower-right', orientation: 'left-right' },
	{ key: 'upper-left>lower-left', a: 'upper-left', b: 'lower-left', orientation: 'top-bottom' },
	{ key: 'upper-right>lower-right', a: 'upper-right', b: 'lower-right', orientation: 'top-bottom' }
];

const captureDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'real-capture');
const MATCH_TOLERANCE_PX = 4;

function nowMs(): number {
	return typeof performance !== 'undefined' && typeof performance.now === 'function'
		? performance.now()
		: Date.now();
}

function loadCroppedSemanticRaster(slot: Slot2x2): SemanticRaster {
	const png = PNG.sync.read(readFileSync(join(captureDir, REAL_CAPTURE_FILES[slot])));
	const widthPx = png.width - REAL_CAPTURE_CROP.leftPx - REAL_CAPTURE_CROP.rightPx;
	const heightPx = png.height - REAL_CAPTURE_CROP.topPx - REAL_CAPTURE_CROP.bottomPx;
	const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
	for (let y = 0; y < heightPx; y += 1) {
		const srcOffset = ((y + REAL_CAPTURE_CROP.topPx) * png.width + REAL_CAPTURE_CROP.leftPx) * 4;
		const dstOffset = y * widthPx * 4;
		rgba.set(png.data.subarray(srcOffset, srcOffset + widthPx * 4), dstOffset);
	}
	return { sourceId: slot, widthPx, heightPx, rgba };
}

function sourceById(
	sources: readonly SemanticSourceLandmarks[],
	sourceId: Slot2x2
): SemanticSourceLandmarks {
	const source = sources.find((candidate) => candidate.sourceId === sourceId);
	if (!source) throw new Error(`missing semantic source ${sourceId}`);
	return source;
}

interface TruthMatch {
	readonly a: SemanticLandmark;
	readonly b: SemanticLandmark;
	readonly residualPx: number;
}

function truthMatches(
	a: SemanticSourceLandmarks,
	b: SemanticSourceLandmarks,
	dxPx: number,
	dyPx: number,
	tolerancePx = MATCH_TOLERANCE_PX
): TruthMatch[] {
	const candidates: TruthMatch[] = [];
	for (const landmarkA of a.landmarks) {
		for (const landmarkB of b.landmarks) {
			if (landmarkA.family !== landmarkB.family) continue;
			const residualPx = Math.hypot(
				landmarkA.xPx - (landmarkB.xPx + dxPx),
				landmarkA.yPx - (landmarkB.yPx + dyPx)
			);
			if (residualPx <= tolerancePx) candidates.push({ a: landmarkA, b: landmarkB, residualPx });
		}
	}
	candidates.sort((left, right) => left.residualPx - right.residualPx);
	const usedA = new Set<SemanticLandmark>();
	const usedB = new Set<SemanticLandmark>();
	const matches: TruthMatch[] = [];
	for (const candidate of candidates) {
		if (usedA.has(candidate.a) || usedB.has(candidate.b)) continue;
		usedA.add(candidate.a);
		usedB.add(candidate.b);
		matches.push(candidate);
	}
	return matches;
}

function inBounds(xPx: number, yPx: number, source: SemanticSourceLandmarks): boolean {
	return xPx >= 0 && yPx >= 0 && xPx < source.widthPx && yPx < source.heightPx;
}

function mismatchInventory(
	a: SemanticSourceLandmarks,
	b: SemanticSourceLandmarks,
	dxPx: number,
	dyPx: number,
	matches: readonly TruthMatch[]
): {
	readonly aVisibleInB: number;
	readonly aMissingInB: number;
	readonly bVisibleInA: number;
	readonly bMissingInA: number;
} {
	const matchedA = new Set(matches.map((match) => match.a));
	const matchedB = new Set(matches.map((match) => match.b));
	const visibleA = a.landmarks.filter((landmark) => inBounds(landmark.xPx - dxPx, landmark.yPx - dyPx, b));
	const visibleB = b.landmarks.filter((landmark) => inBounds(landmark.xPx + dxPx, landmark.yPx + dyPx, a));
	return {
		aVisibleInB: visibleA.length,
		aMissingInB: visibleA.filter((landmark) => !matchedA.has(landmark)).length,
		bVisibleInA: visibleB.length,
		bMissingInA: visibleB.filter((landmark) => !matchedB.has(landmark)).length
	};
}

function writeCroppedPng(path: string, raster: SemanticRaster): void {
	const png = new PNG({ width: raster.widthPx, height: raster.heightPx });
	png.data.set(raster.rgba);
	writeFileSync(path, PNG.sync.write(png));
}

function maxAxisError(actual: { dxPx: number; dyPx: number }, expected: { dxPx: number; dyPx: number }): number {
	return Math.max(Math.abs(actual.dxPx - expected.dxPx), Math.abs(actual.dyPx - expected.dyPx));
}

describe.skipIf(!available())('semantic stitch real-capture benchmark', () => {
	test(
		'records landmark inventory, semantic-vs-OpenCV transforms, timing, and diagnostic overlays',
		async () => {
			const semanticRasters = (Object.keys(REAL_CAPTURE_FILES) as Slot2x2[]).map(loadCroppedSemanticRaster);
			const batch = detectSemanticLandmarkBatch(semanticRasters);
			const grayTiles = loadCroppedTiles() as Record<Slot2x2, Omit<AnalysisRaster, 'scale'>>;

			const landmarkInventory = batch.sources.map((source) => ({
				sourceId: source.sourceId,
				badges: source.landmarks.filter((landmark) => landmark.family === 'badge').length,
				baskets: source.landmarks.filter((landmark) => landmark.family === 'basket').length,
				total: source.landmarks.length
			}));

			const cvWarmStarted = nowMs();
			await loadCv();
			const cvWarmMs = nowMs() - cvWarmStarted;
			const rows = [];
			const edgeDiagnostics = [];

			for (const spec of EDGE_SPECS) {
				const a = sourceById(batch.sources, spec.a);
				const b = sourceById(batch.sources, spec.b);
				const truth = REAL_CAPTURE_GROUND_TRUTH.edges[spec.key];
				const independentMatches = truthMatches(a, b, truth.dxPx, truth.dyPx);
				const mismatch = mismatchInventory(a, b, truth.dxPx, truth.dyPx, independentMatches);
				const semantic = voteSemanticTranslation(a, b);

				const cvStarted = nowMs();
				const cv = await matchTranslation(
					{ ...grayTiles[spec.a], scale: 1 },
					{ ...grayTiles[spec.b], scale: 1 },
					spec.orientation
				);
				const cvElapsedMs = nowMs() - cvStarted;

				rows.push({
					edge: spec.key,
					truthDxPx: truth.dxPx,
					truthDyPx: truth.dyPx,
					sharedTruthConsistentDetections: independentMatches.length,
					semanticOk: semantic.ok,
					semanticDxPx: semantic.translation?.dxPx ?? null,
					semanticDyPx: semantic.translation?.dyPx ?? null,
					semanticMaxAxisErrorPx: semantic.translation ? maxAxisError(semantic.translation, truth) : null,
					semanticInliers: semantic.winner?.inlierCount ?? 0,
					semanticFamilies: semantic.winner?.families ?? [],
					semanticRmsResidualPx: semantic.winner?.rmsResidualPx ?? null,
					semanticAmbiguityMargin: semantic.ambiguityMargin,
					semanticReason: semantic.reason,
					semanticElapsedMs: semantic.elapsedMs,
					cvDxPx: cv.dxPx,
					cvDyPx: cv.dyPx,
					cvMaxAxisErrorPx: maxAxisError(cv, truth),
					cvScore: cv.score,
					cvElapsedMs
				});
				edgeDiagnostics.push({ edge: spec.key, ...mismatch });
			}

			const summary = {
				landmarkLocalizationMs: batch.diagnostics.elapsedMs,
				cvWarmMs,
				scales: batch.scales,
				landmarkInventory,
				edgeDiagnostics,
				rows,
				truthLimitation:
					'The repository has transform ground truth for this capture but no independent per-sprite badge/basket truth. Cross-capture misses therefore inventory detector disagreement, not uniquely labeled FP versus FN.'
			};

			console.log('[semantic-real-capture-summary]', JSON.stringify(summary, null, 2));

			const outputDir = process.env.SEMANTIC_STITCH_ARTIFACT_DIR;
			if (outputDir) {
				mkdirSync(outputDir, { recursive: true });
				for (const raster of semanticRasters) {
					const source = sourceById(batch.sources, raster.sourceId as Slot2x2);
					const pngName = `${raster.sourceId}.png`;
					writeCroppedPng(join(outputDir, pngName), raster);
					writeFileSync(
						join(outputDir, `${raster.sourceId}-landmarks.svg`),
						renderSemanticLandmarkOverlaySvg(source, { backgroundHref: pngName, label: raster.sourceId })
					);
				}
				for (const spec of EDGE_SPECS) {
					const a = sourceById(batch.sources, spec.a);
					const b = sourceById(batch.sources, spec.b);
					const semantic = voteSemanticTranslation(a, b);
					writeFileSync(
						join(outputDir, `${spec.a}__${spec.b}-translation.svg`),
						renderSemanticTranslationOverlaySvg(a, semantic, {
							backgroundHref: `${spec.a}.png`,
							label: spec.key
						})
					);
				}
				writeFileSync(join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
			}

			expect(batch.sources).toHaveLength(4);
			expect(landmarkInventory.reduce((sum, source) => sum + source.total, 0)).toBeGreaterThan(0);
			for (const row of rows) expect(row.cvMaxAxisErrorPx).toBeLessThanOrEqual(MATCH_TOLERANCE_PX);
		},
		120000
	);
});
