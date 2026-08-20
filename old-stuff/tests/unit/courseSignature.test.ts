import { describe, expect, it } from 'vitest';
import {
	AFFINE_FALLBACK_MIN_OVERLAP,
	computeSignatureDescriptor,
	hashSignatureDescriptor,
	matchSignatures,
	MIN_OVERLAP_HOLES,
	MIN_SIGNATURE_HOLES,
	spreadOf
} from '../../src/lib/courseSignature';
import type { CourseSignatureInput, LabeledPoint } from '../../src/lib/courseSignature';
import type { HashBytes } from '../../src/lib/imageIntake';

/**
 * A deterministic, non-degenerate, non-collinear synthetic course: badge i
 * and basket i for holes 1..n, spread out with distinct relative geometry
 * (sin/cos combinations, not a straight line or a circle) so similarity and
 * affine fits are well-conditioned.
 */
function syntheticCourse(n: number, offset = 0): CourseSignatureInput {
	const badges: LabeledPoint[] = [];
	const baskets: LabeledPoint[] = [];
	for (let i = 1; i <= n; i += 1) {
		const holeNumber = i + offset;
		const bx = 100 * i + 60 * Math.sin(i * 1.7) + 20 * Math.cos(i * 0.4);
		const by = 200 + 45 * Math.cos(i * 0.9) + 15 * i;
		badges.push({ holeNumber, xPx: bx, yPx: by });
		baskets.push({
			holeNumber,
			xPx: bx + 80 * Math.cos(i * 1.3) + 40,
			yPx: by + 60 * Math.sin(i * 1.3) + 55
		});
	}
	return { badges, baskets };
}

function transformPoint(
	point: { xPx: number; yPx: number },
	scale: number,
	rotationRad: number,
	tx: number,
	ty: number
): { xPx: number; yPx: number } {
	const cosT = Math.cos(rotationRad);
	const sinT = Math.sin(rotationRad);
	return {
		xPx: scale * (point.xPx * cosT - point.yPx * sinT) + tx,
		yPx: scale * (point.xPx * sinT + point.yPx * cosT) + ty
	};
}

function applySimilarity(
	input: CourseSignatureInput,
	scale: number,
	rotationRad: number,
	tx: number,
	ty: number
): CourseSignatureInput {
	return {
		badges: input.badges.map((point) => ({ ...point, ...transformPoint(point, scale, rotationRad, tx, ty) })),
		baskets: input.baskets.map((point) => ({ ...point, ...transformPoint(point, scale, rotationRad, tx, ty) }))
	};
}

function translate(input: CourseSignatureInput, dx: number, dy: number): CourseSignatureInput {
	return applySimilarity(input, 1, 0, dx, dy);
}

function scaleBy(input: CourseSignatureInput, factor: number): CourseSignatureInput {
	return applySimilarity(input, factor, 0, 0, 0);
}

function rotateBy(input: CourseSignatureInput, rotationRad: number): CourseSignatureInput {
	return applySimilarity(input, 1, rotationRad, 0, 0);
}

const fakeHash: HashBytes = async (bytes) => {
	// A trivial deterministic byte-summary, sufficient to distinguish
	// canonical payloads without needing real Web Crypto in jsdom.
	let sum = 0;
	for (const byte of bytes) sum = (sum * 31 + byte) >>> 0;
	return sum.toString(16).padStart(8, '0');
};

