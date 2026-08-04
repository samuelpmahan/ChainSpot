/**
 * ChainSpot pending Stitch Map handoff (P05-002).
 *
 * A tiny module-level store carrying the stitched PNG blob from /stitch-map to
 * /spot-round across client-side navigation. Survives SPA route changes; a full
 * page reload clears it (stitch sessions are deliberately never persisted). The
 * item is consumed only on a successful Spot Round import or explicit dismissal;
 * a cancelled replacement leaves it available.
 */
import type { ImageRole } from '../domain/project';

export interface PendingHandoff {
	readonly blob: Blob;
	readonly fileName: string;
	readonly targetRole: ImageRole;
}

let pending: PendingHandoff | null = null;

export function setPendingHandoff(handoff: PendingHandoff): void {
	pending = handoff;
}

export function getPendingHandoff(): PendingHandoff | null {
	return pending;
}

export function consumePendingHandoff(): void {
	pending = null;
}
