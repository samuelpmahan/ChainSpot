import { describe, expect, test } from 'vitest';
import {
	composePcr,
	pcrRenderId,
	type CompiledExecutionPlan,
	type OperationSpec,
	type TickTestimony
} from '@chainspot/alg/exec';

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
