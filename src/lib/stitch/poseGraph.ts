/**
 * ChainSpot Stitch Map generalized overlap graph and pose solving (CHSPT-50).
 *
 * The production graph remains the existing all-pairs -> maximum-weight Prim
 * -> refine/escalate -> fusion architecture. CHSPT-75..78 add a semantic
 * front-end to that graph, not a second graph: when repeated badge/basket
 * landmarks supply a well-supported translation, the edge skips the coarse
 * whole-image OpenCV search and goes directly to one local full-resolution
 * verification. Weak, ambiguous, single-landmark, or non-translation
 * semantic evidence falls through to the pre-existing global matcher
 * unchanged.
 */
import { applyAffine6, invertAffine6 } from '../geometry/affine6';
import type { Affine6Coefficients, Affine6Point } from '../geometry/affine6';
import { buildSourceTransform } from '../domain/provenance';
import type { SourceTransform, SourceTransformModel } from '../domain/provenance';
import { matchTranslation, matchSimilarity, matchPointNear, centeredTemplateGeometry } from './cvMatch';
import type { AnalysisRaster, PairOrientation } from './analysis';
import { estimateAffine } from '../alignment/affine';
import type { AlignmentPairInput } from '../alignment/types';
import type { SemanticSourceLandmarks } from './semanticLandmarks';
import { voteSemanticTranslation } from './semanticTranslation';
import { fitMinimalSemanticTransform } from './semanticPoseGraph';
import {
	verifySemanticPoseSeed,
	type SemanticVerificationOptions,
	type SemanticVerificationResult
} from './semanticPoseVerification';

/** Same practical ceiling as `autoLayout.ts`'s `MAX_AUTO_ARRANGE_TILES`; the all-pairs coarse pass is O(N^2) either way. */
export const MAX_POSE_GRAPH_TILES = 24;
export const ROTATION_ESCALATION_MAX_SCORE = 0.9;
export const AFFINE_ESCALATION_MAX_SCORE = 0.9;
export const INCOHERENT_MIN_EDGE_SCORE = 0.2;
export const POSE_FUSION_MAX_DISAGREEMENT_FRACTION = 0.05;
export const FUSION_MIN_SCORE = 0.85;

export type PoseModel = SourceTransformModel;
export type PoseEvidencePath =
	| 'semantic-local-verify'
	| 'semantic-disagreement'
	| 'global-fallback';

export interface SemanticPairDiagnostic {
	readonly a: number;
	readonly b: number;
	readonly path: PoseEvidencePath;
	readonly reason: string;
	readonly correspondenceCount: number;
	readonly spatialSeparationPx: number;
	readonly familyDiversity: number;
	readonly rmsTranslationResidualPx: number | null;
	readonly ambiguityMargin: number;
	readonly transformModel: 'translation' | 'similarity' | 'affine' | null;
	readonly semanticVoteMs: number;
	readonly localVerifyMs: number;
	readonly globalFallbackMs: number;
}

export interface PoseGraphOptions {
	/** Index-aligned source-raster semantic observations from CHSPT-75. */
	readonly semanticSources?: readonly SemanticSourceLandmarks[];
	readonly semanticVerification?: SemanticVerificationOptions;
}

/** One escalated pairwise pose: `coefficients` maps `child`'s own raster px to `parent`'s own raster px. */
export interface PoseEdge {
	readonly parent: number;
	readonly child: number;
	readonly model: PoseModel;
	readonly coefficients: Affine6Coefficients;
	readonly score: number;
	readonly kind: 'placement-edge' | 'fusion-edge';
	/** Which front-end supplied this edge before the existing graph consumed it. */
	readonly path?: PoseEvidencePath;
}

export interface PoseGraphSuccess {
	readonly ok: true;
	readonly order: readonly number[];
	readonly transforms: ReadonlyMap<number, SourceTransform>;
	readonly edges: readonly PoseEdge[];
	readonly placementEdges: readonly PoseEdge[];
	readonly pairDiagnostics: readonly SemanticPairDiagnostic[];
}

export type PoseGraphResult =
	| PoseGraphSuccess
	| { readonly ok: false; readonly reason: 'incoherent'; readonly message: string };

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

function coarserModel(a: PoseModel, b: PoseModel): PoseModel {
	const rank: Record<PoseModel, number> = { translation: 0, similarity: 1, affine: 2 };
	return rank[a] >= rank[b] ? a : b;
}

