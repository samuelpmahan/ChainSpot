/**
 * ChainSpot pending/active AnnotatedRound session (Ticket 1 route split).
 *
 * Two module-level in-memory slots carrying the AnnotatedRound artifact
 * across client-side navigation between /annotate-round and /create-graphics,
 * mirroring src/lib/stitch/handoff.ts's vocabulary and pattern. `pending` is
 * the one-shot crossing slot: Annotate Round sets it on Done, Create Graphics
 * reads it on mount and consumes it after importing. `active` is
 * longer-lived: Create Graphics sets it once the artifact is imported, and it
 * survives Create Graphics <-> Stitch Map round trips for future tickets to
 * read. Both survive SPA route changes; a full page reload clears them
 * (annotation sessions are deliberately never persisted).
 */
import type { AnnotatedRound } from './domain/annotatedRound';

let pending: AnnotatedRound | null = null;
let active: AnnotatedRound | null = null;

export function setPendingAnnotatedRound(round: AnnotatedRound): void {
	pending = round;
}

export function getPendingAnnotatedRound(): AnnotatedRound | null {
	return pending;
}

export function consumePendingAnnotatedRound(): void {
	pending = null;
}

export function setActiveAnnotatedRound(round: AnnotatedRound): void {
	active = round;
}

export function getActiveAnnotatedRound(): AnnotatedRound | null {
	return active;
}
