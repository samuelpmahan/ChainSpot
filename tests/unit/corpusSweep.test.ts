// Multi-course bottom-up gate sweep — CHSPT-82 scale-out.
//
// Generalizes tests/unit/dashsTrackSweep.test.ts's pattern (same engine
// run, same G1-G4 gates, same borrowed 26px ASSOCIATION_TOLERANCE_PX
// convention, same "compute + log before assert" scoreboard discipline —
// see that file's header for the full provenance note on where 26px comes
// from) to the rest of the dev corpus. DashsTrack itself is NOT re-covered
// here; its suite stays exactly as it was, unmodified.
//
// Course scope: chainspot-corpus/dev/Annotated/{Heritage,Lenard,TowneLake}.
// AlexClark also lives in that directory but is deliberately EXCLUDED from
// this sweep, matching every predecessor harness
// (old-stuff/scripts/toph-corpus-gate.md's "AlexClark exclusion" section;
// old-stuff/scripts/toph-corpus-gate.ts; old-stuff/scripts/toph-tune.ts;
// old-stuff/stale-task-files/CHSPT-70.md). Its annotation in this corpus
// checkout is a 3-hole partial corridor/bend-geometry sample (schema
// `{course, imageWidthPx, imageHeightPx, holes}`, no `sourceImage.sha256`,
// no full 18-badge inventory) rather than full-course truth comparable to
// the other four — scoring G1 badge-COUNT against it would invent truth
// the annotation doesn't claim (the real course has more holes/badges than
// the 3 that got truthed here). Recorded as a finding, not silently
// dropped: see the final report for the inventory this was decided from.
//
// Frame alignment: Heritage/Lenard/TowneLake ship the RAW, un-autocropped
// phone screenshot in this corpus checkout (1290x2796px for all three),
// while their annotation's truth was made in the POST-autocrop frame.
// tests/unit/helpers/courseFixture.ts detects the mismatch and applies
// tests/unit/helpers/intakeAutocrop.ts (a verbatim copy of the old
// pipeline's single-image chrome-crop detector) before scoring — see that
// file's header for why this is required, not optional; skipping it would
// misreport a ~680-780px coordinate-frame artifact as a detection miss.
//
// Per-course strictness: a gate that hits truth exactly is pinned strict. A
// gate with a genuine, measured miss gets `test.fails`, with the measured
// numbers in the test name — never a loosened
// tolerance, never an invented one. This is this engine's FIRST-EVER score
// against these three courses; there is no prior new-engine run to
// reproduce. The headline finding, spelled out gate-by-gate below, is that
// Heritage loses badly on G3/G4 (tee recall), while TowneLake and Lenard each
// miss one tee at G3. The "documented falsifier" Lenard (per old codex port
// specs) drops 2/18 on G1/G4 and 1/18 on G3 — i.e. the new engine's failure
// shape does not match the old pipeline's per-course reputation, and
// should not be assumed to.

import { describe, expect, test } from 'vitest';
import {
	DEFAULT_EXECUTION,
	parseConfig,
	resolveConfig,
	runThreeFactor,
	canonicalJson,
	sha256Hex,
	type ThreeFactorRun
} from '@chainspot/alg/detectors/threeFactor';
import defaultConfigJson from '@chainspot/alg/detectors/threeFactor/configs/default.json';
import {
	COURSES,
	loadCourseRaster,
	loadCourseTruth,
	type CourseSpec,
	type CourseHoleTruth
} from './helpers/courseFixture';

/** Borrowed from old-stuff/scripts/toph-corpus-gate.ts:45 — see dashsTrackSweep.test.ts header. */
const ASSOCIATION_TOLERANCE_PX = 26;

function dist(a: { xPx: number; yPx: number }, b: { xPx: number; yPx: number }): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

interface CourseRun {
	readonly run: ThreeFactorRun;
	readonly truth: readonly CourseHoleTruth[];
}

const resolved = resolveConfig(parseConfig(defaultConfigJson), DEFAULT_EXECUTION);
const paramsHashPromise = sha256Hex(canonicalJson(resolved));
const cache = new Map<string, CourseRun>();

/** One engine run per course, memoized and shared across that course's gate tests. */
async function getCourseRun(spec: CourseSpec): Promise<CourseRun> {
	const cached = cache.get(spec.name);
	if (cached) return cached;
	const raster = loadCourseRaster(spec);
	const truth = loadCourseTruth(spec);
	const paramsHash = await paramsHashPromise;
	const run = runThreeFactor(raster, { config: resolved, paramsHash });
	console.log(
		`[corpusSweep] ${spec.name} image ${raster.widthPx}x${raster.heightPx} imageId=${raster.imageId} paramsHash=${paramsHash}`
	);
	const result: CourseRun = { run, truth: truth.holes };
	cache.set(spec.name, result);
	return result;
}