function sampleNearest(raster: AnalysisRaster, xPx: number, yPx: number): number | null {
	const x = Math.round(xPx / raster.scale);
	const y = Math.round(yPx / raster.scale);
	if (x < 0 || y < 0 || x >= raster.widthPx || y >= raster.heightPx) return null;
	return raster.gray[y * raster.widthPx + x];
}

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

interface DirectedTranslation {
	readonly aIndex: number;
	readonly bIndex: number;
	readonly orientation: PairOrientation;
	readonly score: number;
	readonly dxPx: number;
	readonly dyPx: number;
	readonly path: PoseEvidencePath;
	/** True only when dx/dy already came from CHSPT-78's full-resolution local verifier. */
	readonly locallyVerified: boolean;
}

/** The pre-CHSPT-78 global pair search, intentionally unchanged. */
async function globalCoarsePairCandidate(
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
			candidates.push({
				aIndex,
				bIndex,
				orientation,
				score: match.score,
				dxPx: match.dxPx,
				dyPx: match.dyPx,
				path: 'global-fallback',
				locallyVerified: false
			});
		}
	}
	return candidates.reduce((best, candidate) => (candidate.score > best.score ? candidate : best));
}

function maxCorrespondenceSeparation(
	correspondences: readonly { readonly b: { readonly xPx: number; readonly yPx: number } }[]
): number {
	let max = 0;
	for (let i = 0; i < correspondences.length; i += 1) {
		for (let j = i + 1; j < correspondences.length; j += 1) {
			max = Math.max(
				max,
				Math.hypot(
					correspondences[i].b.xPx - correspondences[j].b.xPx,
					correspondences[i].b.yPx - correspondences[j].b.yPx
				)
			);
		}
	}
	return max;
}

function orientationForTranslation(dxPx: number, dyPx: number): PairOrientation {
	return Math.abs(dxPx) >= Math.abs(dyPx) ? 'left-right' : 'top-bottom';
}

function diagnosticBase(
	a: number,
	b: number,
	path: PoseEvidencePath,
	reason: string,
	vote: ReturnType<typeof voteSemanticTranslation> | null,
	fit: ReturnType<typeof fitMinimalSemanticTransform>
): Omit<SemanticPairDiagnostic, 'localVerifyMs' | 'globalFallbackMs'> {
	const winner = vote?.winner ?? null;
	return {
		a,
		b,
		path,
		reason,
		correspondenceCount: winner?.inlierCount ?? 0,
		spatialSeparationPx: winner ? maxCorrespondenceSeparation(winner.correspondences) : 0,
		familyDiversity: winner?.familyDiversity ?? 0,
		rmsTranslationResidualPx: winner?.rmsResidualPx ?? null,
		ambiguityMargin: vote?.ambiguityMargin ?? 0,
		transformModel: fit?.model ?? null,
		semanticVoteMs: vote?.elapsedMs ?? 0
	};
}

