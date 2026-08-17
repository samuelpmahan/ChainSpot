import { describe, expect, it } from 'vitest';
import { estimateSimilarity } from '../../src/lib/alignment/similarity';
import { estimateAffine } from '../../src/lib/alignment/affine';
import { calculateResiduals } from '../../src/lib/alignment/residuals';
import { applyTransform, invertTransform } from '../../src/lib/alignment/transform';
import { validateTransform } from '../../src/lib/alignment/validation';
import { AlignmentFailureReason } from '../../src/lib/alignment/types';
import type { AlignmentPairInput, SerializableTransform } from '../../src/lib/alignment/types';

function pair(
	id: string,
	sourceX: number,
	sourceY: number,
	targetX: number,
	targetY: number,
	enabled = true
): AlignmentPairInput {
	return { id, enabled, source: { xPx: sourceX, yPx: sourceY }, target: { xPx: targetX, yPx: targetY } };
}

function incomplete(id: string, sourceX: number, sourceY: number, enabled = true): AlignmentPairInput {
	return { id, enabled, source: { xPx: sourceX, yPx: sourceY }, target: null };
}

/** Deterministic mulberry32 PRNG so the noisy fits never flake. */
function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function noisePairs(
	transform: { a: number; b: number; c: number; d: number; e: number; f: number },
	count: number,
	amplitude: number,
	seed: number
): AlignmentPairInput[] {
	const random = mulberry32(seed);
	const pairs: AlignmentPairInput[] = [];
	for (let i = 0; i < count; i++) {
		const x = 40 + 180 * ((i * 7) % count) / Math.max(count - 1, 1);
		const y = 30 + 210 * ((i * 5) % count) / Math.max(count - 1, 1);
		const { a, b, c, d, e, f } = transform;
		pairs.push(
			pair(
				`pair-${i}`,
				x,
				y,
				a * x + c * y + e + (random() - 0.5) * 2 * amplitude,
				b * x + d * y + f + (random() - 0.5) * 2 * amplitude
			)
		);
	}
	return pairs;
}

