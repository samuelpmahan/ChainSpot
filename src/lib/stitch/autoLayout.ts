/**
 * ChainSpot Stitch Map four-tile assignment and placement (P1-001).
 *
 * Treats the four same-size screenshots as a fixed 2×2 puzzle rather than
 * trusting file-selection order. Every one of the 24 possible assignments is
 * scored by summing the four expected-neighbor pair matches (upper-left ↔
 * upper-right, upper-left ↔ lower-left, upper-right ↔ lower-right, lower-left ↔
 * lower-right); the strongest globally consistent assignment wins. Ties resolve
 * to the earliest permutation in lexicographic order (a documented stable rule).
 *
 * The upper-left tile anchors at (0, 0). Upper-right and lower-left each take
 * their own directly measured pairwise offset as-is: a real hand-held capture
 * has no reason to overlap identically on every edge, so one edge's
 * measurement is never adjusted to make another edge's measurement "fit" a
 * rectangle. Lower-right has no direct measurement against the anchor, so its
 * placement genuinely does combine two independent measurements of the same
 * point (`reconcilePlacements`) — via upper-right, and via lower-left — which
 * is ordinary two-measurement averaging, not a grid-consistency assumption.
 *
 * Pairwise translation estimates come from `cvMatch.matchTranslation`
 * (OpenCV `matchTemplate`), asynchronously, in two qualities:
 *
 * 1. `'coarse'` for every ordered pair's both orientation hypotheses (12
 *    ordered pairs x 2 orientations = 24 evaluations) — cheap enough to score
 *    all 24 permutations of the 2x2 assignment.
 * 2. `'refine'` for just the four edges the winning assignment actually
 *    commits as placements — exact pixels, paid for only where it matters.
 *
 * This is the same coarse-then-fine split `cvMatch.ts` documents for a single
 * pair, applied one level up: coarse to choose *which* four edges win, refine
 * to place them precisely.
 */
import { matchTranslation } from './cvMatch';
import type { MatchMode } from './cvMatch';
import type { AnalysisRaster, PairEstimate, PairEstimates, PairOrientation } from './analysis';
import { TILE_SLOTS } from './geometry';
import type { TilePlacement, TileSlot } from './geometry';

/**
 * Runs both orientation hypotheses of one ordered pair through `cvMatch` at
 * the given mode and assembles them into the `PairEstimates` shape the
 * assignment/diagnostics code shares with the old matcher. `overlapFraction`
 * is renamed to `overlapFractionPx` here only because that is the field name
 * `PairEstimate` already committed to; both are the same fraction-of-tile
 * quantity.
 */
async function estimatePairBothCv(
	a: AnalysisRaster,
	b: AnalysisRaster,
	mode: MatchMode
): Promise<PairEstimates> {
	const horizontalMatch = await matchTranslation(a, b, 'left-right', { mode });
	const verticalMatch = await matchTranslation(a, b, 'top-bottom', { mode });
	const horizontal = toPairEstimate('left-right', horizontalMatch);
	const vertical = toPairEstimate('top-bottom', verticalMatch);
	return {
		'left-right': horizontal,
		'top-bottom': vertical,
		orientation: horizontal.score >= vertical.score ? 'left-right' : 'top-bottom'
	};
}

function toPairEstimate(
	orientation: PairOrientation,
	match: Awaited<ReturnType<typeof matchTranslation>>
): PairEstimate {
	return {
		orientation,
		dxPx: match.dxPx,
		dyPx: match.dyPx,
		score: match.score,
		overlapFractionPx: match.overlapFraction,
		runnerUpScore: match.runnerUpScore
	};
}

export interface AutoLayout {
	/** slot -> file index (into the caller's raster/file ordering). */
	readonly assignment: Record<TileSlot, number>;
	readonly placements: Record<TileSlot, TilePlacement>;
	/** Sum of the four expected-neighbor scores of the winning assignment. */
	readonly score: number;
	/**
	 * Every directed pair's two orientation-specific estimates keyed
	 * `fileIndex>fileIndex` in the original raster ordering. Raw evidence P1-002
	 * diagnostics consume; never persisted. An expected edge is always scored
	 * with the hypothesis matching its required orientation, so a winning
	 * hypothesis that points the other way is visible as a mismatch rather than
	 * being silently committed.
	 */
	readonly estimates: Readonly<Record<string, PairEstimates>>;
}

interface ExpectedEdge {
	readonly from: TileSlot;
	readonly to: TileSlot;
	readonly orientation: 'left-right' | 'top-bottom';
}

