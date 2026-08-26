// Simple truth scoring for `./lab sweep`. Reads the final board state after
// executeCompiledPlan has run (badges/baskets/tees/assignments, exactly what
// the algorithm produced -- nothing recomputed here) and counts
// matched-vs-expected per gate against an Annotation JSON truth file, using
// the SAME 26px association tolerance convention
// tests/unit/dashsTrackSweep.test.ts borrows from
// old-stuff/scripts/toph-corpus-gate.ts:45. Truth is evaluation-only: it is
// never fed into the plan/board, only read against it afterward.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CanonicalTruth } from '@chainspot/alg/g0/truth';
import type { ExecBoard } from '@chainspot/alg/exec';
import type {
	BadgeEvidence,
	BasketEvidence,
	TeeEvidence,
	ThreeFactorMeasurement,
	ThreeFactorAssignment
} from '@chainspot/alg/detectors/threeFactor/types';

/** Borrowed convention, not a LAB invention -- see file header. */
export const ASSOCIATION_TOLERANCE_PX = 26;

function dist(a: { xPx: number; yPx: number }, b: { xPx: number; yPx: number }): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

export function loadTruth(truthPath: string): CanonicalTruth {
	const path = resolve(truthPath);
	let parsed: CanonicalTruth;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8')) as CanonicalTruth;
	} catch (err) {
		throw new Error(`lab: could not read/parse truth file at ${path}: ${(err as Error).message}`);
	}
	if (!Array.isArray(parsed.holes) || parsed.holes.length === 0) {
		throw new Error(`lab: truth file at ${path} has no holes.`);
	}
	return parsed;
}

export interface GateScore {
	readonly gate: string;
	readonly matched: number;
	readonly expected: number;
	readonly detected?: number;
	readonly maxDeviationPx: number;
	readonly misses: readonly string[];
	readonly objectMatches?: readonly ObjectMatch[];
	readonly unownedDetections?: readonly LocatedDetection[];
	readonly unmatchedTruth?: readonly TruthTarget[];
}

export interface TruthScoreboard {
	readonly expectedHoles: number;
	readonly scores: readonly GateScore[];
}

export interface GroundingHypothesisScore {
	readonly id: string;
	readonly yShiftPx: number;
	readonly provenance: string;
	readonly paired: number;
	readonly matchedWithinTolerance: number;
	readonly falsePositiveCount: number;
	readonly falseNegativeCount: number;
	readonly meanDeviationPx: number;
	readonly medianDeviationPx: number;
	readonly maxDeviationPx: number;
	readonly medianResidualXPx: number;
	readonly medianResidualYPx: number;
}

export interface GroundingComparison {
	readonly gate: 'G2' | 'G3';
	readonly detected: number;
	readonly expected: number;
	readonly provenanceTrusted: boolean;
	readonly hypotheses: readonly GroundingHypothesisScore[];
}

export interface Point {
	readonly xPx: number;
	readonly yPx: number;
}

export interface LocatedDetection extends Point {
	readonly id: string;
	readonly spriteType: 'basket' | 'tee';
	readonly identity: string;
	readonly measurements: Readonly<Record<string, string | number | boolean>>;
	readonly original?: Point;
}

export interface ObjectMatch {
	readonly truthIdentity: string;
	readonly detection: LocatedDetection;
	readonly truthCanonical: Point;
	readonly detectionOriginal?: Point;
	readonly truthOriginal?: Point;
	readonly deviationPx: number;
	readonly reason: string;
}

export interface TruthTarget {
	readonly identity: string;
	readonly point: Point;
}

export interface FrameOffset {
	/** canonical = original + offset; inverse subtraction restores original */
	readonly xPx: number;
	readonly yPx: number;
}

function originalPoint(point: Point, offset?: FrameOffset): Point | undefined {
	return offset ? { xPx: point.xPx - offset.xPx, yPx: point.yPx - offset.yPx } : undefined;
}

function median(values: readonly number[]): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

