// The threeFactor engine: executes a config-declared unit order over the
// evidence board, resolving ABFeatures and collecting the spatial trace.
// The DEFAULT config reproduces frozen dev72 behavior byte-for-byte
// (pinned by tests/unit/threeFactorParity.test.ts).

import { assignThreeFactor, type ZfitKnobs } from './assignment';
import type { ScoringKnobs } from './scoring';
import { validateExecution, type ResolvedConfig } from './config';
import { createBoard, measureUnits, seedBoard, DEFAULT_MEASURE_EXECUTION } from './measure';
import { featureById } from './features/registry';
import { zfitFeature } from './features/g5.zfit';
import { g4ScoringFeature } from './features/g4.scoring';
import { phantomTeeUnit } from './features/g3.phantomTee';
import {
	defaultKnobs,
	nullFeatureContext,
	type Drawable,
	type EngineUnit,
	type FeatureContext,
	type GateId,
	type MeasurementAggregate,
	type ResolvedFeature,
	type RunTrace,
	type UnitTrace
} from './features/types';
import type {
	RecoveredTeeInput,
	RgbaImage,
	ThreeFactorAssignment,
	ThreeFactorMeasurement,
	ThreeFactorParams
} from './types';

const assignmentUnit: EngineUnit = {
	id: 'assignment',
	gate: 'G4',
	consumes: ['measurement', 'recoveredTees'],
	produces: ['assignment'],
	note: 'pair scoring (zfit salvage when enabled) + global one-to-one ownership',
	run(board, ctx) {
		const stop = ctx.span('assignment');
		const measurement = board.get<ThreeFactorMeasurement>('measurement');
		const recovered = board.get<readonly RecoveredTeeInput[]>('recoveredTees');
		const zfit = ctx.resolve(zfitFeature);
		const zfitKnobs = zfit.knobs as unknown as ZfitKnobs;
		const scoringKnobs = ctx.resolve(g4ScoringFeature).knobs as unknown as ScoringKnobs;
		const assignment = assignThreeFactor(measurement, recovered, zfitKnobs, scoringKnobs);
		for (const own of assignment.assignments) {
			ctx.measure('assignment', 'score', own.score);
		}
		board.set('assignment', assignment);
		stop();
	}
};

export const ENGINE_UNITS: readonly EngineUnit[] = [...measureUnits, assignmentUnit, phantomTeeUnit];

export const DEFAULT_EXECUTION: readonly string[] = [...DEFAULT_MEASURE_EXECUTION, 'assignment'];

/** Slots the engine seeds before any unit runs. */
export const SEEDED_SLOTS: readonly string[] = [
	'image',
	'localImage',
	'params',
	'viewport',
	'recoveredTees'
];

export function createTraceContext(resolved: ResolvedConfig, paramsHash: string): {
	ctx: FeatureContext;
	trace: RunTrace;
} {
	const unitById = new Map(ENGINE_UNITS.map((unit) => [unit.id, unit]));
	const traces = new Map<string, UnitTrace>();
	const heatmaps: Record<string, Float32Array> = {};

	function traceFor(unitId: string): UnitTrace {
		let entry = traces.get(unitId);
		if (!entry) {
			const gate: GateId = unitById.get(unitId)?.gate ?? 'shared';
			const feature = featureById(unitId);
			const state: ResolvedFeature | undefined = feature
				? resolved.features[unitId]
				: undefined;
			const knobs = state?.knobs ?? (feature ? defaultKnobs(feature) : {});
			const deviating = feature
				? Object.entries(knobs).filter(([name, value]) => feature.knobs[name]?.default !== value).map(([name]) => name)
				: [];
			entry = {
				id: unitId,
				gate,
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
		execution: resolved.execution,
		units: [],
		heatmaps
	};

	const ctx: FeatureContext = {
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
			let aggregate: MeasurementAggregate | undefined = entry.measurements.find((m) => m.name === name);
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
			}
		} as RunTrace
	};
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
	validateExecution(execution, ENGINE_UNITS, SEEDED_SLOTS);

	// feature -> params bridge: zfit rides CorridorParams so measurement
	// records it (the frozen shape) — engine injects the resolved state.
	const zfitState = resolved?.features['zfit'];
	const effectiveParams: ThreeFactorParams | undefined = zfitState?.enabled
		? { ...(params ?? {}), zfit: true }
		: params;

	const board = createBoard();
	seedBoard(board, image, effectiveParams);
	board.set('recoveredTees', recoveredTees);

	const withTrace = resolved !== undefined;
	const { ctx, trace } = withTrace
		? createTraceContext(resolved, paramsHash ?? '')
		: { ctx: nullFeatureContext, trace: undefined as unknown as RunTrace };

	const unitById = new Map(ENGINE_UNITS.map((unit) => [unit.id, unit]));
	for (const id of execution) {
		const unit = unitById.get(id);
		if (!unit) throw new Error(`engine: unknown unit '${id}'.`);
		unit.run(board, ctx);
	}

	return {
		measurement: board.get<ThreeFactorMeasurement>('measurement'),
		assignment: board.get<ThreeFactorAssignment>('assignment'),
		...(withTrace ? { trace } : {})
	};
}
