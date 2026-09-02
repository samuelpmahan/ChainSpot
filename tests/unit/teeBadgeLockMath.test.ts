import { describe, expect, test } from 'vitest';
import {
	buildTeeBadgeLockEvidence,
	collapseTeeBadgePaths,
	extractTeeBadgePaths,
	maximumWeightTeeBadgeMatching,
	readImageSigma,
	readTeeAxis,
	scoreTeeBadgeRay,
	selectTeeBadgeLocks,
	scoreTeeBadgeCandidates,
	scoreTeeBadgePath,
	traceBadgeToBasket,
	UNKNOWN_SIGMA_FALLBACK_DEG,
	type BadgeBasketTraceInput,
	type CompassImageSigma,
	type CompassTeeAxis,
	type TeeBadgeLockMathKnobs,
	type TeeBadgeLockRawPairRow,
	type TeeBadgeLockScoredCandidate,
	type TeeBadgeLockSupportField
} from '@chainspot/alg/detectors/threeFactor/features/g4.teeBadgeLockMath';

type Path = readonly (readonly [number, number])[];

const KNOBS: TeeBadgeLockMathKnobs = {
	alignmentPower: 2,
	worstWindowSrcPx: 2,
	minWindowCells: 2
};

function leg(path: Path) {
	return {
		endpointId: 'tee',
		geodesic: Math.max(0, path.length - 1),
		path,
		reachable: true
	};
}

function rawPair(
	badgeId: string,
	teeId: string,
	basketId: string,
	path: Path
): TeeBadgeLockRawPairRow {
	return {
		badgeId,
		teeId,
		basketId,
		teeLeg: leg(path),
		basketLeg: leg(path),
		supportMean: 999,
		supportMin: 999,
		supportedFraction: 999,
		worstWindowMean: 999,
		weakSpanCount: 999,
		weakSpanLongestPx: 999,
		pathLengthPx: 999,
		straightDistancePx: 999,
		efficiency: 999,
		endpointSupportTee: 999,
		endpointSupportBasket: 999,
		failureReason: 'forbidden legacy score'
	} as unknown as TeeBadgeLockRawPairRow;
}

function field(
	width: number,
	height: number,
	support: readonly number[],
	bestTheta: readonly number[]
): TeeBadgeLockSupportField {
	return {
		width,
		height,
		scale: 1,
		support: Float32Array.from(support),
		bestTheta: Float32Array.from(bestTheta)
	};
}

function scored(badgeId: string, teeId: string, score: number): TeeBadgeLockScoredCandidate {
	return {
		badgeId,
		teeId,
		teeBadgePath: [
			[0, 0],
			[1, 0]
		],
		score,
		weakAlignedSupport: score,
		pathEfficiency: 1,
		axisErrorDeg: 0,
		axisSource: 'TeeEvidence.angleRad',
		runnerUpMargin: null
	} as unknown as TeeBadgeLockScoredCandidate;
}