describe('computeSignatureDescriptor', () => {
	it('is invariant to translation', () => {
		const base = syntheticCourse(10);
		const shifted = translate(base, 500, -300);
		const a = computeSignatureDescriptor(base);
		const b = computeSignatureDescriptor(shifted);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		expect(a).toEqual(b);
	});

	it('is invariant to uniform scale', () => {
		const base = syntheticCourse(10);
		const scaled = scaleBy(base, 2.5);
		const a = computeSignatureDescriptor(base);
		const b = computeSignatureDescriptor(scaled);
		expect(a).toEqual(b);
	});

	it('is invariant to rotation, anchored on the smallest present hole number', () => {
		const base = syntheticCourse(10);
		const rotated = rotateBy(base, Math.PI / 5);
		const a = computeSignatureDescriptor(base);
		const b = computeSignatureDescriptor(rotated);
		expect(a).toEqual(b);
	});

	it('rejects fewer than MIN_SIGNATURE_HOLES distinct badge-labeled holes', () => {
		const course = syntheticCourse(MIN_SIGNATURE_HOLES - 1);
		const descriptor = computeSignatureDescriptor(course);
		expect(descriptor).toEqual({ ok: false, reason: 'insufficient-holes' });
	});

	it('accepts exactly MIN_SIGNATURE_HOLES distinct badge-labeled holes', () => {
		const course = syntheticCourse(MIN_SIGNATURE_HOLES);
		const descriptor = computeSignatureDescriptor(course);
		expect(descriptor.ok).toBe(true);
	});

	it('rejects a degenerate (near-coincident) point set', () => {
		const badges: LabeledPoint[] = Array.from({ length: MIN_SIGNATURE_HOLES }, (_, i) => ({
			holeNumber: i + 1,
			xPx: 100,
			yPx: 100
		}));
		const descriptor = computeSignatureDescriptor({ badges, baskets: [] });
		expect(descriptor).toEqual({ ok: false, reason: 'degenerate-spread' });
	});
});

describe('hashSignatureDescriptor', () => {
	async function hashOf(input: CourseSignatureInput): Promise<string> {
		const descriptor = computeSignatureDescriptor(input);
		if (!descriptor.ok) throw new Error('expected a valid descriptor');
		return hashSignatureDescriptor(descriptor, fakeHash);
	}

	it('is deterministic for the same shape', async () => {
		const course = syntheticCourse(10);
		expect(await hashOf(course)).toBe(await hashOf(course));
	});

	it('is identical for a translated/scaled/rotated copy of the same shape', async () => {
		const base = syntheticCourse(10);
		const transformed = rotateBy(scaleBy(translate(base, 40, -12), 1.8), 0.3);
		expect(await hashOf(base)).toBe(await hashOf(transformed));
	});

	it('tolerates jitter within the quantization step and is sensitive beyond it', async () => {
		const base = syntheticCourse(10);
		const tinyJitter: CourseSignatureInput = {
			badges: base.badges.map((point) => ({ ...point, xPx: point.xPx + 1e-4 })),
			baskets: base.baskets
		};
		expect(await hashOf(base)).toBe(await hashOf(tinyJitter));

		const bigJitter: CourseSignatureInput = {
			badges: base.badges.map((point, index) =>
				index === 0 ? { ...point, xPx: point.xPx + 5000, yPx: point.yPx + 5000 } : point
			),
			baskets: base.baskets
		};
		expect(await hashOf(base)).not.toBe(await hashOf(bigJitter));
	});
});

