// Browser boundary for the Detector contract: original file bytes → RgbaRaster
// with a content-addressed imageId (sha256 of the bytes).

import type { RgbaRaster } from '@chainspot/alg/detect';

export async function rgbaFromFile(file: File): Promise<RgbaRaster> {
	const bytes = await file.arrayBuffer();
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	const imageId = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

	const bitmap = await createImageBitmap(file);
	try {
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('2d canvas context unavailable');
		ctx.drawImage(bitmap, 0, 0);
		const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
		return { imageId, widthPx: bitmap.width, heightPx: bitmap.height, rgba: data };
	} finally {
		bitmap.close();
	}
}
