// The threeFactor engine: executes a config-declared unit order over the
// evidence board, resolving ABFeatures and collecting the spatial trace.
// The DEFAULT config is the recovered production baseline
// (pinned by tests/unit/threeFactorParity.test.ts).

import { assignThreeFactor, type SearchKnobs } from './assignment';
import type { RibbonKnobs } from './ribbon';
import type { RoutingKnobs } from './routing';
import type { ScoringKnobs } from './scoring';
import { type ResolvedConfig } from './config';
import { measureUnits, seedBoard, DEFAULT_MEASURE_EXECUTION } from './measure';
import { createExecBoard } from '../../exec/board';
import { compileExecutionPlan } from '../../exec/compile';
import { executeCompiledPlan } from '../../exec/gateway';
import type { OperationSpec } from '../../exec/contract';
import { featureById } from './features/registry';
import { zfitFeature } from './features/g5.zfit';
import { g4ScoringFeature } from './features/g4.scoring';
import { g4SearchFeature } from './features/g4.search';
import { g5RibbonFeature } from './features/g5.ribbon';
import { g5RoutingFeature } from './features/g5.routing';
import { phantomTeeUnit } from './features/g3.phantomTee';
import { teeFamilyUnit } from './features/g3.teeFamily';
import { teeMinAreaPoseUnit } from './features/g3.teeMinAreaPose';
import { teeRecoveryUnit } from './features/g3.teeRecovery';
import { straightTestUnit } from './features/st.straightTest';
import { teeBadgeLockUnit } from './features/g4.teeBadgeLock';
import { OcclusionDetector } from './occlusion';
import { cleanBasketFamilyUnit } from './features/g2.cleanBasketFamily';
import {
	defaultKnobs,
	nullFeatureContext,
	type Drawable,
	type EngineUnit,
	type EvidenceBoard,
	type FeatureContext,
	type GateId,
	type MeasurementAggregate,
	type ResolvedFeature,
	type RunTrace,
	type UnitTrace
} from './features/types';
import type {
	StraightTestTrace,
	StraightTestTruthAssistance
} from './features/st.straightTest.contract';
import type {
	RecoveredTeeInput,
	RgbaImage,
	ThreeFactorAssignment,
	ThreeFactorMeasurement,
	ThreeFactorParams
} from './types';

const assignmentUnit: EngineUnit = {
	id: 'assignment',
	gate: 'G6',
	consumes: ['measurement', 'recoveredTees'],
	produces: ['assignment'],
	note: 'straight-route pair scoring + global one-to-one ownership',
	run(board, ctx) {
		const stop = ctx.span('assignment');
		const measurement = board.get<ThreeFactorMeasurement>('measurement');
		const recovered = board.get<readonly RecoveredTeeInput[]>('recoveredTees');
		const straightMeasurement = measurement.parameters.zfit
			? { ...measurement, parameters: { ...measurement.parameters, zfit: false } }
			: measurement;
		const scoringKnobs = ctx.resolve(g4ScoringFeature).knobs as unknown as ScoringKnobs;
		const searchKnobs = ctx.resolve(g4SearchFeature).knobs as unknown as SearchKnobs;
		const ribbonKnobs = ctx.resolve(g5RibbonFeature).knobs as unknown as RibbonKnobs;
		const routingKnobs = ctx.resolve(g5RoutingFeature).knobs as unknown as RoutingKnobs;
		const assignment = assignThreeFactor(
			straightMeasurement,
			recovered,
			undefined,
			scoringKnobs,
			searchKnobs,
			ribbonKnobs,
			routingKnobs
		);
		for (const own of assignment.assignments) {
			ctx.measure('assignment', 'score', own.score);
		}
		board.set('assignment', assignment);
		stop();
	}
};

const zfitUnit: EngineUnit = {
	id: 'zfit',
	gate: 'G7',
	consumes: ['measurement', 'assignment'],
	produces: ['assignment'],
	note: 'optional bent-path Z-fit refinement after straight assignment',
	run(board) {
		// The operation-level implementation owns execution; this unit declaration
		// exists for config validation and schema generation.
		board.set('assignment', board.get<ThreeFactorAssignment>('assignment'));
	}
};

export const ENGINE_UNITS: readonly EngineUnit[] = [
	...measureUnits,
	assignmentUnit,
	zfitUnit,
	phantomTeeUnit,
	teeFamilyUnit,
	teeMinAreaPoseUnit,
	teeRecoveryUnit,
	teeBadgeLockUnit,
	cleanBasketFamilyUnit,
	straightTestUnit
];

export const DEFAULT_EXECUTION: readonly string[] = [
	...DEFAULT_MEASURE_EXECUTION.slice(0, DEFAULT_MEASURE_EXECUTION.indexOf('tees') + 1),
	'teeFamily',
	...DEFAULT_MEASURE_EXECUTION.slice(DEFAULT_MEASURE_EXECUTION.indexOf('tees') + 1),
	'assignment',
	'teeRecovery',
	'zfit'
];