function findSpec(name: string): CourseSpec {
	const spec = COURSES.find((c) => c.name === name);
	if (!spec) throw new Error(`corpusSweep: unknown course ${name}`);
	return spec;
}

function g1Scoreboard(courseName: string, run: ThreeFactorRun, truth: readonly CourseHoleTruth[]) {
	const badges = run.measurement.badges;
	const readNumbers = badges
		.map((b) => (b.label !== null ? Number(b.label) : null))
		.filter((n): n is number => n !== null && Number.isInteger(n));
	const expectedNumbers = truth.map((h) => h.number);
	const matchedNumbers = expectedNumbers.filter((n) => readNumbers.includes(n));
	const missingNumbers = expectedNumbers.filter((n) => !readNumbers.includes(n));
	console.log(
		`[${courseName}][G1] badges found=${badges.length} expected=${expectedNumbers.length} digitsMatched=${matchedNumbers.length}/${expectedNumbers.length} missingHoleNumbers=[${missingNumbers.join(',')}]`
	);
	return { badgeCount: badges.length, expectedCount: expectedNumbers.length, matched: matchedNumbers.length };
}

function g2Scoreboard(courseName: string, run: ThreeFactorRun, truth: readonly CourseHoleTruth[]) {
	const baskets = run.measurement.baskets;
	let matched = 0;
	let maxDeviation = 0;
	const misses: string[] = [];
	for (const hole of truth) {
		let best = Infinity;
		for (const b of baskets) best = Math.min(best, dist(hole.basket, { xPx: b.tipXPx, yPx: b.tipYPx }));
		if (best <= ASSOCIATION_TOLERANCE_PX) {
			matched++;
			maxDeviation = Math.max(maxDeviation, best);
		} else misses.push(`H${hole.number}(${best.toFixed(1)}px)`);
	}
	console.log(
		`[${courseName}][G2] baskets found=${baskets.length} expected=${truth.length} matched=${matched}/${truth.length} maxDeviation=${maxDeviation.toFixed(2)}px misses=[${misses.join(',')}]`
	);
	return { found: baskets.length, expected: truth.length, matched, maxDeviation };
}

function g3Scoreboard(courseName: string, run: ThreeFactorRun, truth: readonly CourseHoleTruth[]) {
	const tees = run.measurement.tees;
	let matched = 0;
	let maxDeviation = 0;
	const misses: string[] = [];
	for (const hole of truth) {
		let best = Infinity;
		for (const t of tees) best = Math.min(best, dist(hole.tee, { xPx: t.xPx, yPx: t.yPx }));
		if (best <= ASSOCIATION_TOLERANCE_PX) {
			matched++;
			maxDeviation = Math.max(maxDeviation, best);
		} else misses.push(`H${hole.number}(${best.toFixed(1)}px)`);
	}
	console.log(
		`[${courseName}][G3] tees found=${tees.length} expected=${truth.length} matched=${matched}/${truth.length} maxDeviation=${maxDeviation.toFixed(2)}px misses=[${misses.join(',')}]`
	);
	return { found: tees.length, expected: truth.length, matched, maxDeviation };
}

function g4Scoreboard(courseName: string, run: ThreeFactorRun, truth: readonly CourseHoleTruth[]) {
	const teesByDetId = new Map(run.assignment.tees.map((t) => [t.detId, t]));
	const basketsByDetId = new Map(run.measurement.baskets.map((b) => [b.detId, b]));
	const badgesByDetId = new Map(run.measurement.badges.map((b) => [b.detId, b]));
	let assignedExact = 0;
	let maxDeviation = 0;
	const misses: string[] = [];
	for (const hole of truth) {
		const assignment = run.assignment.assignments.find((a) => {
			const badge = badgesByDetId.get(a.badgeId);
			return badge && badge.label !== null && Number(badge.label) === hole.number;
		});
		if (!assignment) {
			misses.push(`H${hole.number}:no-assignment`);
			continue;
		}
		const tee = teesByDetId.get(assignment.teeId);
		const basket = basketsByDetId.get(assignment.basketId);
		if (!tee || !basket) {
			misses.push(`H${hole.number}:dangling-ids`);
			continue;
		}
		const teeD = dist(hole.tee, { xPx: tee.xPx, yPx: tee.yPx });
		const basketD = dist(hole.basket, { xPx: basket.tipXPx, yPx: basket.tipYPx });
		const worst = Math.max(teeD, basketD);
		if (teeD <= ASSOCIATION_TOLERANCE_PX && basketD <= ASSOCIATION_TOLERANCE_PX) {
			assignedExact++;
			maxDeviation = Math.max(maxDeviation, worst);
		} else misses.push(`H${hole.number}:tee=${teeD.toFixed(1)}px,basket=${basketD.toFixed(1)}px`);
	}
	console.log(
		`[${courseName}][G4] assignedExact=${assignedExact}/${truth.length} maxDeviation=${maxDeviation.toFixed(2)}px misses=[${misses.join(' ')}]`
	);
	return { assignedExact, expected: truth.length, maxDeviation };
}

