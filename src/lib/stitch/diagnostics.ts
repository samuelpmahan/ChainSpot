/**
 * ChainSpot Stitch Map layout diagnostics and confidence (P1-002; generalized
 * to N tiles).
 *
 * A pure, deterministic pass over the evidence `assignN` already produces:
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
 *
 * `assignN` no longer assumes a fixed topology, so there is no longer a
 * separate "required orientation" a winning hypothesis could point away
 * from — the direction-mismatch diagnostic that depended on that assumption
 * has no general analog and is retired; a weak placement edge is now the sole
 * confidence signal.
 */
import type { AutoLayout, PlacementEdge } from './autoLayout';

export type ConfidenceCategory = 'ok' | 'review';

export interface LayoutDiagnostic {
	readonly category: ConfidenceCategory;
	readonly warnings: readonly string[];
}

/**
 * A placement edge scoring below this is a weak neighbor match: either weak
 * overlap or genuinely unrelated content. Observed: real matching edges score
 * ~1.0; an unrelated tile's edges score ~0.026-0.034. 0.5 sits well below
 * genuine matches and well above the observed unrelated-content floor.
 */
export const WEAK_EDGE_MAX_SCORE = 0.5;

/**
 * Classifies one automatic arrangement into a text confidence category plus a
 * deterministic list of concrete warnings. Pure: never mutates, never
 * discards, and never depends on browser timing or randomness. Scores every
 * edge the arrangement actually placed tiles with (`layout.placementEdges`),
 * whatever topology `assignN` inferred.
 */
export function classifyLayout(layout: AutoLayout): LayoutDiagnostic {
	const warnings: string[] = [];
	const weakEdges = layout.placementEdges.filter((edge) => edge.score < WEAK_EDGE_MAX_SCORE);
	if (weakEdges.length > 0) {
		warnings.push(
			`Weak neighbor match (${edgePairText(weakEdges)}): these screenshots may not share enough overlapping map content, or one may be from a different capture. Recapture with more neighbor overlap — roughly 20% is enough, and more is always fine — or check for a mismatched screenshot.`
		);
	}

	const category: ConfidenceCategory = warnings.length > 0 ? 'review' : 'ok';
	return { category, warnings };
}

function edgePairText(edges: readonly PlacementEdge[]): string {
	return edges.map((edge) => `${edge.from}–${edge.to}`).join(', ');
}

export function categoryLabel(category: ConfidenceCategory): string {
	switch (category) {
		case 'ok':
			return 'strong';
		case 'review':
			return 'usable; review recommended';
	}
}
