// Node decode adapter — file path -> InputAsset. Node-only (node:fs,
// node:crypto, jpeg-js, pngjs). Used by the LAB / CLI / test harnesses where
// there's no DOM to decode images with.
//
// Reachable ONLY via the explicit subpath export '@chainspot/alg/adapters/node'
// (see package.json's "exports" map) — deliberately NOT re-exported from the
// package's main barrel (index.ts), which must stay free of node: imports so
// it can be bundled for the browser. Format is chosen by file extension
// (case-insensitive), not by sniffing magic bytes — keep it simple.
//
// imageId matches the Detector contract's ImageId rule and the browser
// adapter: sha256 hex of the RAW SOURCE FILE BYTES, never the decoded pixels.

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { InputAsset } from '../g0/inputAsset';

function extensionOf(filePath: string): string {
	const dot = filePath.lastIndexOf('.');
	return dot === -1 ? '' : filePath.slice(dot + 1).toLowerCase();
}

/** Decode a PNG/JPEG file on disk to an InputAsset (RGBA pixels + content-addressed imageId). */
export async function decodeNodeFile(filePath: string): Promise<InputAsset> {
	const bytes = await readFile(filePath);
	const imageId = createHash('sha256').update(bytes).digest('hex');

	const ext = extensionOf(filePath);
	let widthPx: number;
	let heightPx: number;
	let rgba: Uint8ClampedArray;

	if (ext === 'jpg' || ext === 'jpeg') {
		const decoded = jpeg.decode(bytes, { useTArray: true });
		widthPx = decoded.width;
		heightPx = decoded.height;
		rgba = new Uint8ClampedArray(decoded.data);
	} else if (ext === 'png') {
		const decoded = PNG.sync.read(bytes);
		widthPx = decoded.width;
		heightPx = decoded.height;
		rgba = new Uint8ClampedArray(decoded.data);
	} else {
		throw new Error(`decodeNodeFile: unsupported file extension ".${ext}" (${filePath}); expected .png, .jpg, or .jpeg`);
	}

	return { imageId, widthPx, heightPx, rgba, sourceByteLength: bytes.byteLength };
}