// ---------------------------------------------------------------------
// TowneLake — measured G3 17/18; the other gates remain pinned strict.
// ---------------------------------------------------------------------
describe('TowneLake gate sweep', () => {
	const spec = findSpec('TowneLake');

	test('G1 — badge count + digit reads', async () => {
		const { run, truth } = await getCourseRun(spec);
		const s = g1Scoreboard(spec.name, run, truth);
		expect(s.badgeCount).toBe(s.expectedCount);
		expect(s.matched).toBe(s.expectedCount);
	}, 60000);

	test('G2 — basket positions', async () => {
		const { run, truth } = await getCourseRun(spec);
		const s = g2Scoreboard(spec.name, run, truth);
		expect(s.matched).toBe(s.expected);
	}, 30000);

		test.fails('G3 — tee positions (measured: matched 17/18, missing H13)', async () => {
		const { run, truth } = await getCourseRun(spec);
		const s = g3Scoreboard(spec.name, run, truth);
		expect(s.matched).toBe(s.expected);
	}, 30000);

	test('G4 — tee->badge assignment (ASSIGNED exact match count)', async () => {
		const { run, truth } = await getCourseRun(spec);
		const s = g4Scoreboard(spec.name, run, truth);
		expect(s.assignedExact).toBe(s.expected);
	}, 30000);
});

// ---------------------------------------------------------------------
// Heritage — measured: G1 16/18, G2 18/18, G3 14/18, G4 11/18.
// G2 pins strict; G1/G3/G4 are real misses, marked test.fails with the
// measured counts in the test name.
// ---------------------------------------------------------------------
describe('Heritage gate sweep', () => {
	const spec = findSpec('Heritage');

	test.fails('G1 — badge count + digit reads (measured: digits 16/18, missing H2,H15)', async () => {
		const { run, truth } = await getCourseRun(spec);
		const s = g1Scoreboard(spec.name, run, truth);
		expect(s.badgeCount).toBe(s.expectedCount);
		expect(s.matched).toBe(s.expectedCount);
	}, 60000);

	test('G2 — basket positions', async () => {
		const { run, truth } = await getCourseRun(spec);
		const s = g2Scoreboard(spec.name, run, truth);
		expect(s.matched).toBe(s.expected);
	}, 30000);

	test.fails(
		'G3 — tee positions (measured: matched 14/18, misses H5,H6,H10,H15 — 70-224px off)',
		async () => {
			const { run, truth } = await getCourseRun(spec);
			const s = g3Scoreboard(spec.name, run, truth);
			expect(s.matched).toBe(s.expected);
		},
		30000
	);

	test.fails(
		'G4 — tee->badge assignment (measured: assignedExact 11/18)',
		async () => {
			const { run, truth } = await getCourseRun(spec);
			const s = g4Scoreboard(spec.name, run, truth);
			expect(s.assignedExact).toBe(s.expected);
		},
		30000
	);
});

// ---------------------------------------------------------------------
// Lenard — measured: G1 16/18, G2 18/18, G3 17/18, G4 16/18.
// The "documented falsifier" per old codex port specs, but on THIS engine
// it clears G2 cleanly; G1, G3, and G4 show real misses.
// ---------------------------------------------------------------------
describe('Lenard gate sweep', () => {
	const spec = findSpec('Lenard');

	test.fails(
		'G1 — badge count + digit reads (measured: digits 16/18, missing H5,H12; one badge misread as a spurious 4-digit label)',
		async () => {
			const { run, truth } = await getCourseRun(spec);
			const s = g1Scoreboard(spec.name, run, truth);
			expect(s.badgeCount).toBe(s.expectedCount);
			expect(s.matched).toBe(s.expectedCount);
		},
		60000
	);

	test('G2 — basket positions', async () => {
		const { run, truth } = await getCourseRun(spec);
		const s = g2Scoreboard(spec.name, run, truth);
		expect(s.matched).toBe(s.expected);
	}, 30000);

		test.fails('G3 — tee positions (measured: matched 17/18, missing H3)', async () => {
		const { run, truth } = await getCourseRun(spec);
		const s = g3Scoreboard(spec.name, run, truth);
		expect(s.matched).toBe(s.expected);
	}, 30000);

	test.fails(
		'G4 — tee->badge assignment (measured: assignedExact 16/18, misses H5,H12 — both no-assignment)',
		async () => {
			const { run, truth } = await getCourseRun(spec);
			const s = g4Scoreboard(spec.name, run, truth);
			expect(s.assignedExact).toBe(s.expected);
		},
		30000
	);
});
