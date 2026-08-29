import { describe, expect, test } from 'vitest';
import {
	buildTeeBadgeCompassReceipt,
	TEE_BADGE_COMPASS_RENDER
} from '@chainspot/alg/detectors/threeFactor/features/g4.teeBadgeCompassReceipt';
import type { Drawable, RunTrace, UnitTrace } from '@chainspot/alg/detectors/threeFactor/features/types';

const lockedRef = 'teeBadgeCompass:tee-1:badge-1';
const lockedDrawable: Drawable = {
	type: 'polyline',
	path: [
		[10, 20],
		[109, 21]
	],
	verdict: 'accepted',
	visualRole: 'tee-badge-path',
	ref: lockedRef,
	reason: 'hole=H14; verdict=locked; angularErrorDeg=1.200; distancePx=100.0; runner-up=9 gap=18.500deg; tee-local geometry only',
	values: {
		hole: 14,
		angularErrorDeg: 1.2,
		distancePx: 100,
		weight: 0.97,
		runnerUpHole: 9,
		runnerUpAngularErrorDeg: 19.7,
		gapDeg: 18.5,
		supportPx: 118,
		fill: 0.71,
		majorPx: 22,
		minorPx: 9,
		courseMedianSupportPx: 120,
		courseMedianFill: 0.7
	},
	metadata: {
		role: 'tee-lock',
		teeId: 'tee-1',
		badgeId: 'badge-1',
		badgeLabel: '14',
		runnerUpBadgeLabel: '9',
		verdict: 'locked',
		poseDegraded: 'false',
		poseDegradedReason: 'n/a'
	}
} as Drawable;

const weakPoseDrawable: Drawable = {
	type: 'polyline',
	path: [
		[0, 0],
		[49, 1]
	],
	verdict: 'accepted',
	visualRole: 'tee-badge-path',
	ref: 'teeBadgeCompass:tee-2:badge-2',
	reason: 'hole=H5; verdict=locked-weak-pose; angularErrorDeg=2.000; distancePx=50.0; POSE DEGRADED (fill too low)',
	values: { hole: 5, angularErrorDeg: 2, distancePx: 50, weight: 0.9, supportPx: 40, fill: 0.2, majorPx: 15, minorPx: 6, courseMedianSupportPx: 120, courseMedianFill: 0.7 },
	metadata: {
		role: 'tee-lock',
		teeId: 'tee-2',
		badgeId: 'badge-2',
		badgeLabel: '5',
		runnerUpBadgeLabel: 'none',
		verdict: 'locked-weak-pose',
		poseDegraded: 'true',
		poseDegradedReason: 'fill too low'
	}
} as Drawable;

const noPadDrawable: Drawable = {
	type: 'point',
	xPx: 200,
	yPx: 200,
	verdict: 'rejected',
	visualRole: 'tee-rejection',
	ref: 'tee-3',
	reason: 'teeBadgeCompass: tee excluded -- no pad geometry',
	metadata: { role: 'no-pad' }
} as Drawable;

const unmatchedDrawable: Drawable = {
	type: 'point',
	xPx: 300,
	yPx: 300,
	verdict: 'info',
	ref: 'teeBadgeCompass:unmatched:badge-3',
	reason: 'UNMATCHED: no tee left (structural)',
	values: { hole: 3 },
	metadata: { role: 'unmatched-badge', badgeId: 'badge-3', badgeLabel: '3', why: 'no tee left (structural)' }
} as Drawable;

const sigmaDrawable: Drawable = {
	type: 'point',
	xPx: 0,
	yPx: 0,
	verdict: 'info',
	ref: 'teeBadgeCompass:sigma',
	reason: 'sigma = max(P90(bestAngularErrorDeg over 5 non-degraded eligible tees) = 2.100 deg, rasterFloorDeg = 0.716 deg [...]) = 2.100 deg.',
	values: {
		sigmaDeg: 2.1,
		floorDeg: 0.716,
		quantileFraction: 0.9,
		quantileValueDeg: 2.1,
		totalEligibleTees: 6,
		excludedForPoseQuality: 1,
		sampleSize: 5,
		minimumSampleSize: 3,
		representativeDistancePx: 100
	},
	metadata: { role: 'sigma', isFallback: 'false' }
} as Drawable;

function unit(drawables: Drawable[]): UnitTrace {
	return {
		id: 'teeBadgeCompass',
		gate: 'G4',
		featureId: 'teeBadgeCompass',
		featureIds: ['teeBadgeCompass'],
		enabled: true,
		knobs: {},
		knobsDeviating: [],
		ms: 1,
		drawables,
		measurements: [
			{ name: 'eligibleTees', count: 1, min: 6, max: 6, sum: 6 },
			{ name: 'noPadTees', count: 1, min: 1, max: 1, sum: 1 },
			{ name: 'locked', count: 1, min: 1, max: 1, sum: 1 },
			{ name: 'lockedWeakPose', count: 1, min: 1, max: 1, sum: 1 },
			{ name: 'ambiguous', count: 1, min: 0, max: 0, sum: 0 },
			{ name: 'unmatchedBadges', count: 1, min: 1, max: 1, sum: 1 },
			{ name: 'unusedTees', count: 1, min: 0, max: 0, sum: 0 }
		]
	};
}

