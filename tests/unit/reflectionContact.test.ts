import { describe, expect, test } from 'vitest';
import { diagnoseReflectionContact, type ReflectionContactInput } from '../../packages/alg/src/experimental/reflectionContact';

function input(overrides: Partial<ReflectionContactInput> = {}): ReflectionContactInput {
	return {
		raster: { widthPx: 8, heightPx: 8, rgba: new Uint8ClampedArray(8 * 8 * 4) },
		ray: { origin: { x: 1, y: 2 }, direction: { x: 1, y: 0 }, lengthPx: 4 },
		contact: { point: { x: 3, y: 2 }, signedGradient: { x: 1, y: 0 }, widthPx: 2 },
		...overrides
	};
}

describe('reflection contact diagnostic', () => {
	test('reflects from the measured gradient and keeps source-frame width', () => {
		const result = diagnoseReflectionContact(input());
		expect(result.status).toBe('supported');
		if (result.status !== 'supported') return;
		expect(result.measuredNormal).toEqual({ x: 1, y: 0 });
		expect(result.incidenceDegrees).toBeCloseTo(0);
		expect(result.widthPx).toBe(2);
		expect(result.reflectedRay.start).toEqual({ x: 3, y: 2 });
		expect(result.reflectedRay.end).toEqual({ x: -1, y: 2 });
		expect(result.unexplainedLength).toBe('none');
	});

	test('returns unsupported without contact instead of fabricating a perpendicular normal', () => {
		const result = diagnoseReflectionContact(input({ contact: undefined }));
		expect(result).toEqual({ status: 'unsupported', reason: 'no-contact', unexplainedLength: 0 });
	});

	test('retains a grazing straight-parallel edge as unexplained and never bends it', () => {
		const result = diagnoseReflectionContact(input({ contact: { point: { x: 3, y: 2 }, signedGradient: { x: 0, y: 1 }, widthPx: 2 } }));
		expect(result.status).toBe('supported');
		if (result.status !== 'supported') return;
		expect(result.unexplainedLength).toBe('grazing');
		expect(result.reflectedRay.direction).toEqual({ x: 1, y: 0 });
		expect(result.reflectedRay.end).toEqual({ x: 7, y: 2 });
	});
});
