/**
 * Producer-agnostic progressive Course Vision evidence contract.
 *
 * This is the public seam between every detection producer (the legacy
 * Pancake worker, the source-prior pure-TS path, and future NuThing
 * operators) and the UI. Events describe WHAT is now known about the course
 * — never which execution path or stage number produced it — so new
 * producers plug in without another frontend redesign.
 *
 * Two hard rules callers must respect:
 *
 * 1. Evidence is transient, retractable visualization state ONLY. Nothing
 *    here may mutate `AnnotatedHole`/domain state — including `final`
 *    events. The completed `CourseDetectionResult` remains the sole
 *    authoritative mutation boundary.
 * 2. Operator identity is always a descriptive name. The P-number is
 *    lineage/debug shorthand and never appears alone in logs, traces, or
 *    UI copy — render via `operatorLabel()` ("P4 · Ribbon-Component
 *    Ownership", never bare "P4").
 */

/**
 * A hole's progression through evidence, ordered by certainty:
 *
 *   candidate → identified → owned → provisional → locked → final
 *
 * - `candidate`: raw landmark(s) observed, not yet tied to a hole number.
 * - `identified`: a badge glyph resolved to a hole number.
 * - `owned`: tee/badge/basket geometric association exists for the hole.
 * - `provisional`: ownership/straightness evidence suggests a likely
 *   resolution (e.g. a P3 straight-ray basket hit) — NOT authoritative.
 * - `locked`: an authoritative fail-closed early-lock criterion has been
 *   met. No such criterion exists yet — reserved for benchmark-gated
 *   NuThing work; no current producer may emit it.
 * - `final`: global reconciliation has produced the authoritative hole.
 */
export type HoleVisionState =
	| 'candidate'
	| 'identified'
	| 'owned'
	| 'provisional'
	| 'locked'
	| 'final';

/** Certainty rank for monotonic display merges. Higher never regresses to lower within one run. */
export const HOLE_VISION_STATE_RANK: Readonly<Record<HoleVisionState, number>> = Object.freeze({
	candidate: 0,
	identified: 1,
	owned: 2,
	provisional: 3,
	locked: 4,
	final: 5
});

/**
 * Which lane produced the evidence. `fast-lane` facts arrive early from
 * cheap operators (pure-TS glyph classification, source-prior landmarks,
 * geometry-only ownership) and are superseded without ceremony;
 * `authoritative` facts come from the full reconciliation path whose
 * completed result will mutate domain state.
 */
export type CourseVisionChannel = 'fast-lane' | 'authoritative';

export interface CourseVisionOperatorRef {
	/** Descriptive name saying what evidence is consumed and what fact is established. */
	readonly name: string;
	/** Historical Pancake lineage shorthand (e.g. "P3"). Absent for NuThing-era operators. */
	readonly shorthand?: string;
}

/** Known operators. New producers add entries here (descriptive name mandatory, shorthand only for Pancake lineage). */
export const COURSE_VISION_OPERATORS = Object.freeze({
	rawUiLandmarkLocalization: Object.freeze({
		name: 'Raw UI Landmark Localization',
		shorthand: 'P1'
	}),
	badgeGlyphIdentification: Object.freeze({
		name: 'Badge Glyph Identification',
		shorthand: 'P2'
	}),
	pureTsBadgeGlyphIdentification: Object.freeze({
		name: 'Pure-TS Badge Glyph Identification'
	}),
	geometricOwnership: Object.freeze({
		name: 'Geometric Tee/Badge/Basket Ownership',
		shorthand: 'P3'
	}),
	ribbonComponentOwnership: Object.freeze({
		name: 'Ribbon-Component Ownership',
		shorthand: 'P4'
	}),
	sparseTeeToHoleAssignment: Object.freeze({
		name: 'Sparse Tee-to-Hole Assignment',
		shorthand: 'P5'
	}),
	basketAssignmentAndReconciliation: Object.freeze({
		name: 'Basket Assignment and Reconciliation',
		shorthand: 'P6'
	}),
	sourceLandmarkFusion: Object.freeze({
		name: 'Source Landmark Fusion'
	}),
	finalCourseGrammarMaterialization: Object.freeze({
		name: 'Final Course Grammar Materialization'
	})
} satisfies Record<string, CourseVisionOperatorRef>);

/** Canonical log/trace label: "P4 · Ribbon-Component Ownership", or the bare descriptive name for NuThing operators. */
export function operatorLabel(operator: CourseVisionOperatorRef): string {
	return operator.shorthand ? `${operator.shorthand} · ${operator.name}` : operator.name;
}

/** A landmark observation in composite/source-image pixels, sized when the producer knows the extent. */
export interface EvidenceLandmark {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx?: number;
	readonly heightPx?: number;
}

/** Batch payload for `candidate` events: everything a cheap pass localized, before any identity exists. */
export interface EvidenceLandmarkBatch {
	readonly tees?: readonly EvidenceLandmark[];
	readonly badges?: readonly EvidenceLandmark[];
	readonly baskets?: readonly EvidenceLandmark[];
}

/** Per-hole payload for `identified`/`owned`/`provisional`/`locked`/`final` events. */
export interface EvidenceHoleGeometry {
	readonly tee?: EvidenceLandmark;
	readonly badge?: EvidenceLandmark;
	readonly basket?: EvidenceLandmark;
}

export interface CourseVisionEvidenceEvent {
	readonly state: HoleVisionState;
	readonly channel: CourseVisionChannel;
	readonly producer: CourseVisionOperatorRef;
	/** Human-readable, e.g. "Pure-TS Badge Glyph Identification resolved H7". */
	readonly message: string;
	/** Present on per-hole events; absent for un-identified candidate batches. */
	readonly holeNumber?: number;
	/** Present on `candidate` batch events. */
	readonly landmarks?: EvidenceLandmarkBatch;
	/** Present on per-hole events when geometry is known. */
	readonly geometry?: EvidenceHoleGeometry;
	/** Milliseconds since the detection request began, for timing traces. */
	readonly elapsedMs?: number;
}

export type CourseVisionEvidenceListener = (
	events: readonly CourseVisionEvidenceEvent[]
) => void;
