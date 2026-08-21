// Browser boundary for pixel access. Everything downstream (autoCrop, stitch)
// is pure math over GrayRaster and never touches the DOM.

import type { LoadedImage } from '$lib/image';

export interface GrayRaster {
	readonly widthPx: number;
	readonly heightPx: number;
	/** Row-major luma, one byte per pixel: gray[y * widthPx + x]. */
	readonly gray: Uint8Array;
}

export interface CropInsets {
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly left: number;
}

/** Pure raster crop (no DOM) — feed autoCrop-confirmed insets to stitch. */
export function cropRaster(r: GrayRaster, insets: CropInsets): GrayRaster {
	const w = r.widthPx - insets.left - insets.right;
	const h = r.heightPx - insets.top - insets.bottom;
	if (w <= 0 || h <= 0) throw new Error('insets exceed raster size');
	const gray = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		gray.set(r.gray.subarray((y + insets.top) * r.widthPx + insets.left, (y + insets.top) * r.widthPx + insets.left + w), y * w);
	}
	return { widthPx: w, heightPx: h, gray };
}

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
