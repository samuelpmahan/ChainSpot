import { describe, expect, test } from 'vitest';
import type { InputAsset } from '@chainspot/alg/g0/inputAsset';
import { createS0Stage, S0_FULL_IMAGE_ADDRESS } from '@chainspot/alg/exec';
import { S0_TO_S1_ADDRESS, runS0IntakePcr } from '$lib/s0IntakePcr';

function portraitWithPhoneChrome(widthPx = 600, heightPx = 1200, chrome = 90): InputAsset {
	const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
	for (let y = 0; y < heightPx; y++) {
		for (let x = 0; x < widthPx; x++) {
			const value = y < chrome || y >= heightPx - chrome ? 30 : (x * 17 + y * 13) & 0xff;
			const offset = (y * widthPx + x) * 4;
			rgba.set([value, value, value, 255], offset);
		}
	}
	return {
		imageId: 's0-browser-phone-chrome',
		widthPx,
		heightPx,
		rgba,
		sourceByteLength: rgba.length
	};
}

describe('S0 full-to-cropped PCR', () => {
	test('runs one real crop Tick over PxC and returns the inspection receipt', async () => {
		const file = new File(['course'], 'course.png', { type: 'image/png' });
		const fullImage = portraitWithPhoneChrome();
		const accessOrder: string[] = [];
		const stage = createS0Stage(undefined, {
			write(image) {
				expect(image).toBe(fullImage);
				expect(stage.pxc.has(S0_TO_S1_ADDRESS)).toBe(true);
				accessOrder.push('cache FullImage');
			}
		});
		const run = await runS0IntakePcr({
			selectedFiles: [file],
			stage,
			decode: async () => {
				accessOrder.push('decode');
				return fullImage;
			}
		});

		expect(run.pcr.ticks.map((tick) => tick.operation.id)).toEqual([
			'source.decodeFullImage',
			'source.cropUDiscChrome',
			'source.cacheFullImage'
		]);
		expect(run.decodeTestimony.actualConsumes).toEqual(['px.source.selectedInput']);
		expect(run.testimony.actualConsumes).toEqual([S0_FULL_IMAGE_ADDRESS]);
		expect(run.testimony.actualProduces).toEqual([S0_TO_S1_ADDRESS]);
		expect(run.pxc.get(S0_FULL_IMAGE_ADDRESS)).toBe(fullImage);
		expect(run.pxc.get(S0_TO_S1_ADDRESS)).toBe(run.croppedImage);
		expect(run.cacheTestimony.actualConsumes).toEqual([S0_FULL_IMAGE_ADDRESS]);
		expect(run.cacheTestimony.actualProduces).toEqual([]);
		expect(accessOrder).toEqual(['decode', 'cache FullImage']);
		expect(run.cropReceipt).toMatchObject({
			originalPx: { width: 600, height: 1200 },
			cropMethod: 'single-phone-entropy',
			croppedPx: { width: 600 }
		});
		expect(run.cropReceipt.upperRowsRemoved).toBeGreaterThan(40);
		expect(run.cropReceipt.lowerRowsRemoved).toBeGreaterThan(40);
		expect(run.cropReceipt.totalPxRemoved).toBeGreaterThan(0);
		expect(run.cropReceipt.pctPxRemoved).toBeGreaterThan(0);
		expect('run' in run.pcr).toBe(false);
	});

	test('requires the one real S0 input', async () => {
		await expect(runS0IntakePcr({ selectedFiles: [] })).rejects.toThrow(
			'requires exactly one image'
		);
	});

	test('retains the open S0-to-S1 pixel address', () => {
		expect(S0_TO_S1_ADDRESS).toBe('px.course.canonicalPixels');
	});
});
