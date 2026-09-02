import { describe, expect, test } from 'vitest';
import {
	composePcr,
	createExecBoard,
	executeCompiledPlan,
	pcrRenderId,
	type CompiledExecutionPlan,
	type OperationRuntime,
	type OperationSpec,
	type TickTestimony
} from '@chainspot/alg/exec';
import { nullFeatureContext } from '@chainspot/alg/detectors/threeFactor/features/types';

const operation: OperationSpec = {
	id: 'badgeStage.masks',
	kind: 'measure',
	gate: 'G1',
	unit: 'badgeStage',
	consumes: ['localImage'],
	produces: ['badgeStage.masks'],
	calculations: ['fn.computeBrightDarkMasks']
};
const plan: CompiledExecutionPlan = {
	ops: [operation],
	planFingerprint: 'plan-fingerprint',
	paramsHash: 'run-args-hash',
	bindings: {}
};
const tick: TickTestimony = {
	opId: operation.id,
	frozenCalculations: [
		{ address: 'fn.computeBrightDarkMasks', implementationHash: 'a'.repeat(64) }
	],
	startedAtMs: 10,
	durationMs: 2,
	declaredConsumes: operation.consumes,
	declaredProduces: operation.produces,
	actualConsumes: operation.consumes,
	actualProduces: operation.produces,
	writes: [{ address: 'badgeStage.masks', kind: 'new-address' }],
	probes: [{ name: 'badgeStage.masks.length', value: 100 }],
	artifacts: []
};

describe('PCR composes testimony without becoming an engine', () => {
	test('selects already-run Ticks and has no execution method', () => {
		const pcr = composePcr(
			{ id: 'badge-pcr', title: 'Badge PCR', tickIds: ['badgeStage.masks'] },
			plan,
			[tick]
		);
		expect(pcr.ticks).toHaveLength(1);
		expect(pcr.ticks[0].testimony).toBe(tick);
		expect(pcr.runResultId).toMatch(/^[0-9a-f]{64}$/);
		expect('run' in pcr).toBe(false);
	});

	test('changing View Args changes only render identity', () => {
		const pcr = composePcr(
			{ id: 'badge-pcr', title: 'Badge PCR', tickIds: ['badgeStage.masks'] },
			plan,
			[tick]
		);
		const before = pcr.runResultId;
		expect(pcrRenderId(pcr, { zoom: 2 })).not.toBe(pcrRenderId(pcr, { zoom: 4 }));
		expect(pcr.runResultId).toBe(before);
	});

	test('changing Run Args crosses the production gateway before PCR composition', () => {
		const runArgOperation: OperationSpec = {
			id: 'test.threshold',
			kind: 'compute',
			gate: 'shared',
			unit: 'test',
			consumes: ['px.test.value', 'px.run.threshold'],
			produces: ['px.test.accepted'],
			calculations: ['fn.applyThreshold']
		};
		let gatewayRuns = 0;
		const applyThreshold = (value: number, threshold: number) => value >= threshold;
		const runtime: OperationRuntime = {
			implementations: new Map([
				[
					runArgOperation.id,
					(board) => {
						gatewayRuns += 1;
						board.set(
							'px.test.accepted',
							applyThreshold(
								board.get<number>('px.test.value'),
								board.get<number>('px.run.threshold')
							)
						);
					}
				]
			]),
			calculationBindings: new Map([
				[runArgOperation.id, [{ address: 'fn.applyThreshold', calculate: applyThreshold }]]
			])
		};
		const requestRun = (threshold: number) => {
			const runPlan: CompiledExecutionPlan = {
				ops: [runArgOperation],
				planFingerprint: 'threshold-plan',
				paramsHash: `threshold:${threshold}`,
				bindings: {}
			};
			const board = createExecBoard();
			board.set('px.test.value', 15);
			board.set('px.run.threshold', threshold);
			const testimony = executeCompiledPlan(
				runPlan,
				board,
				nullFeatureContext,
				undefined,
				runtime
			);
			return {
				accepted: board.get<boolean>('px.test.accepted'),
				pcr: composePcr(
					{ id: 'threshold-pcr', title: 'Threshold PCR', tickIds: [runArgOperation.id] },
					runPlan,
					testimony
				)
			};
		};

		const low = requestRun(10);
		const high = requestRun(20);
		expect(gatewayRuns).toBe(2);
		expect([low.accepted, high.accepted]).toEqual([true, false]);
		expect(low.pcr.runResultId).not.toBe(high.pcr.runResultId);
		expect('run' in low.pcr).toBe(false);
	});

	test('cannot present a planned Tick that never ran', () => {
		expect(() =>
			composePcr(
				{ id: 'badge-pcr', title: 'Badge PCR', tickIds: ['badgeStage.masks'] },
				plan,
				[]
			)
		).toThrow("PCR 'badge-pcr' Tick 'badgeStage.masks' never ran.");
	});
});
