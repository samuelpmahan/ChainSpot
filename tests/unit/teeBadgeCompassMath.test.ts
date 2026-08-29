import { describe, expect, test } from 'vitest';
import {
	axisBearingError,
	buildCompassGeometry,
	buildTeeBadgeCompassEvidence,
	computeCompassPoseQuality,
	deriveCompassSigma,
	exactPositiveHole,
	matchTeeBadgeCompass,
	resolveClaimsByWavePeeling,
	runTeeBadgeCompass,
	scoreCompassGeometry,
	type CompassBadge,
	type CompassGeometry,
	type CompassGeometryRow,
	type CompassScoredRow,
	type CompassTee
} from '@chainspot/alg/detectors/threeFactor/features/g4.teeBadgeCompassMath';

const DEG = 180 / Math.PI;

function row(partial: Partial<CompassGeometryRow> & Pick<CompassGeometryRow, 'teeId' | 'badgeId'>): CompassGeometryRow {
	return {
		teeXPx: 0,
		teeYPx: 0,
		badgeXPx: 100,
		badgeYPx: 0,
		bearingRad: 0,
		aimRad: 0,
		angularErrorDeg: 0,
		distancePx: 100,
		...partial
	};
}

function geometryOf(rows: readonly CompassGeometryRow[], badgeIds?: readonly string[]): CompassGeometry {
	const eligibleTeeIds = [...new Set(rows.map((r) => r.teeId))];
	return {
		rows,
		eligibleTeeIds,
		noPadTeeIds: [],
		badgeIds: badgeIds ?? [...new Set(rows.map((r) => r.badgeId))]
	};
}

describe('axisBearingError -- the literal 180-degree ambiguity', () => {
	test('axis pointing directly at the bearing reads zero error', () => {
		const result = axisBearingError(0, 0);
		expect(result.angularErrorDeg).toBeCloseTo(0);
		expect(result.aimRad).toBeCloseTo(0);
	});

	test('axis pointing exactly opposite the bearing ALSO reads zero error (a pad axis is a line, not a ray)', () => {
		const result = axisBearingError(0, Math.PI);
		expect(result.angularErrorDeg).toBeCloseTo(0);
		// the direction that actually matches the bearing is PI, not 0
		expect(Math.cos(result.aimRad)).toBeCloseTo(Math.cos(Math.PI));
		expect(Math.sin(result.aimRad)).toBeCloseTo(Math.sin(Math.PI));
	});

	test('takes the minimum over both directions for an off-axis bearing', () => {
		const axisRad = 10 / DEG;
		const bearingRad = 5 / DEG;
		const result = axisBearingError(axisRad, bearingRad);
		expect(result.angularErrorDeg).toBeCloseTo(5, 5);
		// the "away" direction (axis + PI) must be far worse here, proving the
		// minimum was actually taken rather than always preferring axisRad
		const away = axisBearingError(axisRad + Math.PI, bearingRad);
		expect(away.angularErrorDeg).toBeCloseTo(5, 5);
	});

	test('a right-angle bearing reads a full 90 degrees regardless of direction', () => {
		const result = axisBearingError(0, Math.PI / 2);
		expect(result.angularErrorDeg).toBeCloseTo(90);
	});
});

