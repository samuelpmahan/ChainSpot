// Browser boundary for pixel access. Everything downstream (autoCrop, stitch)
// is pure math over GrayRaster and never touches the DOM — those pure types
// and cropRaster now live in @chainspot/alg (CHSPT-82 Wave 0 ownership
// inversion); this file keeps only the browser-bound pieces (canvas/File/
// ImageBitmap access).

import type { LoadedImage } from '$lib/image';
import type { GrayRaster, CropInsets } from '@chainspot/alg';

function drawToCanvas(bitmap: ImageBitmap): OffscreenCanvasRenderingContext2D {
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('2d canvas context unavailable');
	ctx.drawImage(bitmap, 0, 0);
	return ctx;
}

/** Decode to a grayscale raster (full resolution). */
export async function rasterFromFile(file: File): Promise<GrayRaster> {
	const bitmap = await createImageBitmap(file);
	try {
		const ctx = drawToCanvas(bitmap);
		const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
		const gray = new Uint8Array(bitmap.width * bitmap.height);
		for (let i = 0; i < gray.length; i++) {
			const o = i * 4;
			// integer Rec.601 luma
			gray[i] = (data[o] * 77 + data[o + 1] * 150 + data[o + 2] * 29) >> 8;
		}
		return { widthPx: bitmap.width, heightPx: bitmap.height, gray };
	} finally {
		bitmap.close();
	}
}

/**
 * Produce a cropped copy of an image as a fresh object URL.
 * Caller owns the returned URL (revoke it like any other).
 */
export async function croppedObjectUrl(image: LoadedImage, insets: CropInsets): Promise<string> {
	const bitmap = await createImageBitmap(image.file);
	try {
		const w = bitmap.width - insets.left - insets.right;
		const h = bitmap.height - insets.top - insets.bottom;
		if (w <= 0 || h <= 0) throw new Error('insets exceed image size');
		const canvas = new OffscreenCanvas(w, h);
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('2d canvas context unavailable');
		ctx.drawImage(bitmap, -insets.left, -insets.top);
		const blob = await canvas.convertToBlob({ type: 'image/png' });
		return URL.createObjectURL(blob);
	} finally {
		bitmap.close();
	}
}
