import { describe, expect, test } from 'vitest';
import {
	createExecBoard,
	executeCompiledPlan,
	trackAccess,
	type CompiledExecutionPlan,
	type OperationRuntime,
	type OperationSpec,
	type PxC
} from '@chainspot/alg/exec';
import { nullFeatureContext } from '@chainspot/alg/detectors/threeFactor/features/types';

const tickSpec: OperationSpec = {
	id: 'test.double',
	kind: 'compute',
	gate: 'shared',
	unit: 'test',
	consumes: ['px.test.input'],
	produces: ['px.test.output'],
	calculations: ['fn.doubleNumber']
};

describe('ExecBoard is the PxC address space', () => {
	test('keeps heterogeneous values and names the reading Tick on a missing read', () => {
		const pxc: PxC = createExecBoard();
		pxc.set('px.test.number', 7);
		pxc.set('px.test.bytes', Uint8Array.from([1, 2, 3]));
		expect(pxc.get<number>('px.test.number')).toBe(7);
		expect([...pxc.get<Uint8Array>('px.test.bytes')]).toEqual([1, 2, 3]);

		const { tracked } = trackAccess(pxc, tickSpec);
		expect(() => tracked.get('px.test.missing')).toThrow(
			"PxC: Tick 'test.double' read missing address 'px.test.missing'."
		);
	});

	test('distinguishes new addresses, declared refinement, and surprising replacement', () => {
		const pxc = createExecBoard();
		pxc.set('px.test.refined', 1);
		pxc.set('px.test.replaced', 1);
		const { tracked, writes } = trackAccess(pxc, {
			id: 'test.writer',
			consumes: ['px.test.refined']
		});
		tracked.set('px.test.new', 2);
		tracked.set('px.test.refined', 2);
		tracked.set('px.test.replaced', 2);
		expect(writes).toEqual([
			{ address: 'px.test.new', kind: 'new-address' },
			{ address: 'px.test.refined', kind: 'refinement' },
			{ address: 'px.test.replaced', kind: 'replacement' }
		]);
	});
});

describe('Tick testimony from the production gateway', () => {
	test('freezes the bound calculation body and reports exact PxC traffic', () => {
		const doubleNumber = (value: number) => value * 2;
		const run = (pxc: PxC) => {
			pxc.set('px.test.output', doubleNumber(pxc.get<number>('px.test.input')));
		};
		const plan: CompiledExecutionPlan = {
			ops: [tickSpec],
			planFingerprint: 'test-plan',
			bindings: {}
		};
		const runtime: OperationRuntime = {
			implementations: new Map([['test.double', run]]),
			calculationBindings: new Map([
				[
					'test.double',
					[{ address: 'fn.doubleNumber', calculate: doubleNumber }]
				]
			])
		};
		const pxc = createExecBoard();
		pxc.set('px.test.input', 21);

		const [tick] = executeCompiledPlan(plan, pxc, nullFeatureContext, undefined, runtime);
		expect(pxc.get('px.test.output')).toBe(42);
		expect(tick.declaredConsumes).toEqual(['px.test.input']);
		expect(tick.actualConsumes).toEqual(['px.test.input']);
		expect(tick.declaredProduces).toEqual(['px.test.output']);
		expect(tick.actualProduces).toEqual(['px.test.output']);
		expect(tick.writes).toEqual([
			{ address: 'px.test.output', kind: 'new-address' }
		]);
		expect(tick.frozenCalculations).toEqual([
			{
				address: 'fn.doubleNumber',
				implementationHash: expect.stringMatching(/^[0-9a-f]{64}$/)
			}
		]);
	});

	test('refuses a runtime binding hidden behind the wrong fn.* address', () => {
		const pxc = createExecBoard();
		pxc.set('px.test.input', 1);
		const runtime: OperationRuntime = {
			implementations: new Map([['test.double', () => undefined]]),
			calculationBindings: new Map([
				['test.double', [{ address: 'fn.notDoubleNumber', calculate: () => undefined }]]
			])
		};
		expect(() =>
			executeCompiledPlan(
				{ ops: [tickSpec], planFingerprint: 'test-plan', bindings: {} },
				pxc,
				nullFeatureContext,
				undefined,
				runtime
			)
		).toThrow(/calculation bindings disagree/);
	});
});
