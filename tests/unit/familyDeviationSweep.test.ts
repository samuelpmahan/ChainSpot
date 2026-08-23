// Family-deviation observational sweep — CHSPT-82 ('add them family shits
// and lets see').
//
// Runs all 4 in-scope courses (DashsTrack, Heritage, Lenard, TowneLake)
// under TWO configs and prints their G1-G4 scoreboards side by side:
//   - default.json            (same frozen baseline scored elsewhere)
//   - family-on.json          (NEW this pass: cleanBasketFamily + teeFamily
//                              both enabled, everything else default —
//                              see src/lib/detectors/threeFactor/configs/
//                              family-on.json's own note for the exact
//                              execution/gate wiring, combined from the
//                              existing single-feature clean-basket-
//                              family-on.json and tee-family-on.json)
//
// This file is PURELY OBSERVATIONAL — no expect() on gate counts, for
// either config. The strict default-config pins already live in
// tests/unit/dashsTrackSweep.test.ts and tests/unit/corpusSweep.test.ts and
// are NOT duplicated or re-asserted here, so there is exactly one place
// each pin can drift. This file only logs + renders evidence images so the
// family-on question can be answered with real numbers and pictures,
// without committing to a tolerance or pass/fail bar for it this pass.
//
// Evidence images: one PNG per course per config, written to
// artifacts/sweep/<RUN_LABEL>/ (gitignored, never committed — see
// tests/unit/helpers/sweepRender.ts for the drawing code and legend, and
// the final report for the legend written out in prose). Rendering is a
// pure function of each run's measurement/assignment output; nothing here
// touches Date/random, so the same engine output always produces the same
// PNG bytes.

import { describe, test } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	DEFAULT_EXECUTION,
	parseConfig,
	resolveConfig,
	runThreeFactor,
	canonicalJson,
	sha256Hex,
	type ThreeFactorRun
} from '$lib/detectors/threeFactor';
import defaultConfigJson from '$lib/detectors/threeFactor/configs/default.json';
import familyOnConfigJson from '$lib/detectors/threeFactor/configs/family-on.json';
import {
	COURSES,
	DASHSTRACK_VIA_ANNOTATED,
	loadCourseRaster,
	loadCourseTruth,
	type CourseSpec,
	type CourseHoleTruth
} from './helpers/courseFixture';
import { renderSweepEvidencePng, type EvidenceHole, type Point } from './helpers/sweepRender';

const ASSOCIATION_TOLERANCE_PX = 26;
const RUN_LABEL = 'chspt-82-family-deviation';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS_DIR = resolve(HERE, '../../artifacts/sweep', RUN_LABEL);

function dist(a: Point, b: Point): number {
	return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
}

interface GateScoreboard {
	readonly badges: { found: number; expected: number; digitsMatched: number };
	readonly baskets: { found: number; expected: number; matched: number; maxDeviation: number };
	readonly tees: { found: number; expected: number; matched: number; maxDeviation: number };
	readonly assignment: { assignedExact: number; expected: number; maxDeviation: number };
	readonly evidenceHoles: readonly EvidenceHole[];
	readonly extraTees: readonly Point[];
	readonly extraBaskets: readonly Point[];
}

