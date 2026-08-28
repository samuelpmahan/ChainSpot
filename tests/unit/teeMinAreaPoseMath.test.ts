import { describe, expect, it } from 'vitest';
import {
	fitMinimumAreaPixelRect,
	type TeeComponentCell,
	type TeeMinimumAreaPoseResult
} from '../../packages/alg/src/detectors/threeFactor/features/g3.teeMinAreaPoseMath';

function axialDeltaDeg(a: number, b: number): number {
	const delta = Math.abs((((a - b) % 180) + 180) % 180);
	return Math.min(delta, 180 - delta);
}

function expectEveryCellInside(
	result: TeeMinimumAreaPoseResult,
	pixels: readonly TeeComponentCell[]
): void {
	expect(result.accepted).toBe(true);
	expect(result.center).not.toBeNull();
	expect(result.angleDeg).not.toBeNull();
	expect(result.majorPx).not.toBeNull();
	expect(result.minorPx).not.toBeNull();
	const center = result.center!;
	const angle = (result.angleDeg! * Math.PI) / 180;
	const ux = Math.cos(angle);
	const uy = Math.sin(angle);
	const vx = -uy;
	const vy = ux;
	for (const pixel of pixels) {
		for (const dx of [-0.5, 0.5]) {
			for (const dy of [-0.5, 0.5]) {
				const x = pixel.xPx + dx - center.xPx;
				const y = pixel.yPx + dy - center.yPx;
				expect(Math.abs(x * ux + y * uy)).toBeLessThanOrEqual(result.majorPx! / 2 + 1e-8);
				expect(Math.abs(x * vx + y * vy)).toBeLessThanOrEqual(result.minorPx! / 2 + 1e-8);
			}
		}
	}
}

function slantedComponent(): TeeComponentCell[] {
	const pixels: TeeComponentCell[] = [];
	for (let major = 0; major < 9; major++) {
		for (let minor = 0; minor < 3; minor++) {
			pixels.push({ xPx: 2 * major + minor, yPx: major + 2 * minor });
		}
	}
	return pixels;
}

describe('exact-component minimum-area pose math', () => {
	it('returns the exact cell-edge rectangle for an axis-aligned component', () => {
		const pixels = [
			{ xPx: 10, yPx: 20 },
			{ xPx: 11, yPx: 20 },
			{ xPx: 12, yPx: 20 },
			{ xPx: 10, yPx: 21 },
			{ xPx: 11, yPx: 21 },
			{ xPx: 12, yPx: 21 }
		];
		const result = fitMinimumAreaPixelRect(pixels);
		expect(result).toMatchObject({
			accepted: true,
			pixelCount: 6,
			score: 1,
			occupancy: 1,
			areaPx2: 6,
			center: { xPx: 11, yPx: 20.5 },
			angleDeg: 0,
			majorPx: 3,
			minorPx: 2
		});
		expect(result.corners).toEqual([
			{ xPx: 9.5, yPx: 19.5 },
			{ xPx: 12.5, yPx: 19.5 },
			{ xPx: 12.5, yPx: 21.5 },
			{ xPx: 9.5, yPx: 21.5 }
		]);
		const corners = result.corners!;
		const twiceSignedArea = corners.reduce((area, corner, index) => {
			const next = corners[(index + 1) % corners.length]!;
			return area + corner.xPx * next.yPx - corner.yPx * next.xPx;
		}, 0);
		expect(twiceSignedArea).toBeGreaterThan(0);
		expectEveryCellInside(result, pixels);
	});

	it('fits a rotated irregular component and encloses every owned pixel cell', () => {
		const pixels = slantedComponent();
		const result = fitMinimumAreaPixelRect(pixels);
		expect(result.accepted).toBe(true);
		expect(result.hullVertexCount).toBeGreaterThanOrEqual(4);
		expect(result.candidateCount).toBeGreaterThan(1);
		expect(axialDeltaDeg(result.angleDeg!, 26.565051177)).toBeLessThan(1);
		expect(result.occupancy).toBeGreaterThan(0);
		expect(result.occupancy).toBeLessThanOrEqual(1);
		expectEveryCellInside(result, pixels);
	});

	it('is deterministic under pixel order', () => {
		const pixels = slantedComponent();
		const forward = fitMinimumAreaPixelRect(pixels);
		const reverse = fitMinimumAreaPixelRect([...pixels].reverse());
		expect(reverse).toEqual(forward);
	});

	it('rejects missing and malformed detector cells', () => {
		expect(fitMinimumAreaPixelRect([])).toMatchObject({ accepted: false, pixelCount: 0 });
		expect(fitMinimumAreaPixelRect([{ xPx: 1, yPx: 1 }])).toMatchObject({
			accepted: false,
			pixelCount: 1
		});
		expect(
			fitMinimumAreaPixelRect([
				{ xPx: 1.25, yPx: 1 },
				{ xPx: 2, yPx: 1 }
			])
		).toMatchObject({ accepted: false, reason: expect.stringMatching(/integer detector cells/) });
		expect(
			fitMinimumAreaPixelRect([
				{ xPx: 1, yPx: 1 },
				{ xPx: 1, yPx: 1 }
			])
		).toMatchObject({ accepted: false, reason: expect.stringMatching(/unique detector cells/) });
	});
});
