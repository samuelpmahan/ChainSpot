/**
 * ChainSpot Stitch Map N-tile assignment and placement (P1-001; generalized
 * beyond the original fixed 2x2 puzzle to any N >= 2 screenshots).
 *
 * Treats the N same-size screenshots as an unknown overlap graph rather than
 * trusting file-selection order or assuming a fixed grid topology. Every
 * ordered pair's both orientation hypotheses are matched at `'coarse'`
 * quality (N*(N-1) ordered pairs x 2 orientations); for each unordered pair
 * the better-scoring of its two directed hypotheses becomes that pair's edge
 * weight. A maximum-weight spanning tree over those edges (Prim's algorithm,
 * seeded at the tile with the strongest total evidence) is the placement
 * topology: exactly N-1 edges, guaranteed to connect every tile regardless of
 * how weak some of the evidence is (a genuinely unrelated tile still gets
 * placed, and its weak edges are exactly what `diagnostics.ts` warns about).
 *
 * The tree's own edges are re-matched at `'refine'` quality for exact pixels
 * — the same coarse-then-refine split the original algorithm used, applied
 * over N-1 edges instead of a fixed four. A tile with additional strong
 * (non-tree) evidence to more than one already-placed neighbor has its final
 * position averaged across every such qualifying edge, generalizing the
 * original algorithm's two-measurement fusion for its unmeasured corner
 * (`reconcilePlacements`) to however many independent measurements a tile
 * actually has.
 *
 * Anchors: the seed tile is placed at (0, 0); every other tile's position is
 * relative to it, never to the original file order.
 */
import { matchTranslation } from './cvMatch';
import type { MatchMode } from './cvMatch';
import type { AnalysisRaster, PairEstimate, PairEstimates, PairOrientation } from './analysis';
import { defaultSlotOrder } from './geometry';
import type { TileNeighbors, TilePlacement, TileSlot } from './geometry';

/**
 * Practical ceiling on automatic arrangement: comparing every pair of tiles is
 * O(N^2), which is cheap at ordinary capture counts (a handful to a couple
 * dozen screenshots) but not meant to scale to hundreds. Beyond this, a
 * different (spatially-prefiltered) strategy would be needed.
 */
export const MAX_AUTO_ARRANGE_TILES = 24;

/**
 * An edge scoring below this is not trusted as extra fusion evidence (see the
 * module comment). Deliberately much stricter than `diagnostics.ts`'s
 * `WEAK_EDGE_MAX_SCORE` (0.5): that threshold only ever gated a tree edge,
 * which real content always has to place somewhere regardless of quality.
 * Fusion is optional corroborating evidence for a tile that's already placed,
 * so a spurious match must never be allowed to drag it away from a correct
 * position. On a real captured course, a genuinely non-overlapping (e.g.
 * diagonal) pair was observed scoring 0.54 — well above 0.5 — purely from
 * shared terrain/style, not real content overlap, and got wrongly fused in
 * before this threshold was raised. Real matching edges in the same capture
 * scored 0.99+, so 0.85 sits safely between confirmed genuine matches and
 * observed real-world false-positive correlation.
 */
const FUSION_MIN_SCORE = 0.85;

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

function pairKey(from: number, to: number): string {
	return `${from}>${to}`;
}

/** One edge the placement algorithm actually used to position a tile. */
export interface PlacementEdge {
	readonly from: TileSlot;
	readonly to: TileSlot;
	readonly orientation: PairOrientation;
	readonly score: number;
	readonly dxPx: number;
	readonly dyPx: number;
}

export interface AutoLayout {
	/** Stable per-tile ids in seed-then-tree-growth order; `order[0]` is the anchor. */
	readonly order: readonly TileSlot[];
	/** slot -> file index (into the caller's raster/file ordering). */
	readonly assignment: Partial<Record<TileSlot, number>>;
	readonly placements: Partial<Record<TileSlot, TilePlacement>>;
	/** Expected-neighbor adjacency: the spanning tree plus any other strong (non-tree) edges. */
	readonly neighbors: TileNeighbors;
	/** The N-1 spanning-tree edges actually used to place each non-anchor tile. */
	readonly placementEdges: readonly PlacementEdge[];
	/** Sum of the placement edges' scores. */
	readonly score: number;
	/**
	 * Every directed pair's two orientation-specific coarse estimates, keyed
	 * `fileIndex>fileIndex` in the original raster ordering. Raw evidence;
	 * never persisted.
	 */
	readonly estimates: Readonly<Record<string, PairEstimates>>;
}

interface DirectedCandidate {
	readonly sourceDirection: 'ij' | 'ji';
	readonly orientation: PairOrientation;
	/** Offset of tile `j` relative to tile `i`, already normalized regardless of source direction. */
	readonly dxPx: number;
	readonly dyPx: number;
	readonly score: number;
}