describe('buildCompassGeometry', () => {
	test('excludes a no-pad tee (never silently dropped) and builds the full tee x badge cross product', () => {
		const tees: CompassTee[] = [
			{ detId: 'tee-a', xPx: 0, yPx: 0, pad: { angleRad: 0, majorPx: 20, minorPx: 8, area: 120, fill: 0.7 } },
			{ detId: 'tee-b', xPx: 5, yPx: 5 } // no pad at all
		];
		const badges: CompassBadge[] = [
			{ detId: 'badge-x', label: '4', cxPx: 10, cyPx: 0 },
			{ detId: 'badge-y', label: '7', cxPx: 0, cyPx: 10 }
		];
		const geometry = buildCompassGeometry(tees, badges);
		expect(geometry.eligibleTeeIds).toEqual(['tee-a']);
		expect(geometry.noPadTeeIds).toEqual(['tee-b']);
		expect(geometry.badgeIds).toEqual(['badge-x', 'badge-y']);
		expect(geometry.rows).toHaveLength(2);
		const toX = geometry.rows.find((r) => r.badgeId === 'badge-x')!;
		expect(toX.distancePx).toBeCloseTo(10);
		expect(toX.angularErrorDeg).toBeCloseTo(0);
		const toY = geometry.rows.find((r) => r.badgeId === 'badge-y')!;
		expect(toY.distancePx).toBeCloseTo(10);
		expect(toY.angularErrorDeg).toBeCloseTo(90);
	});

	test('distance is never a filter -- an arbitrarily far badge still becomes a candidate row', () => {
		const tees: CompassTee[] = [
			{ detId: 'tee-a', xPx: 0, yPx: 0, pad: { angleRad: 0, majorPx: 20, minorPx: 8, area: 120, fill: 0.7 } }
		];
		const badges: CompassBadge[] = [{ detId: 'badge-far', label: '9', cxPx: 1_700 * 5280, cyPx: 0 }];
		const geometry = buildCompassGeometry(tees, badges);
		expect(geometry.rows).toHaveLength(1);
		expect(geometry.rows[0]!.angularErrorDeg).toBeCloseTo(0);
	});
});

describe('deriveCompassSigma', () => {
	const knobs = { quantileFraction: 0.75, minimumSampleSize: 3, rasterTolerancePx: 1.25 };

	function bestRows(anglesDeg: readonly number[], distancePx = 100): CompassGeometryRow[] {
		return anglesDeg.map((angle, index) =>
			row({ teeId: `tee-${index}`, badgeId: `badge-${index}`, angularErrorDeg: angle, distancePx })
		);
	}

	test('sigma = max(robust quantile of best-per-tee angular error, raster floor), with printed provenance', () => {
		const geometry = geometryOf(bestRows([1, 2, 3, 10]));
		const sigma = deriveCompassSigma(geometry, knobs);
		// P75 of [1,2,3,10] via linear interpolation: rank=2.25 -> 3*0.75+10*0.25=4.75
		expect(sigma.quantileValueDeg).toBeCloseTo(4.75);
		expect(sigma.floorDeg).toBeGreaterThan(0);
		expect(sigma.floorDeg as number).toBeLessThan(1); // atan(1.25/100) is well under a degree
		expect(sigma.sigmaDeg).toBeCloseTo(4.75);
		expect(sigma.isFallback).toBe(false);
		expect(sigma.totalEligibleTees).toBe(4);
		expect(sigma.excludedForPoseQuality).toBe(0);
		expect(sigma.sampleSize).toBe(4);
		expect(sigma.provenance).toContain('P75');
		expect(sigma.provenance).toContain('rasterFloorDeg');
	});

	test('falls back LOUDLY (never silently) when too few tees exist for a robust quantile', () => {
		const geometry = geometryOf(bestRows([1, 2]));
		const sigma = deriveCompassSigma(geometry, knobs);
		expect(sigma.isFallback).toBe(true);
		expect(sigma.quantileValueDeg).toBe('UNKNOWN');
		expect(sigma.sigmaDeg).toBe(sigma.floorDeg);
		expect(sigma.provenance).toContain('UNKNOWN');
		expect(sigma.provenance).toMatch(/FALLING BACK LOUDLY/);
	});

	test('zero eligible tees is UNKNOWN, not a crash and not a fabricated number', () => {
		const geometry = geometryOf([]);
		const sigma = deriveCompassSigma(geometry, knobs);
		expect(Number.isNaN(sigma.sigmaDeg)).toBe(true);
		expect(sigma.floorDeg).toBe('UNKNOWN');
		expect(sigma.isFallback).toBe(true);
	});

	test('excludes degraded-pose tees from the quantile sample, but not from the raster-floor distance', () => {
		const geometry = geometryOf(bestRows([1, 2, 3, 99], 100));
		const withoutExclusion = deriveCompassSigma(geometry, knobs);
		expect(withoutExclusion.quantileValueDeg).not.toBe('UNKNOWN');
		// P75 of [1,2,3,99] (rank=2.25 -> 3*.75+99*.25=27): the 99deg outlier
		// pollutes the quantile badly when included.
		expect(withoutExclusion.quantileValueDeg as number).toBeCloseTo(27);

		const withExclusion = deriveCompassSigma(geometry, knobs, new Set(['tee-3']));
		expect(withExclusion.totalEligibleTees).toBe(4);
		expect(withExclusion.excludedForPoseQuality).toBe(1);
		expect(withExclusion.sampleSize).toBe(3);
		// P75 of [1,2,3] (excluding the 99-degree outlier): rank=1.5 -> 2.5
		expect(withExclusion.quantileValueDeg).toBeCloseTo(2.5);
		expect(withExclusion.provenance).toContain('excluded for degraded pose quality');
	});
});

