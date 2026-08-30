import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createExecBoard, executeCompiledPlan } from '@chainspot/alg/exec';
import { createNodeSink } from '@chainspot/alg/exec/node-sink';
import {
	createTraceContext,
	resolveConfiguredParams
} from '@chainspot/alg/detectors/threeFactor/engine';
import { seedBoard } from '@chainspot/alg/detectors/threeFactor/measure';
import type { EvidenceBoard } from '@chainspot/alg/detectors/threeFactor/features/types';
import type { PosteriorTeeRecoveryEvidence } from '@chainspot/alg/detectors/threeFactor/features/g4.posteriorTeeRecovery';
import { loadConfig } from '../../scripts/chainspot-lab/sweep/configIo';
import { canonicalizeInputs } from '../../scripts/chainspot-lab/sweep/inputShim';

const ROOT = resolve(import.meta.dirname, '../..');
const DEFAULT_CONFIG = resolve(ROOT, 'packages/alg/src/detectors/threeFactor/configs/default.json');
const POSTERIOR_CONFIG = resolve(
	ROOT,
	'packages/alg/src/detectors/threeFactor/configs/posterior-tee-recovery-on.json'
);
const CORPUS = resolve(
	process.env.CHAINSPOT_CORPUS_ROOT ?? resolve(ROOT, '..', 'chainspot-corpus')
);
const COURSE_IDS = [
	'AlexClark',
	'DashsTrack',
	'HeritagePark',
	'Lenard',
	'NorthPark',
	'TowneLake'
] as const;

interface CourseRegistryEntry {
	readonly devDir: string;
	readonly image: string;
}

function courseEntry(id: (typeof COURSE_IDS)[number]): CourseRegistryEntry {
	return JSON.parse(
		readFileSync(resolve(ROOT, 'scripts/chainspot-lab/courses', `${id}.json`), 'utf8')
	) as CourseRegistryEntry;
}

async function runCourse(id: (typeof COURSE_IDS)[number]): Promise<PosteriorTeeRecoveryEvidence> {
	const loaded = loadConfig(POSTERIOR_CONFIG);
	const course = courseEntry(id);
	const input = resolve(CORPUS, 'dev', course.devDir, course.image);
	const { image, report } = await canonicalizeInputs([input], undefined);
	const board = createExecBoard();
	seedBoard(
		board as unknown as EvidenceBoard,
		image,
		resolveConfiguredParams(undefined, loaded.resolved)
	);
	board.set('recoveredTees', []);
	board.set('straightTestTruthAssistance', { mode: 'blind', locks: [] });
	const tmp = mkdtempSync(resolve(tmpdir(), `chainspot-posterior-abfeature-${id}-`));
	try {
		const { ctx } = createTraceContext(
			loaded.resolved,
			loaded.plan.paramsHash ?? '',
			loaded.plan.ops,
			{ imageId: report.imageId, canonicalFrame: 'G0 canonical detector-input pixels' }
		);
		executeCompiledPlan(loaded.plan, board, ctx, createNodeSink(tmp));
		return board.get<PosteriorTeeRecoveryEvidence>('posteriorTeeRecovery');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

describe('posteriorTeeRecovery ABFeature', () => {
	test('registration is invisible to the frozen default schedule until explicitly configured', () => {
		const baseline = loadConfig(DEFAULT_CONFIG);
		const posterior = loadConfig(POSTERIOR_CONFIG);
		expect(baseline.resolved.features.posteriorTeeRecovery).toBeUndefined();
		expect(baseline.plan.ops.some((op) => op.id === 'posteriorTeeRecovery')).toBe(false);
		expect(posterior.resolved.features.posteriorTeeRecovery?.enabled).toBe(true);
		expect(posterior.plan.ops.map((op) => op.id)).toContain('posteriorTeeRecovery');
		const lockIndex = posterior.plan.ops.findIndex((op) => op.id === 'teeBadgeLock');
		const posteriorIndex = posterior.plan.ops.findIndex((op) => op.id === 'posteriorTeeRecovery');
		expect(posteriorIndex).toBe(lockIndex + 1);
	});

	test('blind sidecar posterior completes Dev6 as 107 observable/recovered + 1 NULL->phantom', async () => {
		const results = new Map<(typeof COURSE_IDS)[number], PosteriorTeeRecoveryEvidence>();
		for (const course of COURSE_IDS) results.set(course, await runCourse(course));

		const total = [...results.values()].reduce(
			(sum, evidence) => sum + evidence.completions.total,
			0
		);
		const phantoms = [...results.values()].reduce(
			(sum, evidence) => sum + evidence.completions.phantom,
			0
		);
		expect(total).toBe(108);
		expect(phantoms).toBe(1);

		const alex = results.get('AlexClark')!;
		expect(alex.completions.total).toBe(18);
		expect(alex.phantomProposals).toHaveLength(1);
		expect(alex.phantomProposals[0]?.hole).toBe(12);
		expect(alex.jointTop[0]?.selections).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: 'null', hole: '12' })])
		);

		const heritage = results.get('HeritagePark')!;
		expect(heritage.completions.total).toBe(18);
		expect(heritage.completions.phantom).toBe(0);
		expect(heritage.jointTop[0]?.selections).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: 'candidate', hole: '6' })])
		);

		const outDir = resolve(ROOT, 'artifacts/spikes/posterior-tee-recovery');
		mkdirSync(outDir, { recursive: true });
		writeFileSync(
			resolve(outDir, 'abfeature-dev6.json'),
			JSON.stringify(Object.fromEntries(results), null, 2) + '\n'
		);
		console.log(`DEV6_POSTERIOR_ABFEATURE_COMPLETIONS=${total}`);
		console.log(`DEV6_POSTERIOR_ABFEATURE_PHANTOMS=${phantoms}`);
	}, 600_000);
});
