import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CompiledExecutionPlan, Receipt } from '@chainspot/alg/exec';
import type {
	MeasurementAggregate,
	RunTrace
} from '@chainspot/alg/detectors/threeFactor/features/types';
import type { StraightTestTrace } from '@chainspot/alg/detectors/threeFactor/features/st.straightTest.contract';
import {
	CANONICAL_GATE_ORDER,
	GATE_TITLES
} from '@chainspot/alg/detectors/threeFactor/features/types';
import type { G0Report } from './inputShim';

export const RUN_RECEIPT_SCHEMA = 'chainspot-lab-run-receipt@1' as const;

export interface RunPhaseTimings {
	readonly configMs: number;
	readonly intakeMs: number;
	readonly canonicalWriteMs: number;
	readonly gatewayMs: number;
	readonly operationBodyMs: number;
	readonly artifactPersistenceMs: number;
	readonly artifactRenderMs: number;
	readonly truthEvaluationMs: number;
	readonly featureRenderMs: number;
	readonly observedTotalMs: number;
}

export interface RunReceiptOperation {
	readonly index: number;
	readonly id: string;
	readonly gate: string;
	readonly gateTitle: string;
	readonly kind: string;
	readonly unit: string;
	readonly durationMs: number;
	readonly percentOfOperationBody: number;
	readonly conformance: {
		readonly ok: boolean;
		readonly missingConsumes: readonly string[];
		readonly missingProduces: readonly string[];
	};
	readonly probes: Receipt['probes'];
	readonly artifacts: Receipt['artifacts'];
}

export interface RunReceiptGate {
	readonly gate: string;
	readonly title: string;
	readonly status: 'ran' | 'not-scheduled';
	readonly operationIndexes: readonly number[];
	readonly durationMs: number;
	readonly percentOfOperationBody: number;
}

export interface RunReceiptUnit {
	readonly id: string;
	readonly gate: string;
	readonly durationMs: number;
	readonly accepted: number;
	readonly rejected: number;
	readonly info: number;
	readonly measurements: readonly (MeasurementAggregate & { readonly mean: number })[];
	readonly rejectionReasons: readonly { readonly reason: string; readonly count: number }[];
}

export interface RunReceiptResults {
	readonly badges?: number;
	readonly baskets?: number;
	readonly visibleTees?: number;
	readonly recoveredTees?: number;
	readonly phantomTees?: number;
	readonly totalTees?: number;
	readonly assignments?: number;
	readonly rawPairs?: number;
}

export type RunReceiptResultName = keyof RunReceiptResults & string;

/** One provenance line per FINAL RESULTS number. For a present number it says
 * where the value was read from; for an absent number it says WHY it is
 * absent (not-scheduled vs not-enabled vs not-computed), because "never ran"
 * and "ran and found 0" are different receipt lines. */
export type RunReceiptResultsProvenance = Readonly<
	Partial<Record<RunReceiptResultName, string>>
>;

export interface RunReceiptVisualRender {
	readonly kind: 'canonical' | 'artifact' | 'feature';
	readonly gate: string;
	readonly id: string;
	readonly owner: string;
	readonly status: 'rendered' | 'stub';
	readonly summary: string;
	/** Portable paths relative to this run's output directory. */
	readonly files: readonly string[];
}

/** S0 testimony copied from the sealed semantic trace.  Keeping the trace
 * identity beside the rows makes the JSON receipt independently checkable. */
export interface RunReceiptStraightTest extends StraightTestTrace {
	readonly runId: string;
	readonly imageId: string;
	readonly paramsHash: string;
	readonly traceHash: string;
}