describe('teeBadgeLock pure candidate contract', () => {
	test('strips raw rows before pure math, collapses basket duplicates, and refuses divergent paths', () => {
		// Legacy teeLeg testimony is badge → tee. Public teeBadgePath reverses
		// those exact sampled points without interpolation or refitting.
		const legacyPath: Path = [
			[0, 0],
			[1, 0],
			[2, 0]
		];
		const first = rawPair('badge-1', 'tee-1', 'basket-a', legacyPath);
		const duplicate = rawPair('badge-1', 'tee-1', 'basket-b', legacyPath);
		Object.defineProperty(first as object, 'basketId', {
			get() {
				throw new Error('teeBadgeLock must not read basketId');
			}
		});
		Object.defineProperty(first as object, 'basketLeg', {
			get() {
				throw new Error('teeBadgeLock must not read basketLeg');
			}
		});
		Object.defineProperty(first as object, 'supportMean', {
			get() {
				throw new Error('teeBadgeLock must not read legacy joint score');
			}
		});
		Object.defineProperty(first as object, 'jointScore', {
			get() {
				throw new Error('teeBadgeLock must not read legacy joint score');
			}
		});

		const collapsed = extractTeeBadgePaths([first, duplicate]);
		expect(collapsed).toEqual([
			{
				badgeId: 'badge-1',
				teeId: 'tee-1',
				teeBadgePath: [...legacyPath].reverse()
			}
		]);
		expect(extractTeeBadgePaths).toBe(collapseTeeBadgePaths);
		expect(Object.keys(collapsed[0] ?? {}).sort()).toEqual(['badgeId', 'teeBadgePath', 'teeId']);
		const changedJointScores = rawPair('badge-1', 'tee-1', 'basket-any', legacyPath) as any;
		Object.assign(changedJointScores, {
			jointScore: -1,
			supportMean: -2,
			supportMin: -3,
			supportedFraction: -4,
			worstWindowMean: -5,
			pathLengthPx: -6,
			straightDistancePx: -7,
			efficiency: -8
		});
		expect(JSON.stringify(extractTeeBadgePaths([changedJointScores]))).toBe(
			JSON.stringify(collapsed)
		);

		expect(() =>
			collapseTeeBadgePaths([
				rawPair('badge-1', 'tee-1', 'basket-a', legacyPath),
				rawPair('badge-1', 'tee-1', 'basket-b', [
					[0, 0],
					[1, 1],
					[2, 0]
				])
			])
		).toThrow(/duplicate.*teeBadgePath|teeBadgePath.*duplicate/i);
	});

	test('CL-6a: uses the literal weak-window and route-efficiency terms as corroboration only, never the winning score', () => {
		const candidate = {
			badgeId: 'badge-1',
			teeId: 'tee-1',
			teeBadgePath: [
				[0, 0],
				[1, 0],
				[2, 0]
			] as Path
		};
		const imageSigma = { orientationSigmaDeg: 45, sigmaProvenance: { method: 'test-fixture', goodFitCount: 9 } };
		const aligned = scoreTeeBadgePath({
			candidate,
			field: field(3, 1, [1, 0.5, 0.2], [0, 0, 0]),
			teeAxisRad: 0,
			imageSigma,
			knobs: KNOBS
		});
		// w=max(2, round(2 / 1))=2; min(mean(1,.5), mean(.5,.2))=.35 -- still
		// computed and carried as corroboration, but CL-6a means it may only
		// perturb the ray-dominated score within ROUTE_TIE_BREAK_EPSILON.
		expect(aligned.windowCells).toBe(2);
		expect(aligned.weakAlignedSupport).toBeCloseTo(0.35);
		expect(aligned.pathEfficiency).toBe(1);
		expect(aligned.axisErrorDeg).toBeCloseTo(0);
		expect(aligned.axisFactor).toBeCloseTo(1);
		expect(aligned.rayDegraded).toBe(false);
		expect(aligned.score).toBeCloseTo(1, 5); // ray dominates: perfect alignment -> ~1, not 0.35
		expect(aligned.score).toBeGreaterThan(1); // corroboration only nudges upward, never overrides
		expect(aligned.score - 1).toBeLessThan(1e-5); // and the nudge stays within tie-break precision
		expect(aligned.axisSource).toBe('TeeEvidence.angleRad');

		const oppositeAxis = scoreTeeBadgePath({
			candidate,
			field: field(3, 1, [1, 0.5, 0.2], [0, 0, 0]),
			teeAxisRad: Math.PI,
			imageSigma,
			knobs: KNOBS
		});
		expect(oppositeAxis.axisErrorDeg).toBeCloseTo(0);

		const perpendicular = scoreTeeBadgePath({
			candidate,
			field: field(3, 1, [1, 0.5, 0.2], [0, 0, 0]),
			teeAxisRad: Math.PI / 2,
			imageSigma,
			knobs: KNOBS
		});
		expect(perpendicular.axisErrorDeg).toBeCloseTo(90);
		expect(perpendicular.axisFactor).toBeCloseTo(Math.exp(-4));
		// CL-6a: route factors only tie-break, so the poorly-aligned candidate's
		// score still tracks its (tiny) ray factor, not the old product form.
		expect(perpendicular.score).toBeCloseTo(Math.exp(-4), 5);

		const unknownAxis = scoreTeeBadgePath({
			candidate,
			field: field(3, 1, [1, 0.5, 0.2], [0, 0, 0]),
			teeAxisRad: null,
			imageSigma,
			knobs: KNOBS
		});
		expect(unknownAxis.axisErrorDeg).toBe('UNKNOWN');
		expect(unknownAxis.axisSource).toBe('UNKNOWN');
		expect(unknownAxis.axisFactor).toBe(1);
		expect(unknownAxis.rayDegraded).toBe(true);
		// Degraded (no accepted axis fit at all): the score IS the corroboration,
		// unperturbed, since there is no ray term to dominate.
		expect(unknownAxis.score).toBeCloseTo(0.35);

		const routed = scoreTeeBadgePath({
			candidate: {
				badgeId: 'badge-2',
				teeId: 'tee-2',
				teeBadgePath: [
					[0, 0],
					[0, 1],
					[1, 1]
				]
			},
			field: field(2, 2, [1, 1, 1, 1], [0, 0, 0, 0]),
			teeAxisRad: Math.PI / 4,
			knobs: { ...KNOBS, alignmentPower: 0 }
		});
		expect(routed.weakAlignedSupport).toBe(1);
		expect(routed.pathEfficiency).toBeCloseTo(Math.SQRT2 / 2);
		// Perfect ray alignment (axis matches the chord exactly) -> rayFactor=1
		// dominates; pathEfficiency is corroboration, visible only in the tiny
		// tie-break term now, not as a multiplicative discount on the score.
		expect(routed.score).toBeCloseTo(1, 5);
	});

	test('uses the visible min-area pose before baseline tee-angle compatibility fallbacks', () => {
		const [scoredCandidate] = scoreTeeBadgeCandidates({
			candidates: [
				{
					badgeId: 'badge-1',
					teeId: 'tee-1',
					teeBadgePath: [
						[0, 0],
						[2, 0]
					]
				}
			],
			field: field(3, 1, [1, 1, 1], [0, 0, 0]),
			tees: [
				{
					detId: 'tee-1',
					xPx: 0,
					yPx: 0,
					angleRad: Math.PI / 2,
					pad: { angleRad: Math.PI / 2, minAreaPose: { angleRad: 0 } }
				}
			],
			badges: [{ detId: 'badge-1', cxPx: 2, cyPx: 0 }],
			knobs: KNOBS
		});
		expect(scoredCandidate).toMatchObject({
			axisSource: 'TeeEvidence.pad.minAreaPose.angleRad',
			axisErrorDeg: 0
		});
	});

	test('performs deterministic max-weight one-to-one matching with zero dummy slots and no threshold', () => {
		expect(selectTeeBadgeLocks).toBe(maximumWeightTeeBadgeMatching);
		const rectangular = maximumWeightTeeBadgeMatching([
			scored('badge-1', 'tee-only', 0.6),
			scored('badge-2', 'tee-only', 0.2)
		]);
		expect(rectangular.candidates).toHaveLength(2);
		expect(rectangular.locks).toMatchObject([
			{ badgeId: 'badge-1', teeId: 'tee-only', score: 0.6 }
		]);
		expect(rectangular.unmatchedBadgeIds).toEqual(['badge-2']);
		expect(rectangular.unusedTeeIds).toEqual([]);
		expect(rectangular.locks.some((lock) => /dummy/i.test(lock.badgeId + lock.teeId))).toBe(false);

		const zero = maximumWeightTeeBadgeMatching([scored('badge-0', 'tee-0', 0)]);
		expect(zero.locks).toMatchObject([{ badgeId: 'badge-0', teeId: 'tee-0', score: 0 }]);

		// A missing matrix edge is not a score-0 alternative. Sparse dummy
		// slots must remain worse than eligible real zero/negative candidates,
		// so this sparse graph still gets its two real locks.
		const sparse = maximumWeightTeeBadgeMatching([
			scored('badge-1', 'tee-1', -1),
			scored('badge-2', 'tee-2', 0)
		]);
		expect(sparse.locks).toHaveLength(2);
		expect(sparse.locks).toMatchObject([
			{ badgeId: 'badge-1', teeId: 'tee-1', score: -1 },
			{ badgeId: 'badge-2', teeId: 'tee-2', score: 0 }
		]);
		expect(sparse.unmatchedBadgeIds).toEqual([]);
		expect(sparse.unusedTeeIds).toEqual([]);

		const empty = maximumWeightTeeBadgeMatching([], {
			badges: [
				{ detId: 'badge-H2', label: '2' },
				{ detId: 'badge-H1', label: '1' }
			],
			tees: [{ detId: 'tee-b' }, { detId: 'tee-a' }]
		});
		expect(empty.unmatchedBadgeIds).toEqual(['badge-H1', 'badge-H2']);
		expect(empty.unusedTeeIds).toEqual(['tee-a', 'tee-b']);

		const tied = [
			scored('badge-a', 'tee-a', 1),
			scored('badge-a', 'tee-b', 1),
			scored('badge-b', 'tee-a', 1),
			scored('badge-b', 'tee-b', 1)
		];
		const first = maximumWeightTeeBadgeMatching(tied);
		const permuted = maximumWeightTeeBadgeMatching([...tied].reverse());
		const pairs = (value: typeof first) =>
			value.locks
				.map((lock) => [lock.badgeId, lock.teeId])
				.sort((a, b) => a.join(':').localeCompare(b.join(':')));
		expect(pairs(permuted)).toEqual(pairs(first));
	});
});

