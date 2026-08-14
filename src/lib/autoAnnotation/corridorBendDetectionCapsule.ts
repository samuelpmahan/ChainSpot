/**
 * Fourth corridor-bend substrate, and the first built on CAPSULE (region)
 * scoring instead of shortest-path-through-a-mask. Faithful TypeScript port
 * of `scripts/cv-probes/hole_path_capsule_fit.py` (read together with
 * `hole_path_anchor_experiments.py`, which it imports for `split_longest`
 * and the badge-masked line scorer, and `hole_path_alexclark_check.py`,
 * whose unanchored fallback + second graded-evidence refinement pass this
 * module also folds in) — see `scripts/cv-probes/hole-path-lowparam-findings.md`'s
 * "v2: capsule scoring" and "Second course: AlexClark" sections for the
 * validated numbers this port is checked against.
 *
 * WHY capsule scoring, not pathfinding: the other three detectors in this
 * file's family (`corridorBendDetection.ts`, `corridorBendDetectionRibbonMass.ts`,
 * `corridorBendDetectionRibbon.ts`) all trace a shortest path through a
 * binary/graded "open" mask, then RDP-simplify it. The Python research line
 * that led here found that paradigm structurally unable to separate a real
 * shallow bend from a spurious micro-wiggle: sampling evidence ALONG a
 * candidate LINE gives an off-ridge anchor or within-band wobble almost the
 * same score as a genuine dogleg, because both cross the same "on corridor"
 * pixels either way (see the findings doc's "Why straight holes grew
 * spurious bends" section). Scoring the corridor as a REGION instead —
 * dilating the candidate polyline to a capsule of roughly the corridor's own
 * half-width and averaging evidence over that whole tube — fixes this: a
 * micro-wiggle covers the same capsule pixels as the straight chord (nothing
 * gained), while a real bend leaves part of a straight capsule sitting over
 * off-corridor terrain (a real, measurable loss). Measured on the reference
 * fixture: bent-hole capsule gains 0.057-0.386 vs. straight-hole gains
 * 0.001-0.015 — a clean ~4x gap either side of the 0.03 acceptance margin.
 *
 * TWO-STAGE fit, per hole:
 *  1. STRUCTURE (how many bends, roughly where): capsule-scored, coarse-grid
 *     + hill-climb for the first bend, split-longest-segment + hill-climb for
 *     each further one, accepted only if it beats the simpler structure by
 *     `capsuleMarginScore`. Optionally anchored: when a badge point is
 *     supplied, the tee-to-badge segment is FIXED (a real layout invariant —
 *     UDisc places each hole's number badge on its own fairway path, "mask+anchor"
 *     in the findings doc) and only badge-to-basket is searched; the badge
 *     itself is never returned as a bend (mirrors how tee/basket are never
 *     returned as bends either — see `fitCapsuleBends`'s own doc comment).
 *     No badge -> tee-to-basket is searched directly, no fixed segment,
 *     structurally identical to `hole_path_alexclark_check.py`'s unanchored
 *     fit (that script's own separate line-scored pipeline is not re-run
 *     here; the SAME capsule engine handles both cases by simply passing an
 *     empty anchor prefix — see `fitCapsuleBends`'s doc comment for why that
 *     is the faithful generalization, not a shortcut).
 *  2. REFINEMENT (exact bend position, once count is frozen): a second
 *     hill-climb, holding structure (bend count) fixed, using the ORIGINAL
 *     graded (non-capsule) trimmed-mean line scorer instead of the capsule
 *     scorer — mirrors `hole_path_alexclark_check.py`'s residual finding
 *     that saturated/region evidence places a bend well within a narrow
 *     corridor but not AT the true centerline, because within-band position
 *     carries no gradient once a whole capsule already reads ~1; graded
 *     line-sampled evidence recenters it (measured there: 59/74/93% ->
 *     94/71/93% golden containment after this second pass).
 *
 * Badge-BOX masking (not badge-box ROUTING-AROUND): pixels inside the
 * supplied badge's box are excluded from BOTH scorers' means rather than
 * being penalized or treated as impassable — the number glyph sitting on the
 * corridor is noise to ignore, not terrain to route around (mirrors
 * `hole_path_anchor_experiments.py`'s "mask" arm). Only the ONE badge point
 * this call is given gets masked — the Python probe masks every badge on the
 * whole course at once (whole-image evidence map, one badge_mask reused for
 * all 18 holes); `fitCapsuleBends` is evidence-source-agnostic and per-hole
 * by design (see that function's doc comment), so it only ever receives the
 * one badge relevant to the hole it's fitting. An honest, deliberate
 * narrowing of the original probe's masking, not an oversight.
 *
 * This module has TWO independent halves:
 *
 * - `fitCapsuleBends` (the engine, item of primary interest to any other
 *   piece of work wiring this up): takes an already-built `CorridorEvidenceGrid`
 *   (`corridorEvidenceGrid.ts`) plus tee/basket/optional-badge points and
 *   params, returns bend points. Reads ONLY `.evidence` — no coupling to
 *   `ribbonMass.ts`, no coupling to any specific image-processing pipeline,
 *   no assumption about how the grid was built. A separate, parallel piece
 *   of work is expected to produce grids in that exact shape from this
 *   branch's newer ribbon-mass/occluder-bridge/ring-arc research and plug
 *   them into this engine without touching this file.
 * - `buildClassicCorridorEvidence` + `detectCorridorBendsCapsule`: THIS
 *   module's OWN evidence source (the Python probe's own LAB-lightness-
 *   minus-box-mean construction, ported verbatim), used ONLY to validate
 *   `fitCapsuleBends` against the original Python probe's fresh output
 *   (arm C in this branch's evaluation). Nothing about `fitCapsuleBends`
 *   depends on this half existing.
 *
 * Same output contract as the other three detectors: a plain `SourcePoint[]`
 * of bend points, ordered tee-to-basket, no confidence/provenance field ever
 * attached (see `annotatedRound.ts`'s provenance rule).
 *
 * PRODUCTION STATUS: `detectAndApplyCorridorBendsCapsule` below (arm C, this
 * module's own `buildClassicCorridorEvidence` + `fitCapsuleBends`) is the
 * authoritative automatic bend proposal `approveHolePieces` in the Annotate
 * Round page calls — promoted after `scripts/benchmark-corridor-bend-detection.ts`
 * showed it correctly locating a real bend on 16/18 Dash holes and all 3
 * AlexClark holes (17/18 and 3/3 exact bend COUNT respectively), where the
 * previously-shipped shortest-path detector (`corridorBendDetection.ts`'s
 * `detectCorridorBends`) never once correctly located a real bend on either
 * course, and the ribbon-mass shortest-path detector
 * (`corridorBendDetectionRibbonMass.ts`) and the ribbon-mass-driven capsule
 * hybrid (`corridorBendDetectionCapsuleRibbonMass.ts`) both underperformed
 * this module's own classic evidence. Those three remain in the repo,
 * unmodified, for benchmark history/debugging only — none of them are called
 * from production anymore.
 */