export interface RunReceipt {
	readonly schema: typeof RUN_RECEIPT_SCHEMA;
	readonly generatedAt: string;
	readonly revision: string;
	readonly config: {
		readonly name: string;
		readonly path: string;
		readonly paramsHash: string;
		readonly planFingerprint: string;
		readonly throughGate?: string;
		readonly enabledFeatures: readonly string[];
		readonly deviatingFeatures: readonly string[];
	};
	readonly intake: {
		readonly sources: readonly string[];
		readonly sourceImageIds: readonly string[];
		readonly canonicalImageId: string;
		readonly widthPx: number;
		readonly heightPx: number;
		readonly sourceByteLength: number;
		readonly stripChrome: G0Report['stripChrome'];
		readonly autoStitch: G0Report['autoStitch'];
		readonly ledger: G0Report['ledger'];
		readonly truthMatch: G0Report['truthMatch'];
	};
	readonly timings: RunPhaseTimings;
	readonly operations: readonly RunReceiptOperation[];
	readonly gates: readonly RunReceiptGate[];
	readonly units: readonly RunReceiptUnit[];
	readonly results: RunReceiptResults;
	readonly resultsProvenance: RunReceiptResultsProvenance;
	readonly visualRenders: readonly RunReceiptVisualRender[];
	readonly straightTest?: RunReceiptStraightTest;
	readonly evaluation: {
		readonly truthSupplied: boolean;
		readonly skipped: boolean;
		readonly reason?: string;
		readonly scoreboard?: unknown;
	};
	readonly warnings: readonly string[];
}

export interface BuildRunReceiptInput {
	readonly generatedAt: string;
	readonly revision: string;
	readonly configName: string;
	readonly configPath: string;
	readonly throughGate?: string;
	readonly plan: CompiledExecutionPlan;
	readonly receipts: readonly Receipt[];
	readonly report: G0Report;
	readonly trace: RunTrace;
	readonly timings: RunPhaseTimings;
	readonly results: RunReceiptResults;
	readonly resultsProvenance: RunReceiptResultsProvenance;
	readonly visualRenders: readonly RunReceiptVisualRender[];
	/** Loud problems the visual-render composers found while drawing. Appended
	 * to the receipt's WARNINGS so they cannot be silently dropped. */
	readonly renderWarnings?: readonly string[];
	readonly truthSupplied: boolean;
	readonly truthScoringSkipped: boolean;
	readonly truthScoringReason?: string;
	readonly scoreboard?: unknown;
}

function round(value: number): number {
	return Number(value.toFixed(3));
}

function percent(value: number, total: number): number {
	return total > 0 ? round((value / total) * 100) : 0;
}

function conformance(receipt: Receipt): RunReceiptOperation['conformance'] {
	const actualConsumes = new Set(receipt.actualConsumes);
	const actualProduces = new Set(receipt.actualProduces);
	const missingConsumes = receipt.declaredConsumes.filter((slot) => !actualConsumes.has(slot));
	const missingProduces = receipt.declaredProduces.filter((slot) => !actualProduces.has(slot));
	return {
		ok: missingConsumes.length === 0 && missingProduces.length === 0,
		missingConsumes,
		missingProduces
	};
}

function unitReceipt(trace: RunTrace): RunReceiptUnit[] {
	return trace.units.map((unit) => {
		const rejectionCounts = new Map<string, number>();
		for (const drawable of unit.drawables) {
			if (drawable.verdict !== 'rejected') continue;
			const reason = drawable.reason ?? 'UNKNOWN';
			rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
		}
		return {
			id: unit.id,
			gate: unit.gate,
			durationMs: round(unit.ms),
			accepted: unit.drawables.filter((drawable) => drawable.verdict === 'accepted').length,
			rejected: unit.drawables.filter((drawable) => drawable.verdict === 'rejected').length,
			info: unit.drawables.filter((drawable) => drawable.verdict === 'info').length,
			measurements: unit.measurements.map((measurement) => ({
				...measurement,
				mean: measurement.count > 0 ? measurement.sum / measurement.count : Number.NaN
			})),
			rejectionReasons: [...rejectionCounts]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([reason, count]) => ({ reason, count }))
		};
	});
}

