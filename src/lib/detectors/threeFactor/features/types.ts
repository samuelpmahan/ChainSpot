// Core types for the config-driven threeFactor engine.
//
// The algorithm is executed as an ordered list of UNITS over a shared
// evidence board; the order comes from the CONFIG (the single readable
// source of truth for the alg), validated against each unit's declared
// consumes/produces. ABFeatures are behavior with an A/B-style easy-off:
// baseline units default ON, deviations default OFF so that the default
// config reproduces frozen dev72 behavior byte-for-byte.

// ---------------------------------------------------------------------------
// Gates — the human taxonomy over the DAG (organizes config/trace/UI; does
// NOT define execution order, which the config's execution list carries).
// Owner ruling: Straight Test (ST) sits between G4 and G5.
export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'ST' | 'G5' | 'shared';

export const GATE_TITLES: Record<GateId, string> = {
	G1: 'Badges',
	G2: 'Baskets',
	G3: 'Tees',
	G4: 'Tee→Badge',
	ST: 'Straight Test',
	G5: 'Path',
	shared: 'Shared (masks/field)'
};

/**
 * Mapping to the LAB registry cards (scripts/chainspot-lab/gates.ts, ids
 * 0-7). LAB 0 (Crop + Stitch) is pre-detector and has no engine gate.
 */
export const LAB_GATE_MAPPING: Record<number, GateId | 'pre-detector'> = {
	0: 'pre-detector',
	1: 'G1',
	2: 'G2',
	3: 'G3',
	4: 'G3', // Endpoint Recovery
	5: 'ST', // Straight Test
	6: 'G4', // Assignment
	7: 'G5' // Bend Refinement
};

// ---------------------------------------------------------------------------
// Knobs

export interface KnobSpec<T> {
	readonly default: T;
	readonly note?: string;
	/** returns an error string, or null when valid — makeParameters' style */
	readonly validate?: (value: T) => string | null;
}

export type KnobSpecs = Record<string, KnobSpec<unknown>>;

export type KnobValues<K extends KnobSpecs> = { readonly [P in keyof K]: K[P]['default'] };

// ---------------------------------------------------------------------------
// ABFeatures

export interface ABFeature<K extends KnobSpecs = KnobSpecs> {
	/** unique across the registry, e.g. 'zfit', 'phantomTee' */
	readonly id: string;
	readonly gate: GateId;
	/** baseline = part of frozen behavior (default ON); deviation = opt-in */
	readonly kind: 'baseline' | 'deviation';
	readonly defaultEnabled: boolean;
	readonly note?: string;
	readonly knobs: K;
}

export interface ResolvedFeature {
	readonly enabled: boolean;
	readonly knobs: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Spatial trace — the primary instrumentation channel. Drawables live in
// ORIGINAL-IMAGE pixel coordinates. Filtering code MUST emit a rejected
// drawable (with reason) per killed candidate: no silent drops.

export type Verdict = 'accepted' | 'rejected' | 'info';

export interface DrawableBase {
	readonly verdict: Verdict;
	/** mandatory when verdict === 'rejected' */
	readonly reason?: string;
	/** evidence reference (detId etc.) — never pixels */
	readonly ref?: string;
	/** small numeric payload rendered in tooltips */
	readonly values?: Record<string, number>;
}

export interface PointDrawable extends DrawableBase {
	readonly type: 'point';
	readonly xPx: number;
	readonly yPx: number;
}

export interface BoxDrawable extends DrawableBase {
	readonly type: 'box';
	readonly bbox: readonly [number, number, number, number];
}

export interface PolylineDrawable extends DrawableBase {
	readonly type: 'polyline';
	readonly path: readonly (readonly [number, number])[];
}

/**
 * Heatmaps carry their Float32Array OUT OF BAND (transferable across the
 * worker boundary, zero copy); the drawable holds dims + a key into
 * RunTrace.heatmaps.
 */
export interface HeatmapDrawable extends DrawableBase {
	readonly type: 'heatmap';
	readonly key: string;
	readonly widthCells: number;
	readonly heightCells: number;
	/** cell size in original-image px (field scale) */
	readonly cellPx: number;
	readonly originXPx: number;
	readonly originYPx: number;
}

export type Drawable = PointDrawable | BoxDrawable | PolylineDrawable | HeatmapDrawable;

export interface MeasurementAggregate {
	readonly name: string;
	count: number;
	min: number;
	max: number;
	sum: number;
}

export interface UnitTrace {
	readonly id: string;
	readonly gate: GateId;
	readonly enabled: boolean;
	readonly knobs: Record<string, unknown>;
	readonly knobsDeviating: readonly string[];
	ms: number;
	readonly drawables: Drawable[];
	readonly measurements: MeasurementAggregate[];
}

export interface RunTrace {
	readonly configName: string;
	readonly paramsHash: string;
	readonly execution: readonly string[];
	readonly units: UnitTrace[];
	/** keyed heatmap buffers; transfer these across postMessage */
	readonly heatmaps: Record<string, Float32Array>;
}

// ---------------------------------------------------------------------------
// FeatureContext — what units/features get handed at run time.

export interface FeatureContext {
	resolve(feature: ABFeature): ResolvedFeature;
	/** exact aggregates over the full stream (count/min/max/sum) */
	measure(unitId: string, name: string, value: number): void;
	overlay(unitId: string, drawable: Drawable): void;
	heatmap(unitId: string, key: string, data: Float32Array): void;
	/** returns a stop function that records elapsed ms on the unit trace */
	span(unitId: string): () => void;
}

/** No-op context: legacy callers pay nothing and change nothing. */
export const nullFeatureContext: FeatureContext = {
	resolve(feature) {
		return { enabled: feature.defaultEnabled, knobs: defaultKnobs(feature) };
	},
	measure() {},
	overlay() {},
	heatmap() {},
	span() {
		return () => {};
	}
};

export function defaultKnobs(feature: ABFeature): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [name, spec] of Object.entries(feature.knobs)) out[name] = spec.default;
	return out;
}

// ---------------------------------------------------------------------------
// Engine units — stages of the algorithm on the evidence board.

export type EvidenceSlot =
	| 'image'
	| 'localImage'
	| 'params'
	| 'viewport'
	| 'stage'
	| 'badges'
	| 'supportField'
	| 'sprites'
	| 'baskets'
	| 'tees'
	| 'rawPairs'
	| 'measurement'
	| 'assignment';

export interface EvidenceBoard {
	get<T>(slot: EvidenceSlot): T;
	has(slot: EvidenceSlot): boolean;
	set(slot: EvidenceSlot, value: unknown): void;
}

export interface EngineUnit {
	readonly id: string;
	readonly gate: GateId;
	/** slots that must exist before this unit runs */
	readonly consumes: readonly EvidenceSlot[];
	/** slots this unit writes (a slot in both lists = refinement in place) */
	readonly produces: readonly EvidenceSlot[];
	readonly note?: string;
	run(board: EvidenceBoard, ctx: FeatureContext): void;
}
