// Browser decode adapter — File -> InputAsset. DOM/browser-only (File, Web
// Crypto, createImageBitmap, OffscreenCanvas). This is the canonical browser
// decode implementation for the Detector contract's ImageId rule: imageId is
// the sha256 hex of the RAW SOURCE FILE BYTES, never the decoded pixels.
//
// Reachable ONLY via the explicit subpath export '@chainspot/alg/adapters/browser'
// (see package.json's "exports" map) — deliberately NOT re-exported from the
// package's main barrel (index.ts), which must stay importable in a browser
// bundle that also, e.g., excludes this file's Node counterpart. This mirrors
// the discipline already applied to detectors/**: DOM-touching code lives
// behind a subpath, never the bare specifier.
//
// This file needs the DOM lib (File, OffscreenCanvas, createImageBitmap,
// crypto.subtle) for type-checking even though the package's tsconfig lib
// list is ES2022-only (the core must type-check without DOM assumptions);
// the reference directive below scopes that in per-file rather than
// widening the whole package's lib setting.
/// <reference lib="dom" />

import type { InputAsset } from '../g0/inputAsset';

/** Decode a browser File to an InputAsset (RGBA pixels + content-addressed imageId). */
export async function decodeBrowserFile(file: File): Promise<InputAsset> {
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
		return {
			imageId,
			widthPx: bitmap.width,
			heightPx: bitmap.height,
			rgba: data,
			sourceByteLength: bytes.byteLength
		};
	} finally {
		bitmap.close();
	}
}