/** Slots the engine seeds before any unit runs. */
export const SEEDED_SLOTS: readonly string[] = [
	'image',
	'localImage',
	'params',
	'viewport',
	'recoveredTees',
	/** Always present at production front doors. Sweep may replace this
	 * separate S0-only payload with verified canonical comparison assistance
	 * before execution; it never changes detector/raster evidence. */
	'straightTestTruthAssistance'
];

export function createTraceContext(
	resolved: ResolvedConfig,
	paramsHash: string,
	operations: readonly OperationSpec[] = [],
	metadata: Pick<RunTrace, 'runId' | 'imageId' | 'traceHash' | 'canonicalFrame'> = {}
): {
	ctx: FeatureContext;
	trace: RunTrace;
} {
	const unitById = new Map(ENGINE_UNITS.map((unit) => [unit.id, unit]));
	const traces = new Map<string, UnitTrace>();
	const heatmaps: Record<string, Float32Array> = {};
	let straightTest: StraightTestTrace | undefined;
	const featureIdsByUnit = new Map<string, string[]>();
	for (const operation of operations) {
		let ids = featureIdsByUnit.get(operation.unit);
		if (!ids) {
			ids = [];
			featureIdsByUnit.set(operation.unit, ids);
		}
		for (const featureId of operation.features ?? []) {
			if (!ids.includes(featureId)) ids.push(featureId);
		}
	}

	function traceFor(unitId: string): UnitTrace {
		let entry = traces.get(unitId);
		if (!entry) {
			const gate: GateId = unitById.get(unitId)?.gate ?? 'shared';
			const boundFeatureIds = featureIdsByUnit.get(unitId) ?? [];
			const fallbackFeature = featureById(unitId);
			const featureIds =
				boundFeatureIds.length > 0 ? boundFeatureIds : fallbackFeature ? [fallbackFeature.id] : [];
			const featureId =
				featureIds.find((id) => featureById(id)?.render?.units.includes(unitId)) ?? featureIds[0];
			const feature = featureId ? featureById(featureId) : undefined;
			const state: ResolvedFeature | undefined = featureId
				? resolved.features[featureId]
				: undefined;
			const knobs = state?.knobs ?? (feature ? defaultKnobs(feature) : {});
			const deviating = feature
				? Object.entries(knobs)
						.filter(([name, value]) => feature.knobs[name]?.default !== value)
						.map(([name]) => name)
				: [];
			entry = {
				id: unitId,
				gate,
				...(featureId ? { featureId } : {}),
				featureIds,
				enabled: state?.enabled ?? true,
				knobs,
				knobsDeviating: deviating,
				ms: 0,
				drawables: [],
				measurements: []
			};
			traces.set(unitId, entry);
		}
		return entry;
	}

	const trace: RunTrace = {
		configName: resolved.name,
		paramsHash,
		...metadata,
		execution: resolved.execution,
		features: resolved.features,
		units: [],
		heatmaps
	};

	const ctx: FeatureContext = {
		occlusion: new OcclusionDetector(),
		resolve(feature) {
			return (
				resolved.features[feature.id] ?? {
					enabled: feature.defaultEnabled,
					knobs: defaultKnobs(feature)
				}
			);
		},
		measure(unitId, name, value) {
			const entry = traceFor(unitId);
			let aggregate: MeasurementAggregate | undefined = entry.measurements.find(
				(m) => m.name === name
			);
			if (!aggregate) {
				aggregate = { name, count: 0, min: Infinity, max: -Infinity, sum: 0 };
				entry.measurements.push(aggregate);
			}
			aggregate.count++;
			aggregate.sum += value;
			if (value < aggregate.min) aggregate.min = value;
			if (value > aggregate.max) aggregate.max = value;
		},
		overlay(unitId, drawable: Drawable) {
			traceFor(unitId).drawables.push(drawable);
		},
		heatmap(unitId, key, data) {
			traceFor(unitId);
			heatmaps[key] = data;
		},
		recordStraightTest(value) {
			// An empty S0 result is still an executed semantic stage. Materialize
			// its UnitTrace even when it emitted no geometry drawables so receipts
			// can distinguish "ran and abstained" from "not scheduled".
			traceFor('straightTest');
			straightTest = value;
		},
		span(unitId) {
			const start = performance.now();
			return () => {
				traceFor(unitId).ms += performance.now() - start;
			};
		}
	};

	return {
		ctx,
		trace: {
			...trace,
			get units() {
				return [...traces.values()];
			},
			get straightTest() {
				return straightTest;
			}
		} as RunTrace
	};
}

/**
 * Injects a baseline feature's knob value into ThreeFactorParams at the
 * key it already rides (measure.ts's makeParameters), when the caller
 * hasn't set that param explicitly. Shared by every baseline feature whose
 * knobs ride CorridorParams instead of a function parameter of their own
 * (g5.ribbon's fieldScale/supportTau, g5.routing's corridorWidthPx/
 * orientations/widthsSrc/alignmentPower/worstWindowSrcPx) — precedence is
 * caller-explicit param > config knob > frozen default.
 */