describe('P1-003 Map Alignment Math', () => {
	it('similarity recovers exact transforms, applies and inverts them, and fits noisy overdetermined pairs', () => {
		const rotation = 0.4;
		const scale = 1.5;
		const a = scale * Math.cos(rotation);
		const b = scale * Math.sin(rotation);
		const c = -scale * Math.sin(rotation);
		const d = scale * Math.cos(rotation);
		const e = 40;
		const f = -60;
		const sources: [number, number][] = [
			[10, 20],
			[200, 30],
			[180, 240],
			[40, 190]
		];
		const exactPairs = sources.map(([x, y], index) =>
			pair(
				`exact-${index}`,
				x,
				y,
				a * x + c * y + e,
				b * x + d * y + f
			)
		);

		const result = estimateSimilarity({ pairs: exactPairs });

		if (!('transform' in result)) throw new Error(`expected success, got ${result.reason}`);
		const [fa, fb, fc, fd, fe, ff] = result.transform.coefficients;
		expect(fa).toBeCloseTo(a, 9);
		expect(fb).toBeCloseTo(b, 9);
		expect(fc).toBeCloseTo(c, 9);
		expect(fd).toBeCloseTo(d, 9);
		expect(fe).toBeCloseTo(e, 9);
		expect(ff).toBeCloseTo(f, 9);
		expect(result.transform.isInvertible).toBe(true);
		expect(result.transform.orientation).toBe(1);
		expect(result.transform.majorAxisScale).toBeCloseTo(scale, 9);
		expect(result.transform.minorAxisScale).toBeCloseTo(scale, 9);
		expect(result.transform.anisotropy).toBeCloseTo(1, 9);
		expect(result.transform.shear).toBe(0);
		expect(result.metrics.count).toBe(4);
		expect(result.metrics.meanDistance).toBeLessThan(1e-9);
		expect(result.metrics.maxDistance).toBeLessThan(1e-9);

		// Application and inverse round-trip representative points.
		const point = { xPx: 123, yPx: 456 };
		const forward = applyTransform(point, result.transform);
		expect(forward.xPx).toBeCloseTo(a * point.xPx + c * point.yPx + e, 9);
		expect(forward.yPx).toBeCloseTo(b * point.xPx + d * point.yPx + f, 9);
		const inverse = invertTransform(result.transform);
		expect(inverse).not.toBeNull();
		const back = applyTransform(forward, inverse!);
		expect(back.xPx).toBeCloseTo(point.xPx, 9);
		expect(back.yPx).toBeCloseTo(point.yPx, 9);

		// Overdetermined noisy fit uses every enabled complete pair and
		// minimizes residuals without needing exact recovery.
		const noisy = estimateSimilarity({
			pairs: noisePairs({ a, b, c, d, e, f }, 14, 2, 42)
		});
		if (!('transform' in noisy)) throw new Error(`expected success, got ${noisy.reason}`);
		expect(noisy.metrics.count).toBe(14);
		expect(noisy.residuals).toHaveLength(14);
		expect(noisy.usedPairIds).toHaveLength(14);
		expect(noisy.metrics.meanDistance).toBeLessThan(2);
		expect(noisy.metrics.maxDistance).toBeLessThan(8);
		expect(noisy.metrics.rmsDistance).toBeGreaterThan(0);
		expect(noisy.metrics.medianDistance).toBeGreaterThan(0);
	});

	it('affine recovers exact transforms, applies and inverts them, and fits noisy overdetermined pairs', () => {
		const coefficients = [1.2, -0.4, 0.3, 0.8, 50, 100];
		const [a, b, c, d, e, f] = coefficients;
		const sources: [number, number][] = [
			[10, 20],
			[200, 30],
			[180, 240],
			[40, 190]
		];
		const exactPairs = sources.map(([x, y], index) =>
			pair(`exact-${index}`, x, y, a * x + c * y + e, b * x + d * y + f)
		);

		const result = estimateAffine({ pairs: exactPairs });

		if (!('transform' in result)) throw new Error(`expected success, got ${result.reason}`);
		expect([...result.transform.coefficients]).toEqual(coefficients.map((v) => expect.closeTo(v, 9)));
		expect(result.transform.isInvertible).toBe(true);
		expect(result.metrics.count).toBe(4);
		expect(result.metrics.maxDistance).toBeLessThan(1e-9);

		// Application and inverse round-trip representative points.
		const point = { xPx: 123, yPx: 456 };
		const forward = applyTransform(point, result.transform);
		expect(forward.xPx).toBeCloseTo(a * point.xPx + c * point.yPx + e, 9);
		expect(forward.yPx).toBeCloseTo(b * point.xPx + d * point.yPx + f, 9);
		const inverse = invertTransform(result.transform);
		expect(inverse).not.toBeNull();
		const back = applyTransform(forward, inverse!);
		expect(back.xPx).toBeCloseTo(point.xPx, 9);
		expect(back.yPx).toBeCloseTo(point.yPx, 9);

		// Overdetermined noisy fit: all 14 enabled pairs participate.
		const noisy = estimateAffine({
			pairs: noisePairs({ a, b, c, d, e, f }, 14, 3, 7)
		});
		if (!('transform' in noisy)) throw new Error(`expected success, got ${noisy.reason}`);
		expect(noisy.metrics.count).toBe(14);
		expect(noisy.usedPairIds).toHaveLength(14);
		expect(noisy.metrics.meanDistance).toBeLessThan(3);
		expect(noisy.metrics.maxDistance).toBeLessThan(10);
	});

	it('validation filters enabled complete pairs and rejects minimum, degenerate, non-finite, and reflection cases', () => {
		// Disabled and incomplete pairs are excluded from estimation.
		const filteredPairs = [
			pair('p1', 10, 20, 20, 40),
			pair('p2', 100, 30, 110, 50),
			pair('p3', 80, 240, 90, 260),
			pair('p4', 500, 500, 500, 500, false),
			incomplete('p5', 700, 700)
		];
		const similarity = estimateSimilarity({ pairs: filteredPairs });
		if (!('transform' in similarity)) throw new Error(`expected success, got ${similarity.reason}`);
		expect(similarity.usedPairIds).toEqual(['p1', 'p2', 'p3']);
		expect(similarity.residuals).toHaveLength(3);
		const affine = estimateAffine({ pairs: filteredPairs });
		if (!('transform' in affine)) throw new Error(`expected success, got ${affine.reason}`);
		expect(affine.usedPairIds).toEqual(['p1', 'p2', 'p3']);

		// Minimum pair counts.
		const one = estimateSimilarity({ pairs: [pair('p1', 10, 20, 20, 40)] });
		expect(one).toMatchObject({
			model: 'similarity',
			reason: AlignmentFailureReason.INSUFFICIENT_PAIRS,
			requiredPairs: 2,
			availablePairs: 1
		});
		const two = estimateAffine({
			pairs: [pair('p1', 10, 20, 20, 40), pair('p2', 100, 30, 110, 50)]
		});
		expect(two).toMatchObject({
			model: 'affine',
			reason: AlignmentFailureReason.INSUFFICIENT_PAIRS,
			requiredPairs: 3,
			availablePairs: 2
		});

		// Duplicate/zero-spread similarity geometry.
		const zeroSpread = estimateSimilarity({
			pairs: [
				pair('p1', 100, 200, 150, 250),
				pair('p2', 100, 200, 150, 250)
			]
		});
		expect(zeroSpread).toMatchObject({
			model: 'similarity',
			reason: AlignmentFailureReason.ZERO_SPREAD
		});

		// Collinear affine geometry.
		const collinear = estimateAffine({
			pairs: [
				pair('p1', 100, 200, 150, 250),
				pair('p2', 200, 400, 250, 500),
				pair('p3', 300, 600, 350, 650)
			]
		});
		expect(collinear).toMatchObject({
			model: 'affine',
			reason: AlignmentFailureReason.COLLINEAR_GEOMETRY
		});

		// Non-invertible affine (target geometry collapses to one point).
		const collapsed = estimateAffine({
			pairs: [
				pair('p1', 100, 200, 10, 10),
				pair('p2', 300, 400, 10, 10),
				pair('p3', 500, 200, 10, 10)
			]
		});
		expect(collapsed).toMatchObject({
			model: 'affine',
			reason: AlignmentFailureReason.NON_INVERTIBLE
		});

		// Non-finite coordinates fail clearly for both models.
		const nonFinite = [pair('p1', 100, 200, 150, 250), pair('p2', NaN, 200, 150, 250)];
		expect(estimateSimilarity({ pairs: nonFinite })).toMatchObject({
			model: 'similarity',
			reason: AlignmentFailureReason.NON_FINITE_COORDINATES
		});
		expect(
			estimateAffine({ pairs: [...nonFinite, pair('p3', 300, 400, 350, 450)] })
		).toMatchObject({
			model: 'affine',
			reason: AlignmentFailureReason.NON_FINITE_COORDINATES
		});

		// Reflection-only data is rejected rather than silently mirrored.
		const mirrored = estimateSimilarity({
			pairs: [
				pair('p1', 0, 0, 0, 0),
				pair('p2', 100, 0, 0, 100),
				pair('p3', 0, 100, 100, 0)
			]
		});
		expect(mirrored).toMatchObject({
			model: 'similarity',
			reason: AlignmentFailureReason.REFLECTION_REQUIRED
		});

		// Two nearly identical directed segments are always representable by a
		// similarity transform. Tiny closed-form rounding differences must not be
		// misclassified as evidence of a reflection.
		const twoPointFit = estimateSimilarity({
			pairs: [
				pair('p1', 495.68, 508.18, 495.39, 507.4),
				pair('p2', 1600.41, 1794.28, 1598.42, 1791.53)
			]
		});
		expect(twoPointFit).toHaveProperty('transform');

		// Inverting a singular transform returns null.
		const singular: SerializableTransform = {
			model: 'affine',
			coefficients: [0, 0, 0, 0, 0, 0],
			isInvertible: false,
			determinant: 0,
			orientation: 0,
			majorAxisScale: 0,
			minorAxisScale: 0,
			anisotropy: 0,
			shear: 0
		};
		expect(invertTransform(singular)).toBeNull();

		// validateTransform defaults the minimum pair count to the model's
		// requirement (2 for similarity, 3 for affine), so a valid minimal
		// similarity result does not receive a spurious insufficient-pairs
		// warning while an explicit override still wins.
		const twoPairs = [pair('p1', 10, 20, 20, 40), pair('p2', 100, 30, 110, 50)];
		const threePairs = [...twoPairs, pair('p3', 80, 240, 90, 260)];
		const simTransform: SerializableTransform = {
			model: 'similarity',
			coefficients: [1, 0, 0, 1, 0, 0],
			isInvertible: true,
			determinant: 1,
			orientation: 1,
			majorAxisScale: 1,
			minorAxisScale: 1,
			anisotropy: 1,
			shear: 0
		};
		const affineTransform: SerializableTransform = { ...simTransform, model: 'affine' };
		expect(
			validateTransform({ transform: simTransform, pairs: twoPairs }).some(
				(warning) => warning.type === 'INSUFFICIENT_PAIRS'
			)
		).toBe(false);
		expect(
			validateTransform({ transform: affineTransform, pairs: threePairs }).some(
				(warning) => warning.type === 'INSUFFICIENT_PAIRS'
			)
		).toBe(false);
		expect(
			validateTransform({ transform: affineTransform, pairs: twoPairs }).some(
				(warning) => warning.type === 'INSUFFICIENT_PAIRS'
			)
		).toBe(true);
		expect(
			validateTransform({ transform: simTransform, pairs: twoPairs, minPairs: 3 }).some(
				(warning) => warning.type === 'INSUFFICIENT_PAIRS'
			)
		).toBe(true);
	});

	it('residuals report per-pair vectors, aggregate metrics, maximum-pair identity, and affine distortion values', () => {
		const transform: SerializableTransform = {
			model: 'similarity',
			coefficients: [2, 0, 0, 2, 10, 20],
			isInvertible: true,
			determinant: 4,
			orientation: 1,
			majorAxisScale: 2,
			minorAxisScale: 2,
			anisotropy: 1,
			shear: 0
		};
		const pairs: AlignmentPairInput[] = [
			pair('p1', 100, 100, 210, 220),
			pair('p2', 200, 100, 410, 220),
			pair('p3', 300, 150, 620, 330),
			pair('p4', 50, 50, 999, 999, false),
			incomplete('p5', 60, 60)
		];

		const { pairs: residualPairs, metrics } = calculateResiduals({ pairs, transform });

		// Per-pair vectors and distances, disabled/incomplete excluded.
		expect(residualPairs.map((r) => r.pairId)).toEqual(['p1', 'p2', 'p3']);
		expect(residualPairs[0]).toMatchObject({ dx: 0, dy: 0, distance: 0 });
		expect(residualPairs[1].distance).toBe(0);
		expect(residualPairs[2].dx).toBe(-10);
		expect(residualPairs[2].dy).toBe(-10);
		expect(residualPairs[2].distance).toBeCloseTo(Math.sqrt(200), 12);
		expect(residualPairs[2].expected).toEqual({ xPx: 610, yPx: 320 });

		// Aggregate metrics: count, mean, median, RMS, max, maximum identity.
		const expectedMax = Math.sqrt(200);
		expect(metrics.count).toBe(3);
		expect(metrics.meanDistance).toBeCloseTo(expectedMax / 3, 12);
		expect(metrics.medianDistance).toBe(0);
		expect(metrics.rmsDistance).toBeCloseTo(Math.sqrt(200 / 3), 12);
		expect(metrics.maxDistance).toBeCloseTo(expectedMax, 12);
		expect(metrics.maxPairId).toBe('p3');

		// Empty enabled set is defined, not NaN.
		const empty = calculateResiduals({ pairs: [incomplete('p1', 0, 0), pair('p2', 0, 0, 1, 1, false)], transform });
		expect(empty.metrics).toEqual({
			count: 0,
			meanDistance: 0,
			medianDistance: 0,
			rmsDistance: 0,
			maxDistance: 0,
			maxPairId: null
		});
		expect(empty.pairs).toHaveLength(0);

		// A nonempty exact fit still reports its maximum pair identity: every
		// residual is zero, so the first pair in input order is the maximum.
		const exact = calculateResiduals({
			pairs: [pair('e1', 10, 20, 30, 60), pair('e2', 40, 50, 90, 120)],
			transform
		});
		expect(exact.metrics.count).toBe(2);
		expect(exact.metrics.maxDistance).toBe(0);
		expect(exact.metrics.maxPairId).toBe('e1');

		// Affine distortion derivation on a known sheared map.
		const distortion = estimateAffine({
			pairs: [
				pair('p1', 10, 20, 1.2 * 10 + 0.3 * 20 + 50, -0.4 * 10 + 0.8 * 20 + 100),
				pair('p2', 200, 30, 1.2 * 200 + 0.3 * 30 + 50, -0.4 * 200 + 0.8 * 30 + 100),
				pair('p3', 180, 240, 1.2 * 180 + 0.3 * 240 + 50, -0.4 * 180 + 0.8 * 240 + 100),
				pair('p4', 40, 190, 1.2 * 40 + 0.3 * 190 + 50, -0.4 * 40 + 0.8 * 190 + 100)
			]
		});
		if (!('transform' in distortion)) throw new Error(`expected success, got ${distortion.reason}`);
		const { determinant, orientation, majorAxisScale, minorAxisScale, anisotropy, shear } =
			distortion.transform;
		expect(determinant).toBeCloseTo(1.08, 12);
		expect(orientation).toBe(1);
		expect(majorAxisScale).toBeGreaterThan(minorAxisScale);
		expect(minorAxisScale * majorAxisScale).toBeCloseTo(Math.abs(determinant), 12);
		expect(anisotropy).toBeGreaterThan(0);
		expect(anisotropy).toBeLessThan(1);
		expect(shear).toBeCloseTo(Math.abs(1.2 * 0.3 + -0.4 * 0.8) / Math.abs(1.08), 12);
	});
});
