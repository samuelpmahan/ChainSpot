// Core types for the config-driven threeFactor engine.
//
// The algorithm is executed as an ordered list of UNITS over a shared
// evidence board; the order comes from the CONFIG (the single readable
// source of truth for the alg), validated against each unit's declared
// consumes/produces. ABFeatures are behavior with an A/B-style easy-off:
// baseline units default ON and deviations default OFF so the default config
// remains the explicit recovered production behavior.

import type { ABFeatureOperation } from '../../../exec/feature-set';
import { OcclusionDetector } from '../occlusion';
import type { StraightTestTrace } from './st.straightTest.contract';

// ---------------------------------------------------------------------------
// Gates — one canonical knowledge order. The compiler still flattens units
// into operations, but every operation/feature belongs to exactly one phase.
// `shared` is infrastructure ownership, never an extra scheduled gate.
export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'shared';

export const CANONICAL_GATE_ORDER = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'] as const;

export const GATE_TITLES: Record<GateId, string> = {
	G1: 'Badges',
	G2: 'Baskets',
	G3: 'Visible Tees',
	G4: 'Endpoint Recovery',
	G5: 'Straight Test',
	G6: 'Assignment',
	G7: 'Bend Refinement',
	shared: 'Shared Infrastructure'
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
	4: 'G4',
	5: 'G5',
	6: 'G6',
	7: 'G7'
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
	/** baseline = part of production behavior (default ON); deviation = opt-in */
	readonly kind: 'baseline' | 'deviation';
	readonly defaultEnabled: boolean;
	/**
	 * Keep a newly introduced default-OFF experiment out of a pre-existing
	 * frozen resolved-config hash unless the saved config names it explicitly.
	 * This is intentionally opt-in: older deviations remain materialized in
	 * legacy resolved configs exactly as their pinned baseline requires.
	 */
	readonly resolveOnlyWhenConfigured?: boolean;
	readonly note?: string;
	readonly knobs: K;
	/** Ordered executable behavior when this feature participates in an ABFeatureSet. */
	readonly operations?: readonly ABFeatureOperation[];
	/**
	 * OPTIONAL feature-owned rendering. Absent on every feature by default,
	 * so this member cannot move parity and cannot break a feature that
	 * never opts in.
	 *
	 * Why it exists: the LAB renderer registry keys on ArtifactKind (mask,
	 * rgba, componentSet, ...). A kind-keyed renderer gets ONE artifact and
	 * knows nothing about which feature produced it or why, so it can draw
	 * "a mask" but never "the tee candidates this feature rejected, over
	 * the bright mask it rejected them on". The feature knows that. This
	 * hook lets the feature say it.
	 *
	 * It is a DESCRIPTION, not a drawing: `draw` returns a FeatureRenderPlan
	 * of layers over already-traced drawables. It must not rasterize, must
	 * not recompute detector data, and must not reach for pixels — every
	 * value in the plan has to come from the UnitTrace/RunTrace it was
	 * handed. The kind-keyed path stays the owner of raw bytes.
	 */
	readonly render?: FeatureRender;
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
	/** Literal producer provenance that is not a measurement (for example,
	 * contributor references or an explicit UNKNOWN). Render selectors forward
	 * this verbatim and must not synthesize or reinterpret it. */
	readonly metadata?: Readonly<Record<string, string>>;
	/** Presentation intent carried by the detector trace, never inferred from
	 * a magic ref string. It cannot change a verdict or semantic cardinality. */
	readonly visualRole?:
		| 'badge-pixels'
		| 'basket-tip'
		| 'tee-visible-pixels'
		| 'tee-border'
		| 'tee-center'
		| 'tee-shard'
		| 'tee-corner-tick'
		| 'tee-diagonal'
		| 'tee-rejection'
		| 'phantom-center'
		| 'tee-badge-path';
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

/** Exact raster evidence. Unlike a polyline, a pixel set has no implied
 * connectivity and the renderer must not interpolate between its cells. */
export interface PixelSetDrawable extends DrawableBase {
	readonly type: 'pixelSet';
	readonly pixels: readonly (readonly [number, number])[];
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

export type Drawable =
	PointDrawable | BoxDrawable | PolylineDrawable | PixelSetDrawable | HeatmapDrawable;

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
	/** Primary ABFeature whose state supplies this unit's legacy enabled/knob
	 * fields. Derived from the compiled operations, never guessed from unit id. */
	readonly featureId?: string;
	/** Every ABFeature read by this unit's compiled operations, in plan order. */
	readonly featureIds: readonly string[];
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
	/** Optional until a front door knows the canonical run/image identity. */
	readonly runId?: string;
	readonly imageId?: string;
	/** Deterministic semantic trace digest. It intentionally excludes timers
	 * and heatmap payload bytes so equivalent reviewed testimony hashes alike. */
	readonly traceHash?: string;
	readonly canonicalFrame?: string;
	readonly execution: readonly string[];
	/** Exact feature states used by the run. Unit ids are not feature ids: the
	 * `tees` unit, for example, reads the `endpoints` feature's knobs. */
	readonly features: Readonly<Record<string, ResolvedFeature>>;
	readonly units: UnitTrace[];
	/** keyed heatmap buffers; transfer these across postMessage */
	readonly heatmaps: Record<string, Float32Array>;
	/** S0 structured rows; optional so legacy traces remain source-compatible. */
	readonly straightTest?: StraightTestTrace;
}

// ---------------------------------------------------------------------------
// Feature-owned rendering — the three types ABFeature.render is made of, and
// nothing else. They live here because the alg may not depend on LAB and
// ABFeature.render needs a name for its shape; they carry no runtime logic.

/** One draw pass over drawables the trace already holds. Style comes from
 * each Drawable's own `verdict` (accepted/rejected/info) — a layer never
 * restates it, so a renderer can never disagree with the trace. */
export interface FeatureRenderLayer {
	readonly name: string;
	/** one line explaining what this layer is evidence OF */
	readonly note?: string;
	readonly drawables: readonly Drawable[];
}

/** What a feature wants drawn for one run. Declarative: the renderer picks
 * the medium (SVG/PNG/text), the feature picks the content. */
export interface FeatureRenderPlan {
	readonly title: string;
	/**
	 * Artifact id of the raster this plan reads best over (e.g.
	 * 'badgeStage.masks:bright'), for a renderer that can resolve one.
	 * A NAME, never bytes — resolving it stays with the kind-keyed path.
	 * Omit when the overlay stands on its own.
	 */
	readonly base?: string;
	readonly layers: readonly FeatureRenderLayer[];
	/**
	 * Receipt lines. Repo rule: every number ships with where it came from,
	 * or a loud UNKNOWN. These are printed verbatim next to the image.
	 */
	readonly notes: readonly string[];
}

export interface FeatureRender {
	/**
	 * Trace unit ids whose UnitTrace this render consumes. Required because
	 * a unit id is NOT a feature id: the trace unit that carries g3.endpoints'
	 * drawables is called 'tees'. Declaring it here keeps that mapping next
	 * to the feature instead of in a lookup table on the LAB side that goes
	 * stale silently.
	 */
	readonly units: readonly string[];
	/** `unit` is one of `units`; `run` is the whole trace, so cross-gate
	 * overlays (a G3 rejection drawn against G2's accepted baskets) are
	 * possible without a second pass over the image. */
	draw(unit: UnitTrace, run: RunTrace): FeatureRenderPlan;
}

// ---------------------------------------------------------------------------
// FeatureContext — what units/features get handed at run time.

export interface FeatureContext {
	resolve(feature: ABFeature): ResolvedFeature;
	/** exact aggregates over the full stream (count/min/max/sum) */
	measure(unitId: string, name: string, value: number): void;
	overlay(unitId: string, drawable: Drawable): void;
	heatmap(unitId: string, key: string, data: Float32Array): void;
	/** Publish the reviewed S0 row payload beside normal drawables. Optional
	 * keeps custom legacy FeatureContexts source-compatible; production trace
	 * contexts always supply it. */
	recordStraightTest?(trace: StraightTestTrace): void;
	/** returns a stop function that records elapsed ms on the unit trace */
	span(unitId: string): () => void;
	/** Stable per-run known-occlusion service. */
	readonly occlusion: OcclusionDetector;
}

/** No-op context: legacy callers pay nothing and change nothing. */
export const nullFeatureContext: FeatureContext = {
	occlusion: new OcclusionDetector(),
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
	| 'recoveredTees'
	| 'straightProposals'
	| 'straightTestTruthAssistance'
	| 'assignment'
	| 'teeBadgeLock';

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
