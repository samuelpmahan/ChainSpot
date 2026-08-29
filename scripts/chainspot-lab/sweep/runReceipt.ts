import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CompiledExecutionPlan, Receipt } from '@chainspot/alg/exec';
import type {
	MeasurementAggregate,
	RunTrace
} from '@chainspot/alg/detectors/threeFactor/features/types';
import type { StraightTestTrace } from '@chainspot/alg/detectors/threeFactor/features/st.straightTest.contract';
import type { HoleLabeledAssignment } from '@chainspot/alg/exec';
import {
	CANONICAL_GATE_ORDER,
	GATE_TITLES
} from '@chainspot/alg/detectors/threeFactor/features/types';
import type { G0Report } from './inputShim';
import type { NotFoundBadgeRow } from './notFoundRows';
import {
	buildTruthFailureRows,
	type TruthFailureRow,
	type TruthScoreboard
} from './truthScoring';

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

/** One row of the final hole-labeled assignment table: badgeId is kept for
 * traceability, but `hole` (the G1-read digit, e.g. "14", or the loud
 * `UNREAD` when the digit read failed) is the field a human reads. Sourced
 * verbatim from the board's final `assignment` slot via
 * `withHoleLabels(assignment.assignments, measurement.badges)`
 * (`@chainspot/alg/exec`) -- the same mapping the assignment.selection.table
 * and zfit.finalAssignment.table artifacts use, so the receipt and the
 * artifact can never say different holes for the same badge. */
export type RunReceiptAssignmentRow = HoleLabeledAssignment;

/** One badge with no shipped assignment row: see notFoundRows.ts. */
export type RunReceiptNotFoundRow = NotFoundBadgeRow;

export interface RunReceiptSliceOperation {
	readonly id: string;
	readonly ownerGate: string;
	readonly reason: string;
}

/** Slice facts handed in by slicePlanThroughGate (operation.ts). */
export interface RunReceiptSliceInput {
	readonly throughGate: string;
	readonly phase: string;
	readonly parentOperationCount: number;
	/** Operations inside the sliced prefix owned by a later gate, each with
	 * the slot-level reason it had to run. */
	readonly prerequisites: readonly RunReceiptSliceOperation[];
	/** Parent-plan operations after the prefix; not run by this slice. */
	readonly notScheduled: readonly RunReceiptSliceOperation[];
}

/** The receipt's slice section: the input facts plus what this module
 * derives from them (final-result omissions and the straight-hole
 * assignment story). Present only on `--through` runs. */
export interface RunReceiptSlice extends RunReceiptSliceInput {
	readonly scheduledOperationCount: number;
	/** FINAL RESULTS metrics whose producing operations were cut by the
	 * slice, with the line the text receipt prints instead of a number. */
	readonly finalResultsNotScheduled: Readonly<Partial<Record<keyof RunReceiptResults, string>>>;
	/** Straight-hole assignment story, present when the slice scheduled
	 * assignment.selection — every count carries its trace provenance. */
	readonly straightStory?: readonly string[];
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
	/** Empty when 'assignment.selection' was not scheduled (e.g. a `--through`
	 * cutoff before G6); a scheduled selection with zero rows is a real empty
	 * array, never omitted. */
	readonly assignments: readonly RunReceiptAssignmentRow[];
	/** Every G1-read badge absent from `assignments` above (empty array when
	 * every badge has a shipped row, or when assignment.selection was never
	 * scheduled -- same "empty, not omitted" convention as `assignments`). */
	readonly notFoundBadges: readonly RunReceiptNotFoundRow[];
	readonly slice?: RunReceiptSlice;
	readonly resultsProvenance: RunReceiptResultsProvenance;
	readonly visualRenders: readonly RunReceiptVisualRender[];
	readonly straightTest?: RunReceiptStraightTest;
	readonly evaluation: {
		readonly truthSupplied: boolean;
		readonly skipped: boolean;
		readonly reason?: string;
		readonly scoreboard?: TruthScoreboard;
		readonly failureRows: readonly TruthFailureRow[];
	};
	readonly warnings: readonly string[];
	/** Comparison against the previous run of this same config+course output
	 * slot (the run.receipt.json this run overwrote), so a flipped HOLE
	 * ASSIGNMENTS row is never silent across runs. Absent when no previous
	 * receipt existed on disk -- the text receipt then prints the honest
	 * UNKNOWN line instead. */
	readonly previousRun?: RunReceiptPreviousRun;
}

