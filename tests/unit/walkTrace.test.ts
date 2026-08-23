import { describe, expect, it } from 'vitest';
import type { DetectorEmission, RgbaRaster } from '@chainspot/alg/detect';
import { simplifyPath, traceWalk, walkTraceDetector } from '@chainspot/alg/detectors/walkTrace';

const WALK_PURPLE = { r: 120, g: 40, b: 240 }; // hue ≈ 264°, saturated, bright

function raster(widthPx = 600, heightPx = 600): RgbaRaster {
	const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
	for (let i = 0; i < rgba.length; i += 4) {
		rgba[i] = 240;
		rgba[i + 1] = 240;
		rgba[i + 2] = 240;
		rgba[i + 3] = 255;
	}
	return { imageId: 'synthetic', widthPx, heightPx, rgba };
}

function drawSegment(
	image: RgbaRaster,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	halfWidth = 3
): void {
	const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
	for (let s = 0; s <= steps; s++) {
		const cx = Math.round(x0 + ((x1 - x0) * s) / steps);
		const cy = Math.round(y0 + ((y1 - y0) * s) / steps);
		for (let dy = -halfWidth; dy <= halfWidth; dy++) {
			for (let dx = -halfWidth; dx <= halfWidth; dx++) {
				const x = cx + dx;
				const y = cy + dy;
				if (x < 0 || x >= image.widthPx || y < 0 || y >= image.heightPx) continue;
				const p = (y * image.widthPx + x) * 4;
				image.rgba[p] = WALK_PURPLE.r;
				image.rgba[p + 1] = WALK_PURPLE.g;
				image.rgba[p + 2] = WALK_PURPLE.b;
			}
		}
	}
}

describe('walk trace extraction', () => {
	it('recovers an L-shaped walk in order: endpoints and the corner', () => {
		const image = raster();
		drawSegment(image, 50, 50, 400, 50);
		drawSegment(image, 400, 50, 400, 500);

		const vertices = traceWalk(image);
		expect(vertices.length).toBeGreaterThanOrEqual(3);

		// cell size for a 600x600 image is max(3, 600/200) = 3px; allow a few cells
		const tol = 12;
		const first = vertices[0];
		const last = vertices[vertices.length - 1];
		const ends = [first, last];
		// one end near (50,50), the other near (400,500) — order may be either way
		const nearA = ends.find((v) => Math.hypot(v.xPx - 50, v.yPx - 50) <= tol);
		const nearB = ends.find((v) => Math.hypot(v.xPx - 400, v.yPx - 500) <= tol);
		expect(nearA).toBeDefined();
		expect(nearB).toBeDefined();
		// some interior vertex sits at the corner
		const corner = vertices.some((v) => Math.hypot(v.xPx - 400, v.yPx - 50) <= tol);
		expect(corner).toBe(true);
	});

	it('returns [] when there is no walk (course blank)', () => {
		expect(traceWalk(raster())).toHaveLength(0);
	});

	it('ignores small purple specks (noise, not a walk)', () => {
		const image = raster();
		drawSegment(image, 100, 100, 104, 104, 2); // a blob, not a path
		expect(traceWalk(image)).toHaveLength(0);
	});

	it('emits ordered walk-vertex objects through the Detector contract', async () => {
		const image = raster();
		drawSegment(image, 50, 300, 550, 300);

		const emitted: DetectorEmission[] = [];
		await walkTraceDetector(image, (e) => emitted.push(e));

		expect(emitted.length).toBeGreaterThanOrEqual(2);
		for (const [i, e] of emitted.entries()) {
			expect(e.kind).toBe('object');
			if (e.kind !== 'object') return;
			expect(e.objType).toBe('walk-vertex');
			expect(e.seq).toBe(i);
		}
	});
});

describe('simplifyPath', () => {
	it('collapses collinear runs and keeps corners', () => {
		const points = [
			{ xPx: 0, yPx: 0 },
			{ xPx: 5, yPx: 0 },
			{ xPx: 10, yPx: 0 },
			{ xPx: 10, yPx: 5 },
			{ xPx: 10, yPx: 10 }
		];
		expect(simplifyPath(points, 1)).toEqual([
			{ xPx: 0, yPx: 0 },
			{ xPx: 10, yPx: 0 },
			{ xPx: 10, yPx: 10 }
		]);
	});
});
