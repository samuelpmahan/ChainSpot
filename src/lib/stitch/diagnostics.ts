/**
 * ChainSpot Stitch Map layout diagnostics and confidence (P1-002).
 *
 * A pure, deterministic pass over the evidence `assignFour` already produces:
 * one text confidence category (`'ok'` or `'review'`) plus a short list of
 * concrete warning messages. No decoded file is ever discarded regardless of
 * category. Deliberately no layered confidence framework and no enumerated
 * warning taxonomy: correlation score has physical meaning (`TM_CCOEFF_NORMED`
 * true matches ~0.99, unrelated content ~0.03), so it is the one threshold
 * that survives matcher changes without re-tuning.
 */
import type { AutoLayout } from './autoLayout';
import type { TileSlot } from './geometry';

export type ConfidenceCategory = 'ok' | 'review';

export interface LayoutDiagnostic {
	readonly category: ConfidenceCategory;
	readonly warnings: readonly string[];
}

/**
 * An expected edge scoring below this is a weak neighbor match: either weak
 * overlap or genuinely unrelated content. Observed: real matching edges score
 * ~1.0; an unrelated tile's edges score ~0.026-0.034. 0.5 sits well below
 * genuine matches and well above the observed unrelated-content floor.
 */
export const WEAK_EDGE_MAX_SCORE = 0.5;

const EXPECTED_EDGES: readonly { from: TileSlot; to: TileSlot; orientation: 'left-right' | 'top-bottom' }[] = [
	{ from: 'upper-left', to: 'upper-right', orientation: 'left-right' },
	{ from: 'upper-left', to: 'lower-left', orientation: 'top-bottom' },
	{ from: 'upper-right', to: 'lower-right', orientation: 'top-bottom' },
	{ from: 'lower-left', to: 'lower-right', orientation: 'left-right' }
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
	/**
	 * True when the winning orientation hypothesis of this directed pair differs
	 * from the orientation the 2×2 layout requires for this edge. A wrong
	 * direction must never be placed or trusted.
	 */
	readonly directionMismatch: boolean;
}

/**
 * Classifies one automatic arrangement into a text confidence category plus a
 * deterministic list of concrete warnings. Pure: never mutates, never
 * discards, and never depends on browser timing or randomness.
 */
export function classifyLayout(layout: AutoLayout): LayoutDiagnostic {
	const warnings: string[] = [];

	const edges: EdgeEvidence[] = EXPECTED_EDGES.map(({ from, to, orientation }) => {
		const fromFile = layout.assignment[from];
		const toFile = layout.assignment[to];
		const estimates = layout.estimates[`${fromFile}>${toFile}`];
		const estimate = estimates?.[orientation];
		return {
			from,
			to,
			score: estimate?.score ?? 0,
			directionMismatch: estimates ? estimates.orientation !== orientation : false
		};
	});

	const weakEdges = edges.filter((edge) => edge.score < WEAK_EDGE_MAX_SCORE);
	if (weakEdges.length > 0) {
		warnings.push(
			`Weak neighbor match (${edgePairText(weakEdges)}): these screenshots may not share enough overlapping map content, or one may be from a different capture. Recapture with roughly 20–30% neighbor overlap, or check for a mismatched screenshot.`
		);
	}

	const mismatchedEdges = edges.filter((edge) => edge.directionMismatch);
	if (mismatchedEdges.length > 0) {
		warnings.push(
			`Direction mismatch (${edgePairText(mismatchedEdges)}): the strongest match for these expected neighbors points the other way than the 2×2 layout requires. The screenshots were likely captured at a changed orientation or zoom.`
		);
	}

	const category: ConfidenceCategory = warnings.length > 0 ? 'review' : 'ok';
	return { category, warnings };
}

function edgePairText(edges: readonly EdgeEvidence[]): string {
	return edges.map((edge) => `${SLOT_LABELS[edge.from]}–${SLOT_LABELS[edge.to]}`).join(', ');
}

export function categoryLabel(category: ConfidenceCategory): string {
	switch (category) {
		case 'ok':
			return 'strong';
		case 'review':
			return 'usable; review recommended';
	}
}
