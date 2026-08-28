import { describe, expect, test } from 'vitest';
import {
	deriveTeeAimClaims,
	deriveTeeRecoveryTargets
} from '@chainspot/alg/detectors/threeFactor/features/g3.teeRecovery';
import type {
	BadgeEvidence,
	TeeEvidence
} from '@chainspot/alg/detectors/threeFactor/types';

function badge(detId: string, label: string, cxPx: number, cyPx: number): BadgeEvidence {
	return { detId, label, cxPx, cyPx } as BadgeEvidence;
}

function tee(
	detId: string,
	xPx: number,
	yPx: number,
	angleRad: number | null,
	pad?: Partial<NonNullable<TeeEvidence['pad']>>
): TeeEvidence {
	return { detId, xPx, yPx, angleRad, ...(pad ? { pad } : {}) } as TeeEvidence;
}

describe('teeRecovery visible-aim target derivation', () => {
	test('a stale solver ownership cannot make an H4 tee claim H5', () => {
		const badges = [
			badge('badge-4', '4', 100, 100),
			badge('badge-5', '5', 300, 100)
		];
		const tees = [tee('tee-h4', 0, 100, 0)];

		expect(deriveTeeAimClaims(badges, tees)).toEqual([
			expect.objectContaining({ teeId: 'tee-h4', badgeId: 'badge-4' })
		]);
		expect(deriveTeeRecoveryTargets(badges, tees).map((entry) => entry.detId)).toEqual(['badge-5']);
	});

	test('duplicate tee claims are not force-matched into fake badge coverage', () => {
		const badges = [
			badge('badge-1', '1', 100, 0),
			badge('badge-2', '2', 0, 100)
		];
		const tees = [
			tee('tee-a', 0, 0, 0),
			tee('tee-b', 0, 10, 0)
		];

		expect(deriveTeeAimClaims(badges, tees).map((claim) => claim.badgeId)).toEqual([
			'badge-1',
			'badge-1'
		]);
		expect(deriveTeeRecoveryTargets(badges, tees).map((entry) => entry.detId)).toEqual(['badge-2']);
	});

	test('uses the same tee-axis source priority as teeBadgeLock', () => {
		const badges = [
			badge('badge-horizontal', '1', 100, 0),
			badge('badge-vertical', '2', 0, 100)
		];
		const tees = [tee('tee-a', 0, 0, 0, {
			angleRad: 0,
			minAreaPose: {
				centerXPx: 0,
				centerYPx: 0,
				angleRad: Math.PI / 2,
				majorPx: 10,
				minorPx: 6,
				orientedCorners: [[0, 0], [1, 0], [1, 1], [0, 1]]
			}
		})];

		expect(deriveTeeAimClaims(badges, tees)[0]?.badgeId).toBe('badge-vertical');
	});

	test('ignores unread badges when deciding visible ownership', () => {
		const badges = [
			badge('badge-1', '1', 100, 0),
			badge('badge-unread', '', 0, 100)
		];
		const tees = [tee('tee-a', 0, 0, Math.PI / 2)];

		expect(deriveTeeAimClaims(badges, tees)[0]?.badgeId).toBe('badge-1');
		expect(deriveTeeRecoveryTargets(badges, tees)).toHaveLength(0);
	});
});