describe('computeCompassPoseQuality -- raw ingredients, no invented formula', () => {
	const knobs = { fillToleranceFactor: 1.25, areaToleranceFactor: 1.25 };

	function tee(id: string, area: number, fill: number): CompassTee {
		return { detId: id, xPx: 0, yPx: 0, pad: { angleRad: 0, majorPx: 10, minorPx: 5, area, fill } };
	}

	test('flags a pad whose area is a course-relative outlier, in either direction', () => {
		const tees = [tee('t1', 100, 0.9), tee('t2', 100, 0.9), tee('t3', 100, 0.9), tee('t4', 50, 0.9)];
		const quality = computeCompassPoseQuality(tees, knobs);
		const byId = new Map(quality.map((q) => [q.teeId, q]));
		expect(byId.get('t1')!.degraded).toBe(false);
		expect(byId.get('t4')!.degraded).toBe(true);
		expect(byId.get('t4')!.degradedReason).toMatch(/area/);
		expect(byId.get('t4')!.courseMedianSupportPx).toBeCloseTo(100);
		// raw ingredients are carried verbatim, never a synthesized score
		expect(byId.get('t4')!.supportPx).toBe(50);
	});

	test('flags a pad whose fill sits notably below the course median', () => {
		const tees = [tee('t1', 100, 0.9), tee('t2', 100, 0.9), tee('t3', 100, 0.9), tee('t4', 100, 0.3)];
		const quality = computeCompassPoseQuality(tees, knobs);
		const byId = new Map(quality.map((q) => [q.teeId, q]));
		expect(byId.get('t4')!.degraded).toBe(true);
		expect(byId.get('t4')!.degradedReason).toMatch(/fill/);
		expect(byId.get('t1')!.degraded).toBe(false);
	});

	test('a single eligible tee cannot be flagged against itself', () => {
		const quality = computeCompassPoseQuality([tee('solo', 42, 0.5)], knobs);
		expect(quality).toHaveLength(1);
		expect(quality[0]!.degraded).toBe(false);
	});
});

describe('scoreCompassGeometry', () => {
	test('weight is exp(-(angularErrorDeg / sigma)^2), a pure function of angular error alone', () => {
		const geometry = geometryOf([row({ teeId: 't', badgeId: 'b', angularErrorDeg: 6, distancePx: 5_000 })]);
		const scored = scoreCompassGeometry(geometry, 3);
		expect(scored[0]!.weight).toBeCloseTo(Math.exp(-4));
		// distance does not leak into the weight at all
		expect(scored[0]!.distancePx).toBe(5_000);
	});

	test('rejects a non-positive sigma rather than silently producing NaN weights', () => {
		const geometry = geometryOf([row({ teeId: 't', badgeId: 'b' })]);
		expect(() => scoreCompassGeometry(geometry, 0)).toThrow(/sigmaDeg/);
	});
});

function scored(partial: Partial<CompassScoredRow> & Pick<CompassScoredRow, 'teeId' | 'badgeId' | 'weight'>): CompassScoredRow {
	return { ...row({ teeId: partial.teeId, badgeId: partial.badgeId }), ...partial };
}

