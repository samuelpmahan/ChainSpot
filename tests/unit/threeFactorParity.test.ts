// Frozen-behavior parity pin. The projection hash below was captured from
// the PRE-engine-refactor pipeline on a deterministic synthetic raster; the
// engine path must reproduce it exactly. If this test fails, behavior
// changed — that must be a conscious decision, not a side effect.
import { describe, expect, test } from 'vitest';
import { runThreeFactor } from '@chainspot/alg/detectors/threeFactor';
import { canonicalJson, sha256Hex } from '@chainspot/alg/detectors/threeFactor/hash';
import type { RgbaRaster } from '@chainspot/alg/detect';
import type { ThreeFactorRun } from '@chainspot/alg/detectors/threeFactor';

// Deterministic synthetic scene: bright background, one dark-digit badge
// box, a bright hollow tee ring, and a basket-ish blob — enough to push
// pixels through every stage without needing real corpus files.
function syntheticRaster(): RgbaRaster {
	const w = 160;
	const h = 220;
	const rgba = new Uint8ClampedArray(w * h * 4);
	const put = (x: number, y: number, v: number, sat = 0) => {
		const i = (y * w + x) * 4;
		rgba[i] = v;
		rgba[i + 1] = v;
		rgba[i + 2] = Math.max(0, v - sat);
		rgba[i + 3] = 255;
	};
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x, y, 120);
	// bright plate with dark interior "glyph" (badge-ish)
	for (let y = 30; y < 62; y++) for (let x = 40; x < 86; x++) put(x, y, 250);
	for (let y = 38; y < 54; y++) for (let x = 50; x < 58; x++) put(x, y, 20);
	for (let y = 38; y < 54; y++) for (let x = 66; x < 74; x++) put(x, y, 20);
	// hollow bright ring (tee-ish)
	for (let y = 120; y < 140; y++) {
		for (let x = 40; x < 64; x++) {
			const edge = y < 124 || y >= 136 || x < 44 || x >= 60;
			if (edge) put(x, y, 250);
		}
	}
	// bright blob (basket-ish)
	for (let y = 170; y < 200; y++) for (let x = 90; x < 112; x++) put(x, y, 250);
	return { imageId: 'f'.repeat(64), widthPx: w, heightPx: h, rgba };
}

/** Stable projection: everything semantic, nothing bulky (no masks/pixels). */
function projectRun(run: ThreeFactorRun) {
	const m = run.measurement;
	return {
		widthPx: m.widthPx,
		heightPx: m.heightPx,
		viewport: m.viewport,
		parameters: m.parameters,
		badges: m.badges.map((b) => ({
			detId: b.detId,
			cxPx: b.cxPx,
			cyPx: b.cyPx,
			bbox: b.bbox,
			source: b.source,
			label: b.label,
			labelCandidates: b.labelCandidates,
			confidence: b.confidence
		})),
		baskets: m.baskets,
		tees: m.tees.map((t) => ({ ...t, ring: t.ring ?? null })),
		rawPairs: m.rawPairs.map((p) => ({
			pairId: p.pairId,
			supportMean: p.supportMean,
			supportMin: p.supportMin,
			pathLengthPx: p.pathLengthPx,
			efficiency: p.efficiency,
			failureReason: p.failureReason
		})),
		scoredPairs: run.assignment.scoredPairs.map((s) => ({
			pairId: s.raw.pairId,
			score: s.score,
			rank: s.rank,
			factors: s.factors
		})),
		assignments: run.assignment.assignments
	};
}

describe('threeFactor frozen-behavior parity', () => {
	test('pinned projection hash on the synthetic scene', async () => {
		const run = runThreeFactor(syntheticRaster());
		const hash = await sha256Hex(canonicalJson(projectRun(run)));
		expect(hash).toBe('a0a1ac828ce98f89831210896e42aeee468a5527bfe5e752ffa5bf431095396c');
	});
});
