/**
 * Ring-arc spike: do split-hole corridor gaps sit on putting-circle ring
 * arcs (the C1/C2 glyphs rendered around every basket)?
 *
 * Motivation (live overlay review, 2026-08): most observed corridor
 * "tearing" was attributed by eye to C1/C2 ring graphics — including a
 * hole's OWN rings tearing the corridor before the basket, so ownership
 * does not exempt a ring from causing splits. Unlike the basket-marker
 * exclusion dead end (an ownership question Phase 1 couldn't answer),
 * rings are geometrically predictable from basket positions alone: every
 * ring is a circle centered on a basket at one of (at most) two shared
 * radii. If that model is right, the distance from a split gap to its
 * nearest basket should cluster tightly at those radii.
 *
 * Method, deliberately scale-free (no meters-per-px metadata exists on
 * these fixtures): for every split-bucket hole, find the closest pixel
 * pair between the badge's component and the basket's component, take the
 * gap midpoint, and measure its distance to every truth basket. If rings
 * cause the splits, those distances should pile up at ~2 shared values
 * (the C1/C2 radii in px) instead of spreading uniformly — the radii are
 * DISCOVERED by the clustering, not assumed.
 *
 * This is a measurement probe only: it introduces no bridging logic, no
 * ring detector, and no production behavior.
 *
 * Usage:
 *   npx tsx scripts/cv-probes/ring-arc-spike.ts
 */
import { join } from 'node:path';
import {
	DEFAULT_RIBBON_MASS_PARAMS,
	placeSeeds,
	segmentRibbonMass,
	topologyBuckets
} from '../../src/lib/autoAnnotation/ribbonMass';
import type { RibbonMassSeed } from '../../src/lib/autoAnnotation/ribbonMass';
import { FIXTURE_COURSES, loadFixtureRaster } from './ribbonMassFixtures';

interface GapMeasurement {
	readonly course: string;
	readonly holeNumber: number;
	readonly gapMidSrcPx: { x: number; y: number };
	readonly gapWidthPx: number;
	/** Distance from the gap midpoint to the nearest basket, and whose it is. */
	readonly nearestBasketHole: number;
	readonly nearestBasketDistPx: number;
	readonly nearestIsOwn: boolean;
	/** Distances (source px) from the gap's two component-side endpoints to the nearest basket. */
	readonly spanNearPx: number;
	readonly spanFarPx: number;
}

function componentPixels(labels: Int32Array, w: number, label: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < labels.length; i += 1) if (labels[i] === label) out.push(i);
	return out;
}

/** Closest pixel pair between two components (evidence px), brute force over boundary-ish samples. */
function closestPair(
	labels: Int32Array,
	w: number,
	labelA: number,
	labelB: number
): { a: number; b: number; distEv: number } {
	const pxA = componentPixels(labels, w, labelA);
	const pxB = componentPixels(labels, w, labelB);
	// Subsample large components to keep the pair search fast; the gap
	// midpoint only needs ~1-2 evidence px accuracy.
	const step = (arr: number[]) => Math.max(1, Math.floor(arr.length / 4000));
	const sa = step(pxA);
	const sb = step(pxB);
	let best = { a: pxA[0], b: pxB[0], distEv: Infinity };
	for (let i = 0; i < pxA.length; i += sa) {
		const pa = pxA[i];
		const ax = pa % w;
		const ay = (pa - ax) / w;
		for (let j = 0; j < pxB.length; j += sb) {
			const pb = pxB[j];
			const bx = pb % w;
			const by = (pb - bx) / w;
			const d = Math.hypot(ax - bx, ay - by);
			if (d < best.distEv) best = { a: pa, b: pb, distEv: d };
		}
	}
	return best;
}

const measurements: GapMeasurement[] = [];