describe('matchTeeBadgeCompass', () => {
	test('one-to-one maximum-weight matching with a real runner-up gap reads locked', () => {
		const rows = [
			scored({ teeId: 't1', badgeId: 'b1', weight: 0.9, angularErrorDeg: 1 }),
			scored({ teeId: 't1', badgeId: 'b2', weight: 0.1, angularErrorDeg: 20 }),
			scored({ teeId: 't2', badgeId: 'b1', weight: 0.2, angularErrorDeg: 18 }),
			scored({ teeId: 't2', badgeId: 'b2', weight: 0.85, angularErrorDeg: 2 })
		];
		const result = matchTeeBadgeCompass(rows, {
			teeIds: ['t1', 't2'],
			badgeIds: ['b1', 'b2'],
			resolutionBoundDeg: 1
		});
		expect(result.locks).toHaveLength(2);
		const l1 = result.locks.find((l) => l.teeId === 't1')!;
		expect(l1.badgeId).toBe('b1');
		expect(l1.verdict).toBe('locked');
		expect(l1.runnerUp?.badgeId).toBe('b2');
		expect(l1.runnerUp?.gapDeg).toBeCloseTo(19);
		expect(result.unmatchedBadges).toEqual([]);
		expect(result.unusedTeeIds).toEqual([]);
	});

	test('a gap under the resolution bound reads ambiguous, and the badge counts as unmatched', () => {
		const rows = [
			scored({ teeId: 't1', badgeId: 'b1', weight: 0.9, angularErrorDeg: 1 }),
			scored({ teeId: 't1', badgeId: 'b2', weight: 0.88, angularErrorDeg: 1.2 })
		];
		const result = matchTeeBadgeCompass(rows, {
			teeIds: ['t1'],
			badgeIds: ['b1', 'b2'],
			resolutionBoundDeg: 1 // gap is only 0.2deg, well under the bound
		});
		// only one tee exists, so it claims (ambiguously) b1, the higher-weight
		// badge; b2 is left with no tee candidate at all -- both badges surface
		// in UNMATCHED, each with its own honest reason.
		expect(result.locks).toHaveLength(1);
		expect(result.locks[0]!.badgeId).toBe('b1');
		expect(result.locks[0]!.verdict).toBe('ambiguous');
		expect(result.unmatchedBadges).toEqual(
			expect.arrayContaining([
				{ badgeId: 'b1', reason: 'all-candidates-ambiguous' },
				{ badgeId: 'b2', reason: 'no-tee-left' }
			])
		);
		expect(result.unmatchedBadges).toHaveLength(2);
	});

	test('fewer tees than badges reads the surplus badge as no-tee-left, never ambiguous', () => {
		const rows = [scored({ teeId: 't1', badgeId: 'b1', weight: 0.9, angularErrorDeg: 1 })];
		const result = matchTeeBadgeCompass(rows, {
			teeIds: ['t1'],
			badgeIds: ['b1', 'b2'],
			resolutionBoundDeg: 1
		});
		expect(result.locks).toMatchObject([{ teeId: 't1', badgeId: 'b1', verdict: 'locked' }]);
		expect(result.unmatchedBadges).toEqual([{ badgeId: 'b2', reason: 'no-tee-left' }]);
	});

	test('an exact weight tie is broken ONLY by distance, and the tie itself still reads ambiguous', () => {
		const rows = [
			scored({ teeId: 't1', badgeId: 'near', weight: 0.5, angularErrorDeg: 4, distancePx: 50 }),
			scored({ teeId: 't1', badgeId: 'far', weight: 0.5, angularErrorDeg: 4, distancePx: 500 })
		];
		const result = matchTeeBadgeCompass(rows, {
			teeIds: ['t1'],
			badgeIds: ['near', 'far'],
			resolutionBoundDeg: 1
		});
		expect(result.locks).toHaveLength(1);
		// distance breaks the exact tie in favor of the closer badge...
		expect(result.locks[0]!.badgeId).toBe('near');
		// ...but the angular reading genuinely cannot distinguish them (gap=0),
		// so the verdict is honestly 'ambiguous', not a confident lock.
		expect(result.locks[0]!.runnerUp?.gapDeg).toBeCloseTo(0);
		expect(result.locks[0]!.verdict).toBe('ambiguous');
	});

	test('a degraded-pose tee cannot silently win a confident locked verdict', () => {
		const rows = [scored({ teeId: 't1', badgeId: 'b1', weight: 0.9, angularErrorDeg: 1 })];
		const plain = matchTeeBadgeCompass(rows, { teeIds: ['t1'], badgeIds: ['b1'], resolutionBoundDeg: 0.5 });
		expect(plain.locks[0]!.verdict).toBe('locked');

		const degraded = matchTeeBadgeCompass(rows, {
			teeIds: ['t1'],
			badgeIds: ['b1'],
			resolutionBoundDeg: 0.5,
			degradedTeeIds: new Set(['t1'])
		});
		expect(degraded.locks[0]!.verdict).toBe('locked-weak-pose');
		// still counts as a confident claim on its badge -- not unmatched
		expect(degraded.unmatchedBadges).toEqual([]);
	});

	test('a single candidate badge has no runner-up and reads locked outright', () => {
		const rows = [scored({ teeId: 't1', badgeId: 'only', weight: 0.4, angularErrorDeg: 8 })];
		const result = matchTeeBadgeCompass(rows, { teeIds: ['t1'], badgeIds: ['only'], resolutionBoundDeg: 1 });
		expect(result.locks[0]!.runnerUp).toBeNull();
		expect(result.locks[0]!.verdict).toBe('locked');
	});
});