function run(drawables: Drawable[], metadata: Record<string, unknown> = {}): RunTrace {
	return {
		configName: 'tee-badge-compass-fixture',
		paramsHash: 'params-1',
		execution: ['teeBadgeCompass'],
		features: { teeBadgeCompass: { enabled: true, knobs: {} } },
		units: [unit(drawables)],
		heatmaps: {},
		...metadata
	} as RunTrace;
}

describe('teeBadgeCompass acceptance receipt and render seam', () => {
	const drawables = [sigmaDrawable, lockedDrawable, weakPoseDrawable, noPadDrawable, unmatchedDrawable];

	test('pins the TEE->BADGE COMPASS receipt section shape', () => {
		const receipt = buildTeeBadgeCompassReceipt(
			unit(drawables),
			run(drawables, {
				runId: 'run-1',
				imageId: 'image-1',
				traceHash: 'trace-1',
				featureId: 'teeBadgeCompass',
				canonicalFrame: 'image-px'
			})
		);

		expect(receipt.cliText.startsWith('TEE→BADGE COMPASS')).toBe(true);
		for (const value of [
			'runId=run-1',
			'imageId=image-1',
			'paramsHash=params-1',
			'featureId=teeBadgeCompass',
			'traceHash=trace-1',
			'frame=image-px',
			'basketEvidenceRead=0 assignmentRead=0 routingRead=0',
			'recovery-fitted tee poses are excluded by construction',
			'2.4999999999999973'
		]) {
			expect(receipt.cliText).toContain(value);
		}

		expect(receipt.cliText).toContain('SIGMA DERIVATION');
		expect(receipt.cliText).toContain('sigmaDeg=2.1');
		expect(receipt.cliText).toContain('isFallback=false');

		expect(receipt.cliText).toContain('TEE ROWS');
		for (const column of [
			'teeId',
			'lockedHole',
			'angularErrorDeg',
			'distancePx',
			'runnerUpHole',
			'gapDeg',
			'verdict',
			'supportPx',
			'fill',
			'majorPx',
			'minorPx',
			'courseMedianSupportPx',
			'courseMedianFill',
			'poseDegraded'
		]) {
			expect(receipt.cliText).toContain(column);
		}
		expect(receipt.cliText).toContain('tee-1 | H14 |');
		expect(receipt.cliText).toContain('locked-weak-pose');
		expect(receipt.cliText).toContain('DEGRADED (fill too low)');
		expect(receipt.cliText).toContain('tee-3 | no-pad |');

		expect(receipt.cliText).toContain('UNMATCHED BADGES');
		expect(receipt.cliText).toContain('badge-3 | H3 |');

		expect(receipt.lockRows).toHaveLength(2);
		const lockedRow = receipt.lockRows.find((row) => row.teeId === 'tee-1')!;
		expect(lockedRow.hole).toBe(14);
		expect(lockedRow.verdict).toBe('locked');
		expect(lockedRow.runnerUpHole).toBe(9);
		expect(lockedRow.gapDeg).toBe(18.5);
		const weakRow = receipt.lockRows.find((row) => row.teeId === 'tee-2')!;
		expect(weakRow.verdict).toBe('locked-weak-pose');
		expect(weakRow.poseDegraded).toBe('true');

		expect(receipt.noPadRows).toEqual([
			{ teeId: 'tee-3', reason: 'teeBadgeCompass: tee excluded -- no pad geometry' }
		]);
		expect(receipt.unmatchedRows).toEqual([
			{ badgeId: 'badge-3', hole: 3, holeLabel: '3', why: 'no tee left (structural)' }
		]);

		expect(receipt.counts).toEqual({
			eligibleTees: 6,
			noPadTees: 1,
			locked: 1,
			lockedWeakPose: 1,
			ambiguous: 0,
			unmatchedBadges: 1,
			unusedTees: 0
		});
		expect(receipt.sigma.sigmaDeg).toBe(2.1);
		expect(receipt.sigma.excludedForPoseQuality).toBe(1);
		expect(receipt.sigma.isFallback).toBe('false');
	});

	test('an unmatched-course run (no drawables) prints an honest empty section, not a crash', () => {
		const receipt = buildTeeBadgeCompassReceipt(unit([]), run([]));
		expect(receipt.lockRows).toEqual([]);
		expect(receipt.unmatchedRows).toEqual([]);
		expect(receipt.cliText).toContain('(none)');
	});

	test('FeatureRender seam draws exactly the accepted tee-badge polylines, forwarded unchanged', () => {
		const plan = TEE_BADGE_COMPASS_RENDER.draw(unit(drawables), run(drawables));
		const drawn = plan.layers.flatMap((layer) => layer.drawables);
		expect(drawn).toEqual([lockedDrawable, weakPoseDrawable]);
		expect(TEE_BADGE_COMPASS_RENDER.units).toEqual(['teeBadgeCompass']);
	});
});