function scoreRun(run: ThreeFactorRun, truth: readonly CourseHoleTruth[]): GateScoreboard {
	const badges = run.measurement.badges;
	const readNumbers = badges
		.map((b) => (b.label !== null ? Number(b.label) : null))
		.filter((n): n is number => n !== null && Number.isInteger(n));
	const digitsMatched = truth.map((h) => h.number).filter((n) => readNumbers.includes(n)).length;

	const baskets = run.measurement.baskets;
	const tees = run.measurement.tees;

	const evidenceHoles: EvidenceHole[] = [];
	let basketMatched = 0;
	let basketMaxDev = 0;
	let teeMatched = 0;
	let teeMaxDev = 0;
	const usedBasketDetIds = new Set<string>();
	const usedTeeDetIds = new Set<string>();

	for (const hole of truth) {
		let bestBasket: { b: (typeof baskets)[number]; d: number } | null = null;
		for (const b of baskets) {
			const d = dist(hole.basket, { xPx: b.tipXPx, yPx: b.tipYPx });
			if (!bestBasket || d < bestBasket.d) bestBasket = { b, d };
		}
		const matchedBasket = bestBasket && bestBasket.d <= ASSOCIATION_TOLERANCE_PX ? bestBasket : null;
		if (matchedBasket) {
			basketMatched++;
			basketMaxDev = Math.max(basketMaxDev, matchedBasket.d);
			usedBasketDetIds.add(matchedBasket.b.detId);
		}

		let bestTee: { t: (typeof tees)[number]; d: number } | null = null;
		for (const t of tees) {
			const d = dist(hole.tee, { xPx: t.xPx, yPx: t.yPx });
			if (!bestTee || d < bestTee.d) bestTee = { t, d };
		}
		const matchedTee = bestTee && bestTee.d <= ASSOCIATION_TOLERANCE_PX ? bestTee : null;
		if (matchedTee) {
			teeMatched++;
			teeMaxDev = Math.max(teeMaxDev, matchedTee.d);
			usedTeeDetIds.add(matchedTee.t.detId);
		}

		evidenceHoles.push({
			number: hole.number,
			truthTee: hole.tee,
			truthBasket: hole.basket,
			matchedTee: matchedTee ? { xPx: matchedTee.t.xPx, yPx: matchedTee.t.yPx } : null,
			matchedBasket: matchedBasket ? { xPx: matchedBasket.b.tipXPx, yPx: matchedBasket.b.tipYPx } : null
		});
	}

	// A detection is "extra" when no truth point (of its own kind) lies
	// within tolerance of it — independent of which detection each truth
	// point individually picked as nearest.
	const extraTees = tees
		.filter((t) => !truth.some((hole) => dist(hole.tee, { xPx: t.xPx, yPx: t.yPx }) <= ASSOCIATION_TOLERANCE_PX))
		.map((t) => ({ xPx: t.xPx, yPx: t.yPx }));
	const extraBaskets = baskets
		.filter((b) => !truth.some((hole) => dist(hole.basket, { xPx: b.tipXPx, yPx: b.tipYPx }) <= ASSOCIATION_TOLERANCE_PX))
		.map((b) => ({ xPx: b.tipXPx, yPx: b.tipYPx }));

	const teesByDetId = new Map(run.assignment.tees.map((t) => [t.detId, t]));
	const basketsByDetId = new Map(run.measurement.baskets.map((b) => [b.detId, b]));
	const badgesByDetId = new Map(run.measurement.badges.map((b) => [b.detId, b]));
	let assignedExact = 0;
	let assignMaxDev = 0;
	for (const hole of truth) {
		const assignment = run.assignment.assignments.find((a) => {
			const badge = badgesByDetId.get(a.badgeId);
			return badge && badge.label !== null && Number(badge.label) === hole.number;
		});
		if (!assignment) continue;
		const tee = teesByDetId.get(assignment.teeId);
		const basket = basketsByDetId.get(assignment.basketId);
		if (!tee || !basket) continue;
		const teeD = dist(hole.tee, { xPx: tee.xPx, yPx: tee.yPx });
		const basketD = dist(hole.basket, { xPx: basket.tipXPx, yPx: basket.tipYPx });
		if (teeD <= ASSOCIATION_TOLERANCE_PX && basketD <= ASSOCIATION_TOLERANCE_PX) {
			assignedExact++;
			assignMaxDev = Math.max(assignMaxDev, teeD, basketD);
		}
	}

	return {
		badges: { found: badges.length, expected: truth.length, digitsMatched },
		baskets: { found: baskets.length, expected: truth.length, matched: basketMatched, maxDeviation: basketMaxDev },
		tees: { found: tees.length, expected: truth.length, matched: teeMatched, maxDeviation: teeMaxDev },
		assignment: { assignedExact, expected: truth.length, maxDeviation: assignMaxDev },
		evidenceHoles,
		extraTees,
		extraBaskets
	};
}