/** The best-scoring of the four hypotheses (2 orientations x 2 directions) for the pair (i, j). */
function bestCandidate(
	i: number,
	j: number,
	estimates: ReadonlyMap<string, PairEstimates>
): DirectedCandidate | null {
	const ij = estimates.get(pairKey(i, j));
	const ji = estimates.get(pairKey(j, i));
	const candidates: DirectedCandidate[] = [];
	if (ij) {
		candidates.push({
			sourceDirection: 'ij',
			orientation: 'left-right',
			dxPx: ij['left-right'].dxPx,
			dyPx: ij['left-right'].dyPx,
			score: ij['left-right'].score
		});
		candidates.push({
			sourceDirection: 'ij',
			orientation: 'top-bottom',
			dxPx: ij['top-bottom'].dxPx,
			dyPx: ij['top-bottom'].dyPx,
			score: ij['top-bottom'].score
		});
	}
	if (ji) {
		candidates.push({
			sourceDirection: 'ji',
			orientation: 'left-right',
			dxPx: -ji['left-right'].dxPx,
			dyPx: -ji['left-right'].dyPx,
			score: ji['left-right'].score
		});
		candidates.push({
			sourceDirection: 'ji',
			orientation: 'top-bottom',
			dxPx: -ji['top-bottom'].dxPx,
			dyPx: -ji['top-bottom'].dyPx,
			score: ji['top-bottom'].score
		});
	}
	if (candidates.length === 0) return null;
	return candidates.reduce((best, candidate) => (candidate.score > best.score ? candidate : best));
}

/** Re-matches the winning candidate at `'refine'` quality, preserving its `i`-relative-to-`j` sense. */
async function refineCandidate(
	rasters: readonly AnalysisRaster[],
	i: number,
	j: number,
	candidate: DirectedCandidate
): Promise<DirectedCandidate> {
	if (candidate.sourceDirection === 'ij') {
		const match = await matchTranslation(rasters[i], rasters[j], candidate.orientation, {
			mode: 'refine'
		});
		return { ...candidate, dxPx: match.dxPx, dyPx: match.dyPx, score: match.score };
	}
	const match = await matchTranslation(rasters[j], rasters[i], candidate.orientation, {
		mode: 'refine'
	});
	return { ...candidate, dxPx: -match.dxPx, dyPx: -match.dyPx, score: match.score };
}

interface TreeEdge {
	readonly parent: number;
	readonly child: number;
}

/**
 * Maximum-weight spanning tree over the complete graph of `n` raster indices,
 * via Prim's algorithm. Seeded at the index with the strongest total pairwise
 * evidence (ties resolve to the lowest index), so the anchor is whichever tile
 * has the most to go on rather than an arbitrary file-order choice. Returns
 * edges in tree-growth order, so a caller placing tiles in that same order
 * always has the parent already placed.
 */
function buildSpanningTree(n: number, weight: (i: number, j: number) => number): TreeEdge[] {
	let seed = 0;
	let bestSum = -Infinity;
	for (let i = 0; i < n; i += 1) {
		let sum = 0;
		for (let j = 0; j < n; j += 1) {
			if (i !== j) sum += weight(i, j);
		}
		if (sum > bestSum) {
			bestSum = sum;
			seed = i;
		}
	}
	const inTree = new Array<boolean>(n).fill(false);
	inTree[seed] = true;
	const visitOrder = [seed];
	const edges: TreeEdge[] = [];
	while (visitOrder.length < n) {
		let bestI = -1;
		let bestJ = -1;
		let bestWeight = -Infinity;
		for (const i of visitOrder) {
			for (let j = 0; j < n; j += 1) {
				if (inTree[j]) continue;
				const w = weight(i, j);
				if (w > bestWeight) {
					bestWeight = w;
					bestI = i;
					bestJ = j;
				}
			}
		}
		if (bestJ === -1) break;
		inTree[bestJ] = true;
		visitOrder.push(bestJ);
		edges.push({ parent: bestI, child: bestJ });
	}
	return edges;
}

/**
 * Assigns the N rasters to placement slots and produces integer
 * translation-only placements, anchoring the inferred seed tile at (0, 0).
 */
