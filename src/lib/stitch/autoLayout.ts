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
import type { StitchLayout, TilePlacement, TileSlot } from './geometry';

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
	/**
	 * slot -> file index (into the caller's raster/file ordering). Populated only
	 * for the slots the input layout actually uses (all four for a 2x2 input,
	 * two for a 1x2/2x1 input) — see `TILE_SLOTS_BY_LAYOUT`.
	 */
	readonly assignment: Partial<Record<TileSlot, number>>;
	readonly placements: Partial<Record<TileSlot, TilePlacement>>;
	/** Sum of the expected-neighbor edge scores of the winning assignment. */
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

export interface ExpectedEdge {
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

/** The single expected edge of each two-tile layout. */
const EXPECTED_EDGES_1X2: readonly ExpectedEdge[] = [
	{ from: 'left', to: 'right', orientation: 'left-right' }
];
const EXPECTED_EDGES_2X1: readonly ExpectedEdge[] = [
	{ from: 'top', to: 'bottom', orientation: 'top-bottom' }
];

/** The expected-neighbor edge list a layout's winning assignment is scored/classified against. */
export function expectedEdgesForLayout(layout: StitchLayout): readonly ExpectedEdge[] {
	switch (layout) {
		case '2x2':
			return EXPECTED_EDGES;
		case '1x2':
			return EXPECTED_EDGES_1X2;
		case '2x1':
			return EXPECTED_EDGES_2X1;
	}
}

/** Infers which layout an `AutoLayout.assignment`'s populated slots belong to. */
export function layoutForSlots(slots: readonly TileSlot[]): StitchLayout {
	if (slots.includes('left') || slots.includes('right')) return '1x2';
	if (slots.includes('top') || slots.includes('bottom')) return '2x1';
	return '2x2';
}

function pairKey(from: number, to: number): string {
	return `${from}>${to}`;
}

/** The four 2x2 slot names, narrowed out of the wider `TileSlot` union `assignFour` alone uses. */
type Slot2x2 = 'upper-left' | 'upper-right' | 'lower-left' | 'lower-right';

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
	const slotOf: Record<Slot2x2, number> = {
		'upper-left': ordered[0],
		'upper-right': ordered[1],
		'lower-left': ordered[2],
		'lower-right': ordered[3]
	};
	let score = 0;
	for (const edge of EXPECTED_EDGES) {
		const from = slotOf[edge.from as Slot2x2];
		const to = slotOf[edge.to as Slot2x2];
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

	const slotOf: Record<Slot2x2, number> = {
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
		const from = slotOf[edge.from as Slot2x2];
		const to = slotOf[edge.to as Slot2x2];
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

	const placements: Record<Slot2x2, TilePlacement> = {
		'upper-left': { xPx: 0, yPx: 0, visible: true },
		'upper-right': { ...reconciled.upperRight, visible: true },
		'lower-left': { ...reconciled.lowerLeft, visible: true },
		'lower-right': { ...reconciled.lowerRight, visible: true }
	};

	const assignment = Object.fromEntries(
		TILE_SLOTS.map((slot) => [slot, slotOf[slot as Slot2x2]])
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

const TWO_TILE_SLOTS: Record<'left-right' | 'top-bottom', readonly [TileSlot, TileSlot]> = {
	'left-right': ['left', 'right'],
	'top-bottom': ['top', 'bottom']
};

/**
 * Assigns two rasters to a 1x2 (`left`/`right`) or 2x1 (`top`/`bottom`) layout
 * and produces an integer translation-only placement, anchoring the first
 * inferred tile at (0, 0). Unlike `assignFour`, the layout itself (which
 * orientation, and which raster is first) is not known in advance, so all four
 * combinations — both orientations, both orderings — are scored at `'coarse'`
 * before the winner's single edge is re-matched at `'refine'`. There is no
 * permutation search beyond that: with two tiles there is exactly one edge, so
 * the winning combination directly is the answer, not a candidate to reconcile
 * against other edges.
 */
export async function assignTwo(rasters: readonly AnalysisRaster[]): Promise<AutoLayout> {
	if (rasters.length !== 2) {
		throw new Error(`assignTwo: expected exactly two rasters, got ${rasters.length}`);
	}

	const forward = await estimatePairBothCv(rasters[0], rasters[1], 'coarse');
	const backward = await estimatePairBothCv(rasters[1], rasters[0], 'coarse');
	const estimates = new Map<string, PairEstimates>([
		[pairKey(0, 1), forward],
		[pairKey(1, 0), backward]
	]);

	const candidates: readonly { readonly orientation: PairOrientation; readonly from: number; readonly to: number }[] = [
		{ orientation: 'left-right', from: 0, to: 1 },
		{ orientation: 'left-right', from: 1, to: 0 },
		{ orientation: 'top-bottom', from: 0, to: 1 },
		{ orientation: 'top-bottom', from: 1, to: 0 }
	];
	let best = candidates[0];
	let bestScore = -Infinity;
	for (const candidate of candidates) {
		const score = estimates.get(pairKey(candidate.from, candidate.to))?.[candidate.orientation].score ?? 0;
		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}

	// Refine only the winning edge, mirroring `assignFour`'s coarse-then-fine split.
	const refinedMatch = await matchTranslation(rasters[best.from], rasters[best.to], best.orientation, {
		mode: 'refine'
	});
	const refined = toPairEstimate(best.orientation, refinedMatch);
	const winningKey = pairKey(best.from, best.to);
	const coarse = estimates.get(winningKey);
	const otherOrientation: PairOrientation = best.orientation === 'left-right' ? 'top-bottom' : 'left-right';
	const other = coarse?.[otherOrientation];
	estimates.set(winningKey, {
		'left-right': best.orientation === 'left-right' ? refined : (other as PairEstimate),
		'top-bottom': best.orientation === 'top-bottom' ? refined : (other as PairEstimate),
		orientation: refined.score >= (other?.score ?? -Infinity) ? best.orientation : otherOrientation
	});
	bestScore = refined.score;

	const [firstSlot, secondSlot] = TWO_TILE_SLOTS[best.orientation];
	const assignment: Partial<Record<TileSlot, number>> = {
		[firstSlot]: best.from,
		[secondSlot]: best.to
	};
	const placements: Partial<Record<TileSlot, TilePlacement>> = {
		[firstSlot]: { xPx: 0, yPx: 0, visible: true },
		[secondSlot]: { xPx: refined.dxPx, yPx: refined.dyPx, visible: true }
	};

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
