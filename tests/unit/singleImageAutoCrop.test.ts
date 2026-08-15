import { describe, expect, test } from 'vitest';
import { SingleImageCropError, renderCroppedImage } from '../../src/lib/singleImageAutoCrop';
import type { StitchRenderEnv } from '../../src/lib/stitch/render';

function fakeEnv(overrides?: {
	drawImage?: (...args: unknown[]) => void;
	getContext?: () => object | null;
	toBlob?: StitchRenderEnv['toBlob'];
}): { env: StitchRenderEnv; canvas: { width: number; height: number } } {
	const drawImage = overrides?.drawImage ?? (() => {});
	const canvas = { width: 0, height: 0 };
	const context = { drawImage };
	const getContext = overrides?.getContext ?? (() => context);
	return {
		canvas,
		env: {
			createCanvas: () =>
				({
					get width() {
						return canvas.width;
					},
					set width(value: number) {
						canvas.width = value;
					},
					get height() {
						return canvas.height;
					},
					set height(value: number) {
						canvas.height = value;
					},
					getContext
				}) as unknown as HTMLCanvasElement,
			toBlob: overrides?.toBlob ?? (async () => new Blob(['cropped']))
		}
	};
}

describe('single-image crop rendering (annotate-course / annotate-round uploads)', () => {
	test('draws the inset source rectangle at native resolution onto a same-size canvas', async () => {
		const drawCalls: unknown[][] = [];
		const { env, canvas } = fakeEnv({ drawImage: (...args) => drawCalls.push(args) });
		const image = {} as HTMLImageElement;

		const blob = await renderCroppedImage(
			image,
			600,
			1200,
			{ topPx: 100, rightPx: 0, bottomPx: 80, leftPx: 0 },
			'image/png',
			env
		);

		expect(canvas.width).toBe(600);
		expect(canvas.height).toBe(1020);
		expect(drawCalls).toHaveLength(1);
		expect(drawCalls[0]).toEqual([image, 0, 100, 600, 1020, 0, 0, 600, 1020]);
		expect(blob).toBeInstanceOf(Blob);
	});

	test('rejects a crop that removes the entire image, before touching the canvas', async () => {
		const { env } = fakeEnv();
		const image = {} as HTMLImageElement;
		await expect(
			renderCroppedImage(image, 600, 1200, { topPx: 700, rightPx: 0, bottomPx: 700, leftPx: 0 }, 'image/png', env)
		).rejects.toThrow(SingleImageCropError);
	});

	test('surfaces a canvas-context failure as SingleImageCropError', async () => {
		const { env } = fakeEnv({ getContext: () => null });
		const image = {} as HTMLImageElement;
		await expect(
			renderCroppedImage(image, 600, 1200, { topPx: 10, rightPx: 0, bottomPx: 10, leftPx: 0 }, 'image/png', env)
		).rejects.toThrow(SingleImageCropError);
	});

	test('surfaces an encode failure (toBlob resolving null) as SingleImageCropError', async () => {
		const { env } = fakeEnv({ toBlob: async () => null });
		const image = {} as HTMLImageElement;
		await expect(
			renderCroppedImage(image, 600, 1200, { topPx: 10, rightPx: 0, bottomPx: 10, leftPx: 0 }, 'image/png', env)
		).rejects.toThrow(SingleImageCropError);
	});
});
