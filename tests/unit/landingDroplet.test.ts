import { describe, expect, it } from 'vitest';
import type { DetectorEmission, RgbaRaster } from '$lib/detect';
import { findDroplets, landingDropletDetector } from '$lib/detectors/landingDroplet';

const MARKER_BLUE = { r: 30, g: 90, b: 230 }; // hue ≈ 222°, saturated, bright
const GRASS_GREEN = { r: 60, g: 160, b: 60 };

function raster(widthPx = 300, heightPx = 300): RgbaRaster {
	const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
	for (let i = 0; i < rgba.length; i += 4) {
		rgba[i] = GRASS_GREEN.r;
		rgba[i + 1] = GRASS_GREEN.g;
		rgba[i + 2] = GRASS_GREEN.b;
		rgba[i + 3] = 255;
	}
	return { imageId: 'synthetic', widthPx, heightPx, rgba };
}

function paint(
	image: RgbaRaster,
	x: number,
	y: number,
	color: { r: number; g: number; b: number }
): void {
	const p = (y * image.widthPx + x) * 4;
	image.rgba[p] = color.r;
	image.rgba[p + 1] = color.g;
	image.rgba[p + 2] = color.b;
}

/**
 * Draw a droplet: a filled circle of radius r centered at (cx, cy) plus a
 * triangular tail narrowing to a 1px tip at (cx, tipY). Tip is the semantic
 * landing point.
 */
function drawDroplet(image: RgbaRaster, cx: number, cy: number, r: number, tipY: number): void {
	for (let y = cy - r; y <= cy + r; y++) {
		for (let x = cx - r; x <= cx + r; x++) {
			if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) paint(image, x, y, MARKER_BLUE);
		}
	}
	for (let y = cy + r; y <= tipY; y++) {
		const halfWidth = Math.max(0, Math.round((r * (tipY - y)) / (tipY - cy - r + 1)) - 1);
		for (let x = cx - halfWidth; x <= cx + halfWidth; x++) paint(image, x, y, MARKER_BLUE);
	}
}

describe('landing droplet detection', () => {
	it('finds droplets and reports the tip, not the centroid', () => {
		const image = raster();
		drawDroplet(image, 80, 60, 6, 80);
		drawDroplet(image, 200, 150, 7, 172);

		const droplets = findDroplets(image);
		expect(droplets).toHaveLength(2);
		const sorted = [...droplets].sort((a, b) => a.tipXPx - b.tipXPx);
		expect(sorted[0].tipXPx).toBe(80);
		expect(sorted[0].tipYPx).toBe(80); // bottom of tail — well below centroid ≈ 63
		expect(sorted[1].tipXPx).toBe(200);
		expect(sorted[1].tipYPx).toBe(172);
	});

	it('rejects decoys: wrong color, too small, wrong aspect', () => {
		const image = raster();
		// green droplet shape (wrong color)
		for (let y = 40; y <= 60; y++)
			for (let x = 45; x <= 55; x++) paint(image, x, y, { r: 20, g: 200, b: 20 });
		// tiny blue speck (below area/size gates)
		for (let y = 100; y <= 103; y++)
			for (let x = 100; x <= 103; x++) paint(image, x, y, MARKER_BLUE);
		// wide blue banner (aspect < min: wider than tall)
		for (let y = 200; y <= 212; y++)
			for (let x = 150; x <= 190; x++) paint(image, x, y, MARKER_BLUE);

		expect(findDroplets(image)).toHaveLength(0);
	});

	it('emits landing-droplet objects through the Detector contract', async () => {
		const image = raster();
		drawDroplet(image, 120, 100, 6, 120);

		const emitted: DetectorEmission[] = [];
		await landingDropletDetector(image, (e) => emitted.push(e));

		expect(emitted).toHaveLength(1);
		const e = emitted[0];
		expect(e.kind).toBe('object');
		if (e.kind !== 'object') return;
		expect(e.objType).toBe('landing-droplet');
		expect(e.xPx).toBe(120);
		expect(e.yPx).toBe(120);
		expect(e.imageId).toBe('synthetic');
	});
});