async function semanticFirstPairCandidate(
	rasters: readonly AnalysisRaster[],
	semanticSources: readonly SemanticSourceLandmarks[] | undefined,
	i: number,
	j: number,
	diagnostics: SemanticPairDiagnostic[],
	verificationOptions: SemanticVerificationOptions | undefined
): Promise<DirectedTranslation> {
	if (!semanticSources || semanticSources.length !== rasters.length) {
		const global = await globalCoarsePairCandidate(rasters, i, j);
		diagnostics.push({
			...diagnosticBase(i, j, 'global-fallback', 'semantic-landmarks-unavailable', null, null),
			localVerifyMs: 0,
			globalFallbackMs: 0
		});
		return global;
	}

	const vote = voteSemanticTranslation(semanticSources[i], semanticSources[j]);
	const fit = vote.winner ? fitMinimalSemanticTransform(vote.winner.correspondences) : null;
	const spatialSeparationPx = vote.winner ? maxCorrespondenceSeparation(vote.winner.correspondences) : 0;
	const strongTranslation = Boolean(
		vote.ok &&
		vote.translation &&
		vote.winner &&
		fit?.verified &&
		fit.model === 'translation' &&
		fit.evidence.translationVerified &&
		fit.evidence.similarityIdentifiable &&
		spatialSeparationPx >= 3
	);

	if (!strongTranslation || !vote.translation) {
		const reason = vote.reason
			? `semantic-abstained:${vote.reason}`
			: fit?.model && fit.model !== 'translation'
				? `semantic-transform-escalation:${fit.model}`
				: 'semantic-evidence-insufficient';
		const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
		const global = await globalCoarsePairCandidate(rasters, i, j);
		const finished = typeof performance !== 'undefined' ? performance.now() : Date.now();
		diagnostics.push({
			...diagnosticBase(i, j, 'global-fallback', reason, vote, fit),
			localVerifyMs: 0,
			globalFallbackMs: finished - started
		});
		return global;
	}

	const verification = await verifySemanticPoseSeed(
		rasters,
		{
			aIndex: i,
			bIndex: j,
			orientation: orientationForTranslation(vote.translation.dxPx, vote.translation.dyPx),
			dxPx: vote.translation.dxPx,
			dyPx: vote.translation.dyPx,
			confidence: vote.winner?.score,
			seedId: `semantic:${i}:${j}`
		},
		() => globalCoarsePairCandidate(rasters, i, j),
		verificationOptions
	);

	if (verification.path === 'semantic-local') {
		diagnostics.push({
			...diagnosticBase(i, j, 'semantic-local-verify', 'semantic-translation-verified-locally', vote, fit),
			localVerifyMs: verification.timing.localVerifyMs,
			globalFallbackMs: 0
		});
		return {
			aIndex: i,
			bIndex: j,
			orientation: verification.seed.orientation,
			score: verification.match.score,
			dxPx: verification.match.dxPx,
			dyPx: verification.match.dyPx,
			path: 'semantic-local-verify',
			locallyVerified: true
		};
	}

	const fallback = verification.fallback;
	diagnostics.push({
		...diagnosticBase(i, j, 'semantic-disagreement', 'semantic-seed-failed-local-ncc; preserved-global-fallback', vote, fit),
		localVerifyMs: verification.timing.localVerifyMs,
		globalFallbackMs: verification.timing.fallbackMs
	});
	return { ...fallback, path: 'semantic-disagreement', locallyVerified: false };
}

interface EdgeCandidate {
	readonly model: PoseModel;
	readonly coefficients: Affine6Coefficients;
	readonly score: number;
}