export interface RunReceiptPreviousRun {
	readonly generatedAt: string;
	readonly revision: string;
	readonly paramsHash: string;
	/** True when revision AND paramsHash match the current run -- any change
	 * below is then nondeterminism or an input change, never a code delta. */
	readonly sameCodeAndConfig: boolean;
	/** One line per HOLE ASSIGNMENTS row that differs from the previous run;
	 * empty means every row is identical ("no change", stated explicitly). */
	readonly changes: readonly string[];
}

/** Diff this run's HOLE ASSIGNMENTS against the previous run.receipt.json of
 * the same output slot (receipt contract item 6, docs/WORKFLOW.md: "what
 * changed vs the frozen baseline -- or 'no change', explicitly"). Defensive
 * about the previous file's shape: anything unparseable yields undefined and
 * the honest UNKNOWN line stands. */
export function compareToPreviousRun(previousRaw: unknown, current: RunReceipt): RunReceiptPreviousRun | undefined {
	if (typeof previousRaw !== 'object' || previousRaw === null) return undefined;
	const prev = previousRaw as {
		generatedAt?: unknown;
		revision?: unknown;
		config?: { paramsHash?: unknown };
		assignments?: unknown;
	};
	if (typeof prev.generatedAt !== 'string' || typeof prev.revision !== 'string' || !Array.isArray(prev.assignments)) {
		return undefined;
	}
	const prevHash = typeof prev.config?.paramsHash === 'string' ? prev.config.paramsHash : 'UNKNOWN';
	const label = (row: RunReceiptAssignmentRow) => (row.hole === 'UNREAD' ? `UNREAD(${row.badgeId})` : `H${row.hole}`);
	const prevRows = new Map<string, RunReceiptAssignmentRow>();
	for (const row of prev.assignments as RunReceiptAssignmentRow[]) {
		if (row && typeof row.badgeId === 'string') prevRows.set(row.badgeId, row);
	}
	const currRows = new Map(current.assignments.map((row) => [row.badgeId, row]));
	const changes: string[] = [];
	for (const badgeId of [...new Set([...prevRows.keys(), ...currRows.keys()])].sort()) {
		const before = prevRows.get(badgeId);
		const after = currRows.get(badgeId);
		if (before && after) {
			if (before.teeId === after.teeId && before.basketId === after.basketId && before.score === after.score) continue;
			changes.push(
				before.teeId === after.teeId && before.basketId === after.basketId
					? `${label(after)} (${badgeId}): score changed ${before.score} -> ${after.score} (same tee and basket)`
					: `${label(after)} (${badgeId}): flipped ${before.teeId} -> ${before.basketId} (score ${before.score}) INTO ${after.teeId} -> ${after.basketId} (score ${after.score})`
			);
		} else if (before) {
			changes.push(`${label(before)} (${badgeId}): REMOVED -- was ${before.teeId} -> ${before.basketId} (score ${before.score})`);
		} else if (after) {
			changes.push(`${label(after)} (${badgeId}): ADDED -- ${after.teeId} -> ${after.basketId} (score ${after.score})`);
		}
	}
	return {
		generatedAt: prev.generatedAt,
		revision: prev.revision,
		paramsHash: prevHash,
		sameCodeAndConfig: prev.revision === current.revision && prevHash === current.config.paramsHash,
		changes
	};
}

/** Rung 5 of docs/seven-whys/2026-08-28-tee11-mispairing.md, receipt-only:
 * flag any assignment score this many orders of magnitude (or more) below the
 * median sibling score. 3 is a dataset-fit estimate, not physics (Dev6
 * 2026-08-28: healthy rows span about one order, 0.114-0.595, while observed
 * garbage sat >= 12 orders below at 2.4e-13, or at exactly 0; 3 leaves ~2
 * orders of margin on each side). Advisory only -- NEVER a filter; a flagged
 * row still stands. */
