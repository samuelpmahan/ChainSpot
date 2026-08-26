import { describe, expect, test } from 'vitest';
import {
	compileABFeatureSet,
	createExecBoard,
	executeABFeatureSet,
	formatABFeatureSetManifestMarkdown,
	type ABFeatureSet
} from '@chainspot/alg/exec';
import {
	nullFeatureContext,
	type ABFeature
} from '@chainspot/alg/detectors/threeFactor/features/types';

const addOneFeature = {
	id: 'add-one',
	gate: 'shared',
	kind: 'baseline',
	defaultEnabled: true,
	knobs: {},
	operations: [
		{
			spec: {
				id: 'test.add-one',
				kind: 'compute',
				gate: 'shared',
				unit: 'test',
				consumes: ['input'],
				produces: ['middle'],
				features: ['add-one']
			},
			async run(board) {
				await Promise.resolve();
				board.set('middle', board.get<number>('input') + 1);
			}
		}
	]
} satisfies ABFeature;

const doubleFeature = {
	id: 'double',
	gate: 'shared',
	kind: 'baseline',
	defaultEnabled: true,
	knobs: {},
	operations: [
		{
			spec: {
				id: 'test.double',
				kind: 'compute',
				gate: 'shared',
				unit: 'test',
				consumes: ['middle'],
				produces: ['output'],
				features: ['double']
			},
			run(board) {
				board.set('output', board.get<number>('middle') * 2);
			},
			extractArtifacts(board) {
				return [
					{
						kind: 'measurementTable',
						id: 'test.output',
						bytes: new TextEncoder().encode(JSON.stringify({ output: board.get('output') }))
					}
				];
			}
		}
	]
} satisfies ABFeature;

const set: ABFeatureSet = {
	id: 'arithmetic-demo',
	seededSlots: ['input'],
	features: [addOneFeature, doubleFeature]
};

async function runDemo(input = 3) {
	const compiled = compileABFeatureSet(set);
	const board = createExecBoard();
	board.set('input', input);
	const receipt = await executeABFeatureSet(compiled, board, nullFeatureContext, {
		runId: 'test-run',
		invocation: 'vitest abFeatureSet'
	});
	return { compiled, board, receipt };
}

describe('ABFeatureSet', () => {
	test('composes ABFeatures in list order through the shared gateway', async () => {
		const { compiled, board, receipt } = await runDemo();

		expect(compiled.plan.ops.map((op) => op.id)).toEqual(['test.add-one', 'test.double']);
		expect(board.get('output')).toBe(8);
		expect(receipt.enabledFeatureIds).toEqual(['add-one', 'double']);
		expect(receipt.operations.map((operation) => operation.opId)).toEqual([
			'test.add-one',
			'test.double'
		]);
		expect(receipt.operations[0].actualConsumes).toEqual(['input']);
		expect(receipt.operations[0].actualProduces).toEqual(['middle']);
	});

	test('rejects an order whose data dependency is impossible', () => {
		expect(() => compileABFeatureSet({ ...set, features: [doubleFeature, addOneFeature] })).toThrow(
			/test\.double.*consumes 'middle'.*no earlier operation produces it/s
		);
	});

	test('produces a stable semantic hash while retaining real timings', async () => {
		const first = (await runDemo()).receipt;
		const second = (await runDemo()).receipt;
		const changedOutput = (await runDemo(4)).receipt;

		expect(first.manifestHash).toBe(second.manifestHash);
		expect(first.manifestHash).not.toBe(changedOutput.manifestHash);
		expect(first.manifestHash).toMatch(/^[0-9a-f]{64}$/);
		expect(first.durationMs).toBeGreaterThanOrEqual(0);
	});

	test('renders a Markdown chain-of-custody manifest', async () => {
		const markdown = formatABFeatureSetManifestMarkdown((await runDemo()).receipt);

		expect(markdown).toContain('# ABFeatureSet Execution Manifest');
		expect(markdown).toContain('- invocation: `vitest abFeatureSet`');
		expect(markdown).toContain('## test.add-one');
		expect(markdown).toContain('- declared consumes: `input`');
		expect(markdown).toContain('- actual produces: `middle`');
	});
});