import type { AnnotatedHole, SourcePoint } from '../domain/annotatedRound';
import { applyDetectedCorridorBends } from './corridorBendDetection';
import type { CorridorBendRaster } from './corridorBendDetection';
import type { CorridorEvidenceGrid } from './corridorEvidenceGrid';
import { isInsideEvidenceGrid, toEvidenceGridLocal, toEvidenceGridSource } from './corridorEvidenceGrid';

// ---------------------------------------------------------------------------
// fitCapsuleBends: the evidence-agnostic engine.
// ---------------------------------------------------------------------------

export interface CapsuleFitParams {
	/** Capsule half-width (tube radius) evidence is averaged inside, in SOURCE px. Mirrors `CAPSULE_R` (7 grid px at the Python probe's fixed 1/3 downscale = 21 source px). */
	readonly capsuleRadiusSrcPx: number;
	/** Score a structure with one more bend must beat the simpler (accepted) structure by, to keep it. Mirrors `CAPSULE_MARGIN` (0.03). */
	readonly capsuleMarginScore: number;
	/** Hard cap on bends returned (beyond any badge anchor, which is never itself a returned bend). Mirrors `MAX_BENDS` (3). */
	readonly maxBends: number;
	/** Excess-length penalty coefficient, shared by both the capsule scorer and the line-sample refinement scorer (both Python scorers use the same 0.2). Mirrors `LENGTH_ALPHA` / `make_capsule_scorer`'s `alpha=0.2`. */
	readonly lengthPenaltyAlpha: number;
	/** Step (SOURCE px) the refinement stage's trimmed-mean line scorer samples the candidate polyline at. Mirrors `sample()`'s default `step=2.0` (2 grid px at 1/3 scale = 6 source px). */
	readonly lineSampleStepSrcPx: number;
	/** Fraction of the lowest-evidence line samples the refinement scorer drops before averaging. Mirrors the line scorer's `[int(0.2*len(v)):]` trim. */
	readonly lineSampleTrimFraction: number;
	/** Minimum valid (non-badge-masked) line samples required for a non-degenerate refinement score; below this the scorer returns -1. Mirrors `len(v) < 5`. */
	readonly minLineSampleCount: number;
	/** Minimum valid (non-badge-masked) capsule cells required for a non-degenerate structure score; below this the scorer returns -1. Mirrors `mm.sum() < 10`. A raw grid-cell count, not scaled to grid resolution — the Python probe's own literal threshold, faithfully carried over. */
	readonly minCapsulePixelCount: number;
	/** Badge exclusion box half-extents, SOURCE px, centered on the supplied badge point. Mirrors `hole_path_anchor_experiments.py`'s `BADGE_HALF_W`/`BADGE_HALF_H` (34, 24) — the same numbers `hole_path_capsule_fit.py` itself uses for its badge mask. */
	readonly badgeMaskHalfWidthSrcPx: number;
	readonly badgeMaskHalfHeightSrcPx: number;
	/** Coarse-grid fractions along (t, 0=start..1=end) and perpendicular offset ratio (o, times the start-end distance) probed for the FIRST bend only. Mirrors `np.linspace(0.3, 0.7, 5)` / `np.linspace(-0.4, 0.4, 9)`. */
	readonly firstBendTFractions: readonly number[];
	readonly firstBendOffsetFractions: readonly number[];
	/** Hill-climb step sizes (SOURCE px, largest first) for the STRUCTURE search. Mirrors `fit_capsule`'s own `hill_climb(..., steps=(6, 3, 1))` at 1/3 scale -> source px. */
	readonly structureHillClimbStepsSrcPx: readonly number[];
	/** Hill-climb step sizes (SOURCE px, largest first) for the final graded-evidence REFINEMENT. Mirrors `base.hill_climb`'s own default `steps=(8, 4, 2, 1)`. */
	readonly refinementHillClimbStepsSrcPx: readonly number[];
}

