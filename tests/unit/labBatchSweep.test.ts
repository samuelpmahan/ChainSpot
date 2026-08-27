import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const sweepCalls: Array<Record<string, unknown>> = [];

vi.mock('../../scripts/chainspot-lab/sweep/operation', async () => {
	const actual = await vi.importActual<typeof import('../../scripts/chainspot-lab/sweep/operation')>(
		'../../scripts/chainspot-lab/sweep/operation'
	);
	return {
		...actual,
		runSweepOperation: vi.fn(async (input: Record<string, unknown>) => {
			sweepCalls.push(input);
			if ((input.inputPaths as string[]).some((path) => path.endsWith('TheRec-R.PNG'))) {
				throw new Error('synthetic REC stitch failure');
			}
			return {
				configPath: String(input.configPath),
				configName: 'batch-test',
				receipts: [{ actualConsumes: [], actualProduces: [], declaredConsumes: [], declaredProduces: [], durationMs: 12.5 }],
				trace: {
					units: [
						{ id: 'badges', drawables: [{ verdict: 'accepted' }] },
						{ id: 'baskets', drawables: [{ verdict: 'accepted' }] },
						{ id: 'tees', drawables: [{ verdict: 'accepted' }, { verdict: 'accepted' }, { verdict: 'accepted' }, { verdict: 'accepted' }] },
						{ id: 'teeFamily', drawables: [{ verdict: 'accepted' }], measurements: [{ name: 'ringCandidates', count: 4 }, { name: 'preFamilyTees', count: 4 }, { name: 'kept', count: 3 }] }
					]
				},
				outDir: String(input.outDir),
				featureRenders: [],
				artifactRenders: [],
				renderedCount: 0,
				stubbedCount: 0,
				groundingComparisons: [],
				truthScoringSkipped: true
			};
		})
	};
});

import {
	casesForManifest,
	parseBatchArgs,
	renderBatchText,
	runSweepBatch,
	selectBatchManifests,
	summarizeBatchSuccess,
	type BatchManifest,
	type BatchSummary
} from '../../scripts/chainspot-lab/sweep/batch';

const CONFIG = resolve('tests/fixtures/lab-sweep-custom-g5.json');
const BATCH_ROOT = resolve('artifacts/sweep/lab-sweep-custom-g5/batches');

function manifest(overrides: Partial<BatchManifest> = {}): BatchManifest {
	return {
		path: '/tmp/course.json',
		version: 1,
		course: 'ExampleCourse',
		aliases: ['Example'],
		devDir: 'ExampleCourse',
		image: 'Example-full.png',
		...overrides
	};
}

