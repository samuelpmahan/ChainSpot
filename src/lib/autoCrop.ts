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
	if (maxDepth === 0) return 0;

	// The chrome band is monotone (agree ... agree | disagree ...), so binary
	// search finds the transition in ~log2(maxDepth) probes instead of a full
	// linear walk. Each probe is majority-of-3 consecutive lines so a single
	// noisy chrome row (clock digits, spinner) can't fake the boundary. A
	// false-agree pocket deep in map content could overshoot, but the result
	// is a bounded PROPOSAL the user sees applied and can undo.
	const robustAgrees = (d: number): boolean => {
		let agree = 0;
		let probes = 0;
		for (let k = 0; k < RUN_LINES - 1 && d + k < maxDepth; k++) {
			probes++;
			if (lineAgrees(rasters, edge, d + k)) agree++;
		}
		return probes > 0 && agree * 2 > probes;
	};

	if (!robustAgrees(0)) return 0;
	let lo = 0; // deepest known agreeing depth
	let hi = maxDepth; // shallowest known disagreeing depth (or the cap)
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (robustAgrees(mid)) lo = mid;
		else hi = mid;
	}
	// the majority probe lands NEAR the boundary (it under-reaches when its
	// samples straddle into content); refine the exact edge with a short
	// linear extension of single-line checks from there
	let band = lo + 1;
	while (band < maxDepth && lineAgrees(rasters, edge, band)) band++;
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
