import { describe, expect, test } from 'vitest';
import { proposeSharedCrop } from '@chainspot/alg/autoCrop';
import type { GrayRaster } from '@chainspot/alg';

function screenshotLikeRaster(tileNumber: number, widthPx = 24, heightPx = 20): GrayRaster {
	const gray = new Uint8Array(widthPx * heightPx);

	for (let y = 0; y < heightPx; y++) {
		for (let x = 0; x < widthPx; x++) {
			const isSharedChrome = y < 3 || y >= heightPx - 2;
			gray[y * widthPx + x] = isSharedChrome
				? 40 + y
				: (tileNumber * 97 + x * 11 + y * 7) % 256;
		}
	}

	return { widthPx, heightPx, gray };
}

describe('proposeSharedCrop', () => {
	test('proposes only the shared top and bottom phone-chrome bands', () => {
		expect(proposeSharedCrop([screenshotLikeRaster(0), screenshotLikeRaster(1)])).toEqual({
			top: 3,
			right: 0,
			bottom: 2,
			left: 0
		});
	});

	test('declines rasters with different dimensions', () => {
		expect(proposeSharedCrop([screenshotLikeRaster(0), screenshotLikeRaster(1, 25)])).toBeNull();
	});

	test('declines a set with no shared edge band', () => {
		const withoutChrome = screenshotLikeRaster(0);
		const otherWithoutChrome = screenshotLikeRaster(1);
		for (let y = 0; y < withoutChrome.heightPx; y++) {
			for (let x = 0; x < withoutChrome.widthPx; x++) {
				withoutChrome.gray[y * withoutChrome.widthPx + x] = (x * 13 + y * 17) % 256;
				otherWithoutChrome.gray[y * otherWithoutChrome.widthPx + x] =
					(101 + x * 13 + y * 17) % 256;
			}
		}

		expect(proposeSharedCrop([withoutChrome, otherWithoutChrome])).toBeNull();
	});
});