describe('LAB sweep batch', () => {
	beforeEach(() => {
		sweepCalls.length = 0;
		rmSync(BATCH_ROOT, { recursive: true, force: true });
	});

	test('parses the batch form and resolves aliases, groups, and all', () => {
		expect(parseBatchArgs(['batch', '--through', 'G3', CONFIG, 'dev', 'demo'])).toEqual({
		throughGate: 'G3', configPath: CONFIG, selectors: ['dev', 'demo']
	});
		expect(parseBatchArgs(['batch', CONFIG])).toEqual({ throughGate: 'G3', configPath: CONFIG, selectors: [] });

		const manifests = [
			manifest({ course: 'DashsTrack', aliases: ['Dashs', 'Dashs Track'], devDir: 'DashsTrack', set: 'dev' }),
			manifest({ path: '/tmp/rec.json', course: 'TheREC', aliases: ['The Rec', 'REC'], devDir: '.', corpusDir: 'demo', set: 'demo' })
		];
		expect(selectBatchManifests(['Dashs'], manifests).map((entry) => entry.course)).toEqual(['DashsTrack']);
		expect(selectBatchManifests(['demo'], manifests).map((entry) => entry.course)).toEqual(['TheREC']);
		expect(selectBatchManifests(['all'], manifests).map((entry) => entry.course)).toEqual(['DashsTrack', 'TheREC']);
	});

	test('TheREC is a three-case manifest with L/R grouped as one operation', () => {
		const rec = selectBatchManifests(['TheREC']).find((entry) => entry.course === 'TheREC');
		expect(rec).toBeDefined();
		const cases = casesForManifest(rec!);
		expect(cases).toEqual([
			{ name: 'stitched', inputs: ['TheRec-L.PNG', 'TheRec-R.PNG'] },
			{ name: 'clean-full', inputs: ['TheREC-McKinney-TX.jpg'] },
			{ name: 'thrown-full', inputs: ['TheRec-Thrown-full.PNG'] }
		]);
	});

	test('repository manifests classify TheREC under demo and legacy courses under dev', () => {
		const demo = selectBatchManifests(['demo']);
		const dev = selectBatchManifests(['dev']);
		expect(demo.map((entry) => entry.course)).toContain('TheREC');
		expect(dev.map((entry) => entry.course)).not.toContain('TheREC');
	});

	test('runs every case, never supplies truth, continues after failure, and returns nonzero', async () => {
		const output: string[] = [];
		const log = vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
		let code = -1;
		try {
			code = await runSweepBatch(['batch', '--through', 'G3', CONFIG, 'TheREC']);
		} finally {
			log.mockRestore();
		}
		expect(code).toBe(1);
		expect(output.filter((line) => line.startsWith('LAB SWEEP BATCH ['))).toEqual([
			'LAB SWEEP BATCH [1/3] START TheREC/stitched · inputs=2',
			'LAB SWEEP BATCH [1/3] FAIL TheREC/stitched',
			'LAB SWEEP BATCH [2/3] START TheREC/clean-full · inputs=1',
			'LAB SWEEP BATCH [2/3] DONE TheREC/clean-full',
			'LAB SWEEP BATCH [3/3] START TheREC/thrown-full · inputs=1',
			'LAB SWEEP BATCH [3/3] DONE TheREC/thrown-full'
		]);
		expect(sweepCalls).toHaveLength(3);
		expect(sweepCalls[0]).toMatchObject({ throughGate: 'G3' });
		expect(sweepCalls[0]).not.toHaveProperty('truthPath');
		expect(sweepCalls[0].inputPaths).toEqual([
			resolve('../chainspot-corpus/demo/TheRec-L.PNG'),
			resolve('../chainspot-corpus/demo/TheRec-R.PNG')
		]);
		expect(sweepCalls.slice(1).every((call) => !('truthPath' in call))).toBe(true);

		const summary = JSON.parse(readFileSync(resolve(BATCH_ROOT, 'summary.json'), 'utf8')) as BatchSummary;
		expect(summary).toMatchObject({ throughGate: 'G3', succeeded: 2, failed: 1, status: 'failed' });
		expect(summary.rows.map((row) => row.caseName)).toEqual(['stitched', 'clean-full', 'thrown-full']);
		expect(summary.rows[0].status).toBe('failed');
		expect(summary.rows[1]).toMatchObject({
			status: 'ok', badges: 1, baskets: 1, rawRings: 4, preFamilyTees: 4,
			visibleTees: 1, visibleDeficit: 0, operations: 1,
			inputs: ['../chainspot-corpus/demo/TheREC-McKinney-TX.jpg'],
			outDir: 'artifacts/sweep/lab-sweep-custom-g5/batches/TheREC/clean-full'
		});
	});

	test('success summaries expose the compact receipt fields', () => {
		const result = {
			trace: {
				units: [
					{ id: 'badges', drawables: [{ verdict: 'accepted' }, { verdict: 'rejected' }] },
					{ id: 'baskets', drawables: [{ verdict: 'accepted' }] },
					{ id: 'tees', drawables: Array.from({ length: 9 }, () => ({ verdict: 'accepted' })) },
					{ id: 'teeFamily', drawables: [{ verdict: 'accepted' }], measurements: [{ name: 'ringCandidates', count: 9 }, { name: 'preFamilyTees', count: 9 }, { name: 'kept', count: 1 }] }
				]
			},
			receipts: [{ actualConsumes: ['a'], actualProduces: ['b'], declaredConsumes: ['a'], declaredProduces: ['b'], durationMs: 4.25 }]
		} as any;
		const row = summarizeBatchSuccess(manifest(), { name: 'full', inputs: ['Example-full.png'] }, ['/tmp/Example-full.png'], result, '/workspace/scratch/5c4158eab6a1/artifacts/sweep/batch-test/ExampleCourse/full');
		expect(Object.keys(row)).toEqual([
			'course', 'caseName', 'inputs', 'status', 'outDir', 'badges', 'baskets',
			'rawRings', 'preFamilyTees', 'visibleTees', 'visibleDeficit', 'provenance',
			'operations', 'durationMs', 'conformanceDrift'
		]);
		expect(row).toMatchObject({ course: 'ExampleCourse', caseName: 'full', status: 'ok', badges: 1, baskets: 1, rawRings: 9, preFamilyTees: 9, visibleTees: 1, visibleDeficit: 0, operations: 1, durationMs: 4.25, conformanceDrift: 0 });
		expect(row.provenance).toEqual({
			badges: "trace unit 'badges' accepted drawables",
			baskets: "trace unit 'baskets' accepted drawables",
			rawRings: "trace unit 'tees' accepted + rejected drawables (ringMeasure/exclusion)",
			preFamilyTees: "trace unit 'tees' accepted drawables after G3 exclusion",
			visibleTees: "trace unit 'teeFamily' accepted drawables",
			visibleDeficit: "max(0, trace unit 'badges' accepted drawables - visibleTees)",
			operations: 'engine operation receipt count',
			durationMs: 'sum of engine operation receipt durationMs values (volatile run measurement)',
			conformanceDrift: 'engine receipts missing any declared consume/produce slot from actual consumes/produces'
		});
		const summary: BatchSummary = { configName: 'batch-test', configPath: 'config.json', throughGate: 'G3', selectors: ['demo'], rows: [row], succeeded: 1, failed: 0, status: 'ok' };
		expect(renderBatchText(summary)).toContain('course · case · inputs · badges · baskets · rawRings · preFamilyTees · visibleTees · visibleDeficit · ops · ms · drift · status');
		expect(renderBatchText(summary)).toContain("badges: trace unit 'badges' accepted drawables");
		expect(renderBatchText(summary)).toContain('ms: sum of engine operation receipt durationMs values (volatile run measurement)');
		expect(renderBatchText(summary)).toContain('summary: 1 succeeded · 0 failed · status=ok');
	});
});
