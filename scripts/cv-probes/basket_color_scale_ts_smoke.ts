import assert from 'node:assert/strict';
import { estimateBasketTemplateScaleFromColor } from '../../src/lib/autoAnnotation/basketColorScale';
import type { BasketColorRaster } from '../../src/lib/autoAnnotation/basketColorScale';

const basket = [231, 234, 241, 255] as const;
const background = [70, 105, 63, 255] as const;

function raster(widthPx: number, heightPx: number): BasketColorRaster {
	const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
	for (let offset = 0; offset < rgba.length; offset += 4) rgba.set(background, offset);
	return { rgba, widthPx, heightPx };
}

function fill(image: BasketColorRaster, x0: number, y0: number, width: number, height: number): void {
	for (let y = y0; y < y0 + height; y += 1) {
		for (let x = x0; x < x0 + width; x += 1) {
			image.rgba.set(basket, (y * image.widthPx + x) * 4);
		}
	}
}

const template = raster(30, 44);
fill(template, 4, 4, 22, 36);
const source = raster(640, 640);
for (const [x, y] of [[20, 20], [110, 20], [200, 20], [290, 20], [20, 180], [110, 180], [200, 180], [290, 180]]) {
	fill(source, x, y, 42, 67);
}

const estimate = estimateBasketTemplateScaleFromColor(source, template);
assert(estimate, 'Expected a basket color-scale estimate.');
assert(estimate.reliable, `Expected reliable estimate, got dominance=${estimate.dominance.toFixed(2)} support=${estimate.support}.`);
assert(estimate.scale > 1.82 && estimate.scale < 1.94, `Unexpected scale ${estimate.scale}.`);
console.log(JSON.stringify(estimate, null, 2));
