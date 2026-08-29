import { describe, expect, test } from 'vitest';
import {
	compileABFeatureSet,
	createExecBoard,
	executeABFeatureSet,
	type ABFeatureSet
} from '@chainspot/alg/exec';
import {
	teeBadgeLockFeature,
	teeBadgeLockOperation
} from '@chainspot/alg/detectors/threeFactor/features/g4.teeBadgeLock';
import {
	nullFeatureContext,
	type ABFeature
} from '@chainspot/alg/detectors/threeFactor/features/types';

const set: ABFeatureSet = {
	id: 'tee-badge-lock-public-contract',
	features: [teeBadgeLockFeature],
	imports: ['scoring'],
	seededSlots: ['measurement', 'assignment'],
	operations: [{ operation: teeBadgeLockOperation }]
};

const publicFeature: ABFeature = teeBadgeLockFeature;

describe('teeBadgeLock ABFeature production contract', () => {
	test('is a default-OFF G4 frozen-safe deviation; the set owns its public operation', () => {
		expect(teeBadgeLockFeature).toMatchObject({
			id: 'teeBadgeLock',
			gate: 'G4',
			kind: 'deviation',
			defaultEnabled: false,
			resolveOnlyWhenConfigured: true
		});
		expect(publicFeature).toBe(teeBadgeLockFeature);
		expect(publicFeature.operations).toBeUndefined();
	});

	test('compiles and executes through the production ABFeature gateway with honest custody', async () => {
		const compiled = compileABFeatureSet(set, { teeBadgeLock: { enabled: true } });
		const operation = compiled.plan.ops.find((entry) => entry.id === 'teeBadgeLock');
		expect(operation).toMatchObject({
			gate: 'G4',
			consumes: ['measurement', 'assignment'],
			produces: ['teeBadgeLock'],
			features: ['teeBadgeLock', 'scoring']
		});

		const board = createExecBoard();
		board.set('measurement', {
			field: {
				width: 1,
				height: 1,
				scale: 1,
				support: new Float32Array([1]),
				bestTheta: new Float32Array([0])
			},
			viewport: { topPx: 0 }
		});
		board.set('assignment', { tees: [], scoredPairs: [] });
		const manifest = await executeABFeatureSet(compiled, board, nullFeatureContext, {
			runId: 'tee-badge-lock-gateway',
			invocation: 'teeBadgeLockFeature.test'
		});
		const receipt = manifest.operations.find((entry) => entry.opId === 'teeBadgeLock');
		expect(receipt?.declaredConsumes).toEqual([
			'measurement',
			'assignment'
		]);
		expect(receipt?.declaredProduces).toEqual(['teeBadgeLock']);
		expect(receipt?.actualConsumes).toEqual(
			expect.arrayContaining(['measurement', 'assignment'])
		);
		expect(receipt?.actualProduces).toEqual(expect.arrayContaining(['teeBadgeLock']));
		expect(receipt?.durationMs).toBeGreaterThanOrEqual(0);
		expect(receipt?.artifacts.some((artifact) => artifact.kind === 'measurementTable')).toBe(true);
		expect(board.has('teeBadgeLock')).toBe(true);
		expect(board.has('assignment')).toBe(true);
		expect(manifest).toMatchObject({ runId: 'tee-badge-lock-gateway' });
		expect(JSON.stringify(manifest)).toMatch(/checkpoint|teeBadgeLock/i);
	});

	test('scheduled OFF still reads every declared input and publishes empty evidence', async () => {
		const compiled = compileABFeatureSet(set, { teeBadgeLock: { enabled: false } });
		const board = createExecBoard();
		board.set('measurement', {
			field: {
				width: 1,
				height: 1,
				scale: 1,
				support: new Float32Array([1]),
				bestTheta: new Float32Array([0])
			},
			viewport: { topPx: 0 }
		});
		board.set('assignment', { tees: [{ detId: 'tee-forbidden-while-off' }], scoredPairs: [{ raw: { badgeId: 'forbidden-while-off' } }] });

		const manifest = await executeABFeatureSet(compiled, board, nullFeatureContext, {
			runId: 'tee-badge-lock-off',
			invocation: 'teeBadgeLockFeature.test'
		});
		const receipt = manifest.operations.find((entry) => entry.opId === 'teeBadgeLock');
		expect(receipt?.actualConsumes).toEqual([
			'measurement',
			'assignment'
		]);
		expect(receipt?.actualProduces).toEqual(['teeBadgeLock']);
		expect(board.get('teeBadgeLock')).toMatchObject({
			basketEvidenceRead: false,
			candidates: [],
			locks: [],
			unmatchedBadgeIds: [],
			unusedTeeIds: []
		});
	});
});