/** The Python probe's fixed whole-course downscale (`SCALE` in `hole_path_lowparam_fit.py`) every default numeric constant below was originally measured at 1/3-scale grid px for; each field's own doc comment cites the literal Python constant it mirrors. */
const PYTHON_EVIDENCE_SCALE = 3;

export const DEFAULT_CAPSULE_FIT_PARAMS: CapsuleFitParams = {
	capsuleRadiusSrcPx: 7 * PYTHON_EVIDENCE_SCALE,
	capsuleMarginScore: 0.03,
	maxBends: 3,
	lengthPenaltyAlpha: 0.2,
	lineSampleStepSrcPx: 2 * PYTHON_EVIDENCE_SCALE,
	lineSampleTrimFraction: 0.2,
	minLineSampleCount: 5,
	minCapsulePixelCount: 10,
	badgeMaskHalfWidthSrcPx: 34,
	badgeMaskHalfHeightSrcPx: 24,
	firstBendTFractions: [0.3, 0.4, 0.5, 0.6, 0.7],
	firstBendOffsetFractions: [-0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4],
	structureHillClimbStepsSrcPx: [6, 3, 1].map((s) => s * PYTHON_EVIDENCE_SCALE),
	refinementHillClimbStepsSrcPx: [8, 4, 2, 1].map((s) => s * PYTHON_EVIDENCE_SCALE)
};

type LocalPoint = SourcePoint; // Same {xPx,yPx} shape; this alias just marks "grid-local px" call sites for readability.

function polylineLengthLocal(points: readonly LocalPoint[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i += 1) total += Math.hypot(points[i].xPx - points[i - 1].xPx, points[i].yPx - points[i - 1].yPx);
	return total;
}

function excessLengthPenalty(points: readonly LocalPoint[], lengthPenaltyAlpha: number): number {
	const length = polylineLengthLocal(points);
	const straight = Math.max(Math.hypot(points[points.length - 1].xPx - points[0].xPx, points[points.length - 1].yPx - points[0].yPx), 1e-6);
	return lengthPenaltyAlpha * Math.max(0, length / straight - 1);
}

/** Port of `sample(pts, step)`: every segment contributes points at `t = 0, 1/n, ..., (n-1)/n` (n = max(2, floor(segmentLength/step))), then the polyline's own final point is appended once. */
function sampleAlongPolylineLocal(points: readonly LocalPoint[], stepLocalPx: number): LocalPoint[] {
	const out: LocalPoint[] = [];
	for (let i = 0; i < points.length - 1; i += 1) {
		const a = points[i];
		const b = points[i + 1];
		const segmentLength = Math.hypot(b.xPx - a.xPx, b.yPx - a.yPx);
		const n = Math.max(2, Math.floor(segmentLength / stepLocalPx));
		for (let k = 0; k < n; k += 1) {
			const t = k / n;
			out.push({ xPx: a.xPx + (b.xPx - a.xPx) * t, yPx: a.yPx + (b.yPx - a.yPx) * t });
		}
	}
	out.push(points[points.length - 1]);
	return out;
}

/** Squared distance from `(x,y)` to the segment `a`-`b` — the capsule scorer's per-cell coverage test. */
function pointSegmentDistanceSq(x: number, y: number, a: LocalPoint, b: LocalPoint): number {
	const dx = b.xPx - a.xPx;
	const dy = b.yPx - a.yPx;
	const lengthSq = dx * dx + dy * dy;
	let t = 0;
	if (lengthSq > 1e-12) t = Math.min(1, Math.max(0, ((x - a.xPx) * dx + (y - a.yPx) * dy) / lengthSq));
	const px = a.xPx + t * dx - x;
	const py = a.yPx + t * dy - y;
	return px * px + py * py;
}

type ValidCell = (xLocal: number, yLocal: number) => boolean;
type LocalScorer = (points: readonly LocalPoint[]) => number;

/**
 * Port of `make_capsule_scorer`: mean evidence inside the capsule (all grid
 * cells within `radiusLocalPx` of ANY segment of the candidate polyline,
 * `& valid`) minus the excess-length penalty. Reimplemented as an exact
 * point-to-polyline distance test rather than replicating PIL's
 * `ImageDraw.line(width=..., joint="curve")` + endpoint-circle rasterization
 * pixel-for-pixel — the two are the same shape (a stroked polyline with
 * round joins and round end caps IS the Minkowski dilation of the polyline
 * by a disk of that radius, which is exactly "dilate a candidate polyline to
 * a fixed-radius tube" from this module's own doc comment), and PIL's
 * specific rasterization algorithm isn't portable/reproducible outside PIL
 * itself. Restricted to the candidate's own bounding box (padded by the
 * radius) rather than the whole grid, matching the Python probe's own
 * per-hole cost shape (each `score()` call is cheap; the search calls it
 * many times).
 */
