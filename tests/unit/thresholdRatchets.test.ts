// Threshold ratchets — the teeth. A confirmed-real case that breaks a
// course-derived threshold is a footgun firing, full stop -- AFTER Step 0
// verifies the measurement itself (receipt-reconcile: is the fitted
// rectangle/pose sound against actual pixels, was the right object
// measured at all); a broken measurement is a measurement defect, fix the
// measuring, leave the threshold untouched. Never argued case-by-case
// ("logic'd upon") once verified -- always resolved by recording the
// extreme and widening the threshold's derivation to admit it. Registry,
// law, and receipt pointers: docs/RATCHETS.md.
import { describe, expect, test } from 'vitest';
import { defaultKnobs } from '@chainspot/alg/detectors/threeFactor/features/types';
import { g4SearchFeature } from '@chainspot/alg/detectors/threeFactor/features/g4.search';
import { teeRecoveryFeature } from '@chainspot/alg/detectors/threeFactor/features/g3.teeRecovery';
import { DEFAULT_HSV_KNOBS } from '@chainspot/alg/detectors/threeFactor/raster';

const SAFETY = 1.0; // exactly 1.0 per instruction — no extra slack folded in here

describe('threshold ratchets (docs/RATCHETS.md)', () => {
	test('row a: g4.search padClaimOutlierFactor admits the recorded real extreme (ratio 2.00)', () => {
		const knobs = defaultKnobs(g4SearchFeature) as { padClaimOutlierFactor: number };
		const recordedRealRatio = 2.0 * SAFETY;
		// Receipt: artifacts/sweep/dev72-recovered-default/HeritagePark-full/run.receipt.txt
		// measurement padClaimDistancePx (max=128.9915141118659) /
		// measurement padClaimMedianPx (64.30858373243692) => ratio 2.005 ~= 2.00,
		// tied to HOLE ASSIGNMENTS row "H17 | badge-17 | tee-19 -> basket-17".
		expect(
			knobs.padClaimOutlierFactor,
			`padClaimOutlierFactor (${knobs.padClaimOutlierFactor}) must stay > ${recordedRealRatio} ` +
				'to admit the recorded real Heritage H17 tee-19 claim ratio ~2.00. Receipt: ' +
				'artifacts/sweep/dev72-recovered-default/HeritagePark-full/run.receipt.txt ' +
				'(padClaimDistancePx / padClaimMedianPx measurements; HOLE ASSIGNMENTS H17 row). ' +
				'See docs/RATCHETS.md registry row a.'
		).toBeGreaterThan(recordedRealRatio);
	});

	test('row b: teeRecovery axisToleranceDeg admits the recorded real extreme (2.5 deg)', () => {
		const knobs = defaultKnobs(teeRecoveryFeature) as { axisToleranceDeg: number };
		const recordedRealMaxDeg = 2.5;
		// Receipt: artifacts/sweep/dev72-recovered-default/HeritagePark-full/run.receipt.txt
		// measurement axisErrorDeg: n=2 min=2.4999999999999973 max=2.5000000000000004.
		expect(
			knobs.axisToleranceDeg,
			`axisToleranceDeg (${knobs.axisToleranceDeg}) must stay > ${recordedRealMaxDeg} to admit ` +
				'the recorded real max axisErrorDeg 2.5. Receipt: ' +
				'artifacts/sweep/dev72-recovered-default/HeritagePark-full/run.receipt.txt ' +
				'(measurement axisErrorDeg line). See docs/RATCHETS.md registry row b.'
		).toBeGreaterThan(recordedRealMaxDeg);
	});

	// Row c is EXPECTED-FIRED: brightVMin is an absolute literal (210), not even
	// course-derived, and a real, correctly-located recovered pad (DashsTrack
	// badge-5) measures mean V = 188.7, below it. This is a documented,
	// currently-live footgun (backlog item 3), not a bug in this test — it is
	// written with test.fails so the suite records the firing without going
	// red. brightVMin is exported only via DEFAULT_HSV_KNOBS (no standalone
	// export exists in raster.ts; raster.ts was not edited to add one).
	test.fails(
		'row c (EXPECTED-FIRED): raster.ts brightVMin literal (210) does NOT admit the ' +
			'real DashsTrack badge-5 recovered-pad mean V=188.7 -- live footgun, backlog item 3. ' +
			'Receipt: docs/orchestration/2026-08-28-bare-pixel-audit.md (measurement table, ' +
			'"tee-recovered-1 (badge 5)" row, mean V 188.7); crops in ' +
			'artifacts/orchestration/bare-pixel-audit/. Open question the audit leaves unsettled: ' +
			'healthy comparison pad tee-2 measured mean V=183.9 over the same whole-crop region ' +
			'yet segments fine, so the definitive outline-pixels-only measurement is still owed ' +
			'before this ratchet can be properly derived. See docs/RATCHETS.md registry row c.',
		() => {
			const recordedRealMeanV = 188.7;
			expect(DEFAULT_HSV_KNOBS.brightVMin).toBeLessThanOrEqual(recordedRealMeanV);
		}
	);

	// Row d: no valid winner-side (accepted-candidate) bare-fraction samples
	// exist yet -- receipts don't print that audit for accepted candidates
	// (backlog item 1). The only accept-side numbers on record (0.159, 0.626)
	// are runner-ups on one course, not winners, so nothing here can be
	// seeded honestly. Do not invent a fixture against an unseeded row.
	test.todo(
		'maxBareSupportFraction — unseeded: winner-side bare fractions are not receipt-printed yet (backlog item 1)'
	);
});
