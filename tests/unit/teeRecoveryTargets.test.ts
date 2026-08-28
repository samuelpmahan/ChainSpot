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
	test('Heritage H5 stays huntable when G6 temporarily assigns H4 tee-12 to it', () => {
		// Claims-ledger row 27: pre-recovery G6 had badge-5 -> tee-12, but
		// tee-12 is physically H4's pad at (708,1394). H4's badge center is
		// (718,1343); H5's is (721,1078). Recovery targeting must read the tee's
		// own axis, not that stale ownership row.
		const h4 = badge('badge-8', '4', 718, 1343);
		const h5 = badge('badge-5', '5', 721, 1078);
		const tee12Axis = Math.atan2(h4.cyPx - 1394, h4.cxPx - 708);
		const tees = [tee('tee-12', 708, 1394, tee12Axis)];

		expect(deriveTeeAimClaims([h4, h5], tees)).toEqual([
			expect.objectContaining({ teeId: 'tee-12', badgeId: 'badge-8' })
		]);
		expect(deriveTeeRecoveryTargets([h4, h5], tees).map((entry) => entry.detId)).toEqual(['badge-5']);
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
