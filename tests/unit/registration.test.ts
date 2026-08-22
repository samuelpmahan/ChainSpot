import { describe, expect, it } from 'vitest';
import {
	applySimilarity,
	fitSimilarity,
	matchByHoleNumber,
	type RegistrationPair
} from '$lib/registration';

function makePairs(
	scale: number,
	rotationRad: number,
	tx: number,
	ty: number,
	from: readonly { xPx: number; yPx: number }[]
): RegistrationPair[] {
	const cos = Math.cos(rotationRad) * scale;
	const sin = Math.sin(rotationRad) * scale;
	return from.map((f) => ({
		from: f,
		to: { xPx: cos * f.xPx - sin * f.yPx + tx, yPx: sin * f.xPx + cos * f.yPx + ty }
	}));
}

describe('fitSimilarity', () => {
	it('recovers a known scale/rotation/translation exactly', () => {
		const pairs = makePairs(1.5, 0.3, 40, -25, [
			{ xPx: 10, yPx: 20 },
			{ xPx: 200, yPx: 50 },
			{ xPx: 90, yPx: 300 }
		]);
		const t = fitSimilarity(pairs);
		expect(t).not.toBeNull();
		if (!t) return;
		expect(t.scale).toBeCloseTo(1.5, 6);
		expect(t.rotationRad).toBeCloseTo(0.3, 6);
		expect(t.translate.x).toBeCloseTo(40, 6);
		expect(t.translate.y).toBeCloseTo(-25, 6);

		// round-trips every input point
		for (const p of pairs) {
			const mapped = applySimilarity(t, p.from);
			expect(mapped.xPx).toBeCloseTo(p.to.xPx, 6);
			expect(mapped.yPx).toBeCloseTo(p.to.yPx, 6);
		}
	});

	it('fits least-squares through noisy pairs', () => {
		const clean = makePairs(2, -0.1, 5, 8, [
			{ xPx: 0, yPx: 0 },
			{ xPx: 100, yPx: 0 },
			{ xPx: 0, yPx: 100 },
			{ xPx: 100, yPx: 100 }
		]);
		const noisy = clean.map((p, i) => ({
			from: p.from,
			to: { xPx: p.to.xPx + (i % 2 === 0 ? 0.5 : -0.5), yPx: p.to.yPx }
		}));
		const t = fitSimilarity(noisy);
		expect(t).not.toBeNull();
		if (!t) return;
		expect(t.scale).toBeCloseTo(2, 2);
		expect(t.rotationRad).toBeCloseTo(-0.1, 2);
	});

	it('returns null on degenerate input', () => {
		expect(fitSimilarity([])).toBeNull();
		expect(fitSimilarity([{ from: { xPx: 1, yPx: 1 }, to: { xPx: 2, yPx: 2 } }])).toBeNull();
		// coincident from-points carry no shape information
		expect(
			fitSimilarity([
				{ from: { xPx: 5, yPx: 5 }, to: { xPx: 0, yPx: 0 } },
				{ from: { xPx: 5, yPx: 5 }, to: { xPx: 10, yPx: 10 } }
			])
		).toBeNull();
	});
});

describe('matchByHoleNumber', () => {
	it('pairs unique numbers and drops ambiguous duplicates', () => {
		const round = [
			{ n: 1, xPx: 10, yPx: 10 },
			{ n: 2, xPx: 20, yPx: 20 },
			{ n: 3, xPx: 30, yPx: 30 },
			{ n: 3, xPx: 31, yPx: 31 } // duplicate on the round side → dropped
		];
		const composite = [
			{ n: 1, xPx: 110, yPx: 110 },
			{ n: 2, xPx: 120, yPx: 120 },
			{ n: 3, xPx: 130, yPx: 130 },
			{ n: 4, xPx: 140, yPx: 140 } // no counterpart → ignored
		];
		const pairs = matchByHoleNumber(round, composite);
		expect(pairs).toHaveLength(2);
		expect(pairs.map((p) => p.to.xPx).sort()).toEqual([110, 120]);
	});
});
