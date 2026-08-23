/**
 * Badge glyph extraction — the exact logic scripts/nuthing/build-manifest.ts
 * used to materialize the manifest's glyph masks, as a browser-portable
 * function so runtime badge reading and the training data share one
 * definition: interior = bounding box of dark pixels inside the badge bbox;
 * glyph = bright pixels inside that interior that are NOT part of the badge
 * frame component.
 */

import type { Mask } from '../raster';
import type { ComponentStats } from '../components';

export interface BadgeGlyph {
	/** [x, y, w, h] of the dark interior in image coordinates; w=h=0 if none. */
	interiorBbox: [number, number, number, number];
	/** Binary glyph mask of size interior w*h (row-major). */
	mask: Mask;
}

export function extractBadgeGlyph(
	badge: ComponentStats,
	brightMask: Mask,
	darkMask: Mask,
	brightLabels: Int32Array
): BadgeGlyph {
	const width = brightMask.width;
	let ix0 = badge.bboxX + badge.bboxW;
	let iy0 = badge.bboxY + badge.bboxH;
	let ix1 = badge.bboxX - 1;
	let iy1 = badge.bboxY - 1;
	for (let y = badge.bboxY; y < badge.bboxY + badge.bboxH; y++) {
		const row = y * width;
		for (let x = badge.bboxX; x < badge.bboxX + badge.bboxW; x++) {
			if (darkMask.data[row + x]) {
				if (x < ix0) ix0 = x;
				if (y < iy0) iy0 = y;
				if (x > ix1) ix1 = x;
				if (y > iy1) iy1 = y;
			}
		}
	}
	if (ix1 < ix0 || iy1 < iy0) {
		return {
			interiorBbox: [0, 0, 0, 0],
			mask: { width: 0, height: 0, data: new Uint8Array(0) }
		};
	}
	const iw = ix1 - ix0 + 1;
	const ih = iy1 - iy0 + 1;
	const data = new Uint8Array(iw * ih);
	for (let y = 0; y < ih; y++) {
		const src = (iy0 + y) * width;
		for (let x = 0; x < iw; x++) {
			const i = src + (ix0 + x);
			if (brightMask.data[i] && brightLabels[i] !== badge.label) {
				data[y * iw + x] = 1;
			}
		}
	}
	return { interiorBbox: [ix0, iy0, iw, ih], mask: { width: iw, height: ih, data } };
}
