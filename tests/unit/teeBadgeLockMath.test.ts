import { describe, expect, test } from 'vitest';
import {
	collapseTeeBadgePaths,
	extractTeeBadgePaths,
	maximumWeightTeeBadgeMatching,
	selectTeeBadgeLocks,
	scoreTeeBadgeCandidates,
	scoreTeeBadgePath,
	type TeeBadgeLockMathKnobs,
	type TeeBadgeLockRawPairRow,
	type TeeBadgeLockScoredCandidate,
	type TeeBadgeLockSupportField
} from '@chainspot/alg/detectors/threeFactor/features/g4.teeBadgeLockMath';

type Path = readonly (readonly [number, number])[];

const KNOBS: TeeBadgeLockMathKnobs = {
	alignmentPower: 2,
	worstWindowSrcPx: 2,
	minWindowCells: 2,
	teeOrientationSigmaDeg: 45
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

	test('uses the literal weak-window, route-efficiency, and detector-owned axial terms', () => {
		const candidate = {
			badgeId: 'badge-1',
			teeId: 'tee-1',
			teeBadgePath: [
				[0, 0],
				[1, 0],
				[2, 0]
			] as Path
		};
		const aligned = scoreTeeBadgePath({
			candidate,
			field: field(3, 1, [1, 0.5, 0.2], [0, 0, 0]),
			teeAxisRad: 0,
			knobs: KNOBS
		});
		// w=max(2, round(2 / 1))=2; min(mean(1,.5), mean(.5,.2))=.35.
		expect(aligned.windowCells).toBe(2);
		expect(aligned.weakAlignedSupport).toBeCloseTo(0.35);
		expect(aligned.pathEfficiency).toBe(1);
		expect(aligned.axisErrorDeg).toBeCloseTo(0);
		expect(aligned.axisFactor).toBeCloseTo(1);
		expect(aligned.score).toBeCloseTo(0.35);
		expect(aligned.axisSource).toBe('TeeEvidence.angleRad');

		const oppositeAxis = scoreTeeBadgePath({
			candidate,
			field: field(3, 1, [1, 0.5, 0.2], [0, 0, 0]),
			teeAxisRad: Math.PI,
			knobs: KNOBS
		});
		expect(oppositeAxis.axisErrorDeg).toBeCloseTo(0);

		const perpendicular = scoreTeeBadgePath({
			candidate,
			field: field(3, 1, [1, 0.5, 0.2], [0, 0, 0]),
			teeAxisRad: Math.PI / 2,
			knobs: KNOBS
		});
		expect(perpendicular.axisErrorDeg).toBeCloseTo(90);
		expect(perpendicular.axisFactor).toBeCloseTo(Math.exp(-4));
		expect(perpendicular.score).toBeCloseTo(0.35 * Math.exp(-4));

		const unknownAxis = scoreTeeBadgePath({
			candidate,
			field: field(3, 1, [1, 0.5, 0.2], [0, 0, 0]),
			teeAxisRad: null,
			knobs: KNOBS
		});
		expect(unknownAxis.axisErrorDeg).toBe('UNKNOWN');
		expect(unknownAxis.axisSource).toBe('UNKNOWN');
		expect(unknownAxis.axisFactor).toBe(1);
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
		expect(routed.score).toBeCloseTo(Math.SQRT2 / 2);
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