function compareYShift(
	id: string,
	yShiftPx: number,
	provenance: string,
	targets: readonly TruthTarget[],
	detections: readonly LocatedDetection[]
): GroundingHypothesisScore {
	const pairs = targets.flatMap((target, truthIndex) =>
		detections.map((detection, detectionIndex) => {
			const dx = detection.xPx - target.point.xPx;
			const dy = detection.yPx + yShiftPx - target.point.yPx;
			return { truthIndex, detectionIndex, dx, dy, deviationPx: Math.hypot(dx, dy) };
		})
	);
	pairs.sort(
		(a, b) =>
			a.deviationPx - b.deviationPx ||
			a.truthIndex - b.truthIndex ||
			a.detectionIndex - b.detectionIndex
	);
	const usedTruth = new Set<number>();
	const usedDetections = new Set<number>();
	const claimed: typeof pairs = [];
	for (const pair of pairs) {
		if (usedTruth.has(pair.truthIndex) || usedDetections.has(pair.detectionIndex)) continue;
		usedTruth.add(pair.truthIndex);
		usedDetections.add(pair.detectionIndex);
		claimed.push(pair);
		if (usedTruth.size === targets.length || usedDetections.size === detections.length) break;
	}
	const shiftedDetections = detections.map((detection) => ({
		...detection,
		yPx: detection.yPx + yShiftPx
	}));
	const toleranceAssociation = associateDetections(targets, shiftedDetections);
	return {
		id,
		yShiftPx,
		provenance,
		paired: claimed.length,
		matchedWithinTolerance: toleranceAssociation.matched,
		falsePositiveCount: toleranceAssociation.unownedDetections?.length ?? 0,
		falseNegativeCount: toleranceAssociation.unmatchedTruth?.length ?? 0,
		meanDeviationPx:
			claimed.reduce((sum, pair) => sum + pair.deviationPx, 0) / Math.max(1, claimed.length),
		medianDeviationPx: median(claimed.map((pair) => pair.deviationPx)),
		maxDeviationPx: claimed.reduce((max, pair) => Math.max(max, pair.deviationPx), 0),
		medianResidualXPx: median(claimed.map((pair) => pair.dx)),
		medianResidualYPx: median(claimed.map((pair) => pair.dy))
	};
}

function uniqueHypotheses(
	candidates: readonly { id: string; yShiftPx: number; provenance: string }[]
): Array<{ id: string; yShiftPx: number; provenance: string }> {
	const byShift = new Map<number, { id: string; yShiftPx: number; provenance: string }>();
	for (const candidate of candidates) {
		const existing = byShift.get(candidate.yShiftPx);
		if (existing) {
			byShift.set(candidate.yShiftPx, {
				...existing,
				id: `${existing.id}+${candidate.id}`,
				provenance: `${existing.provenance}; ${candidate.provenance}`
			});
		} else byShift.set(candidate.yShiftPx, candidate);
	}
	return [...byShift.values()];
}

/** Deterministic one-to-one nearest-available association. Unlike the old
 * per-truth nearest-neighbour loop, one detection cannot make two truth
 * objects green. Unclaimed detections remain explicit false positives. */
export function associateDetections(
	targets: readonly TruthTarget[],
	detections: readonly LocatedDetection[],
	offset?: FrameOffset
): Pick<
	GateScore,
	| 'matched'
	| 'maxDeviationPx'
	| 'misses'
	| 'objectMatches'
	| 'unownedDetections'
	| 'unmatchedTruth'