describe('teeBadgeLock all-Hn resolver: every unmatched badge is named, never silent', () => {
	const badges = [
		{ detId: 'badge-1', label: '1' },
		{ detId: 'badge-2', label: '2' },
		{ detId: 'badge-3', label: '3' }
	];

	test('two tees, one badge: the loser is named as a conflict with the winner it lost to', () => {
		// badge-1 and badge-2 both reach tee-shared; badge-1 outscores badge-2.
		// badge-3 has zero testimony (orphan).
		const candidates = [
			scored('badge-1', 'tee-shared', 0.9),
			scored('badge-2', 'tee-shared', 0.4)
		];
		const selected = maximumWeightTeeBadgeMatching(candidates, {
			badges,
			tees: [{ detId: 'tee-shared' }]
		});
		expect(selected.locks).toMatchObject([{ badgeId: 'badge-1', teeId: 'tee-shared' }]);
		expect([...selected.unmatchedBadgeIds].sort()).toEqual(['badge-2', 'badge-3']);

		const evidence = buildTeeBadgeLockEvidence(selected, { badges });
		expect(evidence.abstentions).toHaveLength(2);

		const conflict = evidence.abstentions.find((a) => a.badgeId === 'badge-2');
		expect(conflict).toMatchObject({
			hole: 2,
			kind: 'conflict',
			bestTeeId: 'tee-shared',
			bestScore: 0.4,
			winningBadgeId: 'badge-1',
			winningHole: 1,
			winningScore: 0.9
		});
		expect(conflict?.reason).toMatch(/H2/);
		expect(conflict?.reason).toMatch(/tee-shared/);
		expect(conflict?.reason).toMatch(/H1/);
		expect(conflict?.reason).toMatch(/conflict/i);

		const orphan = evidence.abstentions.find((a) => a.badgeId === 'badge-3');
		expect(orphan).toMatchObject({ hole: 3, kind: 'orphan' });
		expect(orphan?.bestTeeId).toBeUndefined();
		expect(orphan?.reason).toMatch(/H3/);
		expect(orphan?.reason).toMatch(/no tee testimony/i);

		// Never silent: every unmatched badge id has exactly one abstention row.
		expect(evidence.abstentions.map((a) => a.badgeId).sort()).toEqual(
			selected.unmatchedBadgeIds.slice().sort()
		);
	});

	test('one tee, three badges: the two losers are each a named conflict against the single winner, never silence', () => {
		const candidates = [
			scored('badge-1', 'tee-only', 0.9),
			scored('badge-2', 'tee-only', 0.4),
			scored('badge-3', 'tee-only', 0.1)
		];
		const selected = maximumWeightTeeBadgeMatching(candidates, {
			badges,
			tees: [{ detId: 'tee-only' }]
		});
		expect(selected.locks).toMatchObject([{ badgeId: 'badge-1', teeId: 'tee-only' }]);
		const evidence = buildTeeBadgeLockEvidence(selected, { badges });
		expect(evidence.abstentions.map((a) => a.badgeId).sort()).toEqual(['badge-2', 'badge-3']);
		for (const a of evidence.abstentions) {
			expect(a.kind).toBe('conflict');
			expect(a.winningBadgeId).toBe('badge-1');
			expect(a.reason.length).toBeGreaterThan(0);
		}
	});

	test('degenerate calibration (all-zero support field): scores collapse to 0, never NaN, and every badge still gets a lock or a named abstention', () => {
		const zeroField = field(2, 1, [0, 0], [0, 0]);
		const scoredCandidates = scoreTeeBadgeCandidates({
			candidates: [
				{ badgeId: 'badge-1', teeId: 'tee-1', teeBadgePath: [[0, 0], [1, 0]] },
				{ badgeId: 'badge-2', teeId: 'tee-2', teeBadgePath: [[0, 0], [1, 0]] }
			],
			field: zeroField,
			knobs: KNOBS
		});
		for (const candidate of scoredCandidates) {
			expect(Number.isFinite(candidate.score)).toBe(true);
			expect(candidate.score).toBe(0);
		}
		const selected = maximumWeightTeeBadgeMatching(scoredCandidates, {
			badges: badges.slice(0, 2),
			tees: [{ detId: 'tee-1' }, { detId: 'tee-2' }]
		});
		const evidence = buildTeeBadgeLockEvidence(selected, { badges: badges.slice(0, 2) });
		// No threshold means zero scores still lock; nothing is dropped for being
		// "too weak" -- degenerate calibration widens nothing here because there
		// was exactly one real edge per badge, so no NaN/Infinity ever appears
		// and abstentions.length + locks.length accounts for every badge.
		expect(evidence.locks.length + evidence.abstentions.length).toBe(2);
		expect(evidence.locks.every((l) => Number.isFinite(l.score))).toBe(true);
	});
});