function makeCapsuleScorer(grid: CorridorEvidenceGrid, valid: ValidCell, radiusLocalPx: number, lengthPenaltyAlpha: number, minCells: number): LocalScorer {
	const radiusSq = radiusLocalPx * radiusLocalPx;
	return (points: readonly LocalPoint[]): number => {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const p of points) {
			if (p.xPx < minX) minX = p.xPx;
			if (p.xPx > maxX) maxX = p.xPx;
			if (p.yPx < minY) minY = p.yPx;
			if (p.yPx > maxY) maxY = p.yPx;
		}
		const x0 = Math.max(0, Math.floor(minX - radiusLocalPx));
		const x1 = Math.min(grid.widthPx - 1, Math.ceil(maxX + radiusLocalPx));
		const y0 = Math.max(0, Math.floor(minY - radiusLocalPx));
		const y1 = Math.min(grid.heightPx - 1, Math.ceil(maxY + radiusLocalPx));
		let sum = 0;
		let count = 0;
		for (let y = y0; y <= y1; y += 1) {
			const rowBase = y * grid.widthPx;
			for (let x = x0; x <= x1; x += 1) {
				if (!valid(x, y)) continue;
				let best = Infinity;
				for (let i = 0; i < points.length - 1; i += 1) {
					const d = pointSegmentDistanceSq(x, y, points[i], points[i + 1]);
					if (d < best) best = d;
					if (best <= radiusSq) break;
				}
				if (best <= radiusSq) {
					sum += grid.evidence[rowBase + x];
					count += 1;
				}
			}
		}
		if (count < minCells) return -1;
		return sum / count - excessLengthPenalty(points, lengthPenaltyAlpha);
	};
}

/**
 * Port of `hole_path_anchor_experiments.py`'s masked `make_scorer` (used as
 * `line_score` in `hole_path_capsule_fit.py`, and as both `sc_flat`'s and
 * `sc_graded`'s underlying shape in `hole_path_alexclark_check.py`): trimmed
 * mean (drop the lowest `trimFraction`) of evidence sampled every
 * `stepLocalPx` along the polyline, restricted to non-badge-masked samples,
 * minus the excess-length penalty. Returns -1 (degenerate) below
 * `minSamples` valid samples.
 */
function makeLineScorer(
	grid: CorridorEvidenceGrid,
	valid: ValidCell,
	stepLocalPx: number,
	trimFraction: number,
	lengthPenaltyAlpha: number,
	minSamples: number
): LocalScorer {
	return (points: readonly LocalPoint[]): number => {
		const samples = sampleAlongPolylineLocal(points, stepLocalPx);
		const values: number[] = [];
		for (const p of samples) {
			const xi = Math.min(grid.widthPx - 1, Math.max(0, Math.trunc(p.xPx)));
			const yi = Math.min(grid.heightPx - 1, Math.max(0, Math.trunc(p.yPx)));
			if (!valid(xi, yi)) continue;
			values.push(grid.evidence[yi * grid.widthPx + xi]);
		}
		if (values.length < minSamples) return -1;
		values.sort((a, b) => a - b);
		const kept = values.slice(Math.floor(trimFraction * values.length));
		const mean = kept.reduce((sum, v) => sum + v, 0) / kept.length;
		return mean - excessLengthPenalty(points, lengthPenaltyAlpha);
	};
}

const HILL_CLIMB_NEIGHBOR_OFFSETS: readonly (readonly [number, number])[] = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
	[1, 1],
	[1, -1],
	[-1, 1],
	[-1, -1]
];

/**
 * Port of `hill_climb`: coordinate-descent over `movable` point indices,
 * largest step size first, greedily accepting any of the 8 neighbor offsets
 * (at the current step size) that improves the FULL points array's score,
 * repeating each step size until a full pass over `movable` improves
 * nothing. Mutates and re-scores the whole array sequentially (an update to
 * one movable index is visible to the next index's trial moves within the
 * same pass) — deliberately not parallelized/batched, to stay numerically
 * faithful to the Python original.
 */
function hillClimbLocal(
	score: LocalScorer,
	initialPoints: readonly LocalPoint[],
	movable: readonly number[],
	stepsLocalPx: readonly number[]
): { readonly points: LocalPoint[]; readonly score: number } {
	const points = initialPoints.map((p) => ({ ...p }));
	for (const step of stepsLocalPx) {
		let improved = true;
		while (improved) {
			improved = false;
			for (const i of movable) {
				let best = score(points);
				let bestPoint = { ...points[i] };
				for (const [dx, dy] of HILL_CLIMB_NEIGHBOR_OFFSETS) {
					points[i] = { xPx: bestPoint.xPx + dx * step, yPx: bestPoint.yPx + dy * step };
					const candidateScore = score(points);
					if (candidateScore > best) {
						best = candidateScore;
						bestPoint = { ...points[i] };
						improved = true;
					}
				}
				points[i] = bestPoint;
			}
		}
	}
	return { points, score: score(points) };
}

/** Port of `split_longest`: inserts the midpoint of the polyline's own longest segment (first occurrence wins on ties, matching `np.argmax`). */
function splitLongestSegmentLocal(points: readonly LocalPoint[]): LocalPoint[] {
	let bestIndex = 0;
	let bestLength = -1;
	for (let i = 0; i < points.length - 1; i += 1) {
		const length = Math.hypot(points[i + 1].xPx - points[i].xPx, points[i + 1].yPx - points[i].yPx);
		if (length > bestLength) {
			bestLength = length;
			bestIndex = i;
		}
	}
	const mid: LocalPoint = { xPx: (points[bestIndex].xPx + points[bestIndex + 1].xPx) / 2, yPx: (points[bestIndex].yPx + points[bestIndex + 1].yPx) / 2 };
	return [...points.slice(0, bestIndex + 1), mid, ...points.slice(bestIndex + 1)];
}