const EXPECTED_EDGES: readonly ExpectedEdge[] = [
	{ from: 'upper-left', to: 'upper-right', orientation: 'left-right' },
	{ from: 'upper-left', to: 'lower-left', orientation: 'top-bottom' },
	{ from: 'upper-right', to: 'lower-right', orientation: 'top-bottom' },
	{ from: 'lower-left', to: 'lower-right', orientation: 'left-right' }
];

function pairKey(from: number, to: number): string {
	return `${from}>${to}`;
}

export interface ReconciledPlacements {
	readonly upperRight: { readonly xPx: number; readonly yPx: number };
	readonly lowerLeft: { readonly xPx: number; readonly yPx: number };
	readonly lowerRight: { readonly xPx: number; readonly yPx: number };
}

/**
 * Places the three non-anchor tiles independently, each from its own directly
 * measured evidence. Upper-right and lower-left take their single
 * expected-neighbor measurement (`ulur`, `ulll`) exactly as measured: a real
 * hand-held capture has no reason to overlap identically on every edge, so one
 * edge's measurement must never be adjusted just to make a different edge's
 * measurement agree with it (a previous version of this function did exactly
 * that, blending all four edges together under a rigid-rectangle assumption —
 * removed because real captures routinely and legitimately disagree).
 *
 * Lower-right has no direct measurement against the upper-left anchor, so it
 * is the one point that genuinely requires combining two independent
 * measurements of the same location: the position implied via upper-right
 * (`urlr`) and via lower-left (`llr`). Averaging those two paths is ordinary
 * two-measurement fusion for an otherwise-unmeasured point, not a
 * grid-consistency assumption — it says nothing about whether the top and
 * bottom rows agree.
 */
export function reconcilePlacements(
	ulur: PairEstimate,
	ulll: PairEstimate,
	urlr: PairEstimate,
	llr: PairEstimate
): ReconciledPlacements {
	const upperRight = { xPx: ulur.dxPx, yPx: ulur.dyPx };
	const lowerLeft = { xPx: ulll.dxPx, yPx: ulll.dyPx };
	const viaRight = { xPx: upperRight.xPx + urlr.dxPx, yPx: upperRight.yPx + urlr.dyPx };
	const viaBottom = { xPx: lowerLeft.xPx + llr.dxPx, yPx: lowerLeft.yPx + llr.dyPx };
	return {
		upperRight,
		lowerLeft,
		lowerRight: {
			xPx: Math.round((viaRight.xPx + viaBottom.xPx) / 2),
			yPx: Math.round((viaRight.yPx + viaBottom.yPx) / 2)
		}
	};
}

/** All 24 permutations of the four file indices in lexicographic order. */
function permutations(): readonly (readonly [number, number, number, number])[] {
	const result: [number, number, number, number][] = [];
	const indices = [0, 1, 2, 3];
	const visit = (current: number[], remaining: number[]): void => {
		if (remaining.length === 0) {
			result.push(current as unknown as [number, number, number, number]);
			return;
		}
		for (let i = 0; i < remaining.length; i += 1) {
			visit(
				[...current, remaining[i]],
				remaining.slice(0, i).concat(remaining.slice(i + 1))
			);
		}
	};
	visit([], indices);
	return result;
}

/**
 * Scores one assignment: the sum of its four expected-neighbor directed pair
 * scores, each read from the hypothesis matching the edge's required
 * orientation. A winner pointing the other way is never rewarded; it simply
 * contributes its (typically poor) required-orientation score and is surfaced
 * by P1-002's direction-mismatch diagnostic.
 */
function scoreAssignment(
	ordered: readonly [number, number, number, number],
	estimates: ReadonlyMap<string, PairEstimates>
): number {
	const slotOf: Record<TileSlot, number> = {
		'upper-left': ordered[0],
		'upper-right': ordered[1],
		'lower-left': ordered[2],
		'lower-right': ordered[3]
	};
	let score = 0;
	for (const edge of EXPECTED_EDGES) {
		const from = slotOf[edge.from];
		const to = slotOf[edge.to];
		const estimate = estimates.get(pairKey(from, to))?.[edge.orientation];
		score += estimate ? estimate.score : 0;
	}
	return score;
}

/**
 * Assigns the four rasters to 2×2 slots and produces integer translation-only
 * placements, anchoring the inferred upper-left tile at (0, 0).
 *
 * Two-quality strategy (see the module doc comment): every ordered pair's both
 * orientations are matched at `'coarse'` first, cheaply enough to score all 24
 * permutations; only the four edges the winner actually commits are then
 * re-matched at `'refine'` for exact pixels.
 */