describe('CL-6a/CL-4/CL-5: ray-first stage A scoring', () => {
	test('the ray overrides a route-favored candidate: the badge the axis actually points at wins, and the audit says why', () => {
		const width = 6;
		const height = 6;
		const support = new Float32Array(width * height).fill(0);
		const bestTheta = new Float32Array(width * height).fill(0);
		// Path A: straight up column x=0 -- strong route support (route favors A).
		// bestTheta matches the column's own tangent (vertical) so alignment=1.
		for (let y = 0; y <= 5; y++) {
			support[y * width + 0] = 0.9;
			bestTheta[y * width + 0] = Math.PI / 2;
		}
		// Path B: straight right row y=0 -- weak route support (route disfavors
		// B); bestTheta 0 already matches the row's own (near-horizontal) tangent.
		for (let x = 0; x <= 5; x++) support[0 * width + x] = Math.max(support[0 * width + x], 0.05);
		const fixtureField: TeeBadgeLockSupportField = { width, height, scale: 1, support, bestTheta };
		const candidates = [
			{ badgeId: 'badge-A', teeId: 'tee-1', teeBadgePath: [[0, 0], [0, 5]] as Path },
			{ badgeId: 'badge-B', teeId: 'tee-1', teeBadgePath: [[0, 0], [5, 0.2]] as Path }
		];
		// The tee's own axis points along +x (angleRad=0) -- straight at badge B,
		// 90 degrees away from badge A.
		const tees = [{ detId: 'tee-1', xPx: 0, yPx: 0, angleRad: 0 }];
		const badges = [
			{ detId: 'badge-A', label: '1', cxPx: 0, cyPx: 5 },
			{ detId: 'badge-B', label: '2', cxPx: 5, cyPx: 0.2 }
		];
		const scored = scoreTeeBadgeCandidates({ candidates, field: fixtureField, tees, badges, knobs: KNOBS });
		const a = scored.find((c) => c.badgeId === 'badge-A')!;
		const b = scored.find((c) => c.badgeId === 'badge-B')!;
		expect(a.weakAlignedSupport).toBeGreaterThan(b.weakAlignedSupport); // route favors A
		expect(b.axisErrorDeg as number).toBeLessThan(a.axisErrorDeg as number); // ray favors B
		expect(b.score).toBeGreaterThan(a.score); // ray wins despite weaker route corroboration

		const selected = maximumWeightTeeBadgeMatching(scored, { badges, tees });
		expect(selected.locks).toMatchObject([{ badgeId: 'badge-B', teeId: 'tee-1' }]);

		const evidence = buildTeeBadgeLockEvidence(selected, { badges, tees });
		const winner = evidence.locks[0];
		expect(winner.badgeId).toBe('badge-B');
		expect(winner.ray?.degraded).toBe(false);
		expect((winner.axisErrorDeg as number) < 10).toBe(true);
		// badge-A is a named conflict (it had real testimony, but lost) -- never silence.
		const loser = evidence.abstentions.find((entry) => entry.badgeId === 'badge-A');
		expect(loser).toMatchObject({ kind: 'conflict', winningBadgeId: 'badge-B' });
	});

	test('poor axis quality degrades the candidate to corroboration-only: route factors alone drive the score', () => {
		const fixtureField = field(6, 1, [0.8, 0.8, 0.8, 0.8, 0.8, 0.8], [0, 0, 0, 0, 0, 0]);
		const poorAxis: CompassTeeAxis = {
			axisRad: Math.PI,
			axisQuality: 'poor',
			axisSource: 'constrained-fit',
			excusedMaskRef: 'excusedMask:tee-1',
			centerUncertaintyPx: 2
		};
		const result = scoreTeeBadgePath({
			candidate: { badgeId: 'badge-1', teeId: 'tee-1', teeBadgePath: [[0, 0], [5, 0]] },
			field: fixtureField,
			compassAxis: poorAxis,
			knobs: KNOBS
		});
		expect(result.rayDegraded).toBe(true);
		expect(result.ray?.degradeReason).toMatch(/poor/i);
		expect(result.axisErrorDeg).toBe('UNKNOWN');
		expect(result.score).toBeCloseTo(result.weakAlignedSupport * result.pathEfficiency);

		const noneAxis: CompassTeeAxis = { ...poorAxis, axisQuality: 'none', axisRad: null };
		const noFit = scoreTeeBadgePath({
			candidate: { badgeId: 'badge-1', teeId: 'tee-1', teeBadgePath: [[0, 0], [5, 0]] },
			field: fixtureField,
			compassAxis: noneAxis,
			knobs: KNOBS
		});
		expect(noFit.rayDegraded).toBe(true);
		expect(noFit.ray?.degradeReason).toMatch(/no accepted axis fit/i);
	});

	test('CL-4: no per-image sigma published -> the named conservative fallback is used, and it is receipted', () => {
		const axis: CompassTeeAxis = {
			axisRad: 0,
			axisQuality: 'good',
			axisSource: 'constrained-fit',
			excusedMaskRef: 'excusedMask:tee-1',
			centerUncertaintyPx: 'UNKNOWN'
		};
		const unknownSigma = readImageSigma(undefined);
		expect(unknownSigma.orientationSigmaDeg).toBe('UNKNOWN');
		const ray = scoreTeeBadgeRay(axis, unknownSigma, Math.PI / 6, 100);
		expect(ray.sigmaUsedDeg).toBe(UNKNOWN_SIGMA_FALLBACK_DEG);
		expect(ray.sigmaProvenance).toMatch(/UNKNOWN_SIGMA_FALLBACK_DEG/);

		const realSigma: CompassImageSigma = readImageSigma({
			orientationSigmaDeg: 2.5,
			sigmaProvenance: { method: 'per-image-fit', goodFitCount: 12 }
		});
		expect(realSigma.orientationSigmaDeg).toBe(2.5);
		const rayReal = scoreTeeBadgeRay(axis, realSigma, 0, 100);
		expect(rayReal.sigmaUsedDeg).toBe(2.5);
		expect(rayReal.sigmaProvenance).toMatch(/per-image-fit/);
		expect(rayReal.sigmaProvenance).toMatch(/n=12/);
	});

	test('CL-5: a small center-uncertainty widens the effective sigma more when the badge is close', () => {
		const axis: CompassTeeAxis = {
			axisRad: 0,
			axisQuality: 'good',
			axisSource: 'constrained-fit',
			excusedMaskRef: 'excusedMask:tee-1',
			centerUncertaintyPx: 4
		};
		const imageSigma: CompassImageSigma = { orientationSigmaDeg: 2, sigmaProvenance: { method: 'test' } };
		const near = scoreTeeBadgeRay(axis, imageSigma, 0.1, 10);
		const far = scoreTeeBadgeRay(axis, imageSigma, 0.1, 1000);
		expect(near.wideningDeg as number).toBeGreaterThan(far.wideningDeg as number);
		expect(near.sigmaUsedDeg as number).toBeGreaterThan(far.sigmaUsedDeg as number);
		expect(near.wideningDeg as number).toBeCloseTo((Math.atan(4 / 10) * 180) / Math.PI, 5);
		const zeroDistance: CompassTeeAxis = axis;
		const degenerate = scoreTeeBadgeRay(zeroDistance, imageSigma, 0, 0);
		// A badge exactly at the tee's own center gets maximal (90deg), honest
		// widening -- never false precision.
		expect(degenerate.wideningDeg).toBe(90);
	});
});