interface StructureSearchConfig {
	readonly maxBends: number;
	readonly capsuleMarginScore: number;
	readonly firstBendTFractions: readonly number[];
	readonly firstBendOffsetFractions: readonly number[];
	readonly hillClimbStepsLocalPx: readonly number[];
}

/**
 * Port of `fit_capsule`: chooses 0..`maxBends` bends between `startLocal` and
 * `endLocal` (with `prefixLocal` — 0 or 1 points — prepended to every scored
 * candidate but never itself searched or moved) by CAPSULE gain. The first
 * bend is seeded by a coarse grid over (t, o) then hill-climbed; each further
 * bend is seeded by splitting the current structure's own longest segment
 * (no grid — "the split seed does not depend on the grid", matching the
 * Python's early `break`) then hill-climbed with every non-anchor,
 * non-endpoint point movable together. A candidate structure is kept only if
 * it beats the previous (accepted) structure's score by `capsuleMarginScore`;
 * otherwise the search stops (this round's candidate is discarded, not just
 * this bend — mirrors the Python's `else: break`, not `continue`).
 */
function fitCapsuleStructureLocal(
	capsuleScore: LocalScorer,
	startLocal: LocalPoint,
	endLocal: LocalPoint,
	prefixLocal: readonly LocalPoint[],
	config: StructureSearchConfig
): { readonly structure: LocalPoint[]; readonly bends: number; readonly score: number } {
	let cur: LocalPoint[] = [...prefixLocal, startLocal, endLocal];
	let curScore = capsuleScore(cur);
	let bends = 0;

	const dx = endLocal.xPx - startLocal.xPx;
	const dy = endLocal.yPx - startLocal.yPx;
	const length = Math.max(Math.hypot(dx, dy), 1e-6);
	const unitX = dx / length;
	const unitY = dy / length;
	const perpX = -unitY;
	const perpY = unitX;

	for (let iteration = 0; iteration < config.maxBends; iteration += 1) {
		let bestCandidate: LocalPoint[] | null = null;
		let bestScore = -Infinity;
		if (bends === 0) {
			for (const t of config.firstBendTFractions) {
				for (const o of config.firstBendOffsetFractions) {
					const mid: LocalPoint = {
						xPx: startLocal.xPx + dx * t + perpX * o * length,
						yPx: startLocal.yPx + dy * t + perpY * o * length
					};
					const candidate = [startLocal, mid, endLocal];
					const s = capsuleScore([...prefixLocal, ...candidate]);
					if (s > bestScore) {
						bestScore = s;
						bestCandidate = candidate;
					}
				}
			}
		} else {
			const candidate = splitLongestSegmentLocal(cur.slice(prefixLocal.length));
			bestCandidate = candidate;
			bestScore = capsuleScore([...prefixLocal, ...candidate]);
		}
		const candidateFull = [...prefixLocal, ...(bestCandidate as LocalPoint[])];
		const movable: number[] = [];
		for (let i = prefixLocal.length + 1; i < candidateFull.length - 1; i += 1) movable.push(i);
		const climbed = hillClimbLocal(capsuleScore, candidateFull, movable, config.hillClimbStepsLocalPx);
		if (climbed.score > curScore + config.capsuleMarginScore) {
			cur = climbed.points;
			curScore = climbed.score;
			bends += 1;
		} else {
			break;
		}
	}
	return { structure: cur, bends, score: curScore };
}

/**
 * Proposes zero or more corridor bend points between `teeSrcPx` and
 * `basketSrcPx`, in SOURCE-image pixels, ordered tee-to-basket — the
 * capsule-scored sibling of `detectCorridorBends` / `detectCorridorBendsRibbonMass`
 * / `detectCorridorBendsRibbon`, and the ENGINE any evidence source (this
 * module's own `buildClassicCorridorEvidence`, or a separate piece of work's
 * ribbon-mass/occluder-bridge/ring-arc evidence) can drive: this function
 * reads ONLY `evidenceGrid.evidence` plus the geometry fields
 * `CorridorEvidenceGrid` documents — it does not know or care how the grid
 * was built.
 *
 * `badgeSrcPx`, when supplied, anchors the first segment tee->badge as FIXED
 * (a real layout invariant: UDisc places each hole's number badge on its own
 * fairway path — see `hole_path_anchor_experiments.py`'s "mask+anchor" arm)
 * and searches badge->basket for 0..`params.maxBends` further bends. The
 * badge point itself is NEVER included in the returned array — like
 * `teeSrcPx`/`basketSrcPx`, it is a fixed anchor the caller already has, not
 * a proposed bend; this also keeps the returned bend COUNT directly
 * comparable to the Python probe's own `bends` field (which counts the same
 * way — see `hole_path_capsule_fit.py`'s `fit_capsule`).
 *
 * `badgeSrcPx` omitted (or off-grid) falls back to an UNANCHORED tee->basket
 * search with no fixed segment — the same capsule-scored engine, just with
 * an empty anchor prefix, which is the direct/faithful generalization of
 * `hole_path_alexclark_check.py`'s unanchored variant: that script's own
 * separate (older, line-scored, non-capsule) pipeline exists in the Python
 * probes because it predates capsule scoring, not because unanchored fitting
 * needs a fundamentally different algorithm — `fit_capsule` itself was
 * already written generically enough (an arbitrary 0-or-1-point `prefix`) to
 * cover both cases, and this port keeps that generality rather than forking
 * into two engines.
 *
 * Final step, always run (mirrors `hole_path_capsule_fit.py`'s own call to
 * `base.hill_climb(line_score, pts, ...)`, and `hole_path_alexclark_check.py`'s
 * stage B): with bend COUNT now frozen, a second hill-climb recenters the
 * found bend positions using the graded (non-capsule) trimmed-mean line
 * scorer, holding tee/badge/basket fixed — capsule scoring is good at
 * deciding whether a bend exists but has no gradient for WHERE within a
 * capsule-width band it sits once found, so this pass corrects that. Any
 * hole with zero bends (anchored or not) also has zero movable points here,
 * so the refinement is a no-op for it, not a special case.
 */
