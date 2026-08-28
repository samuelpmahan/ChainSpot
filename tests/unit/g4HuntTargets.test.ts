// Owner directive 2026-08-28 ("the step-4 input must never come from step
// 6"): teeRecovery's hunted-badge set is derived from detection geometry by
// deriveHuntTargets, never from the G6 assignment solver. These tests pin the
// exact failure this replaced (docs/CLAIMS-LEDGER.md row 27): Heritage
// badge-5 "held" H4's pad from 317px away at rank 1 in the pre-recovery
// assignment, so the old assignment-derived missing set never hunted it while
// its 50px pad remnant sat unexamined.

import { describe, expect, test } from 'vitest';
import { deriveHuntTargets } from '@chainspot/alg/detectors/threeFactor/features/g3.teeRecovery';
import type { BadgeEvidence, TeeEvidence } from '@chainspot/alg/detectors/threeFactor/types';

function badge(detId: string, label: string, cxPx: number, cyPx: number): BadgeEvidence {
	return { detId, label, cxPx, cyPx, confidence: 0.99 } as unknown as BadgeEvidence;
}

function tee(detId: string, xPx: number, yPx: number): TeeEvidence {
	return { detId, xPx, yPx, tier: 'ring', angleRad: null } as unknown as TeeEvidence;
}

describe('deriveHuntTargets — geometric hunted-set derivation', () => {
	test('the Heritage H5 shape: a far badge cannot mask itself by "holding" a neighbor pad', () => {
		// badge-8 (H4) at (718,1343) with its pad tee-12 at (708,1394) ~52px;
		// badge-5 (H5) at (721,1078), 317px from that same pad, own pad missing.
		// Two healthy controls establish the course-derived median.
		const badges = [
			badge('badge-8', '4', 718, 1343),
			badge('badge-5', '5', 721, 1078),
			badge('badge-0', '7', 914, 703),
			badge('badge-6', '9', 1075, 1092)
		];
		const tees = [tee('tee-12', 708, 1394), tee('tee-0', 871, 713), tee('tee-5', 1095, 1048)];
		const derivation = deriveHuntTargets(badges, tees, 3);
		// Greedy nearest gives tee-12 to badge-8; badge-5 is left unclaimed and hunted.
		expect(derivation.targets.map((entry) => entry.detId)).toEqual(['badge-5']);
		const h4 = derivation.claims.find((claim) => claim.badgeId === 'badge-8');
		expect(h4?.teeId).toBe('tee-12');
		expect(h4?.withinBound).toBe(true);
		expect(derivation.medianClaimDistancePx).toBeGreaterThan(0);
	});

	test('every badge claimed within bound -> nothing hunted', () => {
		const badges = [badge('badge-0', '1', 0, 0), badge('badge-1', '2', 1000, 0)];
		const tees = [tee('tee-0', 0, 60), tee('tee-1', 1000, 55)];
		const derivation = deriveHuntTargets(badges, tees, 3);
		expect(derivation.targets).toEqual([]);
		expect(derivation.claims.every((claim) => claim.withinBound)).toBe(true);
	});

	test('an outlier claim hunts its badge even though the tee was formally claimable', () => {
		// Three tight claims set the median; the fourth badge's nearest tee is
		// far past median x factor, so it is hunted despite "having" a claim.
		const badges = [
			badge('badge-0', '1', 0, 0),
			badge('badge-1', '2', 500, 0),
			badge('badge-2', '3', 1000, 0),
			badge('badge-3', '4', 1500, 0)
		];
		const tees = [tee('tee-0', 0, 50), tee('tee-1', 500, 55), tee('tee-2', 1000, 60), tee('tee-3', 1500, 400)];
		const derivation = deriveHuntTargets(badges, tees, 3);
		expect(derivation.targets.map((entry) => entry.detId)).toEqual(['badge-3']);
		const outlier = derivation.claims.find((claim) => claim.badgeId === 'badge-3');
		expect(outlier?.withinBound).toBe(false);
		// four claims sorted [50,55,60,400]: the derivation's median takes the
		// upper-middle element (index floor(n/2)), matching the pad-geometry
		// median helper already in this file -- 60, bound 180.
		expect(derivation.claimBoundPx).toBeCloseTo(60 * 3, 5);
	});

	test('zero visible tees -> no bound derivable, every numbered badge hunted; unreadable badges never hunted', () => {
		const badges = [badge('badge-0', '1', 0, 0), badge('badge-1', 'UNREAD-x', 100, 0)];
		const readable = { ...badges[1], label: null } as unknown as BadgeEvidence;
		const derivation = deriveHuntTargets([badges[0]!, readable], [], 3);
		expect(derivation.targets.map((entry) => entry.detId)).toEqual(['badge-0']);
		expect(derivation.medianClaimDistancePx).toBeNull();
		expect(derivation.claimBoundPx).toBeNull();
	});
});
