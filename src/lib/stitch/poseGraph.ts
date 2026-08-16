/**
 * ChainSpot Stitch Map generalized overlap graph and pose solving (CHSPT-50).
 *
 * Generalizes `autoLayout.ts`'s `assignN` (all-pairs coarse translation
 * matching + maximum-weight spanning tree + fusion) from pure-translation
 * placements to the smallest transform family the evidence actually
 * justifies, per `domain/provenance.ts`'s documented family order
 * (translation -> similarity -> affine). `assignN` itself is untouched — it
 * remains the exact translation-only path `smartImportFiles`/
 * `smartImportViaWorker`/`smartStitch.worker.ts` and today's Stitch Map UI
 * (`+page.svelte`, preview `TilePlacement`s) already depend on. This module
 * is the new path `stitchPipeline.ts`'s `runStitchPipeline` actually uses;
 * `buildPoseGraph` below reuses `assignN`'s exact architecture (all-pairs
 * coarse scoring, Prim's max-weight spanning tree seeded at the strongest
 * tile, coarse-then-refine, multi-edge fusion) rather than inventing a
 * different one, so the two are structurally the same algorithm — this one
 * just carries a `SourceTransform` instead of an `{xPx,yPx}` offset per edge,
 * and knows how to reach for more than translation when translation isn't
 * enough.
 *
 * ESCALATION CRITERION (translation -> similarity -> affine): the coarse
 * O(N^2) all-pairs pass that decides topology stays translation-only and
 * unconditional, exactly as `assignN`'s does — escalation never runs there.
 * Only the N-1 edges the spanning tree actually selected to PLACE a tile are
 * ever escalated, and only when that edge's own translation-only *refine*
 * score (full resolution, not the coarse topology-selection score) comes
 * back below `ROTATION_ESCALATION_MAX_SCORE`. `cvMatch.ts`'s own module doc
 * establishes that a real translation-consistent edge scores ~0.99+; a pair
 * that is genuinely related but rotated relative to each other will score
 * measurably lower than that under a pure axis-aligned translation search,
 * because the mismatch decorrelates the correlation peak — that gap is
 * exactly the signal this module escalates on. Similarity (rotation, fixed
 * scale — see `matchSimilarity`'s own doc for why scale is fixed at this
 * tier) is tried first; only if similarity's own rescored fit is STILL below
 * the bar is affine (independent axis scale + shear, via three point
 * correspondences fit with `alignment/affine.ts`'s `estimateAffine`) tried.
 * Every candidate is rescored on one common scale by `scoreTransformAt`
 * (plain zero-mean NCC between `b`'s actual template pixels and `a` sampled
 * at the candidate transform's predicted location) so escalation can never
 * make an edge's stored score worse than what plain translation already
 * achieved — a failed escalation attempt simply falls back to translation.
 *
 * GLOBAL CONSISTENCY AND ABSTENTION: `assignN` always connects every tile
 * regardless of evidence quality (a weak edge is `diagnostics.ts`'s problem,
 * not a placement failure) — that's correct for `assignN`'s own callers, but
 * CHSPT-50 explicitly wants abstention instead of a forced bad stitch when
 * the graph genuinely doesn't support one. `buildPoseGraph` therefore adds a
 * real rejection path `assignN` does not have: if, even after a full
 * escalation attempt (translation, then similarity, then affine), a tree
 * edge's best rescored score still cannot clear `INCOHERENT_MIN_EDGE_SCORE`,
 * the WHOLE batch is reported `{ ok: false, reason: 'incoherent' }` rather
 * than silently keeping that edge — that edge was the only discovered
 * evidence connecting its subtree to the rest, and if the algorithm's own
 * best full-family effort still can't clear a basic plausibility floor
 * (`diagnostics.ts` observed genuinely unrelated tiles scoring ~0.03-0.05;
 * this floor sits comfortably above that, and comfortably below
 * `diagnostics.ts`'s own 0.5 "still usable, review recommended" floor, so a
 * merely weak-but-real edge is unaffected), forcing a placement anyway would
 * be exactly the "plausible-looking bad stitch" CHSPT-50 wants avoided. A
 * second, independent abstention trigger covers reconciliation rather than
 * connectivity: when a tile has more than one qualifying pose estimate (its
 * tree edge plus fusion candidates) and they do not agree on where the
 * tile's own corners land (see `POSE_FUSION_MAX_DISAGREEMENT_FRACTION`),
 * that is treated as unreconcilable evidence, not averaged away.
 */