export function fitCapsuleBends(
	evidenceGrid: CorridorEvidenceGrid,
	teeSrcPx: SourcePoint,
	basketSrcPx: SourcePoint,
	badgeSrcPx: SourcePoint | undefined,
	params: CapsuleFitParams = DEFAULT_CAPSULE_FIT_PARAMS
): SourcePoint[] {
	const teeLocal = toEvidenceGridLocal(evidenceGrid, teeSrcPx);
	const basketLocal = toEvidenceGridLocal(evidenceGrid, basketSrcPx);
	if (!isInsideEvidenceGrid(evidenceGrid, teeLocal) || !isInsideEvidenceGrid(evidenceGrid, basketLocal)) return [];

	let badgeLocal: LocalPoint | undefined;
	if (badgeSrcPx) {
		const candidate = toEvidenceGridLocal(evidenceGrid, badgeSrcPx);
		if (isInsideEvidenceGrid(evidenceGrid, candidate)) badgeLocal = candidate;
		// An off-grid badge is treated as absent (graceful unanchored fallback)
		// rather than anchoring on a point this grid has no evidence around.
	}

	const badgeHalfWidthLocal = params.badgeMaskHalfWidthSrcPx / evidenceGrid.scale;
	const badgeHalfHeightLocal = params.badgeMaskHalfHeightSrcPx / evidenceGrid.scale;
	const isValidCell: ValidCell = badgeLocal
		? (x, y) =>
				!(
					x >= badgeLocal!.xPx - badgeHalfWidthLocal &&
					x <= badgeLocal!.xPx + badgeHalfWidthLocal &&
					y >= badgeLocal!.yPx - badgeHalfHeightLocal &&
					y <= badgeLocal!.yPx + badgeHalfHeightLocal
				)
		: () => true;

	const capsuleRadiusLocal = params.capsuleRadiusSrcPx / evidenceGrid.scale;
	const capsuleScore = makeCapsuleScorer(evidenceGrid, isValidCell, capsuleRadiusLocal, params.lengthPenaltyAlpha, params.minCapsulePixelCount);
	const lineScore = makeLineScorer(
		evidenceGrid,
		isValidCell,
		params.lineSampleStepSrcPx / evidenceGrid.scale,
		params.lineSampleTrimFraction,
		params.lengthPenaltyAlpha,
		params.minLineSampleCount
	);

	const anchored = badgeLocal !== undefined;
	const prefixLocal: LocalPoint[] = anchored ? [teeLocal] : [];
	const startLocal = anchored ? (badgeLocal as LocalPoint) : teeLocal;

	const { structure } = fitCapsuleStructureLocal(capsuleScore, startLocal, basketLocal, prefixLocal, {
		maxBends: params.maxBends,
		capsuleMarginScore: params.capsuleMarginScore,
		firstBendTFractions: params.firstBendTFractions,
		firstBendOffsetFractions: params.firstBendOffsetFractions,
		hillClimbStepsLocalPx: params.structureHillClimbStepsSrcPx.map((s) => s / evidenceGrid.scale)
	});

	const refinementMovable: number[] = [];
	for (let i = prefixLocal.length + 1; i < structure.length - 1; i += 1) refinementMovable.push(i);
	const refined =
		refinementMovable.length > 0
			? hillClimbLocal(
					lineScore,
					structure,
					refinementMovable,
					params.refinementHillClimbStepsSrcPx.map((s) => s / evidenceGrid.scale)
				).points
			: structure;

	const bendPointsLocal = refined.slice(prefixLocal.length + 1, refined.length - 1);
	return bendPointsLocal.map((p) => toEvidenceGridSource(evidenceGrid, p));
}

// ---------------------------------------------------------------------------
// buildClassicCorridorEvidence: THIS module's own evidence source, used only
// to validate fitCapsuleBends against the original Python probe (arm C).
// ---------------------------------------------------------------------------

export interface ClassicCorridorEvidenceParams {
	/** Box-mean window subtracted from LAB L before clipping, in SOURCE px. Mirrors the Python probe's 41 grid-px window at its fixed 1/3 downscale (41*3 = 123 source px). */
	readonly boxMeanWindowSrcPx: number;
	/** Saturating divisor for LAB-L local brightening. Mirrors `EVIDENCE_DL` (12). */
	readonly evidenceDl: number;
}

export const DEFAULT_CLASSIC_CORRIDOR_EVIDENCE_PARAMS: ClassicCorridorEvidenceParams = {
	boxMeanWindowSrcPx: 41 * PYTHON_EVIDENCE_SCALE,
	evidenceDl: 12
};