describe('matchSignatures', () => {
	it('recovers a known similarity transform with a near-zero residual', () => {
		const source = syntheticCourse(18);
		const target = applySimilarity(source, 1.3, (12 * Math.PI) / 180, 300, -150);

		const result = matchSignatures(source, target);
		expect(result.matched).toBe(true);
		expect(result.model).toBe('similarity');
		expect(result.normalizedRms).toBeLessThan(0.001);
		expect(result.confidence).toBeGreaterThan(0.9);
		expect(result.usedHoleNumbers).toHaveLength(18);
		expect(result.droppedHoleNumbers).toHaveLength(0);
		expect(result.transform).not.toBeNull();

		// The recovered transform should map source badges onto target badges.
		const [a, b, c, d, e, f] = result.transform!.coefficients;
		const badge1 = source.badges[0];
		const expected = target.badges[0];
		const mapped = { xPx: a * badge1.xPx + c * badge1.yPx + e, yPx: b * badge1.xPx + d * badge1.yPx + f };
		expect(mapped.xPx).toBeCloseTo(expected.xPx, 3);
		expect(mapped.yPx).toBeCloseTo(expected.yPx, 3);
	});

	it('rejects when overlap is below MIN_OVERLAP_HOLES', () => {
		const source = syntheticCourse(18);
		const target = { badges: source.badges.slice(0, MIN_OVERLAP_HOLES - 1), baskets: [] };
		const result = matchSignatures(source, target);
		expect(result.matched).toBe(false);
		expect(result.transform).toBeNull();
		expect(result.confidence).toBe(0);
	});

	it('rejects when overlap is below 50% of the smaller side, even with enough absolute overlap', () => {
		// Target has 13 distinct holes total; only 6 of them (holeNumber 1..6)
		// are also present in source. 6 >= MIN_OVERLAP_HOLES but 6 < 0.5*13,
		// isolating the fraction gate from the absolute-count gate.
		const source = syntheticCourse(20);
		const sharedTargetBadges = source.badges.slice(0, 6).map((point) => ({ ...point }));
		const targetOnlyBadges: LabeledPoint[] = Array.from({ length: 7 }, (_, i) => ({
			holeNumber: 101 + i,
			xPx: 900 + i * 30,
			yPx: 900 + i * 17
		}));
		const target: CourseSignatureInput = { badges: [...sharedTargetBadges, ...targetOnlyBadges], baskets: [] };

		const result = matchSignatures(source, target);
		expect(result.matched).toBe(false);
	});

	it('rejects two geometrically unrelated courses despite full hole-number overlap', () => {
		const source = syntheticCourse(18);
		// A different, unrelated layout using the same hole-number range.
		const unrelated: CourseSignatureInput = {
			badges: Array.from({ length: 18 }, (_, i) => ({
				holeNumber: i + 1,
				xPx: 40 * (i % 5) + 7 * Math.sin(i * 5.1),
				yPx: 40 * Math.floor(i / 5) + 7 * Math.cos(i * 3.3)
			})),
			baskets: []
		};
		const result = matchSignatures(source, unrelated);
		expect(result.matched).toBe(false);
	});

	it('prunes a single mislabeled outlier pair and still matches confidently', () => {
		const source = syntheticCourse(12);
		const target = applySimilarity(source, 1.1, 0.15, 50, 20);
		const corrupted: CourseSignatureInput = {
			badges: target.badges.map((point, index) =>
				index === 0 ? { ...point, xPx: point.xPx + 4000, yPx: point.yPx - 3500 } : point
			),
			baskets: target.baskets
		};

		const result = matchSignatures(source, corrupted);
		expect(result.matched).toBe(true);
		expect(result.droppedHoleNumbers).toContain(source.badges[0].holeNumber);
		expect(result.normalizedRms).toBeLessThan(0.01);
	});

	it('falls back to an affine fit on a large overlap when similarity is not confident enough', () => {
		const source = syntheticCourse(AFFINE_FALLBACK_MIN_OVERLAP + 2);
		// Independent x/y scale factors are not explainable by a similarity
		// transform (uniform scale + rotation only) but are exactly what affine
		// models, so this isolates the fallback path.
		const target: CourseSignatureInput = {
			badges: source.badges.map((point) => ({ ...point, xPx: point.xPx * 2.2, yPx: point.yPx * 0.6 })),
			baskets: source.baskets.map((point) => ({ ...point, xPx: point.xPx * 2.2, yPx: point.yPx * 0.6 }))
		};

		const result = matchSignatures(source, target);
		expect(result.matched).toBe(true);
		expect(result.model).toBe('affine');
	});
});

describe('spreadOf', () => {
	it('is zero for an empty or single-point set', () => {
		expect(spreadOf([])).toBe(0);
		expect(spreadOf([{ xPx: 10, yPx: 10 }])).toBe(0);
	});

	it('scales linearly with a uniform scale of the point set', () => {
		const points = [
			{ xPx: 0, yPx: 0 },
			{ xPx: 10, yPx: 0 },
			{ xPx: 0, yPx: 10 }
		];
		const scaled = points.map((point) => ({ xPx: point.xPx * 3, yPx: point.yPx * 3 }));
		expect(spreadOf(scaled)).toBeCloseTo(spreadOf(points) * 3, 6);
	});
});
