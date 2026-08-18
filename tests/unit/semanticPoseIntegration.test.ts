import { describe, expect, test, vi } from 'vitest';
import { buildPoseGraph } from '../../src/lib/stitch/poseGraph';
import type { AnalysisRaster } from '../../src/lib/stitch/analysis';
import type { SemanticLandmark, SemanticSourceLandmarks } from '../../src/lib/stitch/semanticLandmarks';
import { buildGrayRaster, STEP } from '../helpers/smartMap';

function blankRaster(): AnalysisRaster {
	return { widthPx: 1000, heightPx: 1000, gray: new Uint8Array(1000 * 1000), scale: 1 };
}

function landmark(
	sourceId: string,
	family: 'badge' | 'basket',
	xPx: number,
	yPx: number
): SemanticLandmark {
	return { sourceId, family, xPx, yPx, widthPx: 40, heightPx: 30, areaPx: 800, fill: 2 / 3 };
}

function translatedSource(sourceId: string, dxPx: number, dyPx: number): SemanticSourceLandmarks {
	const world = [
		['badge', 100, 100],
		['basket', 400, 500],
		['badge', 700, 200]
	] as const;
	return {
		sourceId,
		widthPx: 1000,
		heightPx: 1000,
		landmarks: world.map(([family, xPx, yPx]) =>
			landmark(sourceId, family, xPx - dxPx, yPx - dyPx)
		)
	};
}

describe('poseGraph semantic-first integration', () => {
	test('strong independent semantic overlap uses one local full-resolution verification and skips global search', async () => {
		const matchNear = vi.fn(async () => ({
			dxPx: 20,
			dyPx: -30,
			score: 0.97,
			runnerUpScore: -1,
			overlapFraction: 0.5
		}));
		const result = await buildPoseGraph([blankRaster(), blankRaster()], {
			semanticSources: [translatedSource('a', 0, 0), translatedSource('b', 20, -30)],
			semanticVerification: { matchNear, now: () => 0 }
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(matchNear).toHaveBeenCalledOnce();
		expect(result.pairDiagnostics).toHaveLength(1);
		expect(result.pairDiagnostics[0]).toMatchObject({
			path: 'semantic-local-verify',
			correspondenceCount: 3,
			familyDiversity: 2,
			rmsTranslationResidualPx: 0,
			transformModel: 'translation'
		});
		expect(result.placementEdges[0].path).toBe('semantic-local-verify');
		expect(result.placementEdges[0].model).toBe('translation');
	});

	test('one shared landmark remains a hypothesis and the existing global matcher places the pair', async () => {
		const noChrome = { chromeTop: 0, chromeBottom: 0 };
		const rasters = [
			buildGrayRaster('upper-left', { ...noChrome, origin: { x: 0, y: 0 } }),
			buildGrayRaster('upper-right', { ...noChrome, origin: { x: STEP, y: 0 } })
		];
		const semanticSources: SemanticSourceLandmarks[] = [
			{
				sourceId: 'a',
				widthPx: rasters[0].widthPx,
				heightPx: rasters[0].heightPx,
				landmarks: [landmark('a', 'badge', 100, 100)]
			},
			{
				sourceId: 'b',
				widthPx: rasters[1].widthPx,
				heightPx: rasters[1].heightPx,
				landmarks: [landmark('b', 'badge', 80, 100)]
			}
		];

		const result = await buildPoseGraph(rasters, { semanticSources });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.pairDiagnostics[0].path).toBe('global-fallback');
		expect(result.pairDiagnostics[0].reason).toContain('insufficient-independent-support');
		expect(result.placementEdges[0].path).toBe('global-fallback');
	});
});
