// DashsTrack bottom-up gate sweep — CHSPT-82.
//
// This is the NEW threeFactor engine's FIRST-EVER scoring run against
// DashsTrack's frozen corpus truth. There is no prior "dev72 replay" of
// this engine to reproduce: the historical "DashsTrack exactly 18/18
// t18/18 b18/18" and "26px association tolerance" figures come from the
// OLD pre-rebuild pipeline (`old-stuff/scripts/pancake-harness.ts` +
// `old-stuff/scripts/toph-corpus-gate.ts`, driving
// `src/lib/autoAnnotation/basketDetection.worker.ts` /
// `src/lib/nuthing/*`), not from this engine (`src/lib/detectors/threeFactor`).
// `scripts/chainspot-lab/README.md` documents that the LAB's own replay
// harnesses for the new tree (`orient.ts`, `gate2.ts`, `gate3.ts`) are not
// ported here. This suite reuses the OLD pipeline's evidence as two things
// only, both explicitly borrowed, neither assumed to still hold:
//   - the 26px `ASSOCIATION_TOLERANCE_PX` matching tolerance convention
//     (`old-stuff/scripts/toph-corpus-gate.ts:45`)
//   - the frozen ground truth itself (tee/basket pixel positions, hole
//     numbers) from `chainspot-corpus/dev/DashsTrack/DashsTrack-full.annotation.json`
//
// If the new engine misses 18/18 within 26px, that is this exercise's
// headline finding, not a bug in the test — the per-gate structure below
// exists to localize where the loss happens. A gate assertion that is
// TRUE-BUT-FAILING against measured reality is marked `test.fails` (not
// loosened, not skipped silently) so CI communicates a known gap instead
// of blocking on it, with the actual measured numbers left in a comment
// next to the assertion.
//
// G1 badge-digit truth: the annotation records `holes[i].number` per hole,
// not a separately-annotated badge digit. Using it as digit truth relies
// on `scripts/chainspot-lab/invariants.ts` (~line 485): "Within the
// current 18-hole assignment model, each numbered badge owns one tee and
// one basket" — i.e. badge digit == hole number by construction for this
// course. Recorded here, not silently assumed.
//
// G5 (path): the annotation's `corridorBends` are not validated path
// ground truth (`scripts/chainspot-lab/cases.ts` flags DashsTrack H4-H6
// density as an open question), so G5 gets `test.todo` only — no
// fabricated assertion.

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
import { loadDashsTrackRaster, loadDashsTrackTruth } from './helpers/dashsTrackFixture';

/** Borrowed from old-stuff/scripts/toph-corpus-gate.ts:45 — see file header note. */
const ASSOCIATION_TOLERANCE_PX = 26;

function dist(a: { xPx: number; yPx: number }, b: { xPx: number; yPx: number }): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

// --- one shared run, computed once, used by every gate test below ---

const raster = loadDashsTrackRaster();
const truth = loadDashsTrackTruth();
const resolved = resolveConfig(parseConfig(defaultConfigJson), DEFAULT_EXECUTION);
const paramsHashPromise = sha256Hex(canonicalJson(resolved));

let run: ThreeFactorRun;
let paramsHash: string;

async function getRun(): Promise<{ run: ThreeFactorRun; paramsHash: string }> {
	if (!run) {
		paramsHash = await paramsHashPromise;
		run = runThreeFactor(raster, { config: resolved, paramsHash });
		console.log(
			`[dashsTrackSweep] image ${raster.widthPx}x${raster.heightPx} imageId=${raster.imageId} paramsHash=${paramsHash}`
		);
	}
	return { run, paramsHash };
}

