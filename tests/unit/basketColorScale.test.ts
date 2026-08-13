import { describe, expect, it } from 'vitest';
import {
	estimateBasketTemplateScaleFromColor,
	extractBasketColorComponents,
	isBasketColorPixel
} from '../../src/lib/autoAnnotation/basketColorScale';
import type { BasketColorRaster } from '../../src/lib/autoAnnotation/basketColorScale';

const BASKET = [231, 234, 241, 255] as const;
const BACKGROUND = [70, 105, 63, 255] as const;

function raster(widthPx: number, heightPx: number): BasketColorRaster {
	const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
	for (let offset = 0; offset < rgba.length; offset += 4) {
		rgba[offset] = BACKGROUND[0];
		rgba[offset + 1] = BACKGROUND[1];
		rgba[offset + 2] = BACKGROUND[2];
		rgba[offset + 3] = BACKGROUND[3];
	}
	return { rgba, widthPx, heightPx };
}

function fillRect(
	rasterValue: BasketColorRaster,
	xPx: number,
	yPx: number,
	widthPx: number,
	heightPx: number,
	color: readonly [number, number, number, number] = BASKET
): void {
	for (let y = yPx; y < yPx + heightPx; y += 1) {
		for (let x = xPx; x < xPx + widthPx; x += 1) {
			const offset = (y * rasterValue.widthPx + x) * 4;
			rasterValue.rgba[offset] = color[0];
			rasterValue.rgba[offset + 1] = color[1];
			rasterValue.rgba[offset + 2] = color[2];
			rasterValue.rgba[offset + 3] = color[3];
		}
	}
}

function basketTemplate(): BasketColorRaster {
	const template = raster(30, 44);
	fillRect(template, 4, 4, 22, 36);
	return template;
}

describe('basket color scale bootstrap', () => {
	it('matches the measured cool off-white basket family rather than literal white', () => {
		expect(isBasketColorPixel(231, 234, 241)).toBe(true);
		expect(isBasketColorPixel(255, 255, 255)).toBe(true);
		expect(isBasketColorPixel(140, 210, 140)).toBe(false);
		expect(isBasketColorPixel(180, 182, 186)).toBe(false);
		expect(isBasketColorPixel(231, 234, 241, 0)).toBe(false);
	});

	it('uses 8-connectivity when extracting repeated color components', () => {
		const source = raster(8, 8);
		fillRect(source, 1, 1, 1, 1);
		fillRect(source, 2, 2, 1, 1);
		const components = extractBasketColorComponents(source);
		expect(components).toHaveLength(1);
		expect(components[0]).toMatchObject({ widthPx: 2, heightPx: 2, areaPx: 2 });
	});

	it('recovers a strong repeated basket mode at the measured template scale', () => {
		const source = raster(520, 360);
		const basketOrigins = [
			[20, 20], [110, 20], [200, 20], [290, 20],
			[20, 150], [110, 150], [200, 150], [290, 150]
		] as const;
		for (const [x, y] of basketOrigins) fillRect(source, x, y, 42, 67);

		const estimate = estimateBasketTemplateScaleFromColor(source, basketTemplate());
		expect(estimate).not.toBeNull();
		expect(estimate!.scale).toBeGreaterThan(1.82);
		expect(estimate!.scale).toBeLessThan(1.94);
		expect(estimate!.representativeSource).toEqual({ widthPx: 42, heightPx: 67 });
		expect(estimate!.representativeTemplate).toEqual({ widthPx: 22, heightPx: 36 });
		expect(estimate!.support).toBe(8);
		expect(estimate!.reliable).toBe(true);
	});

	it('chooses coherent component mass over a larger count of tiny repeated distractors, but abstains when the modes are too close', () => {
		const source = raster(520, 360);
		const basketOrigins = [
			[20, 20], [110, 20], [200, 20],
			[20, 150], [110, 150], [200, 150]
		] as const;
		for (const [x, y] of basketOrigins) fillRect(source, x, y, 42, 67);

		// Deliberately more numerous than the real basket components. The weighted
		// mode should still select the large family, while the conservative
		// reliability guard rejects this artificially coherent two-scale scene.
		for (let index = 0; index < 8; index += 1) {
			fillRect(source, 330 + (index % 4) * 40, 20 + Math.floor(index / 4) * 80, 13, 21);
		}

		const estimate = estimateBasketTemplateScaleFromColor(source, basketTemplate());
		expect(estimate).not.toBeNull();
		expect(estimate!.scale).toBeGreaterThan(1.82);
		expect(estimate!.scale).toBeLessThan(1.94);
		expect(estimate!.support).toBe(6);
		expect(estimate!.weight).toBeGreaterThan(estimate!.secondWeight);
		expect(estimate!.reliable).toBe(false);
	});

	it('refuses to trust a single accidental component', () => {
		const source = raster(160, 120);
		fillRect(source, 30, 25, 42, 67);
		const estimate = estimateBasketTemplateScaleFromColor(source, basketTemplate());
		expect(estimate).not.toBeNull();
		expect(estimate!.support).toBe(1);
		expect(estimate!.reliable).toBe(false);
	});
});