import { applyAffine6, invertAffine6 } from '../geometry/affine6';
import type { Affine6Coefficients, Affine6Point } from '../geometry/affine6';
import { buildSourceTransform } from '../domain/provenance';
import type { SourceTransform, SourceTransformModel } from '../domain/provenance';
import { matchTranslation, matchSimilarity, matchPointNear, centeredTemplateGeometry } from './cvMatch';
import type { AnalysisRaster, PairOrientation } from './analysis';
import { estimateAffine } from '../alignment/affine';
import type { AlignmentPairInput } from '../alignment/types';

/** Same practical ceiling as `autoLayout.ts`'s `MAX_AUTO_ARRANGE_TILES`; the all-pairs coarse pass is O(N^2) either way. */
export const MAX_POSE_GRAPH_TILES = 24;

/**
 * A tree edge's translation-only refine score below this triggers escalation
 * to similarity. See the module doc comment for the full reasoning; 0.9 sits
 * safely below the ~0.99+ floor `cvMatch.ts` documents for a genuine
 * translation-consistent match, and comfortably above `autoLayout.ts`'s own
 * `FUSION_MIN_SCORE` (0.85) so an edge already confident enough to fuse
 * secondary evidence is never needlessly re-searched.
 */
export const ROTATION_ESCALATION_MAX_SCORE = 0.9;
/** Same bar, applied to the similarity candidate before attempting the affine tier. */
export const AFFINE_ESCALATION_MAX_SCORE = 0.9;
/**
 * A tree edge whose best score (after full escalation) is still below this
 * floor is not trusted as evidence at all; see the module doc comment for
 * the reasoning against `diagnostics.ts`'s own observed real-world numbers.
 */
export const INCOHERENT_MIN_EDGE_SCORE = 0.2;
/**
 * Multiple qualifying pose estimates for one tile (its tree edge plus any
 * fusion candidates) must place its corners within this fraction of the
 * tile's own largest dimension of each other, or the disagreement is treated
 * as unreconcilable rather than averaged away. 5% mirrors the spirit of this
 * codebase's other tile-fraction tolerances (e.g. `autoCrop.ts`'s
 * `MAX_INSET_FRACTION`), sized to catch a genuine second-placement
 * contradiction while easily tolerating ordinary sub-pixel measurement
 * noise between independent matches of the same real overlap.
 */
export const POSE_FUSION_MAX_DISAGREEMENT_FRACTION = 0.05;
/** Same fusion-worthiness bar `autoLayout.ts` uses; see that module's own doc comment for the reasoning (kept identical here, not re-derived). */
export const FUSION_MIN_SCORE = 0.85;

export type PoseModel = SourceTransformModel;

/** One escalated pairwise pose: `coefficients` maps `child`'s own raster px to `parent`'s own raster px (composes along the tree exactly like `autoLayout.ts`'s dx/dy addition, just via matrix composition). */
export interface PoseEdge {
	readonly parent: number;
	readonly child: number;
	readonly model: PoseModel;
	readonly coefficients: Affine6Coefficients;
	/** Uniformly rescored via `scoreTransformAt`, so translation/similarity/affine edges compare on one scale. */
	readonly score: number;
	readonly kind: 'placement-edge' | 'fusion-edge';
}

export interface PoseGraphSuccess {
	readonly ok: true;
	/** Raster indices in anchor-then-tree-growth order; `order[0]` is the anchor (identity pose). */
	readonly order: readonly number[];
	/** Per raster index, the RAW pose mapping that raster's full source-raster px to a shared raw composite space (anchor at identity; not yet shifted to a (0,0)-origin output). */
	readonly transforms: ReadonlyMap<number, SourceTransform>;
	/** Every edge actually used (tree placement edges plus qualifying fusion edges). */
	readonly edges: readonly PoseEdge[];
	/** The N-1 spanning-tree edges alone, for confidence classification. */
	readonly placementEdges: readonly PoseEdge[];
}

