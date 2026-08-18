/**
 * ChainSpot-owned CV pipeline configuration root.
 *
 * This is the single object that determines pipeline BEHAVIOR for a given
 * run: `DEFAULT_CV_CONFIG` is the production configuration and MUST produce
 * output identical to the pre-existing hard-coded constants it replaces (see
 * `p6LowParBasketAssignment.ts`, which re-exports its own constants as this
 * file's source of truth so there is exactly one place defaults live).
 *
 * Toph (the counterfactual-replay tool) treats this shape as an opaque JSON
 * object — it patches dot-paths and re-executes the pipeline, but has no
 * built-in knowledge of ribbons, forward gates, holes, or baskets. ChainSpot
 * owns parameter meaning, defaults, and the schema describing how each
 * parameter should render as a control.
 */

import { MIN_RIBBON_IMPROVEMENT_PX, P6_FORWARD_GATE_ANGLE_DEG } from './p6LowParBasketAssignment';

/** Pancake 6.2 local ribbon-evidence swap adjudication levers. */
export interface P6SwapConfig {
	/** When false, P6.2 never runs; the gated P6.1 result passes through unchanged. */
	readonly enabled: boolean;
	/** Minimum ribbon-distance improvement (px) required before a swap is applied. */
	readonly minRibbonImprovementPx: number;
}

/** Pancake 6 (local LowPar basket assignment) configuration. */
export interface P6Config {
	/** Forward-gate half-angle (degrees) a candidate basket must fall within to be solver-eligible. */
	readonly forwardGateAngleDeg: number;
	readonly swap: P6SwapConfig;
}

// P1-P5 are reserved for future replay levers. They are intentionally empty
// today -- every stage currently has no tunable runtime parameters -- but are
// modeled as their own interfaces so a future lever can be added to exactly
// one stage's config without reshaping `ChainSpotCvConfig` itself.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface P1Config {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface P2Config {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface P3Config {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface P4Config {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface P5Config {}

export interface ChainSpotCvConfig {
	readonly p1: P1Config;
	readonly p2: P2Config;
	readonly p3: P3Config;
	readonly p4: P4Config;
	readonly p5: P5Config;
	readonly p6: P6Config;
}

function deepFreeze<T>(value: T): T {
	if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
		Object.getOwnPropertyNames(value).forEach((key) => {
			deepFreeze((value as Record<string, unknown>)[key]);
		});
		Object.freeze(value);
	}
	return value;
}

/**
 * Production defaults. MUST equal the pre-existing hidden constants exactly:
 * `P6_FORWARD_GATE_ANGLE_DEG` (80) and `MIN_RIBBON_IMPROVEMENT_PX` (20); the
 * swap stage has always run unconditionally, so `swap.enabled` defaults true.
 *
 * Deep-frozen so a caller cannot accidentally mutate the shared default and
 * leak that mutation across runs/callers.
 */
export const DEFAULT_CV_CONFIG: ChainSpotCvConfig = deepFreeze({
	p1: {},
	p2: {},
	p3: {},
	p4: {},
	p5: {},
	p6: {
		forwardGateAngleDeg: P6_FORWARD_GATE_ANGLE_DEG,
		swap: {
			enabled: true,
			minRibbonImprovementPx: MIN_RIBBON_IMPROVEMENT_PX
		}
	}
});

/**
 * A "zero-bend shortcut" P6 lever was investigated during the design of this
 * config surface and rejected: "zero bends" is a concept that only appears
 * in the corridor-bend-detection stages (`corridorBendDetection.ts` /
 * `corridorBendDetectionCapsule.ts`), not anywhere in P6's runtime decision
 * path (the forward gate and the swap adjudication). It is NOT a real P6
 * runtime option and is deliberately not exposed here or in
 * `CV_PARAM_SCHEMA`. Do not add it without re-deriving it from an actual P6
 * code path.
 */

export type ParamSpec =
	| { readonly path: string; readonly label: string; readonly type: 'boolean'; readonly default: boolean }
	| {
			readonly path: string;
			readonly label: string;
			readonly type: 'number';
			readonly default: number;
			readonly min?: number;
			readonly max?: number;
			readonly step?: number;
	  }
	| {
			readonly path: string;
			readonly label: string;
			readonly type: 'enum';
			readonly default: string;
			readonly options: readonly string[];
	  };

/**
 * Parameter schema for a generic replay-tool renderer (Toph). Every entry's
 * `path` is a dot-path into `ChainSpotCvConfig`/`DEFAULT_CV_CONFIG`, and its
 * `default` MUST match the corresponding value in `DEFAULT_CV_CONFIG`.
 */
export const CV_PARAM_SCHEMA: readonly ParamSpec[] = [
	{
		path: 'p6.swap.enabled',
		label: 'P6.2 swap adjudication enabled',
		type: 'boolean',
		default: DEFAULT_CV_CONFIG.p6.swap.enabled
	},
	{
		path: 'p6.swap.minRibbonImprovementPx',
		label: 'P6.2 minimum ribbon improvement (px)',
		type: 'number',
		default: DEFAULT_CV_CONFIG.p6.swap.minRibbonImprovementPx,
		min: 0,
		max: 200,
		step: 5
	},
	{
		path: 'p6.forwardGateAngleDeg',
		label: 'P6.1 forward gate angle (deg)',
		type: 'number',
		default: DEFAULT_CV_CONFIG.p6.forwardGateAngleDeg,
		min: 0,
		max: 180,
		step: 5
	}
];
