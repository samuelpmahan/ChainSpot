// Generic evidence store for the compiled-operation execution model.
// Structurally identical to threeFactor/features/types.ts's EvidenceBoard
// (get/has/set, fail-loud reads) but keyed by the open SlotRef string
// instead of the closed EvidenceSlot enum, so it can carry BOTH the
// classic unit-level slots ('stage', 'badges', 'measurement', ...) and the
// new dotted sub-slots a decomposed operation introduces ('badgeStage.
// masks', 'assignment.scoredPairs', ...) in one store. Browser-safe: no
// I/O, no node built-ins.

import type { SlotRef } from './contract';

export interface ExecBoard {
	get<T>(slot: SlotRef): T;
	has(slot: SlotRef): boolean;
	set(slot: SlotRef, value: unknown): void;
}

export type DataAccessKind = 'get' | 'has' | 'set';

export interface DataAccessValueSummary {
	readonly type: string;
	readonly ctor?: string;
	readonly length?: number;
	readonly width?: number;
	readonly height?: number;
	readonly keys?: readonly string[];
	readonly present?: boolean;
}

export interface DataAccessEvent {
	readonly seq: number;
	readonly scope: string;
	readonly kind: DataAccessKind;
	readonly slot: SlotRef;
	readonly value: DataAccessValueSummary;
}

function summarizeValue(value: unknown): DataAccessValueSummary {
	if (value === null) return { type: 'null' };
	if (value === undefined) return { type: 'undefined' };
	const type = typeof value;
	if (type !== 'object') return { type };
	if (Array.isArray(value)) return { type: 'array', length: value.length };
	if (ArrayBuffer.isView(value)) {
		return {
			type: 'typed-array',
			ctor: value.constructor.name,
			length: 'length' in value ? Number((value as { length: number }).length) : undefined
		};
	}
	const record = value as Record<string, unknown>;
	const width = typeof record.width === 'number' ? record.width : undefined;
	const height = typeof record.height === 'number' ? record.height : undefined;
	return {
		type: 'object',
		ctor: value.constructor?.name,
		...(width !== undefined ? { width } : {}),
		...(height !== undefined ? { height } : {}),
		keys: Object.keys(record).slice(0, 16)
	};
}

/**
 * Temporary build-en-place observability seam.
 *
 * It behaves exactly like the old Map-backed board, but while a G0-G3 scope
 * is active it appends a cheap structural record for every get/has/set. It
 * deliberately does NOT proxy nested objects or typed-array indexes: one
 * mask read is useful testimony; a million pixel-index reads are noise.
 */
export class LoggedExecBoard implements ExecBoard {
	private readonly slots = new Map<SlotRef, unknown>();
	private readonly events: DataAccessEvent[] = [];
	private scope: string | null = null;
	private seq = 0;

	get<T>(slot: SlotRef): T {
		if (!this.slots.has(slot)) throw new Error(`exec board: slot '${slot}' not produced yet.`);
		const value = this.slots.get(slot);
		this.record('get', slot, summarizeValue(value));
		return value as T;
	}

	has(slot: SlotRef): boolean {
		const present = this.slots.has(slot);
		this.record('has', slot, { type: 'boolean', present });
		return present;
	}

	set(slot: SlotRef, value: unknown): void {
		this.slots.set(slot, value);
		this.record('set', slot, summarizeValue(value));
	}

	withScope<T>(scope: string, fn: () => T): T {
		const previous = this.scope;
		this.scope = scope;
		try {
			const result = fn();
			if (result instanceof Promise) {
				return result.finally(() => {
					this.scope = previous;
				}) as T;
			}
			this.scope = previous;
			return result;
		} catch (error) {
			this.scope = previous;
			throw error;
		}
	}

	accessLog(): readonly DataAccessEvent[] {
		return this.events;
	}

	private record(kind: DataAccessKind, slot: SlotRef, value: DataAccessValueSummary): void {
		if (!this.scope || !/^G[0-3]:/.test(this.scope)) return;
		this.events.push({ seq: this.seq++, scope: this.scope, kind, slot, value });
	}
}

export function createExecBoard(): ExecBoard {
	return new LoggedExecBoard();
}

export function withBoardAccessScope<T>(board: ExecBoard, scope: string, fn: () => T): T {
	return board instanceof LoggedExecBoard ? board.withScope(scope, fn) : fn();
}

export function boardAccessLog(board: ExecBoard): readonly DataAccessEvent[] {
	return board instanceof LoggedExecBoard ? board.accessLog() : [];
}

/**
 * Wraps a board so every get()/set() call made through the wrapper during
 * one operation's run is recorded — the gateway's source for `actualConsumes`/
 * `actualProduces` on that operation's Receipt (see contract.ts). The
 * underlying board is untouched; this is a one-shot recorder, not a
 * persistent proxy.
 */
export function trackAccess(board: ExecBoard): { tracked: ExecBoard; consumed: Set<SlotRef>; produced: Set<SlotRef> } {
	const consumed = new Set<SlotRef>();
	const produced = new Set<SlotRef>();
	const tracked: ExecBoard = {
		get<T>(slot: SlotRef): T {
			consumed.add(slot);
			return board.get<T>(slot);
		},
		has: (slot) => board.has(slot),
		set: (slot, value) => {
			produced.add(slot);
			board.set(slot, value);
		}
	};
	return { tracked, consumed, produced };
}
