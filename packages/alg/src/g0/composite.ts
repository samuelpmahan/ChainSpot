// Canonical composite materialization — the capability that does not exist
// anywhere today (the app never builds real composite pixels; coordinates
// only. src/routes/lab/+page.svelte fabricates a placeholder imageId with
// Date.now() at line ~235 because nothing upstream of it produces a real
// one — that is the recorded gap this file closes for headless/package
// callers; see the GAP-CLOSED pointer left in the lab route).
//
// This is a rederivation of /lab's canvas-based flattening
// (ctx.drawImage(bitmap, insets.left, insets.top, croppedW, croppedH,
// destX, destY, croppedW, croppedH)) as pure array math, so it runs
// headlessly in Node (no OffscreenCanvas) and produces byte-identical
// output regardless of adapter. It works uniformly for one tile (a
// same-shape "composite" of a single image, e.g. Heritage — degenerate
// N=1 case) or many.
//
// Composite imageId definition (owner-confirmed, byte order explicit):
// sha256 over the concatenation of
//   [4 bytes: widthPx as an unsigned 32-bit BIG-ENDIAN integer]
//   [4 bytes: heightPx as an unsigned 32-bit BIG-ENDIAN integer]
//   [widthPx * heightPx * 4 bytes: the composite's RGBA pixels, row-major,
//    exactly as produced by materializeComposite below]
// Deterministic across platforms because it never touches a re-encoder
// (no PNG/JPEG encode step, whose output can legitimately vary by library
// version) — it hashes the raw pixel buffer this function itself produces,
// plus the two dimensions so a widthxheight transposition can't collide.
// Pinned by a known-tiny-composite test (tests/unit/g0Composite.test.ts).
//
// OperationKind: 'materialize'.

import { sha256Hex } from './hash';
import type { CropInsets } from '../raster';
import type { Placement } from './types';

export interface CompositeTile {
	/** ORIGINAL (uncropped) RGBA pixels, row-major, 4 bytes/px. */
	readonly rgba: Uint8ClampedArray;
	/** ORIGINAL (uncropped) dimensions — must match `insets` against the same crop proposal used everywhere else in the pipeline. */
	readonly widthPx: number;
	readonly heightPx: number;
	/** This tile's placement (top-left of its CROPPED region) in composite-space, pre-bbox-normalization — same units as g0/stitchSolve's Placement output. */
	readonly placement: Placement;
}

export interface CompositeResult {
	readonly imageId: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly rgba: Uint8ClampedArray;
}

const ZERO_INSETS: CropInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/** Big-endian per the documented byte definition above (network order, platform-independent). */
function u32be(n: number): Uint8Array {
	const out = new Uint8Array(4);
	out[0] = (n >>> 24) & 0xff;
	out[1] = (n >>> 16) & 0xff;
	out[2] = (n >>> 8) & 0xff;
	out[3] = n & 0xff;
	return out;
}

export function compositeIdBytes(widthPx: number, heightPx: number, rgba: Uint8ClampedArray): Uint8Array {
	const bytes = new Uint8Array(8 + rgba.length);
	bytes.set(u32be(widthPx), 0);
	bytes.set(u32be(heightPx), 4);
	bytes.set(rgba, 8);
	return bytes;
}

export async function materializeComposite(
	tiles: readonly CompositeTile[],
	insets: CropInsets | null = null
): Promise<CompositeResult> {
	if (tiles.length === 0) throw new Error('materializeComposite requires at least one tile.');
	const effectiveInsets = insets ?? ZERO_INSETS;
	const croppedW = tiles[0].widthPx - effectiveInsets.left - effectiveInsets.right;
	const croppedH = tiles[0].heightPx - effectiveInsets.top - effectiveInsets.bottom;
	if (croppedW <= 0 || croppedH <= 0) throw new Error('insets exceed tile size.');
	for (const tile of tiles) {
		if (
			tile.widthPx - effectiveInsets.left - effectiveInsets.right !== croppedW ||
			tile.heightPx - effectiveInsets.top - effectiveInsets.bottom !== croppedH
		) {
			throw new Error('materializeComposite requires all tiles to crop to the same size.');
		}
	}

	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const tile of tiles) {
		x0 = Math.min(x0, tile.placement.x);
		y0 = Math.min(y0, tile.placement.y);
		x1 = Math.max(x1, tile.placement.x + croppedW);
		y1 = Math.max(y1, tile.placement.y + croppedH);
	}
	const widthPx = Math.ceil(x1 - x0);
	const heightPx = Math.ceil(y1 - y0);
	const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);

	for (const tile of tiles) {
		const destX0 = Math.round(tile.placement.x - x0);
		const destY0 = Math.round(tile.placement.y - y0);
		for (let sy = 0; sy < croppedH; sy++) {
			const dy = destY0 + sy;
			if (dy < 0 || dy >= heightPx) continue;
			const srcRowStart = ((sy + effectiveInsets.top) * tile.widthPx + effectiveInsets.left) * 4;
			for (let sx = 0; sx < croppedW; sx++) {
				const dx = destX0 + sx;
				if (dx < 0 || dx >= widthPx) continue;
				const srcIdx = srcRowStart + sx * 4;
				const dstIdx = (dy * widthPx + dx) * 4;
				rgba[dstIdx] = tile.rgba[srcIdx];
				rgba[dstIdx + 1] = tile.rgba[srcIdx + 1];
				rgba[dstIdx + 2] = tile.rgba[srcIdx + 2];
				rgba[dstIdx + 3] = tile.rgba[srcIdx + 3];
			}
		}
	}

	const imageId = await sha256Hex(compositeIdBytes(widthPx, heightPx, rgba));
	return { imageId, widthPx, heightPx, rgba };
}