export type PoseGraphResult =
	| PoseGraphSuccess
	| { readonly ok: false; readonly reason: 'incoherent'; readonly message: string };

// ---------------------------------------------------------------------------
// Affine6 composition (outer(inner(p)); not provided by `geometry/affine6.ts`
// since that module deliberately stays limited to apply/invert/derive).
// ---------------------------------------------------------------------------

export function composeAffine6(
	outer: Affine6Coefficients,
	inner: Affine6Coefficients
): Affine6Coefficients {
	const [A, B, C, D, E, F] = outer;
	const [a, b, c, d, e, f] = inner;
	return [
		A * a + C * b,
		B * a + D * b,
		A * c + C * d,
		B * c + D * d,
		A * e + C * f + E,
		B * e + D * f + F
	];
}

const IDENTITY_COEFFICIENTS: Affine6Coefficients = [1, 0, 0, 1, 0, 0];

/** The more general of two models, in the translation < similarity < affine order `domain/provenance.ts` documents. */
function coarserModel(a: PoseModel, b: PoseModel): PoseModel {
	const rank: Record<PoseModel, number> = { translation: 0, similarity: 1, affine: 2 };
	return rank[a] >= rank[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Uniform NCC rescoring, shared by every escalation tier
// ---------------------------------------------------------------------------

function sampleNearest(raster: AnalysisRaster, xPx: number, yPx: number): number | null {
	const x = Math.round(xPx / raster.scale);
	const y = Math.round(yPx / raster.scale);
	if (x < 0 || y < 0 || x >= raster.widthPx || y >= raster.heightPx) return null;
	return raster.gray[y * raster.widthPx + x];
}

/**
 * Plain zero-mean normalized cross-correlation, [-1, 1], between `b`'s own
 * template-rect pixels (in `b`'s original-image px) and `a` sampled
 * (nearest-neighbour, analysis-only) at `coefficients` applied to each of
 * those same points. Returns -1 when more than half the sampled points fall
 * outside `a` (an unreliable candidate). This is the one common yardstick
 * every escalation tier's candidate is compared on, so "best of translation/
 * similarity/affine" is always an apples-to-apples comparison.
 */
export function scoreTransformAt(
	a: AnalysisRaster,
	b: AnalysisRaster,
	rectPx: { readonly xPx: number; readonly yPx: number; readonly widthPx: number; readonly heightPx: number },
	coefficients: Affine6Coefficients
): number {
	const stepPx = Math.max(1, b.scale);
	const cols = Math.max(1, Math.round(rectPx.widthPx / stepPx));
	const rows = Math.max(1, Math.round(rectPx.heightPx / stepPx));
	const count = cols * rows;
	const bValues = new Float64Array(count);
	const aValues = new Float64Array(count);
	let outside = 0;
	let index = 0;
	for (let row = 0; row < rows; row += 1) {
		for (let col = 0; col < cols; col += 1, index += 1) {
			const bxPx = rectPx.xPx + col * stepPx;
			const byPx = rectPx.yPx + row * stepPx;
			const bSample = sampleNearest(b, bxPx, byPx);
			bValues[index] = bSample ?? 0;
			const mapped = applyAffine6({ xPx: bxPx, yPx: byPx }, coefficients);
			const aSample = sampleNearest(a, mapped.xPx, mapped.yPx);
			if (aSample === null) {
				outside += 1;
				aValues[index] = bValues[index];
			} else {
				aValues[index] = aSample;
			}
		}
	}
	if (outside > count * 0.5) return -1;
	return zeroMeanNcc(aValues, bValues);
}

function zeroMeanNcc(x: Float64Array, y: Float64Array): number {
	const n = x.length;
	if (n === 0) return 0;
	let mx = 0;
	let my = 0;
	for (let i = 0; i < n; i += 1) {
		mx += x[i];
		my += y[i];
	}
	mx /= n;
	my /= n;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < n; i += 1) {
		const dx = x[i] - mx;
		const dy = y[i] - my;
		sxy += dx * dy;
		sxx += dx * dx;
		syy += dy * dy;
	}
	if (sxx <= 1e-9 || syy <= 1e-9) return 0;
	return sxy / Math.sqrt(sxx * syy);
}

/** Builds rotation-about-`centerB`-mapped-to-`centerA` coefficients (scale fixed at 1) from a `matchSimilarity` result; see that function's own doc for the sampling convention this stays consistent with. */
function similarityCoefficients(
	angleDeg: number,
	centerBPx: { readonly xPx: number; readonly yPx: number },
	centerAPx: { readonly xPx: number; readonly yPx: number }
): Affine6Coefficients {
	const radians = (angleDeg * Math.PI) / 180;
	const a = Math.cos(radians);
	const b = Math.sin(radians);
	const c = -Math.sin(radians);
	const d = Math.cos(radians);
	const e = centerAPx.xPx - (a * centerBPx.xPx + c * centerBPx.yPx);
	const f = centerAPx.yPx - (b * centerBPx.xPx + d * centerBPx.yPx);
	return [a, b, c, d, e, f];
}

// ---------------------------------------------------------------------------
// Pairwise pose escalation
// ---------------------------------------------------------------------------

interface DirectedTranslation {
	readonly aIndex: number;
	readonly bIndex: number;
	readonly orientation: PairOrientation;
	readonly score: number;
	readonly dxPx: number;
	readonly dyPx: number;
}

/** Best of the 4 (2 orientations x 2 directions) coarse hypotheses for one unordered pair — same cost and structure as `autoLayout.ts`'s `estimatePairBothCv`/`bestCandidate`. */
async function coarsePairCandidate(
	rasters: readonly AnalysisRaster[],
	i: number,
	j: number
): Promise<DirectedTranslation> {
	const candidates: DirectedTranslation[] = [];
	for (const [aIndex, bIndex] of [
		[i, j],
		[j, i]
	] as const) {
		for (const orientation of ['left-right', 'top-bottom'] as const) {
			const match = await matchTranslation(rasters[aIndex], rasters[bIndex], orientation, {
				mode: 'coarse'
			});
			candidates.push({ aIndex, bIndex, orientation, score: match.score, dxPx: match.dxPx, dyPx: match.dyPx });
		}
	}
	return candidates.reduce((best, candidate) => (candidate.score > best.score ? candidate : best));
}

interface EdgeCandidate {
	readonly model: PoseModel;
	readonly coefficients: Affine6Coefficients;
	readonly score: number;
}

/**
 * Full translation -> similarity -> affine escalation for one directed pair
 * (`aIndex` -> `bIndex`, in the `matchTranslation` a/b sense). Returns
 * coefficients mapping `b`'s raster px to `a`'s raster px, always the
 * highest-rescored candidate tried — a failed escalation attempt simply
 * falls back to the translation candidate that triggered it.
 */
async function escalatedPose(
	rasters: readonly AnalysisRaster[],
	aIndex: number,
	bIndex: number,
	orientation: PairOrientation
): Promise<EdgeCandidate> {
	const a = rasters[aIndex];
	const b = rasters[bIndex];
	const refined = await matchTranslation(a, b, orientation, { mode: 'refine' });
	const translationCandidate: EdgeCandidate = {
		model: 'translation',
		coefficients: [1, 0, 0, 1, refined.dxPx, refined.dyPx],
		score: refined.score
	};
	if (refined.score >= ROTATION_ESCALATION_MAX_SCORE) return translationCandidate;

	// A CENTERED, orientation-agnostic region of `b`, not `templateGeometry`'s
	// edge-anchored one: `templateGeometry`'s "near edge" anchoring only makes
	// sense under the translation assumption this code path has already
	// determined doesn't hold (see `centeredTemplateGeometry`'s own doc).
	const geom = centeredTemplateGeometry(b);
	const rectPx = { xPx: geom.tx * b.scale, yPx: geom.ty * b.scale, widthPx: geom.tw * b.scale, heightPx: geom.th * b.scale };

	let best = translationCandidate;

	const similarity = await matchSimilarity(a, b);
	if (similarity) {
		const coefficients = similarityCoefficients(similarity.angleDeg, similarity.centerBPx, similarity.centerAPx);
		const score = scoreTransformAt(a, b, rectPx, coefficients);
		const similarityCandidate: EdgeCandidate = { model: 'similarity', coefficients, score };
		if (score > best.score) best = similarityCandidate;

		if (similarityCandidate.score < AFFINE_ESCALATION_MAX_SCORE) {
			const affineCandidate = await tryAffineEscalation(a, b, rectPx, coefficients);
			if (affineCandidate && affineCandidate.score > best.score) best = affineCandidate;
		}
	}

	return best;
}

/** Three non-collinear anchor points spanning the template rect, used as the affine tier's point-correspondence sample sites. */
/**
 * Deliberately spread across `ANCHOR_SPREAD_FRACTION` of `b`'s own
 * dimensions — much wider than `rectPx` (the small centered region
 * `scoreTransformAt` rescores against, sized for `matchSimilarity`'s search
 * reach; see `centeredTemplateGeometry`'s doc). Affine estimation is a
 * least-squares fit over exactly 3 points, so how far apart those points sit
 * directly sets its conditioning: three points clustered inside the small
 * rescoring rect would make `estimateAffine`'s fit hypersensitive to each
 * point's own small matching error, while three points spread widely (and
 * non-collinearly) average that error out — the same reason a real
 * measurement tripod's legs are spread apart, not bunched together.
 */
const ANCHOR_SPREAD_FRACTION = 0.7;

function affineAnchorPoints(b: AnalysisRaster): readonly Affine6Point[] {
	const spreadWidthPx = b.widthPx * b.scale * ANCHOR_SPREAD_FRACTION;
	const spreadHeightPx = b.heightPx * b.scale * ANCHOR_SPREAD_FRACTION;
	const xPx = (b.widthPx * b.scale - spreadWidthPx) / 2;
	const yPx = (b.heightPx * b.scale - spreadHeightPx) / 2;
	return [
		{ xPx: xPx + spreadWidthPx * 0.2, yPx: yPx + spreadHeightPx * 0.2 },
		{ xPx: xPx + spreadWidthPx * 0.8, yPx: yPx + spreadHeightPx * 0.2 },
		{ xPx: xPx + spreadWidthPx * 0.5, yPx: yPx + spreadHeightPx * 0.8 }
	];
}

async function tryAffineEscalation(
	a: AnalysisRaster,
	b: AnalysisRaster,
	rectPx: { readonly xPx: number; readonly yPx: number; readonly widthPx: number; readonly heightPx: number },
	seedCoefficients: Affine6Coefficients
): Promise<EdgeCandidate | null> {
	const anchors = affineAnchorPoints(b);
	const pairs: AlignmentPairInput[] = [];
	for (let index = 0; index < anchors.length; index += 1) {
		const source = anchors[index];
		const predicted = applyAffine6(source, seedCoefficients);
		const match = await matchPointNear(a, b, source, predicted);
		if (!match || match.score < 0) continue;
		pairs.push({
			id: `anchor-${index}`,
			enabled: true,
			source,
			target: { xPx: match.xPx, yPx: match.yPx }
		});
	}
	if (pairs.length < 3) return null;

	const estimation = estimateAffine({ pairs });
	if (!('transform' in estimation)) return null;
	const coefficients = estimation.transform.coefficients;
	const score = scoreTransformAt(a, b, rectPx, coefficients);
	return { model: 'affine', coefficients, score };
}

// ---------------------------------------------------------------------------
// Spanning tree with an abstention floor
// ---------------------------------------------------------------------------

interface TreeEdgeRef {
	readonly parent: number;
	readonly child: number;
}

function buildSpanningTree(n: number, weight: (i: number, j: number) => number): { edges: TreeEdgeRef[]; visitOrder: number[] } {
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
	const edges: TreeEdgeRef[] = [];
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
	return { edges, visitOrder };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Builds a globally-consistent pose per raster (anchor at identity), or
 * reports `{ ok: false, reason: 'incoherent' }` when the evidence does not
 * support one. See the module doc comment for the full escalation and
 * abstention rules. Poses are RAW (anchor-relative, not yet shifted to a
 * (0,0)-origin output) — `stitchPipeline.ts` applies the shared crop and the
 * output-bounds shift once it knows both.
 */
export async function buildPoseGraph(rasters: readonly AnalysisRaster[]): Promise<PoseGraphResult> {
	const n = rasters.length;
	if (n < 2) {
		throw new Error(`buildPoseGraph: expected at least two rasters, got ${n}`);
	}
	if (n > MAX_POSE_GRAPH_TILES) {
		throw new Error(`buildPoseGraph: ${n} tiles exceeds the automatic-arrangement limit of ${MAX_POSE_GRAPH_TILES}`);
	}

	const coarseCache = new Map<string, DirectedTranslation>();
	const coarseFor = async (i: number, j: number): Promise<DirectedTranslation> => {
		const lo = Math.min(i, j);
		const hi = Math.max(i, j);
		const key = `${lo}:${hi}`;
		let candidate = coarseCache.get(key);
		if (!candidate) {
			candidate = await coarsePairCandidate(rasters, lo, hi);
			coarseCache.set(key, candidate);
		}
		return candidate;
	};

	// Topology is decided by coarse translation-only scores alone, exactly
	// like `assignN` — escalation never runs during this pass.
	const weights = new Map<string, number>();
	for (let i = 0; i < n; i += 1) {
		for (let j = i + 1; j < n; j += 1) {
			const candidate = await coarseFor(i, j);
			weights.set(`${i}:${j}`, candidate.score);
		}
	}
	const weight = (i: number, j: number): number => {
		if (i === j) return -Infinity;
		const lo = Math.min(i, j);
		const hi = Math.max(i, j);
		return weights.get(`${lo}:${hi}`) ?? -Infinity;
	};

	const { edges: tree, visitOrder } = buildSpanningTree(n, weight);
	if (visitOrder.length < n) {
		return {
			ok: false,
			reason: 'incoherent',
			message: `${n} captures were supplied but only ${visitOrder.length} share any overlap evidence at all; the rest cannot be placed.`
		};
	}

	// Escalate and place each tree edge, composing along the tree from the
	// anchor (identity) outward — parent is always already placed, since
	// `visitOrder`/`tree` are in growth order.
	const transforms = new Map<number, SourceTransform>();
	transforms.set(visitOrder[0], buildSourceTransform('translation', IDENTITY_COEFFICIENTS));
	const edges: PoseEdge[] = [];
	const placementEdges: PoseEdge[] = [];

	for (const treeEdge of tree) {
		const coarse = await coarseFor(treeEdge.parent, treeEdge.child);
		// `coarse` is keyed by the unordered pair and may have discovered its
		// winning direction/orientation with `aIndex`/`bIndex` swapped relative
		// to (parent, child); escalate in the direction the evidence actually
		// supports, then invert if needed rather than re-deriving a
		// direction-flipped estimate.
		const forward = coarse.aIndex === treeEdge.parent;
		const escalated = await escalatedPose(
			rasters,
			forward ? treeEdge.parent : treeEdge.child,
			forward ? treeEdge.child : treeEdge.parent,
			coarse.orientation
		);
		let coefficients = escalated.coefficients;
		if (!forward) {
			const inverted = invertAffine6(coefficients);
			if (!inverted) {
				return {
					ok: false,
					reason: 'incoherent',
					message: `Capture ${treeEdge.child} could not be reconciled with capture ${treeEdge.parent}: the estimated pose between them is not invertible.`
				};
			}
			coefficients = inverted;
		}

		if (escalated.score < INCOHERENT_MIN_EDGE_SCORE) {
			return {
				ok: false,
				reason: 'incoherent',
				message: `Captures ${treeEdge.parent} and ${treeEdge.child} do not share defensible overlap evidence (best score ${escalated.score.toFixed(3)} even after checking rotation and independent-axis scale), so no consistent placement exists.`
			};
		}

		const parentTransform = transforms.get(treeEdge.parent)!;
		const absoluteCoefficients = composeAffine6(parentTransform.coefficients, coefficients);
		const model = coarserModel(parentTransform.model, escalated.model);
		const absoluteTransform = buildSourceTransform(model, absoluteCoefficients);
		transforms.set(treeEdge.child, absoluteTransform);

		const edge: PoseEdge = {
			parent: treeEdge.parent,
			child: treeEdge.child,
			model: escalated.model,
			coefficients,
			score: escalated.score,
			kind: 'placement-edge'
		};
		edges.push(edge);
		placementEdges.push(edge);
	}

	// Fusion: a tile with additional strong (score >= FUSION_MIN_SCORE),
	// translation-only non-tree evidence to another already-placed tile has
	// its position corroborated/averaged across every such measurement,
	// generalizing `autoLayout.ts`'s own multi-measurement fusion. Kept
	// translation-only and skipped once a tile's own tree-derived pose has
	// been escalated past translation: fusing a coarse translation-only
	// candidate into an already-rotated placement is not evidence of the
	// same family and is not attempted here (see the module doc comment).
	for (let k = 1; k < visitOrder.length; k += 1) {
		const child = visitOrder[k];
		const childTransform = transforms.get(child)!;
		if (childTransform.model !== 'translation') continue;

		const implied: Affine6Coefficients[] = [childTransform.coefficients];
		const fusionEdges: PoseEdge[] = [];
		for (let m = 0; m < k; m += 1) {
			const other = visitOrder[m];
			const otherTransform = transforms.get(other)!;
			if (otherTransform.model !== 'translation') continue;
			const candidate = await coarseFor(other, child);
			if (candidate.score < FUSION_MIN_SCORE) continue;
			const forward = candidate.aIndex === other;
			const relative: Affine6Coefficients = forward
				? [1, 0, 0, 1, candidate.dxPx, candidate.dyPx]
				: [1, 0, 0, 1, -candidate.dxPx, -candidate.dyPx];
			const absolute = composeAffine6(otherTransform.coefficients, relative);
			implied.push(absolute);
			fusionEdges.push({
				parent: other,
				child,
				model: 'translation',
				coefficients: relative,
				score: candidate.score,
				kind: 'fusion-edge'
			});
		}
		if (fusionEdges.length === 0) continue;

		const raster = rasters[child];
		const tileSpanPx = Math.max(raster.widthPx, raster.heightPx) * raster.scale;
		const disagreementPx = maxCornerDisagreement(implied, raster);
		if (disagreementPx > tileSpanPx * POSE_FUSION_MAX_DISAGREEMENT_FRACTION) {
			return {
				ok: false,
				reason: 'incoherent',
				message: `Capture ${child} has multiple independent placements that disagree by ${disagreementPx.toFixed(1)}px, more than the ${(POSE_FUSION_MAX_DISAGREEMENT_FRACTION * 100).toFixed(0)}% of its own size this pipeline treats as reconcilable — the overlap evidence is contradictory.`
			};
		}

		const averaged = averageCoefficients(implied);
		transforms.set(child, buildSourceTransform('translation', averaged));
		edges.push(...fusionEdges);
	}

	return { ok: true, order: visitOrder, transforms, edges, placementEdges };
}

function averageCoefficients(candidates: readonly Affine6Coefficients[]): Affine6Coefficients {
	const sum: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
	for (const candidate of candidates) {
		for (let i = 0; i < 6; i += 1) sum[i] += candidate[i];
	}
	const n = candidates.length;
	return sum.map((value) => value / n) as unknown as Affine6Coefficients;
}

/** Max pairwise Euclidean spread, across `candidates`, of where each candidate transform maps the raster's own four corners. */
function maxCornerDisagreement(
	candidates: readonly Affine6Coefficients[],
	raster: AnalysisRaster
): number {
	const widthPx = raster.widthPx * raster.scale;
	const heightPx = raster.heightPx * raster.scale;
	const corners: Affine6Point[] = [
		{ xPx: 0, yPx: 0 },
		{ xPx: widthPx, yPx: 0 },
		{ xPx: widthPx, yPx: heightPx },
		{ xPx: 0, yPx: heightPx }
	];
	let maxSpread = 0;
	for (const corner of corners) {
		const mapped = candidates.map((coefficients) => applyAffine6(corner, coefficients));
		for (let i = 0; i < mapped.length; i += 1) {
			for (let j = i + 1; j < mapped.length; j += 1) {
				const dx = mapped[i].xPx - mapped[j].xPx;
				const dy = mapped[i].yPx - mapped[j].yPx;
				const distance = Math.hypot(dx, dy);
				if (distance > maxSpread) maxSpread = distance;
			}
		}
	}
	return maxSpread;
}