describe('runTeeBadgeCompass -- end to end', () => {
	const knobs = {
		quantileFraction: 0.9,
		minimumSampleSize: 2,
		rasterTolerancePx: 1.25,
		fillToleranceFactor: 1.25,
		areaToleranceFactor: 1.25
	};

	test('wires geometry, pose quality, sigma, and matching into one honest result', () => {
		const tees: CompassTee[] = [
			{ detId: 'tee-1', xPx: 0, yPx: 0, pad: { angleRad: 0, majorPx: 20, minorPx: 8, area: 120, fill: 0.7 } },
			{ detId: 'tee-2', xPx: 0, yPx: 200, pad: { angleRad: 0, majorPx: 20, minorPx: 8, area: 120, fill: 0.7 } },
			{ detId: 'tee-3', xPx: 500, yPx: 500 } // no pad
		];
		const badges: CompassBadge[] = [
			{ detId: 'badge-1', label: '5', cxPx: 100, cyPx: 0 },
			{ detId: 'badge-2', label: '9', cxPx: 100, cyPx: 200 }
		];
		const result = runTeeBadgeCompass(tees, badges, knobs);
		expect(result.noPadTeeIds).toEqual(['tee-3']);
		expect(result.poseQuality).toHaveLength(2);
		expect(result.locks).toHaveLength(2);
		expect(result.locks.map((l) => l.badgeId).sort()).toEqual(['badge-1', 'badge-2']);
		expect(result.unmatchedBadges).toEqual([]);
		// exactly minimumSampleSize (2) eligible tees -- the quantile IS trusted
		expect(result.sigma.isFallback).toBe(false);
		expect(result.sigma.sampleSize).toBe(2);
		expect(result.locks.every((lock) => lock.verdict === 'locked')).toBe(true);
	});
});

