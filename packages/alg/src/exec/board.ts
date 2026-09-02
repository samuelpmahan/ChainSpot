// Generic evidence store for the compiled-operation execution model.
// Structurally identical to threeFactor/features/types.ts's EvidenceBoard
// (get/has/set, fail-loud reads) but keyed by the open SlotRef string
// instead of the closed EvidenceSlot enum, so it can carry BOTH the
// classic unit-level slots ('stage', 'badges', 'measurement', ...) and the
// new dotted sub-slots a decomposed operation introduces ('badgeStage.
// masks', 'assignment.scoredPairs', ...) in one store. Browser-safe: no
// I/O, no node built-ins.

import type { OperationSpec, PxWriteTestimony, SlotRef } from './contract';

/**
 * PxC's browser-safe address space.  ExecBoard remains as a compatibility
 * name because this is the existing production board evolving in place, not
 * a second synchronized store.
 */
export interface PxC {
	get<T>(slot: SlotRef): T;
	has(slot: SlotRef): boolean;
	set(slot: SlotRef, value: unknown): void;
}

export type ExecBoard = PxC;

export function createExecBoard(): PxC {
	const slots = new Map<SlotRef, unknown>();
	return {
		get<T>(slot: SlotRef): T {
			if (!slots.has(slot)) throw new Error(`exec board: slot '${slot}' not produced yet.`);
			return slots.get(slot) as T;
		},
		has: (slot) => slots.has(slot),
		set: (slot, value) => {
			slots.set(slot, value);
		}
	};
}

/**
 * Wraps a board so every get()/set() call made through the wrapper during
 * one operation's run is recorded — the gateway's source for `actualConsumes`/
 * `actualProduces` on that operation's Receipt (see contract.ts). The
 * underlying board is untouched; this is a one-shot recorder, not a
 * persistent proxy.
 */
export function trackAccess(
	board: PxC,
	tick: Pick<OperationSpec, 'id' | 'consumes'>
): {
	tracked: PxC;
	consumed: Set<SlotRef>;
	produced: Set<SlotRef>;
	writes: PxWriteTestimony[];
} {
	const consumed = new Set<SlotRef>();
	const produced = new Set<SlotRef>();
	const writes: PxWriteTestimony[] = [];
	const declaredConsumes = new Set(tick.consumes);
	const tracked: PxC = {
		get<T>(slot: SlotRef): T {
			consumed.add(slot);
			try {
				return board.get<T>(slot);
			} catch (error) {
				if (!board.has(slot)) {
					throw new Error(`PxC: Tick '${tick.id}' read missing address '${slot}'.`, {
						cause: error
					});
				}
				throw error;
			}
		},
		has: (slot) => board.has(slot),
		set: (slot, value) => {
			const existed = board.has(slot);
			produced.add(slot);
			writes.push({
				address: slot,
				kind: !existed
					? 'new-address'
					: declaredConsumes.has(slot)
						? 'refinement'
						: 'replacement'
			});
			board.set(slot, value);
		}
	};
	return { tracked, consumed, produced, writes };
}
