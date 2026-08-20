import { describe, expect, it } from 'vitest';
import {
	assessTeeBootstrap,
	deriveTeeSweepCalibration,
	sweepPadOrientation
} from '../../src/lib/autoAnnotation/teeBootstrapPolicy';
import type { TeeBadgeAnchor } from '../../src/lib/autoAnnotation/teeBootstrapPolicy';
import type { TeePadCandidate, TeePadRaster } from '../../src/lib/autoAnnotation/teePadDetection';

function blankRaster(widthPx = 180, heightPx = 140): TeePadRaster {
	const rgba = new Uint8Array(widthPx * heightPx * 4);
	for (let offset = 0; offset < rgba.length; offset += 4) {
		rgba[offset] = 120;
		rgba[offset + 1] = 120;
		rgba[offset + 2] = 120;
		rgba[offset + 3] = 255;
	}
	return { rgba, widthPx, heightPx, sourceScale: 1 };
}

function drawPad(
	raster: TeePadRaster,
	centerXPx: number,
	centerYPx: number,
	majorPx: number,
	angleDeg: number
): void {
	const minorPx = majorPx / 1.45;
	const rimPx = Math.max(1, majorPx * 0.11);
	const radians = (angleDeg * Math.PI) / 180;
	const cosine = Math.cos(radians);
	const sine = Math.sin(radians);
	const half = Math.ceil(majorPx);
	for (let y = Math.floor(centerYPx - half); y <= Math.ceil(centerYPx + half); y += 1) {
		for (let x = Math.floor(centerXPx - half); x <= Math.ceil(centerXPx + half); x += 1) {
			if (x < 0 || y < 0 || x >= raster.widthPx || y >= raster.heightPx) continue;
			const dx = x - centerXPx;
			const dy = y - centerYPx;
			const localX = dx * cosine + dy * sine;
			const localY = -dx * sine + dy * cosine;
			const outer = Math.abs(localX) <= majorPx / 2 && Math.abs(localY) <= minorPx / 2;
			const inner = Math.abs(localX) <= majorPx / 2 - rimPx && Math.abs(localY) <= minorPx / 2 - rimPx;
			if (!outer) continue;
			const value = inner ? 158 : 235;
			const offset = (y * raster.widthPx + x) * 4;
			raster.rgba[offset] = value;
			raster.rgba[offset + 1] = value;
			raster.rgba[offset + 2] = value;
		}
	}
}

function candidate(
	xPx: number,
	yPx: number,
	widthPx: number,
	heightPx: number,
	strong = true
): TeePadCandidate {
	return {
		xPx,
		yPx,
		orientationDeg: 0,
		widthPx,
		heightPx,
		score: 1,
		support: strong ? ['gray-center', 'edge-loop'] : ['occluded-edge-loop']
	};
}

function badge(holeNumber: number, xPx: number, yPx: number): TeeBadgeAnchor {
	return { holeNumber, xPx, yPx, widthPx: 30, heightPx: 22 };
}

function axisDelta(a: number, b: number): number {
	const difference = Math.abs((a % 180) - (b % 180));
	return Math.min(difference, 180 - difference);
}

describe('tee bootstrap world-scale orientation', () => {
	it('derives its template bank from detected pad geometry rather than UI pixels', () => {
		const calibration = deriveTeeSweepCalibration([
			candidate(0, 0, 20, 12),
			candidate(0, 0, 21, 13),
			candidate(0, 0, 19, 12)
		]);
		expect(calibration?.representativeMajorPx).toBe(20);
		expect(calibration?.majorSizesPx).toEqual([18, 24, 30]);
	});

	it('recovers a larger outer pad even when detector rectangles measure only the interior', () => {
		const raster = blankRaster();
		drawPad(raster, 60, 60, 30, 27.5);
		const calibration = deriveTeeSweepCalibration([
			candidate(60, 60, 20, 12),
			candidate(20, 20, 20, 12),
			candidate(150, 100, 20, 12)
		]);
		expect(calibration).toBeDefined();
		const measurement = sweepPadOrientation(raster, 60, 60, calibration!);
		expect(measurement).toBeDefined();
		expect(measurement!.majorPx).toBe(30);
		expect(axisDelta(measurement!.axisDeg, 27.5)).toBeLessThanOrEqual(2.5);
		expect(measurement!.score).toBeGreaterThan(0.4);
	});

	it('adapts the same estimator to a much smaller rendered course', () => {
		const raster = blankRaster(120, 100);
		drawPad(raster, 45, 45, 15, 110);
		const calibration = deriveTeeSweepCalibration([
			candidate(45, 45, 10, 7),
			candidate(20, 20, 10, 7),
			candidate(95, 70, 10, 7)
		]);
		expect(calibration?.majorSizesPx).toEqual([9, 12, 15]);
		const measurement = sweepPadOrientation(raster, 45, 45, calibration!);
		expect(measurement).toBeDefined();
		expect(measurement!.majorPx).toBe(15);
		expect(axisDelta(measurement!.axisDeg, 110)).toBeLessThanOrEqual(2.5);
	});
});