> {
	const framedDetections: LocatedDetection[] = detections.map((detection) => {
		const original = originalPoint(detection, offset);
		return { ...detection, ...(original ? { original } : {}) };
	});
	const pairs = targets.flatMap((target, truthIndex) =>
		framedDetections.map((detection, detectionIndex) => ({
			truthIndex,
			detectionIndex,
			deviationPx: dist(target.point, detection)
		}))
	);
	pairs.sort(
		(a, b) =>
			a.deviationPx - b.deviationPx ||
			a.truthIndex - b.truthIndex ||
			a.detectionIndex - b.detectionIndex
	);
	const usedTruth = new Set<number>();
	const usedDetections = new Set<number>();
	const matches: ObjectMatch[] = [];
	for (const pair of pairs) {
		if (pair.deviationPx > ASSOCIATION_TOLERANCE_PX) break;
		if (usedTruth.has(pair.truthIndex) || usedDetections.has(pair.detectionIndex)) continue;
		usedTruth.add(pair.truthIndex);
		usedDetections.add(pair.detectionIndex);
		const target = targets[pair.truthIndex];
		const detection = framedDetections[pair.detectionIndex];
		matches.push({
			truthIdentity: target.identity,
			detection,
			truthCanonical: target.point,
			...(detection.original ? { detectionOriginal: detection.original } : {}),
			...(originalPoint(target.point, offset)
				? { truthOriginal: originalPoint(target.point, offset) }
				: {}),
			deviationPx: pair.deviationPx,
			reason: `accepted: one-to-one distance ${pair.deviationPx.toFixed(2)}px <= ${ASSOCIATION_TOLERANCE_PX}px`
		});
	}
	matches.sort((a, b) => Number(a.truthIdentity.slice(1)) - Number(b.truthIdentity.slice(1)));
	return {
		matched: matches.length,
		maxDeviationPx: matches.reduce((max, match) => Math.max(max, match.deviationPx), 0),
		misses: targets
			.filter((_target, index) => !usedTruth.has(index))
			.map(
				(target) => `${target.identity}:no unclaimed detection within ${ASSOCIATION_TOLERANCE_PX}px`
			),
		objectMatches: matches,
		unownedDetections: framedDetections.filter((_detection, index) => !usedDetections.has(index)),
		unmatchedTruth: targets.filter((_target, index) => !usedTruth.has(index))
	};
}

/** G1: badge count + digit reads (badge label == hole number, per
 * scripts/chainspot-lab/invariants.ts's numbered-badge-owns-one-tee-and-
 * one-basket rule -- recorded, not silently assumed). */
function scoreG1(badges: readonly BadgeEvidence[], truth: CanonicalTruth): GateScore {
	const expectedNumbers = truth.holes.map((h) => h.number).sort((a, b) => a - b);
	const readNumbers = badges
		.map((b) => (b.label !== null ? Number(b.label) : null))
		.filter((n): n is number => n !== null && Number.isInteger(n));
	const matchedNumbers = expectedNumbers.filter((n) => readNumbers.includes(n));
	const misses = expectedNumbers
		.filter((n) => !readNumbers.includes(n))
		.map((n) => `H${n}:no-digit-read`);
	return {
		gate: 'G1',
		matched: matchedNumbers.length,
		expected: expectedNumbers.length,
		maxDeviationPx: 0,
		misses
	};
}

function basketDetections(baskets: readonly BasketEvidence[]): LocatedDetection[] {
	return baskets.map((basket) => ({
		id: basket.detId,
		spriteType: 'basket',
		identity: basket.detId,
		xPx: basket.tipXPx,
		yPx: basket.tipYPx,
		measurements: {
			identity: basket.identity ?? basket.score,
			effectiveVisibility: basket.effectiveVisibility ?? basket.onFrac,
			whiteCoverage: basket.whiteCoverage ?? basket.onFrac,
			blackBorderSupport: basket.blackBorderSupport ?? 1 - basket.offFrac,
			darkCoherence: basket.darkCoherence ?? 0,
			recovered: basket.tier === 'occlusion-recovery' ? 1 : 0
		}
	}));
}

function scoreG2(
	baskets: readonly BasketEvidence[],
	truth: CanonicalTruth,
	offset?: FrameOffset
): GateScore {
	const detections = basketDetections(baskets);
	return {
		gate: 'G2',
		expected: truth.holes.length,
		detected: detections.length,
		...associateDetections(
			truth.holes.map((hole) => ({ identity: `H${hole.number}`, point: hole.basket })),
			detections,
			offset
		)
	};
}