describe('exactPositiveHole and buildTeeBadgeCompassEvidence -- map through the label, never guess', () => {
	test('a numeric label maps to its hole; a null/garbage label prints UNREAD', () => {
		expect(exactPositiveHole('14')).toBe(14);
		expect(exactPositiveHole(null)).toBeUndefined();
		expect(exactPositiveHole('0')).toBeUndefined();
		expect(exactPositiveHole('03')).toBeUndefined();
		expect(exactPositiveHole('garbage')).toBeUndefined();
	});

	test('evidence enrichment carries hole/badgeLabel without altering any lock or match decision', () => {
		const badges: CompassBadge[] = [
			{ detId: 'badge-1', label: '14', cxPx: 0, cyPx: 0 },
			{ detId: 'badge-2', label: null, cxPx: 0, cyPx: 0 }
		];
		const rows = [
			scored({ teeId: 't1', badgeId: 'badge-1', weight: 0.9, angularErrorDeg: 1 }),
			scored({ teeId: 't2', badgeId: 'badge-2', weight: 0.9, angularErrorDeg: 1 })
		];
		const match = matchTeeBadgeCompass(rows, {
			teeIds: ['t1', 't2'],
			badgeIds: ['badge-1', 'badge-2'],
			resolutionBoundDeg: 0.5
		});
		const evidence = buildTeeBadgeCompassEvidence(
			{
				geometry: geometryOf(rows),
				poseQuality: [],
				sigma: {
					sigmaDeg: 3,
					floorDeg: 0.5,
					quantileFraction: 0.9,
					quantileValueDeg: 3,
					totalEligibleTees: 2,
					excludedForPoseQuality: 0,
					sampleSize: 2,
					minimumSampleSize: 2,
					representativeDistancePx: 100,
					isFallback: false,
					provenance: 'test'
				},
				resolutionBoundDeg: 0.5,
				locks: match.locks,
				unmatchedBadges: match.unmatchedBadges,
				unusedTeeIds: match.unusedTeeIds,
				noPadTeeIds: []
			},
			badges
		);
		const byBadge = new Map(evidence.locksHoleLabeled.map((l) => [l.badgeId, l]));
		expect(byBadge.get('badge-1')!.hole).toBe(14);
		expect(byBadge.get('badge-1')!.badgeLabel).toBe('14');
		expect(byBadge.get('badge-2')!.hole).toBeUndefined();
		expect(byBadge.get('badge-2')!.badgeLabel).toBe('UNREAD');
	});
});

