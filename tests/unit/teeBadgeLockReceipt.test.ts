import { describe, expect, test } from 'vitest';
import {
	buildTeeBadgeLockReceipt,
	TEE_BADGE_LOCK_RENDER
} from '@chainspot/alg/detectors/threeFactor/features/g4.teeBadgeLockReceipt';
import type {
	Drawable,
	RunTrace,
	UnitTrace
} from '@chainspot/alg/detectors/threeFactor/features/types';

const badgeId = 'badge H/3';
const teeId = 'tee?H3';
const lockRef = `teeBadgeLock:${encodeURIComponent(badgeId)}:${encodeURIComponent(teeId)}`;

const acceptedPath: Drawable = {
	type: 'polyline',
	path: [
		[30, 20],
		[20, 20],
		[10, 10]
	],
	verdict: 'accepted',
	visualRole: 'tee-badge-path',
	ref: lockRef,
	reason: 'selected exact teeLeg testimony',
	values: {
		hole: 3,
		tierCode: 1,
		score: 0.8,
		weakAligned: 0.9,
		efficiency: 0.95,
		axisErrorDeg: 2,
		axisSourceCode: 0,
		margin: 0.2,
		pathPoints: 3,
		recovered: 1
	}
} as Drawable;

function unit(drawables: Drawable[]): UnitTrace {
	return {
		id: 'teeBadgeLock',
		gate: 'G4',
		featureId: 'teeBadgeLock',
		featureIds: ['teeBadgeLock'],
		enabled: true,
		knobs: {},
		knobsDeviating: [],
		ms: 1,
		drawables,
		measurements: [
			{ name: 'candidates', count: 1, min: 1, max: 1, sum: 1 },
			{ name: 'locks', count: 1, min: 1, max: 1, sum: 1 },
			{ name: 'visibleLocks', count: 1, min: 1, max: 1, sum: 1 },
			{ name: 'recoveredLocks', count: 0, min: 0, max: 0, sum: 0 },
			{ name: 'unmatchedBadges', count: 0, min: 0, max: 0, sum: 0 },
			{ name: 'unusedTees', count: 0, min: 0, max: 0, sum: 0 }
		]
	};
}

function run(drawables: Drawable[], metadata: Record<string, unknown> = {}): RunTrace {
	return {
		configName: 'tee-badge-lock-fixture',
		paramsHash: 'params-1',
		execution: ['teeBadgeLock'],
		features: { teeBadgeLock: { enabled: true, knobs: {} } },
		units: [unit(drawables)],
		heatmaps: {},
		...metadata
	} as RunTrace;
}

describe('teeBadgeLock acceptance receipt and render seam', () => {
	test('prints the literal lock receipt, provenance, counts, and every lock field', () => {
		const receipt = buildTeeBadgeLockReceipt(
			unit([acceptedPath]),
			run([acceptedPath], {
				runId: 'run-1',
				imageId: 'image-1',
				traceHash: 'trace-1',
				featureId: 'teeBadgeLock',
				canonicalFrame: 'image-px'
			})
		);
		expect(receipt.cliText.startsWith('TEE→BADGE LOCK')).toBe(true);
		for (const value of [
			'runId=run-1',
			'imageId=image-1',
			'paramsHash=params-1',
			'featureId=teeBadgeLock',
			'traceHash=trace-1',
			'frame=image-px',
			'basketEvidenceRead=0'
		]) {
			expect(receipt.cliText).toContain(value);
		}
		for (const column of [
			'lockId',
			'hole',
			'badgeId',
			'teeId',
			'tier',
			'score',
			'weakAligned',
			'efficiency',
			'axisErrorDeg',
			'axisSource',
			'margin',
			'pathPoints',
			'verdict',
			'reason'
		]) {
			expect(receipt.cliText).toContain(column);
		}
		for (const count of [
			'candidates',
			'locks',
			'visibleLocks',
			'recoveredLocks',
			'unmatchedBadges',
			'unusedTees'
		]) {
			expect(receipt.cliText).toContain(count);
		}
		expect(receipt.rows[0]).toMatchObject({
			lockId: lockRef,
			hole: 3,
			badgeId,
			teeId,
			verdict: 'accepted'
		});
	});

	test('uses loud UNKNOWN provenance and renders only producer-emitted accepted tee-badge polylines', () => {
		const rejected = {
			...acceptedPath,
			verdict: 'rejected',
			ref: 'teeBadgeLock:badge-H5:tee-H5',
			reason: 'not selected'
		} as Drawable;
		const unrelated = {
			type: 'polyline',
			path: [
				[0, 0],
				[1, 1]
			],
			verdict: 'accepted',
			visualRole: 'tee-border',
			ref: 'not-a-lock'
		} as Drawable;
		const receipt = buildTeeBadgeLockReceipt(
			unit([acceptedPath, rejected, unrelated]),
			run([acceptedPath, rejected, unrelated], { paramsHash: '' })
		);
		expect(receipt.cliText).toMatch(/runId=UNKNOWN/);
		expect(receipt.cliText).toMatch(/imageId=UNKNOWN/);
		expect(receipt.cliText).toMatch(/paramsHash=UNKNOWN/);
		expect(receipt.cliText).toMatch(/featureId=teeBadgeLock/);
		expect(receipt.cliText).toMatch(/traceHash=UNKNOWN/);
		expect(receipt.cliText).toMatch(/frame=UNKNOWN/);
		const plan = TEE_BADGE_LOCK_RENDER.draw(
			unit([acceptedPath, rejected, unrelated]),
			run([acceptedPath, rejected, unrelated])
		);
		const drawn = plan.layers.flatMap((layer) => layer.drawables);
		expect(drawn).toEqual([acceptedPath]);
		expect(drawn[0]).toMatchObject({
			type: 'polyline',
			path: [
				[30, 20],
				[20, 20],
				[10, 10]
			]
		});
		expect(plan.layers.flatMap((layer) => layer.drawables)).toHaveLength(
			receipt.rows.filter((row: any) => row.verdict === 'accepted').length
		);
	});
});