/**
 * Diagnostic coordinate grounding. This never changes detector output and
 * never turns an untrusted annotation into trusted truth. It executes the
 * engine once, then compares a short list of provenance-backed Y transforms
 * against the resulting evidence so a crop/anchor convention cannot hide
 * behind the inherited 26px association tolerance.
 */
export function compareTruthGrounding(
	board: ExecBoard,
	truth: CanonicalTruth,
	frameOffset: FrameOffset | undefined,
	provenanceTrusted: boolean
): GroundingComparison[] {
	const comparisons: GroundingComparison[] = [];
	if (board.has('baskets')) {
		const baskets = board.get<readonly BasketEvidence[]>('baskets');
		const detections = basketDetections(baskets);
		const targets = truth.holes.map((hole) => ({ identity: `H${hole.number}`, point: hole.basket }));
		const whiteOffsets = baskets.map(
			(basket) => basket.tipYPx - (basket.whiteBbox[1] + basket.whiteBbox[3])
		);
		const whiteOffset = median(whiteOffsets);
		const semanticOffsets = baskets.map(
			(basket) => basket.tipYPx - (basket.bbox[1] + basket.bbox[3])
		);
		const semanticOffset = median(semanticOffsets);
		const candidates = [
			{
				id: 'as-emitted',
				yShiftPx: 0,
				provenance: 'engine BasketEvidence.tipYPx unchanged'
			},
			...(frameOffset
				? [
						{
							id: 'g0-crop-reapplied',
							yShiftPx: frameOffset.yPx,
							provenance: `G0 single-source transform canonical = original + y(${frameOffset.yPx}) applied once more`
						},
						{
							id: 'g0-crop-undone',
							yShiftPx: -frameOffset.yPx,
							provenance: `inverse of G0 single-source y transform (${frameOffset.yPx})`
						}
					]
				: []),
			...(Number.isFinite(semanticOffset)
				? [
						{
							id: 'semantic-box-exclusive-bottom',
							yShiftPx: -semanticOffset,
							provenance: `median tipYPx-(semantic bboxY+bboxH)=${semanticOffset}px from engine BasketEvidence`
						},
						{
							id: 'semantic-box-last-pixel',
							yShiftPx: -semanticOffset - 1,
							provenance: `semantic exclusive-bottom hypothesis minus one raster pixel; semantic gap=${semanticOffset}px`
						}
					]
				: []),
			...(Number.isFinite(whiteOffset)
				? [
						{
							id: 'white-box-exclusive-bottom',
							yShiftPx: -whiteOffset,
							provenance: `median tipYPx-(white bboxY+bboxH)=${whiteOffset}px; detector-local geometry only`
						},
						{
							id: 'white-box-last-pixel',
							yShiftPx: -whiteOffset - 1,
							provenance: `white-component last pixel; detector-local geometry only; white gap=${whiteOffset}px`
						}
					]
				: [])
		];
		comparisons.push({
			gate: 'G2',
			detected: detections.length,
			expected: targets.length,
			provenanceTrusted,
			hypotheses: uniqueHypotheses(candidates).map((candidate) =>
				compareYShift(
					candidate.id,
					candidate.yShiftPx,
					candidate.provenance,
					targets,
					detections
				)
			)
		});
	}
	return comparisons;
}

function scoreG3(
	tees: readonly TeeEvidence[],
	truth: CanonicalTruth,
	offset?: FrameOffset
): GateScore {
	const detections: LocatedDetection[] = tees.map((tee) => ({
		id: tee.detId,
		spriteType: 'tee',
		identity: `${tee.detId}:${tee.tier}`,
		xPx: tee.xPx,
		yPx: tee.yPx,
		measurements: {
			tier: tee.tier,
			area: tee.area,
			fill: tee.fill,
			onRing: tee.onRing
		}
	}));
	return {
		gate: 'G3',
		expected: truth.holes.length,
		detected: detections.length,
		...associateDetections(
			truth.holes.map((hole) => ({ identity: `H${hole.number}`, point: hole.tee })),
			detections,
			offset
		)
	};
}

