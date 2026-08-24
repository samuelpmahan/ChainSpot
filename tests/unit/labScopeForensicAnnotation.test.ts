import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, test } from 'vitest';
import { renderScope } from '../../scripts/chainspot-lab/scope/render';
import type { ScopeResolvedRequest } from '../../scripts/chainspot-lab/scope/types';

function pixel(png: PNG, x: number, y: number): readonly number[] {
	const i = (y * png.width + x) * 4;
	return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

describe('LAB scope forensic annotation', () => {
	test('hairline target points at evidence without painting over the exact anchor pixel', () => {
		const width = 200;
		const height = 200;
		const data = new Uint8Array(width * height * 4);
		for (let i = 0; i < data.length; i += 4) {
			data[i] = 17;
			data[i + 1] = 23;
			data[i + 2] = 31;
			data[i + 3] = 255;
		}
		const request: ScopeResolvedRequest = {
			name: 'anchor',
			kind: 'point',
			focus: { x: 100, y: 100, w: 1, h: 1 },
			points: [[100, 100]],
			template: 'default',
			color: 0
		};
		const dir = mkdtempSync(join(tmpdir(), 'lab-scope-forensic-'));
		const output = join(dir, 'scope.png');
		renderScope({ raster: { width, height, data }, imagePath: '/tmp/raster.png', request, outputPath: output });
		const png = PNG.sync.read(readFileSync(output));

		// context frame 340 + gap 18 + local frame 340 + gap 18 = forensic-wide x=716.
		// 160px forensic content has 10px chrome and is vertically centered in the 340px canvas.
		const forensicCenters: readonly (readonly [number, number])[] = [
			[806, 170],
			[992, 170],
			[1178, 170]
		];
		for (const [cx, cy] of forensicCenters) {
			expect(pixel(png, cx, cy)).toEqual([17, 23, 31, 255]);
			expect(pixel(png, cx - 5, cy)).toEqual([255, 235, 90, 255]);
			expect(pixel(png, cx + 5, cy)).toEqual([255, 235, 90, 255]);
		}
	});
});
