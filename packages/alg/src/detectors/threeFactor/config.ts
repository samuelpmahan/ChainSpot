// Config loading for the threeFactor engine. Hand-rolled validation in
// makeParameters' throw style — zero dependencies. A config is SPARSE:
// it lists only deviations from registry defaults, so the file's diff IS
// the experiment. The resolved (fully merged) form is what gets hashed.
//
// NOTE on execution order: the validator enforces DECLARED dependencies
// only. An order can be valid yet semantically silly (e.g. tees before
// baskets loses the near-sprite exclusion) — grid searches must filter on
// outcome metrics, not mere validity.

import { ALL_FEATURES, featureById } from './features/registry';
import { defaultKnobs, type ABFeature, type EngineUnit, type GateId, type ResolvedFeature } from './features/types';

export const CONFIG_SCHEMA = 'threeFactor-config@1';

export interface ThreeFactorConfig {
	readonly schema: typeof CONFIG_SCHEMA;
	readonly name: string;
	readonly note?: string;
	/** full unit execution order; omitted = inherit the default order */
	readonly execution?: readonly string[];
	/** gate -> featureId -> deviation */
	readonly gates?: Readonly<
		Partial<Record<GateId, Record<string, { enabled?: boolean; knobs?: Record<string, unknown> }>>>
	>;
}

export interface ResolvedConfig {
	readonly name: string;
	readonly execution: readonly string[];
	/** featureId -> fully resolved state (defaults merged with deviations) */
	readonly features: Readonly<Record<string, ResolvedFeature>>;
}

const GATE_IDS: readonly GateId[] = ['G1', 'G2', 'G3', 'G4', 'ST', 'G5', 'shared'];

function fail(message: string): never {
	throw new Error(`threeFactor config: ${message}`);
}

/** Validate raw parsed JSON into a ThreeFactorConfig. Throws with named errors. */
export function parseConfig(raw: unknown): ThreeFactorConfig {
	if (raw === null || typeof raw !== 'object') fail('config must be a JSON object.');
	const cfg = raw as Record<string, unknown>;
	// Reject typos loudly: a silently ignored key (e.g. 'gatess') would make an
	// experiment run as baseline while looking like it ran.
	const KNOWN_KEYS = ['$schema', 'schema', 'name', 'note', 'execution', 'gates'];
	for (const key of Object.keys(cfg)) {
		if (!KNOWN_KEYS.includes(key)) fail(`unknown key '${key}'.`);
	}
	if (cfg.schema !== CONFIG_SCHEMA) fail(`schema must be '${CONFIG_SCHEMA}'.`);
	if (typeof cfg.name !== 'string' || !cfg.name) fail('name must be a non-empty string.');
	if (cfg.execution !== undefined) {
		if (!Array.isArray(cfg.execution) || cfg.execution.some((u) => typeof u !== 'string')) {
			fail('execution must be an array of unit ids.');
		}
	}
	if (cfg.gates !== undefined) {
		if (cfg.gates === null || typeof cfg.gates !== 'object') fail('gates must be an object.');
		for (const [gate, entries] of Object.entries(cfg.gates as Record<string, unknown>)) {
			if (!GATE_IDS.includes(gate as GateId)) fail(`unknown gate '${gate}'.`);
			if (entries === null || typeof entries !== 'object') fail(`gate '${gate}' must map feature ids to settings.`);
			for (const [featureId, deviation] of Object.entries(entries as Record<string, unknown>)) {
				const feature = featureById(featureId);
				if (!feature) fail(`unknown feature '${featureId}' under gate '${gate}'.`);
				if (feature.gate !== gate) fail(`feature '${featureId}' belongs to gate '${feature.gate}', not '${gate}'.`);
				validateDeviation(feature, deviation);
			}
		}
	}
	return cfg as unknown as ThreeFactorConfig;
}

