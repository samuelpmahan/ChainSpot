import { describe, expect, it, vi } from 'vitest';
import type { AnalysisRaster } from '../../src/lib/stitch/analysis';
import type { TranslationMatch } from '../../src/lib/stitch/cvMatch';
import {
	verifySemanticPoseSeed,
	type SemanticPoseSeed
} from '../../src/lib/stitch/semanticPoseVerification';

const raster = (): AnalysisRaster => ({
	widthPx: 100,
	heightPx: 100,
	gray: new Uint8Array(100 * 100),
	scale: 1
});

const seed: SemanticPoseSeed = {
	aIndex: 0,
	bIndex: 1,
	orientation: 'left-right',
	dxPx: 76,
	dyPx: -4,
	confidence: 0.93,
	seedId: 'fixture-pair-0-1'
};

const match = (score: number, dxPx = 76, dyPx = -4): TranslationMatch => ({
	dxPx,
	dyPx,
	score,
	runnerUpScore: -1,
	overlapFraction: 0.24
});

describe('verifySemanticPoseSeed', () => {
	it('uses one local OpenCV verification and completely skips the global search when the seed is supported', async () => {
		const near = vi.fn(async () => match(0.94, 77, -3));
		const fallback = vi.fn(async () => ({ expensive: true }));
		const ticks = [10, 13];

		const result = await verifySemanticPoseSeed([raster(), raster()], seed, fallback, {
			matchNear: near,
			minScore: 0.85,
			radiusPx: 40,
			now: () => ticks.shift() ?? 13
		});

		expect(result.path).toBe('semantic-local');
		expect(near).toHaveBeenCalledOnce();
		expect(near).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'left-right', 76, -4, 40);
		expect(fallback).not.toHaveBeenCalled();
		if (result.path === 'semantic-local') {
			expect(result.match).toEqual(match(0.94, 77, -3));
			expect(result.timing).toEqual({ localVerifyMs: 3, fallbackMs: 0, totalMs: 3 });
		}
	});

	it('falls back to the caller-owned global search when local evidence is weak and exposes both costs', async () => {
		const near = vi.fn(async () => match(0.41));
		const fallback = vi.fn(async () => ({ chosen: 'legacy-four-way-pair-search' as const }));
		const ticks = [100, 104, 104, 119];

		const result = await verifySemanticPoseSeed([raster(), raster()], seed, fallback, {
			matchNear: near,
			minScore: 0.85,
			now: () => ticks.shift() ?? 119
		});

		expect(result.path).toBe('opencv-global-fallback');
		expect(fallback).toHaveBeenCalledOnce();
		if (result.path === 'opencv-global-fallback') {
			expect(result.localMatch.score).toBe(0.41);
			expect(result.fallback.chosen).toBe('legacy-four-way-pair-search');
			expect(result.timing).toEqual({ localVerifyMs: 4, fallbackMs: 15, totalMs: 19 });
		}
	});

	it('does not let upstream confidence bypass image evidence', async () => {
		const highConfidenceSeed = { ...seed, confidence: 0.999 };
		const fallback = vi.fn(async () => 'fallback');
		const result = await verifySemanticPoseSeed([raster(), raster()], highConfidenceSeed, fallback, {
			matchNear: async () => match(0.2),
			now: () => 0
		});
		expect(result.path).toBe('opencv-global-fallback');
		expect(fallback).toHaveBeenCalledOnce();
	});
});
