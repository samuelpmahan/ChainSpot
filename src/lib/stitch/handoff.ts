/**
 * ChainSpot pending Stitch Map handoff (P05-002).
 *
 * A tiny module-level store carrying the stitched PNG blob from /stitch-map to
 * whichever downstream stage owns `targetRole` — /annotate-round for
 * `source-overview`, /create-graphics for `target-basemap` — across
 * client-side navigation. Survives SPA route changes; a full page reload
 * clears it (stitch sessions are deliberately never persisted). The item is
 * consumed only on a successful import or explicit dismissal on the
 * destination page; a cancelled replacement leaves it available.
 */
import type { ImageRole } from '../domain/project';

export interface PendingHandoff {
	readonly blob: Blob;
	readonly fileName: string;
	readonly targetRole: ImageRole;
}

let pending: PendingHandoff | null = null;

/**
 * Listeners notified when a handoff is published.
 *
 * Stitch Map's own "Use as UDisc source" always navigates immediately after
 * publishing, so for years the destination's `onMount` read was sufficient.
 * The guided demo can publish while the destination is *already mounted*
 * (`/demo`'s rail arms a step the visitor is standing on), and a mounted page
 * has no reason to re-read a plain module variable — so the banner never
 * appeared and the arming reported a success the visitor could not see.
 * Publishing now announces itself, and destinations subscribe in addition to
 * their mount-time read.
 */
type PendingHandoffListener = () => void;
const listeners = new Set<PendingHandoffListener>();

export function setPendingHandoff(handoff: PendingHandoff): void {
	pending = handoff;
	for (const listener of [...listeners]) listener();
}

/**
 * Subscribes to handoff publications. Returns an unsubscribe function for the
 * caller's teardown; a destination that forgets to call it would keep a
 * destroyed component's closure alive.
 */
export function subscribePendingHandoff(listener: PendingHandoffListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getPendingHandoff(): PendingHandoff | null {
	return pending;
}

export function consumePendingHandoff(): void {
	pending = null;
}