/** G4: full tee->badge->basket assignment, exact-match convention from
 * tests/unit/dashsTrackSweep.test.ts's G4 case -- both endpoints of the
 * assignment claimed for a hole's badge number must land within
 * ASSOCIATION_TOLERANCE_PX of that hole's truth. */
function scoreG4(
	measurement: ThreeFactorMeasurement,
	assignment: ThreeFactorAssignment,
	truth: CanonicalTruth
): GateScore {
	const teesById = new Map(measurement.tees.map((t) => [t.detId, t]));
	const basketsById = new Map(measurement.baskets.map((b) => [b.detId, b]));
	const badgesByLabel = new Map<number, string>();
	for (const b of measurement.badges) {
		if (b.label !== null) badgesByLabel.set(Number(b.label), b.detId);
	}

	let matched = 0;
	let maxDeviationPx = 0;
	const misses: string[] = [];
	for (const hole of truth.holes) {
		const badgeId = badgesByLabel.get(hole.number);
		const found = badgeId ? assignment.assignments.find((a) => a.badgeId === badgeId) : undefined;
		if (!found) {
			misses.push(`H${hole.number}:no-assignment`);
			continue;
		}
		const tee = teesById.get(found.teeId);
		const basket = basketsById.get(found.basketId);
		if (!tee || !basket) {
			misses.push(`H${hole.number}:dangling-ids`);
			continue;
		}
		const teeD = dist(hole.tee, tee);
		const basketD = dist(hole.basket, { xPx: basket.tipXPx, yPx: basket.tipYPx });
		const worst = Math.max(teeD, basketD);
		if (teeD <= ASSOCIATION_TOLERANCE_PX && basketD <= ASSOCIATION_TOLERANCE_PX) {
			matched++;
			if (worst > maxDeviationPx) maxDeviationPx = worst;
		} else {
			misses.push(`H${hole.number}:tee=${teeD.toFixed(1)}px,basket=${basketD.toFixed(1)}px`);
		}
	}
	return { gate: 'G4', matched, expected: truth.holes.length, maxDeviationPx, misses };
}

/** Reads 'measurement' and 'assignment' straight off the board
 * executeCompiledPlan just ran against -- the algorithm's own final
 * output, not a recomputation. G5 (path) has no frozen ground truth in the
 * Annotation schema (corridorBends are unvalidated -- see
 * tests/unit/dashsTrackSweep.test.ts's header), so it is not scored here,
 * matching that suite's test.todo rather than fabricating an assertion. */
export function scoreTruth(
	board: ExecBoard,
	truth: CanonicalTruth,
	frameOffset?: FrameOffset
): TruthScoreboard {
	const scores: GateScore[] = [];
	if (board.has('badges'))
		scores.push(scoreG1(board.get<readonly BadgeEvidence[]>('badges'), truth));
	if (board.has('baskets')) {
		scores.push(scoreG2(board.get<readonly BasketEvidence[]>('baskets'), truth, frameOffset));
	}
	if (board.has('tees')) {
		scores.push(scoreG3(board.get<readonly TeeEvidence[]>('tees'), truth, frameOffset));
	}
	if (board.has('measurement') && board.has('assignment')) {
		const measurement = board.get<ThreeFactorMeasurement>('measurement');
		const assignment = board.get<ThreeFactorAssignment>('assignment');
		scores.push(scoreG4(measurement, assignment, truth));
	}
	return {
		expectedHoles: truth.holes.length,
		scores
	};
}

function pointText(point: Point | undefined): string {
	return point ? `(${point.xPx.toFixed(2)},${point.yPx.toFixed(2)})` : 'UNKNOWN';
}

