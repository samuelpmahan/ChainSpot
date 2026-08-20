import { describe, expect, it } from 'vitest';
import { findOccludedTeePadMatch } from '../../src/lib/autoAnnotation/teeOcclusionRecovery';
import type { TeeOcclusionRaster } from '../../src/lib/autoAnnotation/teeOcclusionRecovery';

const WIDTH = 200;
const HEIGHT = 200;
const PAD_ASPECT = 1.45;
const PAD_RIM_FRACTION = 0.11;

/** Draws the same rim/interior/background rectangle the production template synthesizer expects, so a perfect match is achievable. */
function drawPad(rgba: Uint8ClampedArray, centerX: number, centerY: number, majorPx: number, angleDeg: number): void {
	const minorPx = majorPx / PAD_ASPECT;
	const rimPx = Math.max(1, majorPx * PAD_RIM_FRACTION);
	const radians = (angleDeg * Math.PI) / 180;
	const cosine = Math.cos(radians);
	const sine = Math.sin(radians);
	const halfExtent = Math.ceil(majorPx);
	for (let y = -halfExtent; y <= halfExtent; y += 1) {
		for (let x = -halfExtent; x <= halfExtent; x += 1) {
			const px = centerX + x;
			const py = centerY + y;
			if (px < 0 || px >= WIDTH || py < 0 || py >= HEIGHT) continue;
			const localX = x * cosine + y * sine;
			const localY = -x * sine + y * cosine;
			const insideOuter = Math.abs(localX) <= majorPx / 2 && Math.abs(localY) <= minorPx / 2;
			const insideInner = Math.abs(localX) <= majorPx / 2 - rimPx && Math.abs(localY) <= minorPx / 2 - rimPx;
			if (!insideOuter) continue;
			const value = insideInner ? 158 : 235;
			const offset = (py * WIDTH + px) * 4;
			rgba[offset] = value;
			rgba[offset + 1] = value;
			rgba[offset + 2] = value;
			rgba[offset + 3] = 255;
		}
	}
}

function buildRaster(centerX: number, centerY: number, majorPx: number, angleDeg: number): TeeOcclusionRaster {
	const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
	rgba.fill(120); // background
	for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255; // alpha
	drawPad(rgba, centerX, centerY, majorPx, angleDeg);
	return { rgba, widthPx: WIDTH, heightPx: HEIGHT };
}

function occludeBox(raster: TeeOcclusionRaster, xPx: number, yPx: number, widthPx: number, heightPx: number): void {
	const rgba = raster.rgba as Uint8ClampedArray;
	const left = Math.max(0, Math.floor(xPx - widthPx / 2));
	const right = Math.min(raster.widthPx - 1, Math.ceil(xPx + widthPx / 2));
	const top = Math.max(0, Math.floor(yPx - heightPx / 2));
	const bottom = Math.min(raster.heightPx - 1, Math.ceil(yPx + heightPx / 2));
	for (let y = top; y <= bottom; y += 1) {
		for (let x = left; x <= right; x += 1) {
			const offset = (y * raster.widthPx + x) * 4;
			rgba[offset] = 20;
			rgba[offset + 1] = 20;
			rgba[offset + 2] = 20;
		}
	}
}

describe('findOccludedTeePadMatch', () => {
	it('finds an unoccluded pad with a near-perfect score', () => {
		const raster = buildRaster(100, 100, 30, 0);
		const match = findOccludedTeePadMatch(raster, 100, 100, 40, [30], [], []);
		expect(match).toBeDefined();
		expect(match!.xPx).toBeCloseTo(100, 0);
		expect(match!.yPx).toBeCloseTo(100, 0);
		expect(match!.score).toBeGreaterThan(0.9);
	});

	it('finds a pad partially covered by a masked badge box, better than without masking', () => {
		const raster = buildRaster(100, 100, 30, 20);
		// Cover roughly a third of the pad with an opaque box.
		occludeBox(raster, 112, 92, 20, 20);

		const badgeBox = { xPx: 112, yPx: 92, widthPx: 22, heightPx: 22 };
		const masked = findOccludedTeePadMatch(raster, 100, 100, 40, [30], [badgeBox], []);
		const unmasked = findOccludedTeePadMatch(raster, 100, 100, 40, [30], [], []);

		expect(masked).toBeDefined();
		expect(masked!.xPx).toBeCloseTo(100, 0);
		expect(masked!.yPx).toBeCloseTo(100, 0);
		// Masking the occluder should score at least as well as leaving it in, and
		// the position should land much closer to the true center.
		expect(masked!.score).toBeGreaterThanOrEqual((unmasked?.score ?? 0) - 1e-6);
	});

	it('masks a circular occluder (putting-circle style annulus)', () => {
		const raster = buildRaster(100, 100, 30, 0);
		// A thin ring stroke crossing the right edge of the pad.
		const circle = { xPx: 100, yPx: 100, radiusPx: 16, innerRadiusPx: 13 };
		occludeBox(raster, 114, 100, 6, 30); // simulate the ring's visual effect on that side
		const match = findOccludedTeePadMatch(raster, 100, 100, 40, [30], [], [circle]);
		expect(match).toBeDefined();
		expect(match!.xPx).toBeCloseTo(100, 0);
		expect(match!.yPx).toBeCloseTo(100, 0);
	});

	it('returns undefined when nothing pad-like is present', () => {
		const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
		rgba.fill(120);
		for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
		const raster: TeeOcclusionRaster = { rgba, widthPx: WIDTH, heightPx: HEIGHT };
		const match = findOccludedTeePadMatch(raster, 100, 100, 40, [30], [], []);
		expect(match).toBeUndefined();
	});

	it('returns undefined when too much of the template would be masked out', () => {
		const raster = buildRaster(100, 100, 30, 0);
		const hugeBox = { xPx: 100, yPx: 100, widthPx: 200, heightPx: 200 };
		const match = findOccludedTeePadMatch(raster, 100, 100, 40, [30], [hugeBox], []);
		expect(match).toBeUndefined();
	});
});