describe('DashsTrack bottom-up gate sweep (deterministic E2E vs frozen truth)', () => {
	// The engine run against the real 1290x2091 photo is expensive; it only
	// happens once (memoized in getRun()) but the first test to call it pays
	// the full cost, so it needs a longer-than-default timeout.
	test('G1 — badge count + digit reads', async () => {
		const { run: r } = await getRun();
		const badges = r.measurement.badges;
		const expectedCount = truth.holes.length;
		const readNumbers = badges
			.map((b) => (b.label !== null ? Number(b.label) : null))
			.filter((n): n is number => n !== null && Number.isInteger(n))
			.sort((a, b) => a - b);
		const expectedNumbers = truth.holes.map((h) => h.number).sort((a, b) => a - b);
		const matchedNumbers = expectedNumbers.filter((n) => readNumbers.includes(n));

		console.log(
			`[G1] badges found=${badges.length} expected=${expectedCount} | digits read=${readNumbers.length}/${expectedCount} matched=${matchedNumbers.length}/${expectedCount}`
		);

		expect(badges.length).toBe(expectedCount);
		expect(matchedNumbers.length).toBe(expectedCount);
	}, 60000);

	test('G2 — basket positions', async () => {
		const { run: r } = await getRun();
		const baskets = r.measurement.baskets;
		const truthBaskets = truth.holes.map((h) => h.basket);

		let matched = 0;
		let maxDeviation = 0;
		const unmatchedTruth: number[] = [];
		for (const hole of truth.holes) {
			let best = Infinity;
			for (const b of baskets) {
				const d = dist(hole.basket, { xPx: b.tipXPx, yPx: b.tipYPx });
				if (d < best) best = d;
			}
			if (best <= ASSOCIATION_TOLERANCE_PX) {
				matched++;
				if (best > maxDeviation) maxDeviation = best;
			} else {
				unmatchedTruth.push(hole.number);
			}
		}

		console.log(
			`[G2] baskets found=${baskets.length} expected=${truthBaskets.length} | matched within ${ASSOCIATION_TOLERANCE_PX}px=${matched}/${truthBaskets.length} maxDeviation=${maxDeviation.toFixed(2)}px unmatchedHoles=[${unmatchedTruth.join(',')}]`
		);

		expect(matched).toBe(truthBaskets.length);
	}, 30000);

	test('G3 — tee positions', async () => {
		const { run: r } = await getRun();
		const tees = r.measurement.tees;
		const truthTees = truth.holes.map((h) => h.tee);

		let matched = 0;
		let maxDeviation = 0;
		const unmatchedTruth: number[] = [];
		for (const hole of truth.holes) {
			let best = Infinity;
			for (const t of tees) {
				const d = dist(hole.tee, { xPx: t.xPx, yPx: t.yPx });
				if (d < best) best = d;
			}
			if (best <= ASSOCIATION_TOLERANCE_PX) {
				matched++;
				if (best > maxDeviation) maxDeviation = best;
			} else {
				unmatchedTruth.push(hole.number);
			}
		}

		console.log(
			`[G3] tees found=${tees.length} expected=${truthTees.length} | matched within ${ASSOCIATION_TOLERANCE_PX}px=${matched}/${truthTees.length} maxDeviation=${maxDeviation.toFixed(2)}px unmatchedHoles=[${unmatchedTruth.join(',')}]`
		);

		expect(matched).toBe(truthTees.length);
	}, 30000);

	// G4's assertion is structured to compute + log BEFORE asserting, so the
	// scoreboard line always prints even when the final assert fails/xfails.
	test('G4 — tee->badge assignment (ASSIGNED exact match count)', async () => {
		const { run: r } = await getRun();
		const assignments = r.assignment.assignments;
		const teesByDetId = new Map(r.assignment.tees.map((t) => [t.detId, t]));
		const basketsByDetId = new Map(r.measurement.baskets.map((b) => [b.detId, b]));
		const badgesByDetId = new Map(r.measurement.badges.map((b) => [b.detId, b]));

		let assignedExact = 0;
		let maxDeviation = 0;
		const misses: string[] = [];
		for (const hole of truth.holes) {
			const assignment = assignments.find((a) => {
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
				if (worst > maxDeviation) maxDeviation = worst;
			} else {
				misses.push(`H${hole.number}:tee=${teeD.toFixed(1)}px,basket=${basketD.toFixed(1)}px`);
			}
		}

		// Scoreboard prints unconditionally, before the assert can throw.
		console.log(
			`[G4] ASSIGNED exact=${assignedExact}/${truth.holes.length} maxDeviation=${maxDeviation.toFixed(2)}px | misses=[${misses.join(' ')}]`
		);

		expect(assignedExact).toBe(truth.holes.length);
	}, 30000);

	test.todo(
		'G5 — path truth (no frozen ground truth exists: corridorBends in the ' +
			'annotation are not validated path truth; scripts/chainspot-lab/cases.ts ' +
			'flags DashsTrack H4-H6 renderer density as an open, unproven question)'
	);
});