export function buildRunReceipt(input: BuildRunReceiptInput): RunReceipt {
	const warnings: string[] = [...(input.renderWarnings ?? [])];
	if (input.plan.ops.length !== input.receipts.length) {
		warnings.push(
			`plan/receipt length mismatch: ${input.plan.ops.length} planned, ${input.receipts.length} received`
		);
	}
	const operations: RunReceiptOperation[] = [];
	const plannedById = new Map(input.plan.ops.map((operation) => [operation.id, operation]));
	const receivedIds = new Set<string>();
	for (let index = 0; index < input.receipts.length; index++) {
		const receipt = input.receipts[index];
		const plannedAtIndex = input.plan.ops[index];
		const op = plannedById.get(receipt.opId);
		if (!op) {
			warnings.push(`receipt ${index + 1} names unknown operation '${receipt.opId}'`);
			continue;
		}
		receivedIds.add(receipt.opId);
		if (plannedAtIndex?.id !== receipt.opId) {
			warnings.push(
				`operation ${index + 1} receipt mismatch: planned '${plannedAtIndex?.id ?? 'none'}', received '${receipt.opId}'`
			);
		}
		const operationConformance = conformance(receipt);
		if (!operationConformance.ok)
			warnings.push(`operation '${receipt.opId}' has consume/produce conformance drift`);
		operations.push({
			index: index + 1,
			id: op.id,
			gate: op.gate,
			gateTitle: GATE_TITLES[op.gate as keyof typeof GATE_TITLES] ?? op.gate,
			kind: op.kind,
			unit: op.unit,
			durationMs: round(receipt.durationMs),
			percentOfOperationBody: percent(receipt.durationMs, input.timings.operationBodyMs),
			conformance: operationConformance,
			probes: receipt.probes,
			artifacts: receipt.artifacts
		});
	}
	for (const op of input.plan.ops) {
		if (!receivedIds.has(op.id)) warnings.push(`planned operation '${op.id}' has no receipt`);
	}

	for (const operation of operations) {
		const rank = (CANONICAL_GATE_ORDER as readonly string[]).indexOf(operation.gate);
		if (rank < 0)
			warnings.push(`operation '${operation.id}' has noncanonical gate '${operation.gate}'`);
	}

	const gates: RunReceiptGate[] = CANONICAL_GATE_ORDER.map((gate) => {
		const owned = operations.filter((operation) => operation.gate === gate);
		const durationMs = owned.reduce((sum, operation) => sum + operation.durationMs, 0);
		return {
			gate,
			title: GATE_TITLES[gate],
			status: owned.length > 0 ? 'ran' : 'not-scheduled',
			operationIndexes: owned.map((operation) => operation.index),
			durationMs: round(durationMs),
			percentOfOperationBody: percent(durationMs, input.timings.operationBodyMs)
		};
	});

	const featureStates = Object.entries(input.trace.features);
	const straightTest = input.trace.straightTest && {
		...input.trace.straightTest,
		runId: input.trace.runId ?? 'UNKNOWN',
		imageId: input.trace.imageId ?? 'UNKNOWN',
		paramsHash: input.trace.paramsHash || 'UNKNOWN',
		traceHash: input.trace.traceHash ?? 'UNKNOWN'
	};
	return {
		schema: RUN_RECEIPT_SCHEMA,
		generatedAt: input.generatedAt,
		revision: input.revision,
		config: {
			name: input.configName,
			path: input.configPath,
			paramsHash: input.trace.paramsHash,
			planFingerprint: input.plan.planFingerprint,
			...(input.throughGate ? { throughGate: input.throughGate } : {}),
			enabledFeatures: featureStates.filter(([, state]) => state.enabled).map(([id]) => id),
			deviatingFeatures: input.trace.units
				.filter((unit) => unit.knobsDeviating.length > 0)
				.flatMap((unit) => unit.featureIds)
				.filter((id, index, all) => all.indexOf(id) === index)
		},
		intake: {
			sources: input.report.filePaths,
			sourceImageIds: input.report.rawImageIds,
			canonicalImageId: input.report.imageId,
			widthPx: input.report.widthPx,
			heightPx: input.report.heightPx,
			sourceByteLength: input.report.sourceByteLength,
			stripChrome: input.report.stripChrome,
			autoStitch: input.report.autoStitch,
			ledger: input.report.ledger,
			truthMatch: input.report.truthMatch
		},
		timings: Object.fromEntries(
			Object.entries(input.timings).map(([name, value]) => [name, round(value)])
		) as unknown as RunPhaseTimings,
		operations,
		gates,
		units: unitReceipt(input.trace),
		results: input.results,
		resultsProvenance: input.resultsProvenance,
		visualRenders: input.visualRenders,
		...(straightTest ? { straightTest } : {}),
		evaluation: {
			truthSupplied: input.truthSupplied,
			skipped: input.truthScoringSkipped,
			...(input.truthScoringReason ? { reason: input.truthScoringReason } : {}),
			...(input.scoreboard ? { scoreboard: input.scoreboard } : {})
		},
		warnings
	};
}

export function writeRunReceiptJson(outDir: string, receipt: RunReceipt): string {
	const path = resolve(outDir, 'run.receipt.json');
	writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
	return path;
}