function logSideBySide(courseName: string, gate: string, label: (s: GateScoreboard) => string, def: GateScoreboard, fam: GateScoreboard) {
	console.log(`[${courseName}][${gate}] default: ${label(def)} | family-on: ${label(fam)}`);
}

const defaultResolved = resolveConfig(parseConfig(defaultConfigJson), DEFAULT_EXECUTION);
const familyOnResolved = resolveConfig(parseConfig(familyOnConfigJson), DEFAULT_EXECUTION);

const ALL_COURSES: readonly CourseSpec[] = [DASHSTRACK_VIA_ANNOTATED, ...COURSES];

describe('family-on deviation sweep (observational — no asserts on gate counts)', () => {
	for (const spec of ALL_COURSES) {
		test(
			spec.name,
			async () => {
				const raster = loadCourseRaster(spec);
				const truth = loadCourseTruth(spec).holes;

				const defaultHash = await sha256Hex(canonicalJson(defaultResolved));
				const familyHash = await sha256Hex(canonicalJson(familyOnResolved));
				const defaultRun = runThreeFactor(raster, { config: defaultResolved, paramsHash: defaultHash });
				const familyRun = runThreeFactor(raster, { config: familyOnResolved, paramsHash: familyHash });

				const def = scoreRun(defaultRun, truth);
				const fam = scoreRun(familyRun, truth);

				console.log(
					`[${spec.name}] image ${raster.widthPx}x${raster.heightPx} imageId=${raster.imageId} defaultParamsHash=${defaultHash} familyOnParamsHash=${familyHash}`
				);
				logSideBySide(spec.name, 'G1', (s) => `badges=${s.badges.found}/${s.badges.expected} digitsMatched=${s.badges.digitsMatched}/${s.badges.expected}`, def, fam);
				logSideBySide(
					spec.name,
					'G2',
					(s) => `baskets found=${s.baskets.found} matched=${s.baskets.matched}/${s.baskets.expected} maxDev=${s.baskets.maxDeviation.toFixed(2)}px extras=${s.extraBaskets.length}`,
					def,
					fam
				);
				logSideBySide(
					spec.name,
					'G3',
					(s) => `tees found=${s.tees.found} matched=${s.tees.matched}/${s.tees.expected} maxDev=${s.tees.maxDeviation.toFixed(2)}px extras=${s.extraTees.length}`,
					def,
					fam
				);
				logSideBySide(
					spec.name,
					'G4',
					(s) => `assignedExact=${s.assignment.assignedExact}/${s.assignment.expected} maxDev=${s.assignment.maxDeviation.toFixed(2)}px`,
					def,
					fam
				);

				mkdirSync(ARTIFACTS_DIR, { recursive: true });
				const defaultPng = renderSweepEvidencePng({
					widthPx: raster.widthPx,
					heightPx: raster.heightPx,
					rgba: raster.rgba,
					holes: def.evidenceHoles,
					extraTees: def.extraTees,
					extraBaskets: def.extraBaskets
				});
				const familyPng = renderSweepEvidencePng({
					widthPx: raster.widthPx,
					heightPx: raster.heightPx,
					rgba: raster.rgba,
					holes: fam.evidenceHoles,
					extraTees: fam.extraTees,
					extraBaskets: fam.extraBaskets
				});
				const defaultPath = resolve(ARTIFACTS_DIR, `${spec.name}.png`);
				const familyPath = resolve(ARTIFACTS_DIR, `${spec.name}-family-on.png`);
				writeFileSync(defaultPath, defaultPng);
				writeFileSync(familyPath, familyPng);
				console.log(`[${spec.name}] wrote ${defaultPath}`);
				console.log(`[${spec.name}] wrote ${familyPath}`);
			},
			90000
		);
	}
});
