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
 * The upper-left tile anchors at (0, 0) and the other three receive integer
 * translation-only placements. The lower-right placement is reconciled from the
 * two redundant paths (down the right column and across the bottom row) rather
 * than trusting a single edge.
 */
import { estimatePair } from './analysis';
import type { AnalysisRaster, PairEstimate } from './analysis';
import { TILE_SLOTS } from './geometry';
import type { TilePlacement, TileSlot } from './geometry';

export interface AutoLayout {
	/** slot -> file index (into the caller's raster/file ordering). */
	readonly assignment: Record<TileSlot, number>;
	readonly placements: Record<TileSlot, TilePlacement>;
	/** Sum of the four expected-neighbor scores of the winning assignment. */
	readonly score: number;
	/** Second-best assignment score; separation feeds P1-002 confidence. */
	readonly runnerUpScore: number;
	readonly separation: number;
	/** Per-edge scores of the winning assignment, keyed `from>to` slots. */
	readonly edgeScores: Readonly<Record<string, number>>;
	/**
	 * Every directed pair estimate keyed `fileIndex>fileIndex` in the original
	 * raster ordering. Raw evidence P1-002 diagnostics consume; never persisted.
	 */
	readonly estimates: Readonly<Record<string, PairEstimate>>;
	/**
	 * The lower-right placement as implied by each redundant path and how far
	 * those paths disagree (P1-002 consistency evidence).
	 */
	readonly lowerRightPaths: {
		readonly viaRight: { readonly xPx: number; readonly yPx: number };
		readonly viaBottom: { readonly xPx: number; readonly yPx: number };
		readonly deltaPx: number;
	};
	/**
	 * Translation-consistency evidence across the grid: how much the top-row and
	 * bottom-row horizontal steps disagree (`rowDeltaPx`) and how much the
	 * left-column and right-column vertical steps disagree (`columnDeltaPx`).
	 * Large deltas indicate mixed zoom or a capture that is not one coherent 2×2.
	 */
	readonly steps: { readonly rowDeltaPx: number; readonly columnDeltaPx: number };
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

/** An edge whose estimate orientation disagrees with the expected geometry. */
const ORIENTATION_MISMATCH_PENALTY = 0.5;

function pairKey(from: number, to: number): string {
	return `${from}>${to}`;
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
 * scores, applying the mismatch penalty when an edge's estimate is not in the
 * expected orientation.
 */
function scoreAssignment(
	ordered: readonly [number, number, number, number],
	estimates: ReadonlyMap<string, PairEstimate>
): { score: number; edgeScores: Record<string, number> } {
	const slotOf: Record<TileSlot, number> = {
		'upper-left': ordered[0],
		'upper-right': ordered[1],
		'lower-left': ordered[2],
		'lower-right': ordered[3]
	};
	const edgeScores: Record<string, number> = {};
	let score = 0;
	for (const edge of EXPECTED_EDGES) {
		const from = slotOf[edge.from];
		const to = slotOf[edge.to];
		const estimate = estimates.get(pairKey(from, to));
		const base = estimate ? estimate.score : 0;
		const edgeScore = estimate && estimate.orientation === edge.orientation ? base : base * ORIENTATION_MISMATCH_PENALTY;
		edgeScores[`${edge.from}>${edge.to}`] = edgeScore;
		score += edgeScore;
	}
	return { score, edgeScores };
}

/**
 * Assigns the four rasters to 2×2 slots and produces integer translation-only
 * placements, anchoring the inferred upper-left tile at (0, 0).
 */
export function assignFour(
	rasters: readonly AnalysisRaster[],
	options?: Parameters<typeof estimatePair>[2]
): AutoLayout {
	if (rasters.length !== 4) {
		throw new Error(`assignFour: expected exactly four rasters, got ${rasters.length}`);
	}

	const estimates = new Map<string, PairEstimate>();
	for (let i = 0; i < rasters.length; i += 1) {
		for (let j = 0; j < rasters.length; j += 1) {
			if (i === j) continue;
			estimates.set(pairKey(i, j), estimatePair(rasters[i], rasters[j], options));
		}
	}

	let best: readonly [number, number, number, number] | null = null;
	let bestScore = -Infinity;
	let runnerUpScore = -Infinity;
	let bestEdgeScores: Record<string, number> = {};
	for (const ordered of permutations()) {
		const { score, edgeScores } = scoreAssignment(ordered, estimates);
		if (score > bestScore) {
			runnerUpScore = bestScore;
			bestScore = score;
			best = ordered;
			bestEdgeScores = edgeScores;
		} else if (score > runnerUpScore) {
			runnerUpScore = score;
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
	const ulur = estimates.get(pairKey(slotOf['upper-left'], slotOf['upper-right']));
	const ulll = estimates.get(pairKey(slotOf['upper-left'], slotOf['lower-left']));
	const urlr = estimates.get(pairKey(slotOf['upper-right'], slotOf['lower-right']));
	const llr = estimates.get(pairKey(slotOf['lower-left'], slotOf['lower-right']));
	if (!ulur || !ulll || !urlr || !llr) {
		throw new Error('assignFour: missing directed edge estimate');
	}

	const upperRight = { xPx: ulur.dxPx, yPx: ulur.dyPx };
	const lowerLeft = { xPx: ulll.dxPx, yPx: ulll.dyPx };
	// Two redundant paths to the lower-right: down the right column from
	// upper-right, and across the bottom row from lower-left. Reconcile by
	// averaging the two coordinates (rounded to integers), and expose how far the
	// two paths disagreed so P1-002 can detect a contradictory lower-right.
	const viaRight = { xPx: upperRight.xPx + urlr.dxPx, yPx: upperRight.yPx + urlr.dyPx };
	const viaBottom = { xPx: lowerLeft.xPx + llr.dxPx, yPx: lowerLeft.yPx + llr.dyPx };
	const lowerRight = {
		xPx: Math.round((viaRight.xPx + viaBottom.xPx) / 2),
		yPx: Math.round((viaRight.yPx + viaBottom.yPx) / 2)
	};
	const lowerRightPaths = {
		viaRight,
		viaBottom,
		deltaPx: Math.max(
			Math.abs(viaRight.xPx - viaBottom.xPx),
			Math.abs(viaRight.yPx - viaBottom.yPx)
		)
	};
	// Horizontal step along the top row must match the bottom row, and the
	// vertical step down the left column must match the right column, for the
	// capture to be one coherent same-zoom 2×2 grid.
	const steps = {
		rowDeltaPx: Math.abs(ulur.dxPx - llr.dxPx),
		columnDeltaPx: Math.abs(ulll.dyPx - urlr.dyPx)
	};

	const placements: Record<TileSlot, TilePlacement> = {
		'upper-left': { xPx: 0, yPx: 0, visible: true },
		'upper-right': { xPx: upperRight.xPx, yPx: upperRight.yPx, visible: true },
		'lower-left': { xPx: lowerLeft.xPx, yPx: lowerLeft.yPx, visible: true },
		'lower-right': { xPx: lowerRight.xPx, yPx: lowerRight.yPx, visible: true }
	};

	const assignment = Object.fromEntries(
		TILE_SLOTS.map((slot) => [slot, slotOf[slot]])
	) as Record<TileSlot, number>;

	const estimatesRecord: Record<string, PairEstimate> = {};
	for (const [key, value] of estimates) {
		estimatesRecord[key] = value;
	}

	return {
		assignment,
		placements,
		score: bestScore,
		runnerUpScore,
		separation: bestScore - runnerUpScore,
		edgeScores: bestEdgeScores,
		estimates: estimatesRecord,
		lowerRightPaths,
		steps
	};
}
