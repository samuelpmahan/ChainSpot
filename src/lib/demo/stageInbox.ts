/**
 * ChainSpot demo stage inbox.
 *
 * One module-level, one-shot slot carrying demo-loaded files across the
 * client-side navigation from `/demo` (or the guide rail) to `/stitch-map`,
 * mirroring `src/lib/stitch/handoff.ts`'s vocabulary and lifetime exactly.
 * Survives SPA route changes; a full page reload clears it.
 *
 * Only Stitch Map needs an inbox. The two downstream stages already accept an
 * externally supplied image through the product's own pending-handoff store, so
 * the demo reuses that rather than inventing a parallel path — the fewer seams
 * the demo owns, the less of the demo can drift away from the real product.
 *
 * The slot carries plain `File`s, which Stitch Map hands to the same Smart
 * Import entry point its own file input uses. It deliberately does not carry
 * decoded images, placements, crops, or any precomputed result: the arrangement
 * a visitor sees must be one the product just computed in front of them.
 */

let pendingStitchCaptures: File[] | null = null;

/**
 * Listeners notified when captures are deposited, mirroring
 * `stitch/handoff.ts`'s subscription for the same reason: the rail can arm a
 * step the visitor is already standing on, and a mounted Stitch Map has no
 * reason to re-read a plain module variable. Without this the visitor clicks
 * "Load the real inputs", is told it worked, and watches nothing happen.
 */
type StitchCaptureListener = () => void;
const listeners = new Set<StitchCaptureListener>();

export function setPendingStitchCaptures(files: readonly File[]): void {
	pendingStitchCaptures = [...files];
	for (const listener of [...listeners]) listener();
}

/** Subscribes to deposits. Returns an unsubscribe function for teardown. */
export function subscribePendingStitchCaptures(listener: StitchCaptureListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getPendingStitchCaptures(): File[] | null {
	return pendingStitchCaptures ? [...pendingStitchCaptures] : null;
}

/** Claims the pending captures, leaving the slot empty. */
export function takePendingStitchCaptures(): File[] | null {
	const files = pendingStitchCaptures;
	pendingStitchCaptures = null;
	return files;
}

export function clearPendingStitchCaptures(): void {
	pendingStitchCaptures = null;
}