describe('tee bootstrap decision policy', () => {
	it('AUTO-accepts only strong pad + strong orientation + unique badge ownership', () => {
		const raster = blankRaster();
		drawPad(raster, 55, 65, 30, 0);
		const result = assessTeeBootstrap(
			raster,
			[candidate(55, 65, 20, 12, true)],
			[badge(1, 110, 65), badge(2, 80, 120)]
		);
		expect(result.holes.find((hole) => hole.holeNumber === 1)?.decision).toBe('auto');
		expect(result.holes.find((hole) => hole.holeNumber === 2)?.decision).toBe('unresolved');
		expect(result.counts).toEqual({ auto: 1, review: 0, unresolved: 1 });
	});

	it('downgrades a weak/occluded pad with strong badge alignment to REVIEW', () => {
		const raster = blankRaster();
		drawPad(raster, 55, 65, 30, 0);
		const result = assessTeeBootstrap(
			raster,
			[candidate(55, 65, 20, 12, false)],
			[badge(5, 110, 65)]
		);
		const hole = result.holes[0];
		expect(hole.decision).toBe('review');
		expect(hole.assignment?.padEvidence).toBe('weak');
		expect(hole.assignment?.ownershipEvidence).toBe('strong');
	});

	it('leaves weak appearance + unmeasurable orientation UNRESOLVED instead of guessing', () => {
		const raster = blankRaster();
		const result = assessTeeBootstrap(
			raster,
			[candidate(55, 65, 20, 12, false)],
			[badge(3, 110, 65)]
		);
		expect(result.holes[0].decision).toBe('unresolved');
		expect(result.assignments).toHaveLength(0);
	});

	it('keeps distant REVIEW rays even when AUTO holes establish a much shorter typical distance', () => {
		const raster = blankRaster(320, 220);
		const candidates: TeePadCandidate[] = [];
		const badges: TeeBadgeAnchor[] = [];
		for (let index = 0; index < 4; index += 1) {
			const y = 35 + index * 40;
			drawPad(raster, 45, y, 30, 0);
			candidates.push(candidate(45, y, 20, 12, true));
			badges.push(badge(index + 1, 100, y));
		}
		// A weak pad-like structure points exactly at badge 5, but at more
		// than twice the distance established by the four AUTO holes. Distance
		// is not a hard rejection signal: preserve the candidate for downstream
		// scoring/pruning instead of deleting a legitimate long-hole hypothesis.
		drawPad(raster, 40, 200, 30, 0);
		candidates.push(candidate(40, 200, 20, 12, false));
		badges.push(badge(5, 190, 200));

		const result = assessTeeBootstrap(raster, candidates, badges);
		const hole = result.holes.find((candidateHole) => candidateHole.holeNumber === 5);
		expect(hole?.decision).toBe('review');
		expect(hole?.assignment?.candidate.xPx).toBe(40);
		expect(hole?.assignment?.badgeRay?.distancePx).toBeGreaterThan(140);
	});

	it('suppresses AUTO when two badges are similarly compatible with the same axis', () => {
		const raster = blankRaster();
		drawPad(raster, 45, 65, 30, 0);
		const result = assessTeeBootstrap(
			raster,
			[candidate(45, 65, 20, 12, true)],
			[badge(1, 95, 65), badge(2, 104, 65)]
		);
		expect(result.counts.auto).toBe(0);
		expect(result.holes.find((hole) => hole.holeNumber === 1)?.decision).toBe('review');
	});

	it('offers a genuinely tied pad to the second badge once the first badge is won by its own better candidate', () => {
		// P1 sits almost exactly between badge A and badge B (a real course-layout
		// coincidence, not detector error): its measured axis passes both badge
		// bodies at nearly identical ray distance, so ownership is a proximity
		// tie. Before the fix, `assessCandidate` committed P1 to whichever badge
		// was a few pixels closer (A) and B never saw it as a candidate at all,
		// even though A has its own separate, unambiguous pad (P2) and would
		// never have used P1 anyway.
		const raster = blankRaster(500, 140);
		drawPad(raster, 250, 65, 30, 0); // P1: the tied pad
		drawPad(raster, 420, 65, 30, 0); // P2: badge A's own unambiguous pad
		const badgeA = badge(1, 445, 65); // dist to P2 = 25 (auto); dist to P1 = 195
		const badgeB = badge(2, 55, 65); // dist to P1 = 195 (tied with badge A); no pad of its own
		const result = assessTeeBootstrap(
			raster,
			[candidate(250, 65, 20, 12, true), candidate(420, 65, 20, 12, true)],
			[badgeA, badgeB]
		);
		const holeA = result.holes.find((hole) => hole.holeNumber === 1);
		const holeB = result.holes.find((hole) => hole.holeNumber === 2);
		expect(holeA?.decision).toBe('auto');
		expect(holeA?.assignment?.candidate.xPx).toBe(420);
		expect(holeB?.decision).toBe('review');
		expect(holeB?.assignment?.candidate.xPx).toBe(250);
		expect(holeB?.assignment?.ownershipEvidence).toBe('ambiguous');
	});
});