function measurementsText(values: Readonly<Record<string, string | number | boolean>>): string {
	return Object.entries(values)
		.map(([key, value]) => `${key}=${typeof value === 'number' ? Number(value.toFixed(4)) : value}`)
		.join(',');
}

export function printScoreboard(board: TruthScoreboard): void {
	console.log(
		`--- Truth scoreboard (${ASSOCIATION_TOLERANCE_PX}px association tolerance, ${board.expectedHoles} holes expected) ---`
	);
	for (const s of board.scores) {
		const ok = s.matched === s.expected ? 'OK' : 'MISS';
		console.log(
			`  ${s.gate}: ${s.matched}/${s.expected} matched [${ok}]${
				s.detected === undefined
					? ''
					: ` detected=${s.detected} falsePositives=${s.unownedDetections?.length ?? 0} falseNegatives=${s.misses.length}`
			} maxDeviation=${s.maxDeviationPx.toFixed(2)}px`
		);
		if (s.misses.length > 0) console.log(`       misses: ${s.misses.join(' ')}`);
		for (const match of s.objectMatches ?? []) {
			console.log(
				`       ${match.truthIdentity} ${match.detection.spriteType} ${match.detection.identity} DETECTED ` +
					`canonical=${pointText(match.detection)} original=${pointText(match.detectionOriginal)} ` +
					`truthCanonical=${pointText(match.truthCanonical)} truthOriginal=${pointText(match.truthOriginal)} ` +
					`delta=${match.deviationPx.toFixed(2)}px measurements=[${measurementsText(match.detection.measurements)}] reason="${match.reason}"`
			);
		}
		for (const detection of s.unownedDetections ?? []) {
			console.log(
				`       FALSE_POSITIVE ${detection.spriteType} ${detection.identity} DETECTED canonical=${pointText(detection)} ` +
					`original=${pointText(detection.original)} measurements=[${measurementsText(detection.measurements)}] ` +
					`ownership=UNKNOWN reason="rejected by truth association: no unclaimed truth object within ${ASSOCIATION_TOLERANCE_PX}px"`
			);
		}
	}
}

export function printGroundingComparisons(comparisons: readonly GroundingComparison[]): void {
	for (const comparison of comparisons) {
		console.log(
			`--- ${comparison.gate} grounding hypotheses (${comparison.detected} detected / ${comparison.expected} annotation objects; ` +
				`${comparison.provenanceTrusted ? 'source provenance MATCHED' : 'DIAGNOSTIC ONLY -- source provenance UNMATCHED'}) ---`
		);
		const ranked = [...comparison.hypotheses].sort(
			(a, b) =>
				a.medianDeviationPx - b.medianDeviationPx ||
				a.meanDeviationPx - b.meanDeviationPx ||
				a.yShiftPx - b.yShiftPx
		);
		for (const [index, hypothesis] of ranked.entries()) {
			console.log(
				`  ${index === 0 ? 'LOWEST_RESIDUAL ' : '                '}${hypothesis.id}: detectionY += ${hypothesis.yShiftPx}px ` +
				`paired=${hypothesis.paired} matched=${hypothesis.matchedWithinTolerance} ` +
				`falsePositives=${hypothesis.falsePositiveCount} falseNegatives=${hypothesis.falseNegativeCount} ` +
				`median=${hypothesis.medianDeviationPx.toFixed(2)}px ` +
				`mean=${hypothesis.meanDeviationPx.toFixed(2)}px max=${hypothesis.maxDeviationPx.toFixed(2)}px ` +
				`medianResidual=(${hypothesis.medianResidualXPx.toFixed(2)},${hypothesis.medianResidualYPx.toFixed(2)})px`
			);
			console.log(`         provenance: ${hypothesis.provenance}`);
		}
		console.log(
			'  NOTE: hypotheses alter evaluation coordinates only; engine detections and ownership are unchanged.'
		);
	}
}
