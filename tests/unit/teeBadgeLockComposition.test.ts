import { describe, expect, test } from 'vitest';
import {
	extractTeeBadgePaths,
	scoreTeeBadgeCandidates,
	selectTeeBadgeLocks,
	buildTeeBadgeLockEvidence,
	maximumWeightTeeBadgeMatching,
	type TeeBadgePathInput
} from '@chainspot/alg/detectors/threeFactor/features/g4.teeBadgeLockMath';

const path = (tee: number, badge: number) =>
	[
		[tee, 0],
		[badge, 0]
	] as const;

describe('teeBadgeLock final composition', () => {
	test('collapses 5,832 raw rows into exactly 324 tee×badge candidates', () => {
		const rawRows = Array.from({ length: 18 * 324 }, (_, index) => {
			const badge = Math.floor(index / 324) + 1;
			const tee = (index % 18) + 1;
			return {
				badgeId: `badge-${badge}`,
				teeId: `tee-${tee}`,
				basketId: `basket-${index % 9}`,
				teeLeg: { path: path(badge, tee) },
				basketLeg: { path: [[99, 99]] },
				jointScore: index,
				supportMean: index
			} as unknown as TeeBadgePathInput;
		});
		const paths: any = extractTeeBadgePaths(rawRows);
		expect(paths).toHaveLength(324);
		expect(typeof scoreTeeBadgeCandidates).toBe('function');
		expect(
			paths.find(
				(candidate: any) => candidate.badgeId === 'badge-1' && candidate.teeId === 'tee-18'
			)?.teeBadgePath
		).toEqual(path(18, 1));
	});

	test('selects 18 diagonal locks with 15 visible and recovered H3/H5/H12', () => {
		const holes = Array.from({ length: 18 }, (_, index) => index + 1);
		const scored = holes.flatMap((badge) =>
			holes.map((tee) => ({
				badgeId: `badge-${badge}`,
				teeId: `tee-H${tee}`,
				teeBadgePath: path(tee, badge),
				score: badge === tee ? 1 : 0,
				weakAlignedSupport: badge === tee ? 1 : 0,
				pathEfficiency: 1,
				axisErrorDeg: 0,
				axisSource: 'TeeEvidence.angleRad'
			}))
		);
		expect(selectTeeBadgeLocks).toBe(maximumWeightTeeBadgeMatching);
		const selected: any = selectTeeBadgeLocks(scored as any);
		expect(selected.candidates).toHaveLength(324);
		expect(selected.locks).toHaveLength(18);
		const evidence: any = buildTeeBadgeLockEvidence(selected, {
			badges: holes.map((hole) => ({ detId: `badge-${hole}`, label: String(hole) })),
			tees: holes.map((hole) => ({
				detId: `tee-H${hole}`,
				tier: [3, 5, 12].includes(hole) ? 'recovered' : 'visible'
			}))
		});
		expect(evidence.locks).toHaveLength(18);
		expect(evidence.locks.filter((lock: any) => lock.tier === 'visible')).toHaveLength(15);
		expect(
			evidence.locks.filter((lock: any) => lock.tier === 'recovered').map((lock: any) => lock.hole)
		).toEqual([3, 5, 12]);
	});

	test('is byte-invariant to every basket-side mutation', () => {
		const base = [
			{
				badgeId: 'badge-1',
				teeId: 'tee-1',
				basketId: 'basket-a',
				teeLeg: { path: path(2, 1) },
				basketLeg: { path: [[9, 9]] }
			}
		];
		const mutated = [
			{ ...base[0], basketId: 'basket-z', basketLeg: { path: [[-99, 77]] }, jointScore: -Infinity }
		];
		expect(JSON.stringify(extractTeeBadgePaths(base as TeeBadgePathInput[]))).toBe(
			JSON.stringify(extractTeeBadgePaths(mutated as TeeBadgePathInput[]))
		);
	});
});