export async function assignN(rasters: readonly AnalysisRaster[]): Promise<AutoLayout> {
	const n = rasters.length;
	if (n < 2) {
		throw new Error(`assignN: expected at least two rasters, got ${n}`);
	}
	if (n > MAX_AUTO_ARRANGE_TILES) {
		throw new Error(
			`assignN: ${n} tiles exceeds the automatic-arrangement limit of ${MAX_AUTO_ARRANGE_TILES}`
		);
	}

	const estimates = new Map<string, PairEstimates>();
	for (let i = 0; i < n; i += 1) {
		for (let j = 0; j < n; j += 1) {
			if (i === j) continue;
			estimates.set(pairKey(i, j), await estimatePairBothCv(rasters[i], rasters[j], 'coarse'));
		}
	}

	const candidateCache = new Map<string, DirectedCandidate | null>();
	const candidateFor = (i: number, j: number): DirectedCandidate | null => {
		const lo = Math.min(i, j);
		const hi = Math.max(i, j);
		const key = pairKey(lo, hi);
		if (!candidateCache.has(key)) {
			candidateCache.set(key, bestCandidate(lo, hi, estimates));
		}
		const candidate = candidateCache.get(key) ?? null;
		if (!candidate) return null;
		// `candidate` is always "hi relative to lo". Flip when the caller asked the
		// other way — `sourceDirection` must flip too ('ij' <-> 'ji'), since it is
		// interpreted relative to the caller's own (i, j) order (see
		// `refineCandidate`): the same underlying raw estimate that was "computed
		// via rasters[lo] -> rasters[hi]" from lo's perspective is "computed via
		// rasters[j] -> rasters[i]" from a (hi, lo) caller's perspective. Leaving
		// it unflipped previously caused `refineCandidate` to re-match in the
		// wrong raster order whenever a tree edge was queried in reverse.
		if (i === lo) return candidate;
		return {
			...candidate,
			sourceDirection: candidate.sourceDirection === 'ij' ? 'ji' : 'ij',
			dxPx: -candidate.dxPx,
			dyPx: -candidate.dyPx
		};
	};
	const weight = (i: number, j: number): number => candidateFor(i, j)?.score ?? -Infinity;

	const tree = buildSpanningTree(n, weight);
	const visitOrder = [tree.length > 0 ? tree[0].parent : 0, ...tree.map((edge) => edge.child)];
	const slots = defaultSlotOrder(n);
	const slotOfRaster = new Map<number, TileSlot>();
	visitOrder.forEach((rasterIndex, k) => slotOfRaster.set(rasterIndex, slots[k]));

	const positions = new Map<number, { xPx: number; yPx: number }>();
	positions.set(visitOrder[0], { xPx: 0, yPx: 0 });
	const placementEdges: PlacementEdge[] = [];
	const neighborSet = new Map<TileSlot, Set<TileSlot>>();
	const addNeighbor = (a: TileSlot, b: TileSlot): void => {
		if (!neighborSet.has(a)) neighborSet.set(a, new Set());
		if (!neighborSet.has(b)) neighborSet.set(b, new Set());
		neighborSet.get(a)!.add(b);
		neighborSet.get(b)!.add(a);
	};

	for (const edge of tree) {
		const raw = candidateFor(edge.parent, edge.child);
		if (!raw) continue;
		const refined = await refineCandidate(rasters, edge.parent, edge.child, raw);
		const parentPos = positions.get(edge.parent)!;
		positions.set(edge.child, {
			xPx: parentPos.xPx + refined.dxPx,
			yPx: parentPos.yPx + refined.dyPx
		});
		const fromSlot = slotOfRaster.get(edge.parent)!;
		const toSlot = slotOfRaster.get(edge.child)!;
		placementEdges.push({
			from: fromSlot,
			to: toSlot,
			orientation: refined.orientation,
			score: refined.score,
			dxPx: refined.dxPx,
			dyPx: refined.dyPx
		});
		addNeighbor(fromSlot, toSlot);
	}

	// Fuse any additional strong evidence: a tile with more than one qualifying
	// edge to an already-placed neighbor has its position averaged across every
	// such measurement, generalizing the original two-path fusion.
	for (let k = 1; k < visitOrder.length; k += 1) {
		const child = visitOrder[k];
		const implied: { xPx: number; yPx: number }[] = [];
		for (let m = 0; m < k; m += 1) {
			const other = visitOrder[m];
			const candidate = candidateFor(other, child);
			if (!candidate || candidate.score < FUSION_MIN_SCORE) continue;
			const otherPos = positions.get(other)!;
			implied.push({ xPx: otherPos.xPx + candidate.dxPx, yPx: otherPos.yPx + candidate.dyPx });
			addNeighbor(slotOfRaster.get(other)!, slotOfRaster.get(child)!);
		}
		if (implied.length === 0) continue;
		const sum = implied.reduce(
			(acc, p) => ({ xPx: acc.xPx + p.xPx, yPx: acc.yPx + p.yPx }),
			{ xPx: 0, yPx: 0 }
		);
		positions.set(child, {
			xPx: Math.round(sum.xPx / implied.length),
			yPx: Math.round(sum.yPx / implied.length)
		});
	}

	const placements: Record<TileSlot, TilePlacement> = {};
	const assignment: Record<TileSlot, number> = {};
	visitOrder.forEach((rasterIndex, k) => {
		const slot = slots[k];
		const pos = positions.get(rasterIndex)!;
		placements[slot] = { xPx: pos.xPx, yPx: pos.yPx, visible: true };
		assignment[slot] = rasterIndex;
	});

	const neighbors: Record<TileSlot, readonly TileSlot[]> = {};
	for (const slot of slots) neighbors[slot] = [...(neighborSet.get(slot) ?? [])];

	return {
		order: slots,
		assignment,
		placements,
		neighbors,
		placementEdges,
		score: placementEdges.reduce((sum, edge) => sum + edge.score, 0),
		estimates: Object.fromEntries(estimates)
	};
}