function validateDeviation(feature: ABFeature, deviation: unknown): void {
	if (deviation === null || typeof deviation !== 'object') {
		fail(`feature '${feature.id}': settings must be an object.`);
	}
	const dev = deviation as { enabled?: unknown; knobs?: unknown };
	if (dev.enabled !== undefined && typeof dev.enabled !== 'boolean') {
		fail(`feature '${feature.id}': enabled must be a boolean.`);
	}
	if (dev.knobs !== undefined) {
		if (dev.knobs === null || typeof dev.knobs !== 'object') {
			fail(`feature '${feature.id}': knobs must be an object.`);
		}
		for (const [name, value] of Object.entries(dev.knobs as Record<string, unknown>)) {
			const spec = feature.knobs[name];
			if (!spec) fail(`feature '${feature.id}': unknown knob '${name}'.`);
			if (spec.validate) {
				const error = spec.validate(value);
				if (error !== null) fail(`feature '${feature.id}' knob '${name}': ${error}`);
			}
		}
	}
}

/**
 * Validate an execution order against unit declarations: every id known, no
 * duplicates, every consumed slot produced by an EARLIER unit (a slot listed
 * in both consumes and produces of one unit is a refinement and needs an
 * earlier producer). Externally provided slots seed the walk.
 */
export function validateExecution(
	execution: readonly string[],
	units: readonly EngineUnit[],
	seeded: readonly string[]
): void {
	const byId = new Map(units.map((unit) => [unit.id, unit]));
	const available = new Set(seeded);
	const ran = new Set<string>();
	for (const id of execution) {
		const unit = byId.get(id);
		if (!unit) fail(`execution lists unknown unit '${id}'.`);
		if (ran.has(id)) fail(`execution lists unit '${id}' twice.`);
		for (const slot of unit.consumes) {
			if (!available.has(slot)) {
				fail(`unit '${id}' consumes '${slot}' but no earlier unit produces it.`);
			}
		}
		for (const slot of unit.produces) available.add(slot);
		ran.add(id);
	}
}

/**
 * Cross-feature invariant: routing.ts's `flood` uses a bucketed priority
 * queue (ring buffer of `ring` buckets, each `quantum` wide). Correctness
 * requires `ring * quantum` to exceed the maximum possible single-step edge
 * weight, or a relaxation's target bucket wraps around the ring and
 * collides with an already-drained bucket — corrupting distances silently
 * instead of erroring. The max edge weight is `(1 + costMultiplier) *
 * Math.SQRT2` (worst-case local cost at zero support, times the diagonal
 * step length; see ribbon.ts buildSupportCost / routing.ts STEP). A single
 * knob's validate() can't see another feature's resolved value, so this is
 * enforced here instead — fail at config-resolve time, not at runtime.
 */
function validateRoutingRingQuantum(features: Readonly<Record<string, ResolvedFeature>>): void {
	const routing = features['routing'];
	const ribbon = features['ribbon'];
	if (!routing || !ribbon) return;
	const quantum = routing.knobs['quantum'] as number;
	const ring = routing.knobs['ring'] as number;
	const costMultiplier = ribbon.knobs['costMultiplier'] as number;
	const maxEdgeWeight = (1 + costMultiplier) * Math.SQRT2;
	if (ring * quantum <= maxEdgeWeight) {
		fail(
			`routing: ring (${ring}) * quantum (${quantum}) = ${ring * quantum} must exceed the maximum ` +
				`possible single-step edge weight (~${maxEdgeWeight.toFixed(3)}, from ribbon.costMultiplier=` +
				`${costMultiplier}) — otherwise the bucket queue wraps and silently corrupts routing distances.`
		);
	}
}

/** Merge registry defaults with the config's deviations. */
export function resolveConfig(config: ThreeFactorConfig, defaultExecution: readonly string[]): ResolvedConfig {
	const features: Record<string, ResolvedFeature> = {};
	for (const feature of ALL_FEATURES) {
		const deviation = config.gates?.[feature.gate]?.[feature.id];
		features[feature.id] = {
			enabled: deviation?.enabled ?? feature.defaultEnabled,
			knobs: { ...defaultKnobs(feature), ...(deviation?.knobs ?? {}) }
		};
	}
	validateRoutingRingQuantum(features);
	return {
		name: config.name,
		execution: config.execution ?? defaultExecution,
		features
	};
}