async function escalatedPose(
	rasters: readonly AnalysisRaster[],
	aIndex: number,
	bIndex: number,
	orientation: PairOrientation,
	preverified?: DirectedTranslation
): Promise<EdgeCandidate> {
	const a = rasters[aIndex];
	const b = rasters[bIndex];
	const refined = preverified?.locallyVerified
		? { dxPx: preverified.dxPx, dyPx: preverified.dyPx, score: preverified.score }
		: await matchTranslation(a, b, orientation, { mode: 'refine' });
	const translationCandidate: EdgeCandidate = {
		model: 'translation',
		coefficients: [1, 0, 0, 1, refined.dxPx, refined.dyPx],
		score: refined.score
	};

	// A semantic edge reached this point only after the semantic translation
	// residual was already low AND full-resolution NCC accepted the local seed.
	// Do not escalate merely because three points make a larger family
	// mathematically identifiable; residual, not identifiability, owns family
	// escalation on the semantic path.
	if (preverified?.locallyVerified) return translationCandidate;
	if (refined.score >= ROTATION_ESCALATION_MAX_SCORE) return translationCandidate;

	const geom = centeredTemplateGeometry(b);
	const rectPx = {
		xPx: geom.tx * b.scale,
		yPx: geom.ty * b.scale,
		widthPx: geom.tw * b.scale,
		heightPx: geom.th * b.scale
	};

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

interface TreeEdgeRef {
	readonly parent: number;
	readonly child: number;
}

function buildSpanningTree(
	n: number,
	weight: (i: number, j: number) => number
): { edges: TreeEdgeRef[]; visitOrder: number[] } {
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

export async function buildPoseGraph(
	rasters: readonly AnalysisRaster[],
	options: PoseGraphOptions = {}
): Promise<PoseGraphResult> {
	const n = rasters.length;
	if (n < 2) throw new Error(`buildPoseGraph: expected at least two rasters, got ${n}`);
	if (n > MAX_POSE_GRAPH_TILES) {
		throw new Error(`buildPoseGraph: ${n} tiles exceeds the automatic-arrangement limit of ${MAX_POSE_GRAPH_TILES}`);
	}

	const pairDiagnostics: SemanticPairDiagnostic[] = [];
	const coarseCache = new Map<string, DirectedTranslation>();
	const coarseFor = async (i: number, j: number): Promise<DirectedTranslation> => {
		const lo = Math.min(i, j);
		const hi = Math.max(i, j);
		const key = `${lo}:${hi}`;
		let candidate = coarseCache.get(key);
		if (!candidate) {
			candidate = await semanticFirstPairCandidate(
				rasters,
				options.semanticSources,
				lo,
				hi,
				pairDiagnostics,
				options.semanticVerification
			);
			coarseCache.set(key, candidate);
		}
		return candidate;
	};

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

	const transforms = new Map<number, SourceTransform>();
	transforms.set(visitOrder[0], buildSourceTransform('translation', IDENTITY_COEFFICIENTS));
	const edges: PoseEdge[] = [];
	const placementEdges: PoseEdge[] = [];

	for (const treeEdge of tree) {
		const coarse = await coarseFor(treeEdge.parent, treeEdge.child);
		const forward = coarse.aIndex === treeEdge.parent;
		const escalated = await escalatedPose(
			rasters,
			coarse.aIndex,
			coarse.bIndex,
			coarse.orientation,
			coarse.locallyVerified ? coarse : undefined
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
		transforms.set(treeEdge.child, buildSourceTransform(model, absoluteCoefficients));

		const edge: PoseEdge = {
			parent: treeEdge.parent,
			child: treeEdge.child,
			model: escalated.model,
			coefficients,
			score: escalated.score,
			kind: 'placement-edge',
			path: coarse.path
		};
		edges.push(edge);
		placementEdges.push(edge);
	}

	// Existing corroborating fusion remains intact. Semantic-local candidates
	// are already full-resolution and therefore do not pay a second refine.
	for (let k = 1; k < visitOrder.length; k += 1) {
		const child = visitOrder[k];
		const childTransform = transforms.get(child)!;
		if (childTransform.model !== 'translation') continue;

		const raster = rasters[child];
		const tileSpanPx = Math.max(raster.widthPx, raster.heightPx) * raster.scale;
		const disagreementLimitPx = tileSpanPx * POSE_FUSION_MAX_DISAGREEMENT_FRACTION;
		const implied: Affine6Coefficients[] = [childTransform.coefficients];
		const fusionEdges: PoseEdge[] = [];
		for (let m = 0; m < k; m += 1) {
			const other = visitOrder[m];
			const otherTransform = transforms.get(other)!;
			if (otherTransform.model !== 'translation') continue;
			const candidate = await coarseFor(other, child);
			if (candidate.score < FUSION_MIN_SCORE) continue;
			const refined = candidate.locallyVerified
				? { dxPx: candidate.dxPx, dyPx: candidate.dyPx }
				: await matchTranslation(
					rasters[candidate.aIndex],
					rasters[candidate.bIndex],
					candidate.orientation,
					{ mode: 'refine' }
				);
			const forward = candidate.aIndex === other;
			const relative: Affine6Coefficients = forward
				? [1, 0, 0, 1, refined.dxPx, refined.dyPx]
				: [1, 0, 0, 1, -refined.dxPx, -refined.dyPx];
			const absolute = composeAffine6(otherTransform.coefficients, relative);
			if (maxCornerDisagreement([childTransform.coefficients, absolute], raster) > disagreementLimitPx) continue;
			implied.push(absolute);
			fusionEdges.push({
				parent: other,
				child,
				model: 'translation',
				coefficients: relative,
				score: candidate.score,
				kind: 'fusion-edge',
				path: candidate.path
			});
		}
		if (fusionEdges.length === 0) continue;
		const averaged = averageCoefficients(implied);
		transforms.set(child, buildSourceTransform('translation', averaged));
		edges.push(...fusionEdges);
	}

	return { ok: true, order: visitOrder, transforms, edges, placementEdges, pairDiagnostics };
}

function averageCoefficients(candidates: readonly Affine6Coefficients[]): Affine6Coefficients {
	const sum: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
	for (const candidate of candidates) {
		for (let i = 0; i < 6; i += 1) sum[i] += candidate[i];
	}
	const n = candidates.length;
	return sum.map((value) => value / n) as unknown as Affine6Coefficients;
}

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
