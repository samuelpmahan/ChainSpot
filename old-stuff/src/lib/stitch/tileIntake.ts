/**
 * ChainSpot stitch tile intake coordination (P05-002 review).
 *
 * Per-slot generation counters protect the tile slots from stale asynchronous
 * decodes: every new file selection, removal, or session reset invalidates all
 * earlier in-flight decodes for the affected slots, so a late-resolving older
 * decode can never replace the newest tile or publish a stale error/status.
 * Different slots remain fully independent and may decode concurrently. Browser
 * image decoding is never cancelled; stale results are simply discarded.
 *
 * `guardedDecode` is the deterministic seam the page uses for every tile decode:
 * it begins a generation, decodes through the injected function, and reports
 * whether the result is still permitted to publish.
 */
import type { DecodedImage, DecodeImageFile } from '../imageIntake';

export class TileDecodeCoordinator {
	private generations = new Map<string, number>();

	/** Marks a new decode attempt for a slot; returns its generation identity. */
	begin(slot: string): number {
		const next = (this.generations.get(slot) ?? 0) + 1;
		this.generations.set(slot, next);
		return next;
	}

	/** True only when `generation` is still the newest attempt for `slot`. */
	isCurrent(slot: string, generation: number): boolean {
		return this.generations.get(slot) === generation;
	}

	/** Invalidates every in-flight decode for one slot (for example on removal). */
	invalidate(slot: string): void {
		this.generations.set(slot, (this.generations.get(slot) ?? 0) + 1);
	}

	/** Invalidates every in-flight decode for the given slots (session reset). */
	invalidateAll(slots: readonly string[]): void {
		for (const slot of slots) this.invalidate(slot);
	}
}

export type GuardedDecodeResult =
	| { ok: true; decoded: DecodedImage }
	| { ok: false; stale: true }
	| { ok: false; error: unknown };

/**
 * One guarded tile decode attempt. The caller begins a generation BEFORE any
 * selection validation (so even an unsupported newer selection invalidates the
 * older in-flight decode), then passes that generation here. The caller's
 * `decode` may resolve or reject at any time; only the newest attempt for the
 * slot may publish its result. A stale success and a stale failure both report
 * `{ ok: false, stale: true }` so the page publishes nothing over the newest
 * tile's state.
 */
export async function guardedDecode(
	coordinator: TileDecodeCoordinator,
	slot: string,
	generation: number,
	file: File,
	decode: DecodeImageFile
): Promise<GuardedDecodeResult> {
	let decoded: DecodedImage;
	try {
		decoded = await decode(file);
	} catch (error) {
		if (!coordinator.isCurrent(slot, generation)) return { ok: false, stale: true };
		return { ok: false, error };
	}
	if (!coordinator.isCurrent(slot, generation)) return { ok: false, stale: true };
	return { ok: true, decoded };
}