describe('CL-6b: badge -> basket path tracing', () => {
	function buildGridField(
		width: number,
		height: number,
		onPath: (x: number, y: number) => boolean,
		thetaAt: (x: number, y: number) => number
	): TeeBadgeLockSupportField {
		const support = new Float32Array(width * height);
		const bestTheta = new Float32Array(width * height);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const index = y * width + x;
				support[index] = onPath(x, y) ? 1 : 0;
				bestTheta[index] = thetaAt(x, y);
			}
		}
		return { width, height, scale: 1, support, bestTheta };
	}

	test('a bent path is ridge-followed to the terminus around the bend, not a straight cast', () => {
		const width = 16;
		const height = 20;
		const fixtureField = buildGridField(
			width,
			height,
			(x, y) => (y >= 1 && y <= 3 && x >= 0 && x <= 10) || (x >= 9 && x <= 11 && y >= 2 && y <= 17),
			(x, y) => (x < 10 ? 0 : Math.PI / 2)
		);
		const input: BadgeBasketTraceInput = {
			badgeId: 'badge-1',
			startPx: [1, 2],
			headingRad: 0,
			field: fixtureField,
			supportTau: 0.5,
			corridorWidthPx: 2,
			startBadgeBbox: [0, 1, 2, 3],
			occluders: [],
			baskets: [{ basketId: 'basket-bend', bbox: [9, 15, 3, 3] }],
			maxTraceLengthPx: 100
		};
		const outcome = traceBadgeToBasket(input);
		expect(outcome.outcome).toBe('basket');
		if (outcome.outcome === 'basket') {
			expect(outcome.basketId).toBe('basket-bend');
			// Proof the trace actually turned: it visited well past the bend row,
			// not just the horizontal segment (a straight cast would never get here).
			expect(outcome.points.some((p) => p[1] > 8)).toBe(true);
		}
	});

	test('a gap under a badge bbox tunnels through instead of petering out', () => {
		const width = 20;
		const height = 6;
		const fixtureField = buildGridField(
			width,
			height,
			(x, y) => y >= 1 && y <= 3 && (x < 6 || x > 9) && x <= 15,
			() => 0
		);
		const input: BadgeBasketTraceInput = {
			badgeId: 'badge-1',
			startPx: [1, 2],
			headingRad: 0,
			field: fixtureField,
			supportTau: 0.5,
			corridorWidthPx: 2,
			startBadgeBbox: [0, 1, 2, 3],
			occluders: [{ id: 'badge-other', bbox: [5, 0, 5, 5] }],
			baskets: [{ basketId: 'basket-far', bbox: [13, 1, 3, 3] }],
			maxTraceLengthPx: 50
		};
		const outcome = traceBadgeToBasket(input);
		expect(outcome.outcome).toBe('basket');
		if (outcome.outcome === 'basket') {
			expect(outcome.basketId).toBe('basket-far');
			expect(outcome.tunneledSegments.length).toBeGreaterThan(0);
			expect(outcome.tunneledSegments[0].overId).toBe('badge-other');
		}
	});

	test('a path that genuinely ends nowhere returns a loud UNKNOWN with its partial trace, never a proximity guess', () => {
		const width = 20;
		const height = 6;
		const fixtureField = buildGridField(width, height, (x, y) => y >= 1 && y <= 3 && x <= 5, () => 0);
		const input: BadgeBasketTraceInput = {
			badgeId: 'badge-1',
			startPx: [1, 2],
			headingRad: 0,
			field: fixtureField,
			supportTau: 0.5,
			corridorWidthPx: 2,
			startBadgeBbox: [0, 1, 2, 3],
			occluders: [],
			// A basket exists far away, off this dead-end path entirely -- proving
			// the tracer never falls back to "nearest basket" once it peters out.
			baskets: [{ basketId: 'basket-irrelevant', bbox: [50, 50, 3, 3] }],
			maxTraceLengthPx: 50
		};
		const outcome = traceBadgeToBasket(input);
		expect(outcome.outcome).toBe('unknown');
		if (outcome.outcome === 'unknown') {
			expect(outcome.reason).toBe('petered-out');
			expect(outcome.points.length).toBeGreaterThan(1);
			expect(outcome.lengthPx).toBeGreaterThan(0);
		}
	});
});