export async function assignFour(rasters: readonly AnalysisRaster[]): Promise<AutoLayout> {
	if (rasters.length !== 4) {
		throw new Error(`assignFour: expected exactly four rasters, got ${rasters.length}`);
	}

	const estimates = new Map<string, PairEstimates>();
	for (let i = 0; i < rasters.length; i += 1) {
		for (let j = 0; j < rasters.length; j += 1) {
			if (i === j) continue;
			estimates.set(pairKey(i, j), await estimatePairBothCv(rasters[i], rasters[j], 'coarse'));
		}
	}

	let best: readonly [number, number, number, number] | null = null;
	let bestScore = -Infinity;
	for (const ordered of permutations()) {
		const score = scoreAssignment(ordered, estimates);
		if (score > bestScore) {
			bestScore = score;
			best = ordered;
		}
	}
	if (!best) {
		throw new Error('assignFour: no assignment scored');
	}

	const slotOf: Record<TileSlot, number> = {
		'upper-left': best[0],
		'upper-right': best[1],
		'lower-left': best[2],
		'lower-right': best[3]
	};

	// Refine only the four edges the winning assignment actually commits: the
	// 24-permutation scoring above only ever needed to know *which* assignment
	// wins, not exact pixels, so it ran entirely at 'coarse'. Now that the
	// winner is fixed, its four edges are re-matched at 'refine' for the exact
	// placement pixels. The pair's *other* orientation (not required by this
	// edge) is left at its already-computed coarse value — recomputing it at
	// full cost would only ever feed the direction-mismatch check below, and a
	// coarse estimate is already sufficient signal for "does the other
	// direction score competitively" without paying for a second refine pass
	// per edge.
	for (const edge of EXPECTED_EDGES) {
		const from = slotOf[edge.from];
		const to = slotOf[edge.to];
		const key = pairKey(from, to);
		const coarse = estimates.get(key);
		if (!coarse) continue;
		const refinedMatch = await matchTranslation(rasters[from], rasters[to], edge.orientation, {
			mode: 'refine'
		});
		const refined = toPairEstimate(edge.orientation, refinedMatch);
		const otherOrientation: PairOrientation =
			edge.orientation === 'left-right' ? 'top-bottom' : 'left-right';
		const other = coarse[otherOrientation];
		estimates.set(key, {
			'left-right': edge.orientation === 'left-right' ? refined : other,
			'top-bottom': edge.orientation === 'top-bottom' ? refined : other,
			orientation: refined.score >= other.score ? edge.orientation : otherOrientation
		});
	}

	// The permutation-scoring loop above only ever compared assignments at
	// 'coarse' quality. Re-derive the winner's own score from the now-refined
	// estimates so `layout.score` (which diagnostics thresholds against)
	// reflects the same exact-pixel evidence the placements themselves use, not
	// the coarse approximation that merely picked the winner.
	bestScore = scoreAssignment(best, estimates);

	// Each expected edge is placed from the hypothesis matching its required
	// orientation, so a winning hypothesis that points the other way can never
	// become the actual placement of the edge.
	const ulur = estimates.get(pairKey(slotOf['upper-left'], slotOf['upper-right']))?.['left-right'];
	const ulll = estimates.get(pairKey(slotOf['upper-left'], slotOf['lower-left']))?.['top-bottom'];
	const urlr = estimates.get(pairKey(slotOf['upper-right'], slotOf['lower-right']))?.['top-bottom'];
	const llr = estimates.get(pairKey(slotOf['lower-left'], slotOf['lower-right']))?.['left-right'];
	if (!ulur || !ulll || !urlr || !llr) {
		throw new Error('assignFour: missing directed edge estimate');
	}

	// Each non-anchor tile is placed independently from its own evidence; see
	// `reconcilePlacements` for why lower-right is the sole exception that
	// combines two measurements.
	const reconciled = reconcilePlacements(ulur, ulll, urlr, llr);

	const placements: Record<TileSlot, TilePlacement> = {
		'upper-left': { xPx: 0, yPx: 0, visible: true },
		'upper-right': { ...reconciled.upperRight, visible: true },
		'lower-left': { ...reconciled.lowerLeft, visible: true },
		'lower-right': { ...reconciled.lowerRight, visible: true }
	};

	const assignment = Object.fromEntries(
		TILE_SLOTS.map((slot) => [slot, slotOf[slot]])
	) as Record<TileSlot, number>;

	const estimatesRecord: Record<string, PairEstimates> = {};
	for (const [key, value] of estimates) {
		estimatesRecord[key] = value;
	}

	return {
		assignment,
		placements,
		score: bestScore,
		estimates: estimatesRecord
	};
}
