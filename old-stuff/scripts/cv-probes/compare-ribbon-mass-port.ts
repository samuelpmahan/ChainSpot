/**
 * Fixture-parity check for the TypeScript ribbon-mass port
 * (`src/lib/autoAnnotation/ribbonMass.ts`) against the Python research
 * probes' committed results (branch `claude/grayt-ribbon-mass-ihcxiq`:
 * `scripts/cv-probes/ribbon_mass_segmentation.py` /
 * `ribbon_mass_topology.py`, results in `ribbon-mass-results/`).
 *
 * Reproduces the research configuration exactly: DETECTED badges (the
 * committed `detect-course` output hardcoded in
 * `hole_path_tee_recovery.py`) plus TRUTH basket positions/ownership as
 * seeds — the fixture-only oracle configuration, per the findings docs'
 * two-layers-of-oracle-leakage caveat. This is validation tooling; the
 * production shadow path never sees truth.
 *
 * Exact bit-parity is not expected (jpeg-js vs PIL JPEG decode, float vs
 * PIL fixed-point Lanczos), so the check compares the numbers that carry
 * the findings: per-hole topology buckets, endpoint nearest-distance
 * within-30px counts, component counts, and mask coverage fractions.
 *
 * Usage:
 *   npx tsx scripts/cv-probes/compare-ribbon-mass-port.ts
 */
import { join } from 'node:path';
import {
	DEFAULT_RIBBON_MASS_PARAMS,
	keptAreaPx,
	nearestKeptDistancePx,
	placeSeeds,
	recommendedKeptLabels,
	segmentRibbonMass,
	topologyBuckets
} from '../../src/lib/autoAnnotation/ribbonMass';
import type { RibbonMassSeed } from '../../src/lib/autoAnnotation/ribbonMass';
import { FIXTURE_COURSES, loadFixtureRaster } from './ribbonMassFixtures';

/** The Python probes' committed per-course results (`ribbon-mass-topology.json` / `ribbon-mass-summary.json`). */
const EXPECTED = {
	GoldenTeeSet: {
		buckets: { exclusiveSameComponent: 8, sharedSameComponent: 3, split: 7, noSeedHit: 0 },
		sharedConflictComponents: 2,
		teeWithin30: 13,
		basketWithin30: 18,
		nComponents: 110,
		recommendedFrac: 0.0854
	},
	AlexClarkSet: {
		buckets: { exclusiveSameComponent: 3, sharedSameComponent: 7, split: 8, noSeedHit: 0 },
		sharedConflictComponents: 5,
		teeWithin30: 13,
		basketWithin30: 18,
		nComponents: 165,
		recommendedFrac: 0.0899
	}
} as const;

const COURSES = FIXTURE_COURSES;

let failures = 0;
function check(name: string, actual: number, expected: number, tolerance = 0): void {
	const ok = Math.abs(actual - expected) <= tolerance;
	if (!ok) failures += 1;
	console.log(`  ${ok ? 'OK  ' : 'DIFF'} ${name}: got ${actual}, python ${expected}${tolerance ? ` (±${tolerance})` : ''}`);
}

for (const course of COURSES) {
	console.log(`\n=== ${course.name} ===`);
	const raster = loadFixtureRaster(join(process.cwd(), course.zip));
	const badges = course.badges.map(([, xPx, yPx]) => ({ xPx, yPx }));
	const started = Date.now();
	const segmentation = segmentRibbonMass(raster, badges, DEFAULT_RIBBON_MASS_PARAMS);
	console.log(`  segmented ${raster.widthPx}x${raster.heightPx} in ${Date.now() - started}ms`);

	const seeds: RibbonMassSeed[] = [
		...course.badges.map(([n, xPx, yPx]) => ({
			seedId: `badge-${n}`,
			kind: 'badge' as const,
			holeNumber: n,
			xPx,
			yPx
		})),
		...course.truth.map(([n, , , xPx, yPx]) => ({
			seedId: `basket-${n}`,
			kind: 'basket' as const,
			holeNumber: n,
			xPx,
			yPx
		}))
	];
	const placements = placeSeeds(segmentation, seeds, DEFAULT_RIBBON_MASS_PARAMS.seedRadiusPx);
	const topology = topologyBuckets(placements, course.truth.map(([n]) => n));
	const kept = recommendedKeptLabels(segmentation, placements);

	let teeWithin30 = 0;
	let basketWithin30 = 0;
	const borderlineTees: string[] = [];
	for (const [n, tx, ty, bx, by] of course.truth) {
		const teeDist = nearestKeptDistancePx(
			segmentation.labels, segmentation.widthEv, segmentation.heightEv, segmentation.scale, kept, tx, ty);
		const basketDist = nearestKeptDistancePx(
			segmentation.labels, segmentation.widthEv, segmentation.heightEv, segmentation.scale, kept, bx, by);
		if (teeDist <= 30) teeWithin30 += 1;
		if (basketDist <= 30) basketWithin30 += 1;
		if (teeDist > 20) borderlineTees.push(`${n}:${teeDist.toFixed(1)}`);
	}
	console.log(`  tee distances > 20px: ${borderlineTees.join(' ')}`);

	const expected = EXPECTED[course.name];
	check('exclusiveSameComponent', topology.counts.exclusiveSameComponent, expected.buckets.exclusiveSameComponent);
	check('sharedSameComponent', topology.counts.sharedSameComponent, expected.buckets.sharedSameComponent);
	check('split', topology.counts.split, expected.buckets.split);
	check('noSeedHit', topology.counts.noSeedHit, expected.buckets.noSeedHit);
	check('sharedConflictComponents', topology.sharedConflictComponents.length, expected.sharedConflictComponents);
	// ±1 tolerance, measured and explained (2026-08): each course has exactly
	// one borderline component that flips across the float-precision gap
	// between this port and PIL/scipy — AlexClarkSet's hole-15 tee fragment
	// measures lStd 12.07 here vs just under the 12.0 floor in Python, and a
	// GoldenTeeSet threshold-boundary pixel merges hole 4's tee-end fragment
	// into a seeded component (component count 111 vs 110). Per-hole topology
	// buckets match the Python results exactly on all 36 holes.
	check('tee within 30px (recommended)', teeWithin30, expected.teeWithin30, 1);
	check('basket within 30px (recommended)', basketWithin30, expected.basketWithin30);
	check('nComponents (area >= 25)', segmentation.components.length, expected.nComponents, 8);
	const recommendedFrac = keptAreaPx(segmentation.labels, kept) / segmentation.labels.length;
	check('recommended mask fraction', Number(recommendedFrac.toFixed(4)), expected.recommendedFrac, 0.005);
	console.log(
		`  buckets per hole: exclusive=${JSON.stringify(topology.perHole.filter((h) => h.bucket === 'exclusiveSameComponent').map((h) => h.holeNumber))} ` +
			`shared=${JSON.stringify(topology.perHole.filter((h) => h.bucket === 'sharedSameComponent').map((h) => h.holeNumber))} ` +
			`split=${JSON.stringify(topology.perHole.filter((h) => h.bucket === 'split').map((h) => h.holeNumber))}`
	);
}

console.log(failures === 0 ? '\nAll checks matched the committed Python fixture results.' : `\n${failures} check(s) differed — see DIFF lines above.`);
process.exit(failures === 0 ? 0 : 1);