// sRGB -> LAB lightness (skimage `rgb2lab`, D65/2°) — the same formulas
// `ribbonMass.ts`'s private `labLightness` uses, re-declared rather than
// imported: this module must stay independent of `ribbonMass.ts` (that
// pipeline's own doc comment declares it must never gate a production
// decision, and this module's cost/dependency story should be self-contained
// the same way `corridorBendDetectionRibbon.ts` already keeps its own box
// mean self-contained rather than importing `ribbonMass.ts`'s `boxMeanReflect`).
function srgbToLinear(c: number): number {
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function labLightnessFromRaster(raster: CorridorBendRaster): Float32Array {
	const n = raster.widthPx * raster.heightPx;
	const out = new Float32Array(n);
	const eps = 216 / 24389; // (6/29)^3
	const kappa = 24389 / 27;
	for (let i = 0; i < n; i += 1) {
		const p = i * raster.channels;
		const rl = srgbToLinear(raster.data[p] / 255);
		const gl = srgbToLinear(raster.data[p + 1] / 255);
		const bl = srgbToLinear(raster.data[p + 2] / 255);
		const y = 0.21267285140562253 * rl + 0.715152155287818 * gl + 0.07217499330655958 * bl;
		out[i] = y > eps ? 116 * Math.cbrt(y) - 16 : kappa * y;
	}
	return out;
}

function reflectIndex(i: number, n: number): number {
	if (n === 1) return 0;
	let idx = i;
	while (idx < 0 || idx >= n) {
		if (idx < 0) idx = -1 - idx;
		else idx = 2 * n - 1 - idx;
	}
	return idx;
}

/** O(n) sliding-window box mean of one line, reflect-padded (scipy `uniform_filter` boundary convention) — same shape as `corridorBendDetectionRibbon.ts`'s private `boxMean1D`, re-declared here for this module's own independence (see the doc comment above `srgbToLinear`). */
function boxMean1D(values: Float32Array, size: number): Float32Array {
	const n = values.length;
	if (size <= 1) return values.slice();
	const left = Math.floor(size / 2);
	const extLen = n + size - 1;
	const prefix = new Float64Array(extLen + 1);
	for (let i = 0; i < extLen; i += 1) prefix[i + 1] = prefix[i] + values[reflectIndex(i - left, n)];
	const out = new Float32Array(n);
	for (let i = 0; i < n; i += 1) out[i] = (prefix[i + size] - prefix[i]) / size;
	return out;
}

function boxMean2D(plane: Float32Array, w: number, h: number, size: number): Float32Array {
	const afterRows = new Float32Array(plane.length);
	const rowBuf = new Float32Array(w);
	for (let y = 0; y < h; y += 1) {
		for (let x = 0; x < w; x += 1) rowBuf[x] = plane[y * w + x];
		const filtered = boxMean1D(rowBuf, size);
		for (let x = 0; x < w; x += 1) afterRows[y * w + x] = filtered[x];
	}
	const out = new Float32Array(plane.length);
	const colBuf = new Float32Array(h);
	for (let x = 0; x < w; x += 1) {
		for (let y = 0; y < h; y += 1) colBuf[y] = afterRows[y * w + x];
		const filtered = boxMean1D(colBuf, size);
		for (let y = 0; y < h; y += 1) out[y * w + x] = filtered[y];
	}
	return out;
}

/**
 * Ports `hole_path_lowparam_fit.py`'s `evidence_map` (also inlined verbatim
 * in `hole_path_capsule_fit.py`'s `main`): `clip((L - boxmean(L, window)) / evidenceDl, 0, 1)`
 * over `raster`'s own LAB lightness — a per-hole crop's evidence, not a
 * whole-course one (see `cropSourceRasterAroundHole` in
 * `corridorBendDetection.ts` for the crop convention this is meant to run
 * on; this function itself only reads pixels, it does not crop).
 *
 * `teeSrcPx`/`basketSrcPx` are accepted (matching this module's other
 * detector-style entry points' `(raster, tee, basket, ...)` shape) and used
 * for exactly one thing: if EITHER falls outside `raster`'s own bounds, this
 * returns an all-zero evidence grid rather than a partially-meaningless one
 * — this function must stay total (`CorridorEvidenceGrid`, unlike
 * `SourcePoint[]`, has no natural "nothing here" value), so "no usable
 * signal for this hole" is represented as an evidence field `fitCapsuleBends`
 * naturally finds nothing worth bending toward in, returning zero bends,
 * rather than a special sentinel every caller would need to know about.
 */
export function buildClassicCorridorEvidence(
	raster: CorridorBendRaster,
	teeSrcPx: SourcePoint,
	basketSrcPx: SourcePoint,
	params: ClassicCorridorEvidenceParams = DEFAULT_CLASSIC_CORRIDOR_EVIDENCE_PARAMS
): CorridorEvidenceGrid {
	const lightness = labLightnessFromRaster(raster);
	const windowPx = Math.max(1, Math.round(params.boxMeanWindowSrcPx / raster.scale));
	const localMean = boxMean2D(lightness, raster.widthPx, raster.heightPx, windowPx);
	const evidence = new Float32Array(lightness.length);
	for (let i = 0; i < evidence.length; i += 1) evidence[i] = Math.min(1, Math.max(0, (lightness[i] - localMean[i]) / params.evidenceDl));

	const grid: CorridorEvidenceGrid = {
		widthPx: raster.widthPx,
		heightPx: raster.heightPx,
		originXPx: raster.originXPx,
		originYPx: raster.originYPx,
		scale: raster.scale,
		evidence
	};
	const teeLocal = toEvidenceGridLocal(grid, teeSrcPx);
	const basketLocal = toEvidenceGridLocal(grid, basketSrcPx);
	if (!isInsideEvidenceGrid(grid, teeLocal) || !isInsideEvidenceGrid(grid, basketLocal)) evidence.fill(0);
	return grid;
}

// ---------------------------------------------------------------------------
// detectCorridorBendsCapsule: this module's own arm-C detector (evidence
// builder + engine wired together), matching the other three detectors'
// SourcePoint[] contract.
// ---------------------------------------------------------------------------

export interface DetectCorridorBendsCapsuleParams {
	readonly evidence: ClassicCorridorEvidenceParams;
	readonly fit: CapsuleFitParams;
}

export const DEFAULT_DETECT_CORRIDOR_BENDS_CAPSULE_PARAMS: DetectCorridorBendsCapsuleParams = {
	evidence: DEFAULT_CLASSIC_CORRIDOR_EVIDENCE_PARAMS,
	fit: DEFAULT_CAPSULE_FIT_PARAMS
};

/**
 * Proposes zero or more corridor bend points between `teeSrcPx` and
 * `basketSrcPx`, in SOURCE-image pixels, ordered tee-to-basket — this
 * module's own arm-C detector, built ONLY from `buildClassicCorridorEvidence`
 * + `fitCapsuleBends` for validating the latter against the original Python
 * probe. `badgeSrcPx` is optional (see `fitCapsuleBends`'s doc comment on the
 * anchored/unanchored fallback). Pure: takes an already-extracted raster
 * (see `cropSourceRasterAroundHole` in `corridorBendDetection.ts`), directly
 * unit-testable with synthetic crops.
 */
export function detectCorridorBendsCapsule(
	raster: CorridorBendRaster,
	teeSrcPx: SourcePoint,
	basketSrcPx: SourcePoint,
	badgeSrcPx?: SourcePoint,
	params: DetectCorridorBendsCapsuleParams = DEFAULT_DETECT_CORRIDOR_BENDS_CAPSULE_PARAMS
): SourcePoint[] {
	const grid = buildClassicCorridorEvidence(raster, teeSrcPx, basketSrcPx, params.evidence);
	return fitCapsuleBends(grid, teeSrcPx, basketSrcPx, badgeSrcPx, params.fit);
}

// ---------------------------------------------------------------------------
// Production integration — see the PRODUCTION STATUS note in this module's
// own doc comment. `approveHolePieces` calls ONLY this function; it must
// never run alongside another detector (no dual-detector arbitration).
// ---------------------------------------------------------------------------

/**
 * Detects and applies corridor bends for one hole, in one step — the
 * production entry point `approveHolePieces` calls once a hole's tee and
 * basket are both confirmed. Combines `detectCorridorBendsCapsule` with the
 * SAME `applyDetectedCorridorBends` rules every detector in this family uses
 * (`corridorBendDetection.ts`): proposed bends are added via the ordinary
 * `addCorridorBend` primitive, exactly like a hand-placed bend — no
 * confidence/provenance field, immediately draggable/deletable.
 *
 * A no-op (returns a fresh, unchanged array — the pure-reducer convention;
 * see `applyDetectedCorridorBends`'s own doc comment) whenever:
 *  - the hole is missing a tee or basket;
 *  - the hole already has at least one corridor bend — manual "+ Add
 *    Bend(s)" work before Approve is never clobbered, and in this case the
 *    detector is never even invoked, not merely discarded;
 *  - `raster` is `null` — the caller's own crop step failed (mirrors
 *    `cropSourceRasterAroundHole`'s nullable return: no decoded image yet,
 *    canvas unsupported, or a degenerate crop window);
 *  - the detector finds no evidence worth proposing, or throws for any
 *    reason (caught here, not left to the caller).
 * Detection failing or finding nothing is always valid and must never block
 * hole approval — `approveHolePieces` calls this only AFTER confirming both
 * pieces, so nothing here can undo that confirmation.
 *
 * `badgeSrcPx` is optional — omit it (no detected number badge for this hole
 * yet, or none at all) and the underlying fit runs unanchored, exactly like
 * the AlexClark benchmark course, which ships no badge ground truth at all
 * and still reached 3/3 exact bend counts.
 */
export function detectAndApplyCorridorBendsCapsule(
	holes: readonly AnnotatedHole[],
	holeId: string,
	raster: CorridorBendRaster | null,
	badgeSrcPx: SourcePoint | undefined,
	params: DetectCorridorBendsCapsuleParams = DEFAULT_DETECT_CORRIDOR_BENDS_CAPSULE_PARAMS
): AnnotatedHole[] {
	const hole = holes.find((candidate) => candidate.id === holeId);
	if (!hole?.tee || !hole.basket || hole.corridorBends.length > 0 || !raster) return holes.slice();
	try {
		const bends = detectCorridorBendsCapsule(raster, hole.tee, hole.basket, badgeSrcPx, params);
		return applyDetectedCorridorBends(holes, holeId, bends);
	} catch {
		return holes.slice();
	}
}
