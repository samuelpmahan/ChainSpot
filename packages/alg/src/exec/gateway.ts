// R1 / BUILD-3: THE gateway. executeCompiledPlan is the only function in
// this codebase allowed to walk a CompiledExecutionPlan's operation list —
// engine.ts's runEngine calls this and nothing else touches operations
// directly. Writes no files itself: artifacts and receipts flow through
// the caller-supplied ExecSink (R1). No node:fs/node:path here or
// anywhere it imports.
//
// Synchronous by design (see sha256.ts's header): runEngine's public
// contract — and the parity-pinned test that calls runThreeFactor
// synchronously — predates this wave and is a hard invariant, so the ONE
// gateway had to become sync-capable rather than runEngine growing an
// async escape hatch around it.

import type { CompiledExecutionPlan } from './compile';
import type { ExecBoard } from './board';
import { trackAccess } from './board';
import type { ExecSink } from './sink';
import { createNullSink } from './sink';
import { operationImpls, ARTIFACT_EXTRACTORS } from './operations';
import type { Probe, Receipt } from './contract';
import type { FeatureContext } from '../detectors/threeFactor/features/types';

export type OperationImpl = (board: ExecBoard, ctx: FeatureContext) => void | Promise<void>;

export interface OperationArtifact {
	readonly kind: Parameters<ExecSink['putArtifact']>[0];
	readonly id: string;
	readonly bytes: Uint8Array;
	readonly dims?: Parameters<ExecSink['putArtifact']>[3];
}

export interface OperationRuntime {
	readonly implementations: ReadonlyMap<string, OperationImpl>;
	readonly artifactExtractors?: Readonly<
		Record<string, (board: ExecBoard) => readonly OperationArtifact[]>
	>;
}

const DEFAULT_OPERATION_RUNTIME: OperationRuntime = {
	implementations: operationImpls,
	artifactExtractors: ARTIFACT_EXTRACTORS
};

function now(): number {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Generic shape probes: for every slot an operation actually produced,
 * record its element count when the value is array-like. Cheap, universal,
 * and independent of the legacy per-UNIT ctx.measure aggregates (which
 * FeatureContext exposes write-only, so per-operation deltas aren't
 * recoverable from it) — a deliberate, disclosed scope choice: fine-grained
 * score distributions still ride ctx.measure/UnitTrace at unit level;
 * Receipt.probes carries op-level candidate-count shape instead.
 */
function shapeProbes(board: ExecBoard, produced: ReadonlySet<string>): Probe[] {
	const probes: Probe[] = [];
	for (const slot of produced) {
		const value = board.get<unknown>(slot);
		if (Array.isArray(value) || ArrayBuffer.isView(value)) {
			probes.push({ name: `${slot}.length`, value: (value as { length: number }).length });
		}
	}
	return probes;
}

export function executeCompiledPlan(
	plan: CompiledExecutionPlan,
	board: ExecBoard,
	ctx: FeatureContext,
	sink: ExecSink = createNullSink(),
	runtime: OperationRuntime = DEFAULT_OPERATION_RUNTIME
): readonly Receipt[] {
	const receipts: Receipt[] = [];
	for (const op of plan.ops) {
		const impl = runtime.implementations.get(op.id);
		if (!impl)
			throw new Error(
				`executeCompiledPlan: no implementation registered for operation '${op.id}'.`
			);

		const startedAtMs = now();
		const { tracked, consumed, produced } = trackAccess(board);
		const result = impl(tracked, ctx);
		if (result instanceof Promise) {
			throw new Error(
				`executeCompiledPlan: asynchronous operation '${op.id}' requires executeCompiledPlanAsync.`
			);
		}
		const durationMs = now() - startedAtMs;

		const artifacts = (runtime.artifactExtractors?.[op.id]?.(board) ?? []).map((a) =>
			sink.putArtifact(a.kind, a.id, a.bytes, a.dims)
		);

		const receipt: Receipt = {
			opId: op.id,
			startedAtMs,
			durationMs,
			declaredConsumes: op.consumes,
			declaredProduces: op.produces,
			actualConsumes: [...consumed],
			actualProduces: [...produced],
			probes: shapeProbes(board, produced),
			artifacts
		};
		sink.putReceipt(receipt);
		receipts.push(receipt);
	}
	return receipts;
}

/** Browser/LAB counterpart: same gateway contract, but awaits asynchronous operations in list order. */
export async function executeCompiledPlanAsync(
	plan: CompiledExecutionPlan,
	board: ExecBoard,
	ctx: FeatureContext,
	sink: ExecSink = createNullSink(),
	runtime: OperationRuntime = DEFAULT_OPERATION_RUNTIME
): Promise<readonly Receipt[]> {
	const receipts: Receipt[] = [];
	for (const op of plan.ops) {
		const impl = runtime.implementations.get(op.id);
		if (!impl) {
			throw new Error(
				`executeCompiledPlanAsync: no implementation registered for operation '${op.id}'.`
			);
		}

		const startedAtMs = now();
		const { tracked, consumed, produced } = trackAccess(board);
		await impl(tracked, ctx);
		const durationMs = now() - startedAtMs;
		const artifacts = (runtime.artifactExtractors?.[op.id]?.(board) ?? []).map((artifact) =>
			sink.putArtifact(artifact.kind, artifact.id, artifact.bytes, artifact.dims)
		);
		const receipt: Receipt = {
			opId: op.id,
			startedAtMs,
			durationMs,
			declaredConsumes: op.consumes,
			declaredProduces: op.produces,
			actualConsumes: [...consumed],
			actualProduces: [...produced],
			probes: shapeProbes(board, produced),
			artifacts
		};
		sink.putReceipt(receipt);
		receipts.push(receipt);
	}
	return receipts;
}
