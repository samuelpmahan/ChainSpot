/**
 * ChainSpot Stitch Map layout diagnostics and confidence (P1-002).
 *
 * A single pure, deterministic pass over the raw evidence `assignFour` already
 * produces. It turns that evidence into one simple text confidence category and
 * a small list of concrete warnings. Confidence is product guidance, not a
 * research-grade probability: "strong" means the layout is internally consistent
 * under the bounded 2×2 model and the representative fixtures; it does not mean
 * pixel-perfect or universally correct. "Uncertain" results always remain
 * editable and no decoded file is ever discarded.
 *
 * Thresholds are named constants with comments tied to fixture behavior, not
 * scattered magic numbers. There is deliberately no layered confidence
 * framework: the correct product behavior is usually "load the best attempt and
 * ask the user to review," not "certify the algorithm."
 */
import type { AnalysisRaster } from './analysis';
import type { AutoLayout } from './autoLayout';
import type { TileSlot } from './geometry';

export type ConfidenceCategory = 'strong' | 'review' | 'uncertain';

export type StitchWarningKind =
	| 'weak-overlap'
	| 'contradictory-lower-right'
	| 'mixed-zoom'
	| 'ambiguous-repeated-imagery'
	| 'unrelated-tile'
	| 'no-connected-layout';

export interface StitchWarning {
	readonly kind: StitchWarningKind;
	/** A user-readable, accessibility-safe description of the concrete issue. */
	readonly message: string;
}

export interface LayoutDiagnostic {
	readonly category: ConfidenceCategory;
	readonly warnings: readonly StitchWarning[];
}

// --- Thresholds, each tied to documented fixture behavior -------------------

/**
 * Expected-neighbor overlap below this fraction of a tile dimension is flagged
 * as weak overlap. Fixtures: the "strong" set overlaps 25% (0.25) and the "weak"
 * recoverable set overlaps 17.5% (0.175), below ChainSpot's intended 20–30%.
 */
export const WEAK_OVERLAP_MAX_FRACTION = 0.2;

/**
 * Assignment score below this is never "strong": it means at least one expected
 * neighbor match is well below a credible match. Fixture "strong" scores ~4.0
 * (four near-perfect edges); an unrelated tile pulls the total well below this.
 */
export const STRONG_MIN_ASSIGNMENT_SCORE = 3.2;

/**
 * Assignment score below this means the best attempt is not coherent enough to
 * claim an arrangement and the result is `uncertain`.
 */
export const REVIEW_MIN_ASSIGNMENT_SCORE = 2.4;

/**
 * Winner-vs-runner-up assignment separation below this is not "strong". The
 * strong fixture's correct arrangement wins by ~0.16 and must stay strong; the
 * weak 17.5%-overlap fixture's narrow search band leaves only ~0.07 separation,
 * which is the "review" signal.
 */
export const STRONG_MIN_SEPARATION = 0.1;

/** An expected edge scoring below this is a weak neighbor match. */
export const WEAK_EDGE_MAX_SCORE = 0.6;

/**
 * An expected edge scoring below this means the two tiles do not appear to share
 * map content (the best whole-band match is still poor). Fixture "incompatible"
 * renders one tile as unrelated high-contrast content, which scores near 0.55.
 */
export const UNRELATED_EDGE_MAX_SCORE = 0.82;

/**
 * An expected edge whose winner beats its best distinct alternative (analysis
 * runner-up) by less than this is ambiguous: repeated imagery makes a different
 * placement nearly as plausible. Fixture "repetitive" ties at 0. The weak
 * 17.5%-overlap fixture's edges keep ~0.075-0.13 separation (indistinct but not
 * repeated), so they must not fire.
 */
export const AMBIGUOUS_EDGE_MIN_SEPARATION = 0.05;

/**
 * A globally ambiguous assignment (winner vs runner-up within this tiny margin)
 * is never trusted. This only catches near-exact assignment ties; the weak
 * fixture's ~0.07 separation is above it and stays "review".
 */
export const GLOBAL_AMBIGUITY_MAX_SEPARATION = 0.02;

/**
 * The two redundant lower-right paths (right column vs bottom row) must agree to
 * within this fraction of a tile dimension; otherwise the position is
 * contradictory. Fixture "incompatible" produces a ~20px disagreement on 200px
 * tiles (0.10).
 */
export const PATH_DELTA_MAX_FRACTION = 0.04;

/**
 * The top-row and bottom-row horizontal steps (and the two vertical steps) must
 * agree to within this fraction of a tile dimension; otherwise the capture is
 * not one coherent same-zoom grid. Fixture "incompatible" produces a ~10px row
 * or column delta on 200px tiles (0.05).
 */
export const STEP_DELTA_MAX_FRACTION = 0.04;

const EXPECTED_EDGES: readonly { from: TileSlot; to: TileSlot }[] = [
	{ from: 'upper-left', to: 'upper-right' },
	{ from: 'upper-left', to: 'lower-left' },
	{ from: 'upper-right', to: 'lower-right' },
	{ from: 'lower-left', to: 'lower-right' }
];

const HARD_WARNING_KINDS: readonly StitchWarningKind[] = [
	'contradictory-lower-right',
	'mixed-zoom',
	'ambiguous-repeated-imagery',
	'unrelated-tile',
	'no-connected-layout'
];

const SLOT_LABELS: Record<TileSlot, string> = {
	'upper-left': 'upper-left',
	'upper-right': 'upper-right',
	'lower-left': 'lower-left',
	'lower-right': 'lower-right'
};