export const SCORE_ANOMALY_ORDERS_BELOW_MEDIAN = 3;

/** Upper-middle median, the same convention deriveGeometricClaims uses. */
export function assignmentScoreMedian(rows: ReadonlyArray<{ readonly score: number }>): number | null {
	if (rows.length === 0) return null;
	const scores = rows.map((row) => row.score).sort((a, b) => a - b);
	return scores[Math.floor(scores.length / 2)];
}

/** The advisory suffix for one assignment row, or null when unremarkable. */
export function scoreAnomalyNote(score: number, median: number | null): string | null {
	if (median === null || median <= 0) return null;
	if (score <= 0) {
		return `  << SCORE ANOMALY: 0 is unboundedly below the median sibling score ${median} (advisory only, never a filter; rung 5 of docs/seven-whys/2026-08-28-tee11-mispairing.md)`;
	}
	const orders = Math.log10(median / score);
	if (orders < SCORE_ANOMALY_ORDERS_BELOW_MEDIAN) return null;
	return `  << SCORE ANOMALY: ${orders.toFixed(1)} orders of magnitude below the median sibling score ${median} (advisory only, never a filter; rung 5 of docs/seven-whys/2026-08-28-tee11-mispairing.md)`;
}

export interface BuildRunReceiptInput {
	readonly generatedAt: string;
	readonly revision: string;
	readonly configName: string;
	readonly configPath: string;
	readonly throughGate?: string;
	readonly slice?: RunReceiptSliceInput;
	readonly plan: CompiledExecutionPlan;
	readonly receipts: readonly Receipt[];
	readonly report: G0Report;
	readonly trace: RunTrace;
	readonly timings: RunPhaseTimings;
	readonly results: RunReceiptResults;
	/** See RunReceipt.assignments. Empty (not omitted) when nothing was
	 * scheduled to produce it. */
	readonly assignments: readonly RunReceiptAssignmentRow[];
	readonly notFoundBadges: readonly RunReceiptNotFoundRow[];
	readonly resultsProvenance: RunReceiptResultsProvenance;
	readonly visualRenders: readonly RunReceiptVisualRender[];
	/** Loud problems the visual-render composers found while drawing. Appended
	 * to the receipt's WARNINGS so they cannot be silently dropped. */
	readonly renderWarnings?: readonly string[];
	readonly truthSupplied: boolean;
	readonly truthScoringSkipped: boolean;
	readonly truthScoringReason?: string;
	readonly scoreboard?: TruthScoreboard;
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

/** Operations whose run is what gives each FINAL RESULTS metric a value.
 * A metric whose producers were all cut by a `--through` slice prints
 * `not scheduled (--through GN)` instead of a bare 0 or UNKNOWN — a
 * board-seeded default (e.g. recoveredTees = 0) is not a result. */
const FINAL_RESULT_PRODUCERS: Record<keyof RunReceiptResults, readonly string[]> = {
	badges: ['badges'],
	baskets: ['baskets', 'cleanBasketFamily'],
	visibleTees: ['teeFamily', 'tees.exclusion'],
	recoveredTees: ['teeRecovery', 'phantomTee'],
	phantomTees: ['phantomTee'],
	totalTees: ['teeRecovery', 'phantomTee'],
	assignments: ['assignment.selection', 'zfit'],
	rawPairs: ['rawPairs']
};

function deriveSlice(
	input: BuildRunReceiptInput,
	units: readonly RunReceiptUnit[]
): { slice?: RunReceiptSlice; results: RunReceiptResults } {
	if (!input.slice) return { results: input.results };
	const slice = input.slice;
	const scheduled = new Set(input.plan.ops.map((operation) => operation.id));
	const cut = new Set(slice.notScheduled.map((operation) => operation.id));
	const finalResultsNotScheduled: Partial<Record<keyof RunReceiptResults, string>> = {};
	const results: Record<string, number | undefined> = { ...input.results };
	for (const metric of Object.keys(FINAL_RESULT_PRODUCERS) as (keyof RunReceiptResults)[]) {
		const producers = FINAL_RESULT_PRODUCERS[metric];
		if (producers.some((id) => scheduled.has(id))) continue;
		if (!producers.some((id) => cut.has(id))) continue; // absent from the config, not cut by the slice
		if (metric === 'totalTees' && input.results.visibleTees !== undefined) {
			finalResultsNotScheduled[metric] = `not final: ${input.results.visibleTees} visible; tee recovery not scheduled (--through ${slice.throughGate})`;
		} else {
			finalResultsNotScheduled[metric] = `not scheduled (--through ${slice.throughGate})`;
		}
		results[metric] = undefined;
	}

	let straightStory: string[] | undefined;
	if (scheduled.has('assignment.selection')) {
		const unit = (id: string) => units.find((candidate) => candidate.id === id);
		const selection = unit('assignment');
		const recovery = unit('teeRecovery');
		const selectedCount = selection?.measurements.find(
			(measurement) => measurement.name === 'score'
		)?.count;
		straightStory = [];
		straightStory.push(
			`assignment.selection assigned ${selectedCount ?? 'UNKNOWN'} of ${input.results.badges ?? 'UNKNOWN'} badges straight from visible tees (provenance: unit 'assignment' measurement 'score' count — one score per selected assignment)`
		);
		if (recovery) {
			straightStory.push(
				`teeRecovery then recovered ${recovery.accepted} occluded tee(s) and completed their holes (provenance: unit 'teeRecovery' accepted drawables)`
			);
		} else if (cut.has('teeRecovery')) {
			straightStory.push(`teeRecovery not scheduled (--through ${slice.throughGate})`);
		}
		straightStory.push(
			`assignments on the board at this cutoff: ${input.results.assignments ?? 'UNKNOWN'} (provenance: board 'assignment' slot after the last scheduled operation)`
		);
		if (cut.has('zfit')) {
			straightStory.push(`zfit bend refinement not scheduled (--through ${slice.throughGate})`);
		}
	}

	return {
		slice: {
			...slice,
			scheduledOperationCount: input.plan.ops.length,
			finalResultsNotScheduled,
			...(straightStory ? { straightStory } : {})
		},
		results: results as RunReceiptResults
	};
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

	const units = unitReceipt(input.trace);
	const { slice, results } = deriveSlice(input, units);
	const featureStates = Object.entries(input.trace.features);
	const straightTest = input.trace.straightTest && {
		...input.trace.straightTest,
		runId: input.trace.runId ?? 'UNKNOWN',
		imageId: input.trace.imageId ?? 'UNKNOWN',
		paramsHash: input.trace.paramsHash || 'UNKNOWN',
		traceHash: input.trace.traceHash ?? 'UNKNOWN'
	};
	const failureRows = input.scoreboard
		? buildTruthFailureRows(
				input.scoreboard,
				{
					runId: input.trace.runId ?? 'UNKNOWN',
					imageId: input.trace.imageId ?? input.report.imageId,
					paramsHash: input.trace.paramsHash || 'UNKNOWN',
					traceHash: input.trace.traceHash ?? 'UNKNOWN'
				},
				input.report.singleSourceOffset
			)
		: [];
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
		units,
		results,
		assignments: input.assignments,
		notFoundBadges: input.notFoundBadges,
		resultsProvenance: input.resultsProvenance,
		...(slice ? { slice } : {}),
		visualRenders: input.visualRenders,
		...(straightTest ? { straightTest } : {}),
		evaluation: {
			truthSupplied: input.truthSupplied,
			skipped: input.truthScoringSkipped,
			...(input.truthScoringReason ? { reason: input.truthScoringReason } : {}),
			...(input.scoreboard ? { scoreboard: input.scoreboard } : {}),
			failureRows
		},
		warnings
	};
}

export function writeRunReceiptJson(outDir: string, receipt: RunReceipt): string {
	const path = resolve(outDir, 'run.receipt.json');
	writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
	return path;
}
