// G0 canonical intake — the shape both decode adapters produce.
//
// InputAsset is deliberately a strict superset of the Detector contract's
// RgbaRaster (detect.ts): every G0 operation and every existing detector
// can take an InputAsset wherever an RgbaRaster is expected, with no
// conversion step. The one field it adds, sourceByteLength, is provenance
// only (never consulted by any pure kernel) — it lets callers sanity-check
// a decode against the original file size and lets the truth-firewall test
// assert that attaching truth never changes what gets decoded.
//
// Both adapters (adapters/node.ts, adapters/browser.ts) must produce this
// exact shape from raw file bytes: imageId is the sha256 hex of the RAW
// SOURCE BYTES (not the decoded pixels — two different encodings of the
// same picture are two different files here), matching the Detector
// contract's ImageId rule and today's src/lib/rgba.ts behavior.

import type { RgbaRaster } from '../detect';
import type { GrayRaster } from '../raster';

export interface InputAsset extends RgbaRaster {
	/** Byte length of the original encoded file (PNG/JPEG), before decode. */
	readonly sourceByteLength: number;
}

/**
 * Derive a GrayRaster (crop/stitch's input shape) from an already-decoded
 * RGBA asset, integer Rec.601 luma — the same formula src/lib/raster.ts
 * uses browser-side. Exists so a Node/headless caller can decode a file
 * ONCE (via decodeNodeFile) and feed the same pixels to both RGBA-based
 * detectors and gray-based crop/stitch, rather than decoding twice.
 */
export function toGrayRaster(asset: Pick<RgbaRaster, 'widthPx' | 'heightPx' | 'rgba'>): GrayRaster {
	const { widthPx, heightPx, rgba } = asset;
	const gray = new Uint8Array(widthPx * heightPx);
	for (let i = 0; i < gray.length; i++) {
		const o = i * 4;
		gray[i] = (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
	}
	return { widthPx, heightPx, gray };
}
