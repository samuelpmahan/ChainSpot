import { describe, expect, test } from 'vitest';
import basketSpriteData from '@chainspot/alg/detectors/threeFactor/assets/basket-sprite.json';
import { groupBrightDarkComponentFields } from '@chainspot/alg/detectors/threeFactor/componentField';
import type { Mask } from '@chainspot/alg/detectors/threeFactor/raster';
import { createExecBoard } from '@chainspot/alg/exec/board';
import { ComponentPxC } from '@chainspot/alg/stages/componentPxC';
import {
	executeS2BasketsCandidate,
	materializeS2Subtraction
} from '@chainspot/alg/stages/S2/candidate/index';

const template = basketSpriteData as { width: number; height: number; rows: string[] };
const width = 220;
const height = 90;

function emptyMask(): Mask {
	return { width, height, data: new Uint8Array(width * height) };
}

function drawBasket(bright: Mask, dark: Mask, x: number, y: number): void {
	for (let yy = 0; yy < template.height; yy++)
		for (let xx = 0; xx < template.width; xx++)
			if (template.rows[yy][xx] === '1') bright.data[(y + yy) * width + x + xx] = 1;
	const outerX = x - 2;
	const outerY = y - 3;
	const outerWidth = template.width + 4;
	const outerHeight = template.height + 6;
	for (let xx = outerX; xx < outerX + outerWidth; xx++) {
		dark.data[outerY * width + xx] = 1;
		dark.data[(outerY + outerHeight - 1) * width + xx] = 1;
	}
	for (let yy = outerY; yy < outerY + outerHeight; yy++) {
		dark.data[yy * width + outerX] = 1;
		dark.data[yy * width + outerX + outerWidth - 1] = 1;
	}
}

function fuseShellToNoise(dark: Mask, x: number, y: number): void {
	for (let xx = x - 12; xx < x - 2; xx++) dark.data[(y + 20) * width + xx] = 1;
}

describe('S2 Basket-native component construction', () => {
	test('finds a common shell family and stores Basket objects with defining detector references', () => {
		const bright = emptyMask();
		const dark = emptyMask();
		drawBasket(bright, dark, 8, 10);
		drawBasket(bright, dark, 80, 10);
		drawBasket(bright, dark, 152, 10);
		fuseShellToNoise(dark, 80, 10);
		const fields = groupBrightDarkComponentFields({ bright, dark });
		const pxc = createExecBoard();
		const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
		pxc.set(ComponentPxC.image, { imageId: 'synthetic', widthPx: width, heightPx: height, rgba });
		pxc.set(ComponentPxC.masks, { bright, dark });
		pxc.set(ComponentPxC.fields, fields);

		const run = executeS2BasketsCandidate(pxc);
		expect(run.family.members).toHaveLength(3);
		expect(run.shellFamily.margins).toEqual([2, 3, 2, 3]);
		expect(run.baskets).toHaveLength(3);
		expect(run.baskets[1].bbox).toEqual([78, 7, 46, 72]);
		expect(run.baskets[0].has).toMatchObject({
			detectFamily: { fn: 'fn.Basket.detectFamily' },
			findShellFamily: { fn: 'fn.Basket.findShellFamily', margins: [2, 3, 2, 3] },
			findPx: { fn: 'fn.Basket.findPx' }
		});
		expect(run.baskets[0].px.length).toBe(run.baskets[0].whitePx + run.baskets[0].blackPx);
		const subtraction = materializeS2Subtraction(run.image, run.baskets);
		expect(subtraction.basketPx).toBe(
			run.baskets.reduce((sum, basket) => sum + basket.px.length, 0)
		);
		expect(subtraction.remainingOpaquePx).toBe(width * height - subtraction.basketPx);
	});
});
