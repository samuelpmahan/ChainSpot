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
 *
 * A warning here costs a user their confidence in an arrangement that may be
 * perfectly correct, so every warning must correspond to something they could
 * actually act on. In particular, generous neighbor overlap is a supported
 * capture style and never warned about on its own: the more content two tiles
 * share, the better they match, and a user who panned in careful small steps
 * must not be told their captures look wrong. What genuinely cannot work — the
 * same screenshot supplied twice — is rejected outright before scoring rather
 * than warned about here (see `duplicates.ts`).
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
	 * from the orientation the 2×2 layout requires for this edge.
	 *
	 * On its own this is not evidence of anything. Generous neighbor overlap is
	 * a legitimate and well-supported capture style, and the more content two
	 * tiles share, the more readily that shared region also explains itself
	 * under the other orientation hypothesis — so the losing hypothesis can edge
	 * ahead on a pair that genuinely sits exactly where the layout says it does.
	 * See `classifyLayout` for why this is only ever reported alongside a weak
	 * required-orientation match.
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
			`Weak neighbor match (${edgePairText(weakEdges)}): these screenshots may not share enough overlapping map content, or one may be from a different capture. Recapture with more neighbor overlap — roughly 20% is enough, and more is always fine — or check for a mismatched screenshot.`
		);
	}

	// Gated on the edge also being weak. An edge that matches strongly in the
	// orientation the layout requires is a real, well-supported neighbor pair,
	// and the committed placement uses that strong measurement — so the other
	// hypothesis happening to score higher says nothing a user could act on.
	// Reporting it anyway punished exactly the users who captured most
	// carefully, since generous overlap is what makes both hypotheses plausible
	// in the first place. Where the required orientation is genuinely weak, the
	// mismatch is real evidence about why, and it is still reported.
	const mismatchedEdges = edges.filter(
		(edge) => edge.directionMismatch && edge.score < WEAK_EDGE_MAX_SCORE
	);
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
