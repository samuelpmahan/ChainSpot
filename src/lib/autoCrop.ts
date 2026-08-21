// Minimal 2+ tile shared-chrome crop proposal. Pure — no DOM; CLI/Vitest can
// feed synthetic rasters.
//
// Evidence model (rederived from the old app's idea, hardening dropped): under
// the capture protocol every screenshot is the same device/orientation/zoom,
// so app chrome is bit-identical at fixed screen coordinates across captures
// while map content moves. Scan inward from each edge; while the tiles agree
// on a line, it's chrome; the first sustained disagreement is map content.
// The result is a proposal — the caller must get explicit user confirmation.

import type { GrayRaster, CropInsets } from '$lib/raster';

/** Max fraction of a dimension an inset may consume. */
const MAX_INSET_FRACTION = 0.25;
/** A pixel "agrees" when the value range across tiles is within this. */
const AGREE_MAX_RANGE = 12;
/** A line is chrome when at least this fraction of its pixels agree. */
const AGREE_MIN_FRACTION = 0.6;
/** Lines of sustained disagreement that end a chrome band. */
const RUN_LINES = 4;
/** A proposed band must be at least this deep to be worth proposing. */
const MIN_BAND_PX = 2;

type Edge = 'top' | 'bottom' | 'left' | 'right';

function lineAgrees(rasters: GrayRaster[], edge: Edge, depth: number): boolean {
	const { widthPx: w, heightPx: h } = rasters[0];
	const horizontal = edge === 'top' || edge === 'bottom';
	const len = horizontal ? w : h;
	let agree = 0;
	for (let j = 0; j < len; j++) {
		let min = 255;
		let max = 0;
		for (const r of rasters) {
			let x: number, y: number;
			if (edge === 'top') (x = j), (y = depth);
			else if (edge === 'bottom') (x = j), (y = h - 1 - depth);
			else if (edge === 'left') (x = depth), (y = j);
			else (x = w - 1 - depth), (y = j);
			const v = r.gray[y * w + x];
			if (v < min) min = v;
			if (v > max) max = v;
		}
		if (max - min <= AGREE_MAX_RANGE) agree++;
	}
	return agree / len >= AGREE_MIN_FRACTION;
}

function scanEdge(rasters: GrayRaster[], edge: Edge): number {
	const { widthPx: w, heightPx: h } = rasters[0];
	const maxDepth = Math.floor((edge === 'top' || edge === 'bottom' ? h : w) * MAX_INSET_FRACTION);
	let band = 0;
	let disagreeRun = 0;
	for (let d = 0; d < maxDepth; d++) {
		if (lineAgrees(rasters, edge, d)) {
			band = d + 1;
			disagreeRun = 0;
		} else if (++disagreeRun >= RUN_LINES) {
			break;
		}
	}
	return band >= MIN_BAND_PX ? band : 0;
}

/**
 * Propose shared insets for N >= 2 same-sized rasters.
 * Returns null when sizes differ or nothing crops.
 */
export function proposeSharedCrop(rasters: GrayRaster[]): CropInsets | null {
	if (rasters.length < 2) return null;
	const { widthPx, heightPx } = rasters[0];
	if (!rasters.every((r) => r.widthPx === widthPx && r.heightPx === heightPx)) return null;

	const insets: CropInsets = {
		top: scanEdge(rasters, 'top'),
		bottom: scanEdge(rasters, 'bottom'),
		left: scanEdge(rasters, 'left'),
		right: scanEdge(rasters, 'right')
	};
	const any = insets.top || insets.bottom || insets.left || insets.right;
	return any ? insets : null;
}