interface EdgeEvidence {
	readonly from: TileSlot;
	readonly to: TileSlot;
	readonly score: number;
	readonly overlapFractionPx: number;
	readonly runnerUpScore: number;
}

/**
 * Classifies one automatic arrangement into a text confidence category plus a
 * deterministic list of concrete warnings. Pure: never mutates, never discards,
 * and never depends on browser timing or randomness.
 */
export function classifyLayout(layout: AutoLayout, rasters: readonly AnalysisRaster[]): LayoutDiagnostic {
	const warnings: StitchWarning[] = [];
	const tileDimPx = rasters.length > 0 ? rasters[0].widthPx * rasters[0].scale : 200;
	const pathDeltaPx = PATH_DELTA_MAX_FRACTION * tileDimPx;
	const stepDeltaPx = STEP_DELTA_MAX_FRACTION * tileDimPx;

	const edges = EXPECTED_EDGES.map(({ from, to }) => {
		const fromFile = layout.assignment[from];
		const toFile = layout.assignment[to];
		const estimate = layout.estimates[`${fromFile}>${toFile}`];
		return {
			from,
			to,
			score: estimate?.score ?? 0,
			overlapFractionPx: estimate?.overlapFractionPx ?? 0,
			runnerUpScore: estimate?.runnerUpScore ?? 0
		};
	});

	const weakOverlapEdges = edges.filter((edge) => edge.overlapFractionPx < WEAK_OVERLAP_MAX_FRACTION);
	if (weakOverlapEdges.length > 0) {
		warnings.push({
			kind: 'weak-overlap',
			message: `Weak horizontal or vertical overlap (${edgePairText(weakOverlapEdges)}): screenshots share about ${Math.round(
				Math.min(...weakOverlapEdges.map((edge) => edge.overlapFractionPx)) * 100
			)}% of a neighbor's width or height. Recapture with roughly 20–30% neighbor overlap.`
		});
	}

	if (layout.lowerRightPaths.deltaPx > pathDeltaPx) {
		warnings.push({
			kind: 'contradictory-lower-right',
			message: `Contradictory lower-right position: the right-column and bottom-row estimates place lower-right about ${Math.round(
				layout.lowerRightPaths.deltaPx
			)} px apart. The capture may not be one coherent 2×2 at one zoom.`
		});
	}

	if (layout.steps.rowDeltaPx > stepDeltaPx || layout.steps.columnDeltaPx > stepDeltaPx) {
		warnings.push({
			kind: 'mixed-zoom',
			message:
				'Mixed dimensions or zoom: the inferred horizontal or vertical steps are inconsistent across the capture. Recapture all four screenshots at one zoom and orientation.'
		});
	}

	const ambiguousEdges = edges.filter(
		(edge) => edge.score - edge.runnerUpScore < AMBIGUOUS_EDGE_MIN_SEPARATION
	);
	if (ambiguousEdges.length > 0 || layout.separation < GLOBAL_AMBIGUITY_MAX_SEPARATION) {
		warnings.push({
			kind: 'ambiguous-repeated-imagery',
			message:
				'Ambiguous or repeated imagery: more than one placement is nearly as plausible for some edges, so a locally high match is not trustworthy without review.'
		});
	}

	const unrelatedEdges = edges.filter((edge) => edge.score < UNRELATED_EDGE_MAX_SCORE);
	if (unrelatedEdges.length > 0) {
		warnings.push({
			kind: 'unrelated-tile',
			message: `One screenshot does not appear to share map content with its neighbors (${edgePairText(
				unrelatedEdges
			)}). It may be from a different capture.`
		});
	}

	const weakEdges = edges.filter((edge) => edge.score < WEAK_EDGE_MAX_SCORE);
	if (weakEdges.length >= 2) {
		warnings.push({
			kind: 'no-connected-layout',
			message:
				'No connected 2×2 layout: multiple expected neighbor matches are weak, so the screenshots do not form one coherent arrangement.'
		});
	}

	const category = classifyCategory(warnings, layout);
	return { category, warnings };
}

function edgePairText(edges: readonly EdgeEvidence[]): string {
	return edges.map((edge) => `${SLOT_LABELS[edge.from]}–${SLOT_LABELS[edge.to]}`).join(', ');
}

function classifyCategory(warnings: readonly StitchWarning[], layout: AutoLayout): ConfidenceCategory {
	if (warnings.some((warning) => HARD_WARNING_KINDS.includes(warning.kind))) {
		return 'uncertain';
	}
	if (layout.score < REVIEW_MIN_ASSIGNMENT_SCORE) {
		return 'uncertain';
	}
	if (
		warnings.some((warning) => warning.kind === 'weak-overlap') ||
		layout.score < STRONG_MIN_ASSIGNMENT_SCORE ||
		layout.separation < STRONG_MIN_SEPARATION
	) {
		return 'review';
	}
	return 'strong';
}

export function categoryLabel(category: ConfidenceCategory): string {
	switch (category) {
		case 'strong':
			return 'strong';
		case 'review':
			return 'usable; review recommended';
		case 'uncertain':
			return 'uncertain — automatic arrangement is not claimed; manual correction required';
	}
}

export interface DiagnosticCopy {
	/** Simple text label for the confidence category (never a percentage). */
	readonly label: string;
	/** Warning messages for display; empty when the layout is strong. */
	readonly warnings: readonly string[];
}

/** Renders a diagnostic into display copy; warnings carry their own text. */
export function diagnosticText(diagnostic: LayoutDiagnostic): DiagnosticCopy {
	return {
		label: categoryLabel(diagnostic.category),
		warnings: diagnostic.warnings.map((warning) => warning.message)
	};
}
