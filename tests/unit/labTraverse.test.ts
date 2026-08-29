import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, test } from 'vitest';
import { polarOffset, renderTraverseScope, TRAVERSE_DIRECTIONS } from '../../scripts/chainspot-lab/scope/render';
import { traverseTarget, traversalNeighbors } from '../../scripts/chainspot-lab/traverse/operation';

const CANONICAL = {
	imageId: 'a'.repeat(64),
	widthPx: 600,
	heightPx: 600,
	stripChrome: { source: 'none', insets: null },
	alreadyCanonicalInput: false,
	autoStitch: { sourceCount: 1, hadFallback: false }
} as const;

describe('LAB traverse motion', () => {
	test('hex handles are convenience vectors over image-coordinate polar motion', () => {
		expect(TRAVERSE_DIRECTIONS.map((direction) => [direction.n, direction.angleDeg])).toEqual([
			[1, 270], [2, 330], [3, 30], [4, 90], [5, 150], [6, 210]
		]);
		const [rightX, rightY] = polarOffset(75, 0);
		expect(rightX).toBeCloseTo(75, 6);
		expect(rightY).toBeCloseTo(0, 6);
		const [downX, downY] = polarOffset(75, 90);
		expect(downX).toBeCloseTo(0, 6);
		expect(downY).toBeCloseTo(75, 6);
		const [upX, upY] = polarOffset(75, 270);
		expect(upX).toBeCloseTo(0, 6);
		expect(upY).toBeCloseTo(-75, 6);
	});

	test('CLI and UI share arbitrary Cartesian, polar, absolute, and hex target math', () => {
		const current = [300, 300] as const;
		expect(traverseTarget(current, 75, { kind: 'xy', dx: 20, dy: -30 }).point).toEqual([320, 270]);
		expect(traverseTarget(current, 75, { kind: 'absolute', point: [111, 222] }).point).toEqual([111, 222]);
		const polar = traverseTarget(current, 75, { kind: 'polar', distance: 100, angleDeg: 90 }).point;
		expect(polar[0]).toBeCloseTo(300, 6);
		expect(polar[1]).toBeCloseTo(400, 6);
		const hex = traverseTarget(current, 75, { kind: 'hex', neighbor: 1 }).point;
		expect(hex[0]).toBeCloseTo(300, 6);
		expect(hex[1]).toBeCloseTo(225, 6);
		expect(traversalNeighbors(current, 75).map((neighbor) => neighbor.n)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	test('renders one current tile plus six numbered neighboring views', () => {
		const width = 600;
		const height = 600;
		const data = new Uint8Array(width * height * 4);
		for (let i = 0; i < data.length; i += 4) {
			data[i] = 30;
			data[i + 1] = 60;
			data[i + 2] = 90;
			data[i + 3] = 255;
		}
		const dir = mkdtempSync(join(tmpdir(), 'lab-traverse-'));
		const output = join(dir, 'traverse.png');
		renderTraverseScope({
			raster: { width, height, data, imageId: CANONICAL.imageId },
			imagePath: '/tmp/course.png',
			canonical: CANONICAL,
			current: [300, 300],
			radiusPx: 75,
			grid: false,
			tileOutputPx: 100,
			outputPath: output
		});
		const png = PNG.sync.read(readFileSync(output));
		expect(png.width).toBeGreaterThan(300);
		expect(png.height).toBeGreaterThan(300);
		const sidecar = JSON.parse(readFileSync(`${output}.json`, 'utf8'));
		expect(sidecar.current).toEqual([300, 300]);
		expect(Object.keys(sidecar.centers).sort()).toEqual(['0', '1', '2', '3', '4', '5', '6']);
		expect(sidecar.radiusPx).toBe(75);
	});
});