for (const course of FIXTURE_COURSES) {
	const raster = loadFixtureRaster(join(process.cwd(), course.zip));
	const segmentation = segmentRibbonMass(
		raster,
		course.badges.map(([, xPx, yPx]) => ({ xPx, yPx })),
		DEFAULT_RIBBON_MASS_PARAMS
	);
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
	const baskets = course.truth.map(([n, , , bx, by]) => ({ holeNumber: n, xPx: bx, yPx: by }));

	console.log(`\n=== ${course.name}: ${topology.counts.split} split holes ===`);
	for (const hole of topology.perHole) {
		if (hole.bucket !== 'split' || hole.badgeComponentLabel === null || hole.basketComponentLabel === null)
			continue;
		const pair = closestPair(
			segmentation.labels,
			segmentation.widthEv,
			hole.badgeComponentLabel,
			hole.basketComponentLabel
		);
		const ax = (pair.a % segmentation.widthEv) * segmentation.scale;
		const ay = Math.floor(pair.a / segmentation.widthEv) * segmentation.scale;
		const bx = (pair.b % segmentation.widthEv) * segmentation.scale;
		const by = Math.floor(pair.b / segmentation.widthEv) * segmentation.scale;
		const mid = { x: (ax + bx) / 2, y: (ay + by) / 2 };
		let nearest = baskets[0];
		let nearestDist = Infinity;
		for (const basket of baskets) {
			const d = Math.hypot(mid.x - basket.xPx, mid.y - basket.yPx);
			if (d < nearestDist) {
				nearestDist = d;
				nearest = basket;
			}
		}
		// Ring-spanning test: a ring-caused tear should have its two sides on
		// opposite sides of the ring, so the interval between the gap
		// endpoints' distances to the NEAREST basket should contain the ring
		// radius. The midpoint alone under-determines wide tears.
		const dA = Math.hypot(ax - nearest.xPx, ay - nearest.yPx);
		const dB = Math.hypot(bx - nearest.xPx, by - nearest.yPx);
		const m: GapMeasurement = {
			course: course.name,
			holeNumber: hole.holeNumber,
			gapMidSrcPx: { x: Math.round(mid.x), y: Math.round(mid.y) },
			gapWidthPx: Math.round(pair.distEv * segmentation.scale * 10) / 10,
			nearestBasketHole: nearest.holeNumber,
			nearestBasketDistPx: Math.round(nearestDist * 10) / 10,
			nearestIsOwn: nearest.holeNumber === hole.holeNumber,
			spanNearPx: Math.round(Math.min(dA, dB) * 10) / 10,
			spanFarPx: Math.round(Math.max(dA, dB) * 10) / 10
		};
		measurements.push(m);
		console.log(
			`  hole ${String(m.holeNumber).padStart(2)}: gap ${String(m.gapWidthPx).padStart(5)}px wide at (${m.gapMidSrcPx.x},${m.gapMidSrcPx.y})` +
				` -> nearest basket = hole ${String(m.nearestBasketHole).padStart(2)} (${m.nearestIsOwn ? 'OWN' : 'foreign'})` +
				` spans ${m.spanNearPx}-${m.spanFarPx}px from it`
		);
	}
}

// Ring model check: distances to the nearest basket should cluster at the
// (unknown) C1/C2 radii if rings cause the splits. Print the sorted
// distances and a coarse histogram so the clustering — or its absence — is
// visible directly rather than assumed.
const dists = measurements.map((m) => m.nearestBasketDistPx).sort((a, b) => a - b);
console.log(`\n=== gap-midpoint -> nearest-basket distances, all ${dists.length} split holes ===`);
console.log(`  sorted: ${dists.join(', ')}`);
const BIN = 15;
const bins = new Map<number, number>();
for (const d of dists) {
	const bin = Math.floor(d / BIN) * BIN;
	bins.set(bin, (bins.get(bin) ?? 0) + 1);
}
for (const [bin, count] of [...bins.entries()].sort((a, b) => a[0] - b[0])) {
	console.log(`  ${String(bin).padStart(4)}-${String(bin + BIN).padStart(3)}px: ${'#'.repeat(count)} (${count})`);
}
const own = measurements.filter((m) => m.nearestIsOwn).length;
console.log(
	`\n  nearest basket is the hole's OWN in ${own}/${measurements.length} split gaps — ` +
		`own rings tear corridors too; ring handling cannot lean on ownership.`
);

// Which candidate radii are spanned by the most gaps, per course (courses
// have different capture zoom — the prior session measured marker radii
// 96px vs 76px — so radii must not be pooled across courses).
for (const courseName of [...new Set(measurements.map((m) => m.course))]) {
	const rows = measurements.filter((m) => m.course === courseName);
	console.log(`\n=== ${courseName}: radii spanned by gap intervals (candidate ring radii) ===`);
	const coverage: { r: number; holes: number[] }[] = [];
	for (let r = 10; r <= 200; r += 5) {
		const holes = rows.filter((m) => m.spanNearPx <= r && r <= m.spanFarPx).map((m) => m.holeNumber);
		coverage.push({ r, holes });
	}
	const best = [...coverage].sort((a, b) => b.holes.length - a.holes.length).slice(0, 6);
	for (const { r, holes } of best) {
		console.log(`  r=${String(r).padStart(3)}px spans ${holes.length}/${rows.length} gaps (holes ${holes.join(', ')})`);
	}
}
