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
import type { ThreeFactorMeasurement, ThreeFactorAssignment } from '@chainspot/alg/detectors/threeFactor/types';

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
	readonly maxDeviationPx: number;
	readonly misses: readonly string[];
}

export interface TruthScoreboard {
	readonly expectedHoles: number;
	readonly scores: readonly GateScore[];
}

interface Point {
	readonly xPx: number;
	readonly yPx: number;
}

function bestMatch(target: Point, candidates: readonly Point[]): number {
	let best = Infinity;
	for (const c of candidates) {
		const d = dist(target, c);
		if (d < best) best = d;
	}
	return best;
}

/** G1: badge count + digit reads (badge label == hole number, per
 * scripts/chainspot-lab/invariants.ts's numbered-badge-owns-one-tee-and-
 * one-basket rule -- recorded, not silently assumed). */
function scoreG1(measurement: ThreeFactorMeasurement, truth: CanonicalTruth): GateScore {
	const expectedNumbers = truth.holes.map((h) => h.number).sort((a, b) => a - b);
	const readNumbers = measurement.badges
		.map((b) => (b.label !== null ? Number(b.label) : null))
		.filter((n): n is number => n !== null && Number.isInteger(n));
	const matchedNumbers = expectedNumbers.filter((n) => readNumbers.includes(n));
	const misses = expectedNumbers.filter((n) => !readNumbers.includes(n)).map((n) => `H${n}:no-digit-read`);
	return { gate: 'G1', matched: matchedNumbers.length, expected: expectedNumbers.length, maxDeviationPx: 0, misses };
}

function scoreG2(measurement: ThreeFactorMeasurement, truth: CanonicalTruth): GateScore {
	let matched = 0;
	let maxDeviationPx = 0;
	const misses: string[] = [];
	const candidates = measurement.baskets.map((b) => ({ xPx: b.tipXPx, yPx: b.tipYPx }));
	for (const hole of truth.holes) {
		const d = bestMatch(hole.basket, candidates);
		if (d <= ASSOCIATION_TOLERANCE_PX) {
			matched++;
			if (d > maxDeviationPx) maxDeviationPx = d;
		} else {
			misses.push(`H${hole.number}:${d === Infinity ? 'no-baskets' : `${d.toFixed(1)}px`}`);
		}
	}
	return { gate: 'G2', matched, expected: truth.holes.length, maxDeviationPx, misses };
}

function scoreG3(measurement: ThreeFactorMeasurement, truth: CanonicalTruth): GateScore {
	let matched = 0;
	let maxDeviationPx = 0;
	const misses: string[] = [];
	const candidates = measurement.tees.map((t) => ({ xPx: t.xPx, yPx: t.yPx }));
	for (const hole of truth.holes) {
		const d = bestMatch(hole.tee, candidates);
		if (d <= ASSOCIATION_TOLERANCE_PX) {
			matched++;
			if (d > maxDeviationPx) maxDeviationPx = d;
		} else {
			misses.push(`H${hole.number}:${d === Infinity ? 'no-tees' : `${d.toFixed(1)}px`}`);
		}
	}
	return { gate: 'G3', matched, expected: truth.holes.length, maxDeviationPx, misses };
}

/** G4: full tee->badge->basket assignment, exact-match convention from
 * tests/unit/dashsTrackSweep.test.ts's G4 case -- both endpoints of the
 * assignment claimed for a hole's badge number must land within
 * ASSOCIATION_TOLERANCE_PX of that hole's truth. */
function scoreG4(measurement: ThreeFactorMeasurement, assignment: ThreeFactorAssignment, truth: CanonicalTruth): GateScore {
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
export function scoreTruth(board: ExecBoard, truth: CanonicalTruth): TruthScoreboard {
	const measurement = board.get<ThreeFactorMeasurement>('measurement');
	const assignment = board.get<ThreeFactorAssignment>('assignment');
	return {
		expectedHoles: truth.holes.length,
		scores: [scoreG1(measurement, truth), scoreG2(measurement, truth), scoreG3(measurement, truth), scoreG4(measurement, assignment, truth)]
	};
}

export function printScoreboard(board: TruthScoreboard): void {
	console.log(`--- Truth scoreboard (${ASSOCIATION_TOLERANCE_PX}px association tolerance, ${board.expectedHoles} holes expected) ---`);
	for (const s of board.scores) {
		const ok = s.matched === s.expected ? 'OK' : 'MISS';
		console.log(`  ${s.gate}: ${s.matched}/${s.expected} matched [${ok}] maxDeviation=${s.maxDeviationPx.toFixed(2)}px`);
		if (s.misses.length > 0) console.log(`       misses: ${s.misses.join(' ')}`);
	}
}
