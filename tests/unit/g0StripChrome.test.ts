import { describe, expect, test } from 'vitest';
import { stripChromeProposal } from '../../packages/alg/src/g0/stripChrome';
import type { GrayRaster } from '../../packages/alg/src/raster';

function portraitWithPhoneChrome(width = 600, height = 1200, chrome = 90): GrayRaster {
	const gray = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const inChrome = y < chrome || y >= height - chrome;
			// Edge UI is intentionally low entropy; map body has a broad repeating
			// histogram so the recovered single-image detector sees a clear boundary.
			gray[y * width + x] = inChrome ? 30 : (x * 17 + y * 13) & 0xff;
		}
	}
	return { widthPx: width, heightPx: height, gray };
}

describe('G0 StripChrome', () => {
	test('strips top/bottom phone UI from a portrait capture before downstream work', () => {
		const result = stripChromeProposal([portraitWithPhoneChrome()]);
		expect(result.source).toBe('single-phone-entropy');
		expect(result.insets).not.toBeNull();
		expect(result.insets!.top).toBeGreaterThan(40);
		expect(result.insets!.bottom).toBeGreaterThan(40);
		expect(result.insets!.left).toBe(0);
		expect(result.insets!.right).toBe(0);
	});

	test('does not invent a single-image horizontal crop', () => {
		const result = stripChromeProposal([portraitWithPhoneChrome()]);
		expect(result.insets?.left ?? 0).toBe(0);
		expect(result.insets?.right ?? 0).toBe(0);
	});

	test('already-canonical/non-phone imagery passes through without fake sanitation', () => {
		const widthPx = 1000;
		const heightPx = 800;
		const gray = new Uint8Array(widthPx * heightPx);
		for (let i = 0; i < gray.length; i++) gray[i] = (i * 37) & 0xff;
		expect(stripChromeProposal([{ widthPx, heightPx, gray }])).toEqual({ insets: null, source: 'none' });
	});
});
