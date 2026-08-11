/**
 * ChainSpot Stitch Map re-run protection (P1-002).
 *
 * Re-running automatic arrangement must never silently destroy a manually
 * refined arrangement. This module decides when a re-run needs an explicit
 * "Replace current arrangement" decision: only when a prior automatic result
 * exists AND the current placements no longer match it (i.e. the user changed
 * something by hand). Deterministic and pure — it never mutates state, so a
 * cancelled re-run preserves crop, placements, selection, visibility, opacity,
 * and export state.
 */
import type { TilePlacement, TileSlot } from './geometry';

export type PlacementMap = Partial<Record<TileSlot, TilePlacement>>;

/**
 * True when both maps exist and every placement matches on x/y and visibility.
 * Compares whichever slots either map actually has, so this works unchanged
 * for a 2x2, 1x2, or 2x1 session without a layout parameter.
 */
export function placementsEqual(
	a: PlacementMap | null | undefined,
	b: PlacementMap | null | undefined
): boolean {
	if (!a || !b) return false;
	const slots = new Set<TileSlot>([
		...(Object.keys(a) as TileSlot[]),
		...(Object.keys(b) as TileSlot[])
	]);
	for (const slot of slots) {
		const pa = a[slot];
		const pb = b[slot];
		if (!pa || !pb) return false;
		if (pa.xPx !== pb.xPx || pa.yPx !== pb.yPx || pa.visible !== pb.visible) return false;
	}
	return true;
}

/**
 * True when a re-run must ask the user first: there is a prior automatic result
 * and the current placements were refined away from it. An empty session or a
 * session still holding the last automatic result needs no confirmation.
 */
export function requiresReplaceDecision(
	current: PlacementMap | null | undefined,
	lastAuto: PlacementMap | null | undefined
): boolean {
	if (!lastAuto) return false;
	if (!current) return false;
	return !placementsEqual(current, lastAuto);
}