function bridgeParam<K extends keyof ThreeFactorParams>(
	params: ThreeFactorParams | undefined,
	key: K,
	state: ResolvedFeature | undefined,
	knobName: string
): ThreeFactorParams | undefined {
	if (!state || params?.[key] !== undefined) return params;
	return { ...(params ?? {}), [key]: state.knobs[knobName] } as ThreeFactorParams;
}

/**
 * Resolve every config feature whose values ride the legacy
 * ThreeFactorParams/CorridorParams seed. All execution front doors must call
 * this before seedBoard so the config hash and the executed parameters cannot
 * disagree. Caller-explicit numeric/routing params retain precedence over
 * baseline knobs. An enabled zfit ABFeature remains authoritative over the
 * legacy boolean flag, preserving the existing config behavior.
 */
export function resolveConfiguredParams(
	params: ThreeFactorParams | undefined,
	resolved?: ResolvedConfig
): ThreeFactorParams | undefined {
	if (!resolved) return params;
	const zfitState = resolved.features['zfit'];
	let effectiveParams: ThreeFactorParams | undefined = zfitState?.enabled
		? { ...(params ?? {}), zfit: true }
		: params;

	const ribbonState = resolved.features['ribbon'];
	effectiveParams = bridgeParam(effectiveParams, 'fieldScale', ribbonState, 'fieldScale');
	effectiveParams = bridgeParam(effectiveParams, 'supportTau', ribbonState, 'supportTau');

	const routingState = resolved.features['routing'];
	effectiveParams = bridgeParam(
		effectiveParams,
		'corridorWidthPx',
		routingState,
		'corridorWidthPx'
	);
	effectiveParams = bridgeParam(effectiveParams, 'orientations', routingState, 'orientations');
	effectiveParams = bridgeParam(effectiveParams, 'widthsSrc', routingState, 'widthsSrc');
	effectiveParams = bridgeParam(effectiveParams, 'alignmentPower', routingState, 'alignmentPower');
	effectiveParams = bridgeParam(
		effectiveParams,
		'worstWindowSrcPx',
		routingState,
		'worstWindowSrcPx'
	);
	return effectiveParams;
}

export interface EngineResult {
	readonly measurement: ThreeFactorMeasurement;
	readonly assignment: ThreeFactorAssignment;
	readonly trace?: RunTrace;
}

/**
 * Run the engine: seed the board, validate the execution order against unit
 * declarations, execute in the config's order. `resolved` carries the
 * feature states and the order; omit for frozen defaults with no trace.
 */
export function runEngine(
	image: RgbaImage,
	params: ThreeFactorParams | undefined,
	recoveredTees: readonly RecoveredTeeInput[],
	resolved?: ResolvedConfig,
	paramsHash?: string
): EngineResult {
	const execution = resolved?.execution ?? DEFAULT_EXECUTION;
	// Compile validates the fully-expanded OPERATION list against the op-level
	// dependency DAG (stronger than the old unit-level validateExecution it
	// replaces: it also proves each decomposed unit's own internal chain is a
	// genuine, satisfiable dependency order — R2). `resolved` may be absent
	// (frozen-default, no-trace callers, e.g. the parity pin): compile still
	// needs a ResolvedConfig shape to expand `execution`, so an empty-features
	// stand-in is used — ctx (nullFeatureContext below) never consults it.
	const compileTarget: ResolvedConfig = resolved ?? {
		name: 'frozen-default',
		execution,
		features: {}
	};
	const plan = compileExecutionPlan(compileTarget, paramsHash);

	const effectiveParams = resolveConfiguredParams(params, resolved);

	// Exactly ONE gateway walks operations from here down — executeCompiledPlan
	// (packages/alg/src/exec/gateway.ts). The board is now the exec layer's
	// generic string-keyed ExecBoard; it is structurally identical to the
	// EvidenceBoard the legacy unit bodies expect (get/has/set), so
	// seedBoard — untouched — still seeds it directly.
	const board = createExecBoard();
	seedBoard(board as unknown as EvidenceBoard, image, effectiveParams);
	board.set('recoveredTees', recoveredTees);
	board.set(
		'straightTestTruthAssistance',
		{ mode: 'blind', locks: [] } satisfies StraightTestTruthAssistance
	);

	const withTrace = resolved !== undefined;
	const { ctx, trace } = withTrace
		? createTraceContext(resolved, paramsHash ?? '', plan.ops)
		: { ctx: nullFeatureContext, trace: undefined as unknown as RunTrace };

	executeCompiledPlan(plan, board, ctx);

	return {
		measurement: board.get<ThreeFactorMeasurement>('measurement'),
		assignment: board.get<ThreeFactorAssignment>('assignment'),
		...(withTrace ? { trace } : {})
	};
}
