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

const CANONICAL = {
	imageId: 'a'.repeat(64),
	widthPx: 200,
	heightPx: 200,
	stripChrome: { source: 'none', insets: null },
	autoStitch: { sourceCount: 1, hadFallback: false }
} as const;

function panelCenters(outputSizes: readonly number[]): readonly (readonly [number, number])[] {
	const CHROME = 8;
	const LABEL_H = 24;
	const MAIN_GAP = 18;
	const FORENSIC_GAP = 6;
	const main = outputSizes.slice(0, 2);
	const forensic = outputSizes.slice(2);
	const centers: [number, number][] = main.map((size, index) => [
		main.slice(0, index).reduce((x, prior) => x + prior + CHROME * 2 + MAIN_GAP, 0) + CHROME + size / 2,
		LABEL_H + CHROME + size / 2
	]);
	const forensicX = main.reduce((x, size, index) => x + size + CHROME * 2 + (index < main.length - 1 ? MAIN_GAP : 0), 0) + MAIN_GAP;
	let forensicY = 0;
	for (const size of forensic) {
		centers.push([forensicX + CHROME + size / 2, forensicY + LABEL_H + CHROME + size / 2]);
		forensicY += LABEL_H + size + CHROME * 2 + FORENSIC_GAP;
	}
	return centers;
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
		const meta = renderScope({ raster: { width, height, data }, imagePath: '/tmp/raster.png', canonical: CANONICAL, request, outputPath: output });
		const png = PNG.sync.read(readFileSync(output));
		const centers = panelCenters(meta.panels.map((panel) => panel.outputPx));

		for (const [cx, cy] of centers.slice(2)) {
			expect(pixel(png, cx, cy)).toEqual([17, 23, 31, 255]);
			expect(pixel(png, cx - 5, cy)).toEqual([255, 235, 90, 255]);
			expect(pixel(png, cx + 5, cy)).toEqual([255, 235, 90, 255]);
		}
	});

	test('pins never enter forensic panels', () => {
		const width = 200;
		const height = 200;
		const data = new Uint8Array(width * height * 4).fill(40);
		for (let i = 3; i < data.length; i += 4) data[i] = 255;
		const request: ScopeResolvedRequest = {
			name: 'pin-evidence',
			kind: 'point',
			focus: { x: 100, y: 100, w: 1, h: 1 },
			points: [[100, 100]],
			template: 'default',
			color: 0,
			richOverlay: false
		};
		const dir = mkdtempSync(join(tmpdir(), 'lab-scope-pin-'));
		const output = join(dir, 'scope.png');
		const meta = renderScope({
			raster: { width, height, data },
			imagePath: '/tmp/raster.png',
			canonical: CANONICAL,
			request,
			pins: [{ name: 'maybe', point: [100, 100], kind: 'temp', style: 'ring-dot', ttlRemaining: 2 }],
			outputPath: output
		});
		const png = PNG.sync.read(readFileSync(output));
		const centers = panelCenters(meta.panels.map((panel) => panel.outputPx));
		for (const [cx, cy] of centers.slice(2)) {
			// Exact center remains the source pixel; only the forensic hairline is nearby.
			expect(pixel(png, cx, cy)).toEqual([40, 40, 40, 255]);
		}
	});
});
