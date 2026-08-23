// Pure raster types + crop — no DOM. See src/lib/raster.ts in the app (the
// browser boundary: decode-from-File, canvas crop-to-object-URL) built on
// top of these.

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