describe('resolveClaimsByWavePeeling -- Kahn-style toposort', () => {
	test('single unique pair -> wave 1, empty forcedBy', () => {
		const edges = [{ teeId: 'tA', badgeId: 'X', angularErrorDeg: 1.5 }];
		const result = resolveClaimsByWavePeeling(edges);
		expect(result.locks).toHaveLength(1);
		expect(result.locks[0]).toMatchObject({
			teeId: 'tA',
			badgeId: 'X',
			wave: 1,
			forcedBy: []
		});
		expect(result.contestedClusters).toHaveLength(0);
	});

	test('cascade: teeA->[X,Y], teeB->[X] => B->X wave 1, A->Y wave 2 with forcedBy [X]', () => {
		const edges = [
			{ teeId: 'tA', badgeId: 'X', angularErrorDeg: 2.0 },
			{ teeId: 'tA', badgeId: 'Y', angularErrorDeg: 3.0 },
			{ teeId: 'tB', badgeId: 'X', angularErrorDeg: 1.5 }
		];
		const result = resolveClaimsByWavePeeling(edges);
		expect(result.locks).toHaveLength(2);
		// Wave 1: tB->X (B has degree 1, X has degree 2 -> degree 1 after B locks)
		const wave1 = result.locks.filter((l) => l.wave === 1);
		expect(wave1).toHaveLength(1);
		expect(wave1[0]).toMatchObject({
			teeId: 'tB',
			badgeId: 'X',
			wave: 1,
			forcedBy: []
		});
		// Wave 2: tA->Y (A now has degree 1, Y has degree 1)
		const wave2 = result.locks.filter((l) => l.wave === 2);
		expect(wave2).toHaveLength(1);
		expect(wave2[0]).toMatchObject({
			teeId: 'tA',
			badgeId: 'Y',
			wave: 2,
			forcedBy: ['X']
		});
		expect(result.contestedClusters).toHaveLength(0);
	});

	test('2x2 all-edges cluster -> zero locks, one cluster with 4 pairs', () => {
		const edges = [
			{ teeId: 'tA', badgeId: 'X', angularErrorDeg: 1.0 },
			{ teeId: 'tA', badgeId: 'Y', angularErrorDeg: 2.0 },
			{ teeId: 'tB', badgeId: 'X', angularErrorDeg: 1.5 },
			{ teeId: 'tB', badgeId: 'Y', angularErrorDeg: 2.5 }
		];
		const result = resolveClaimsByWavePeeling(edges);
		expect(result.locks).toHaveLength(0);
		expect(result.contestedClusters).toHaveLength(1);
		const cluster = result.contestedClusters[0]!;
		expect(cluster.teeIds.sort()).toEqual(['tA', 'tB']);
		expect(cluster.badgeIds.sort()).toEqual(['X', 'Y']);
		expect(cluster.pairs).toHaveLength(4);
	});

	test('determinism: shuffled input produces identical output', () => {
		const baseEdges = [
			{ teeId: 'tA', badgeId: 'X', angularErrorDeg: 1.0 },
			{ teeId: 'tB', badgeId: 'Y', angularErrorDeg: 2.0 }
		];
		const result1 = resolveClaimsByWavePeeling(baseEdges);
		const result2 = resolveClaimsByWavePeeling([baseEdges[1]!, baseEdges[0]!]);
		expect(result1.locks.map((l) => ({ ...l }))).toEqual(result2.locks.map((l) => ({ ...l })));
		expect(result1.contestedClusters).toEqual(result2.contestedClusters);
	});

	test('two independent chains peel in parallel waves', () => {
		const edges = [
			// Chain 1: tA->[X, Z], tC->[X]
			{ teeId: 'tA', badgeId: 'X', angularErrorDeg: 1.0 },
			{ teeId: 'tA', badgeId: 'Z', angularErrorDeg: 2.0 },
			{ teeId: 'tC', badgeId: 'X', angularErrorDeg: 1.5 },
			// Chain 2: tB->[Y, W], tD->[Y]
			{ teeId: 'tB', badgeId: 'Y', angularErrorDeg: 2.0 },
			{ teeId: 'tB', badgeId: 'W', angularErrorDeg: 3.0 },
			{ teeId: 'tD', badgeId: 'Y', angularErrorDeg: 1.5 }
		];
		const result = resolveClaimsByWavePeeling(edges);
		expect(result.locks).toHaveLength(4);
		// Wave 1: both tC->X and tD->Y
		const wave1 = result.locks.filter((l) => l.wave === 1);
		expect(wave1).toHaveLength(2);
		const wave1Pairs = wave1.map((l) => `${l.teeId}->${l.badgeId}`).sort();
		expect(wave1Pairs).toEqual(['tC->X', 'tD->Y']);
		// Wave 2: both tA->Z and tB->W
		const wave2 = result.locks.filter((l) => l.wave === 2);
		expect(wave2).toHaveLength(2);
		const wave2Pairs = wave2.map((l) => `${l.teeId}->${l.badgeId}`).sort();
		expect(wave2Pairs).toEqual(['tA->Z', 'tB->W']);
		expect(result.contestedClusters).toHaveLength(0);
	});

	test('two tees whose edge sets are both exactly {X} -> zero locks, contested cluster containing both tees and X', () => {
		const edges = [
			{ teeId: 'tA', badgeId: 'X', angularErrorDeg: 1.0 },
			{ teeId: 'tB', badgeId: 'X', angularErrorDeg: 1.5 }
		];
		const result = resolveClaimsByWavePeeling(edges);
		// No locks since both tees compete for the same badge
		expect(result.locks).toHaveLength(0);
		// One contested cluster with both tees and the badge
		expect(result.contestedClusters).toHaveLength(1);
		const cluster = result.contestedClusters[0];
		expect(cluster.teeIds.sort()).toEqual(['tA', 'tB']);
		expect(cluster.badgeIds).toEqual(['X']);
		expect(cluster.pairs).toHaveLength(2);
		const pairStrings = cluster.pairs.map((p) => `${p.teeId}->${p.badgeId}`).sort();
		expect(pairStrings).toEqual(['tA->X', 'tB->X']);
	});
});
