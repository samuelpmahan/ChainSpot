import type { PxC } from '../exec/board';
import type { OperationSpec, TickTestimony } from '../exec/contract';

export interface ReceiptPart {
	readonly address: string;
	readonly summary: string;
}

export interface TickReceipt {
	readonly tick: string;
	readonly attempts: readonly unknown[];
	readonly result: unknown;
	readonly consumed: readonly ReceiptPart[];
	readonly calculations: readonly { readonly address: string; readonly timingMs?: number }[];
	readonly produced: readonly ReceiptPart[];
}

function summarize(value: unknown): string {
	if (Array.isArray(value)) return `count=${value.length}`;
	if (value instanceof Uint8Array || value instanceof Uint8ClampedArray || value instanceof Uint32Array || value instanceof Int32Array)
		return `length=${value.length}`;
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'object') return `object keys=${Object.keys(value as object).length}`;
	return String(value);
}

/**
 * Receipt completeness invariant: every Part a Tick declares it consumes or
 * produces MUST appear in the receipt. A Stage cannot report only the
 * interesting delta while silently omitting its materialized outputs.
 */
export function materializeTickReceipt(op: OperationSpec, pxc: PxC, testimony: TickTestimony): TickReceipt {
	const part = (address: string): ReceiptPart => ({
		address,
		summary: pxc.has(address) ? summarize(pxc.get(address)) : 'MISSING'
	});
	const consumed = op.consumes.map(part);
	const produced = op.produces.map(part);
	const missingConsumed = consumed.filter((entry) => entry.summary === 'MISSING');
	if (missingConsumed.length) throw new Error(
		`Receipt incomplete for ${op.id}: declared input(s) missing: ${missingConsumed.map((x) => x.address).join(', ')}`
	);
	const missingProduced = produced.filter((entry) => entry.summary === 'MISSING');
	if (missingProduced.length) throw new Error(
		`Receipt incomplete for ${op.id}: declared output(s) missing: ${missingProduced.map((x) => x.address).join(', ')}`
	);
	if (!testimony) throw new Error(`Receipt incomplete for ${op.id}: execution testimony missing`);
	if (op.calculations.length === 0) throw new Error(`Receipt incomplete for ${op.id}: no declared calculations`);
	return {
		tick: op.id,
		attempts: (testimony as any).attempts ?? [],
		result: (testimony as any).result ?? testimony,
		consumed,
		calculations: op.calculations.map((address) => ({ address })),
		produced
	};
}

export function materializeStageReceipt(ops: readonly OperationSpec[], pxc: PxC, testimonies: readonly TickTestimony[]): readonly TickReceipt[] {
	const byTick = new Map(testimonies.map((t: any) => [t.tick ?? t.operationId ?? t.id, t] as const));
	if (testimonies.length !== ops.length) throw new Error(
		`Stage receipt incomplete: declared ${ops.length} Tick(s), received ${testimonies.length} testimony record(s)`
	);
	return ops.map((op, index) => {
		const testimony = byTick.get(op.id) ?? testimonies[index];
		if (!testimony) throw new Error(`Stage receipt incomplete: no testimony for Tick ${op.id}`);
		return materializeTickReceipt(op, pxc, testimony as TickTestimony);
	});
}
