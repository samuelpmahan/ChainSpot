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
import type { ThreeFactorAssignment } from '@chainspot/alg/detectors/threeFactor/types';
import type { RunTrace } from '@chainspot/alg/detectors/threeFactor/features/types';
import { buildPosteriorTeeRecoveryPlan } from '@chainspot/alg/detectors/threeFactor/features/g4.posteriorTeeRecoveryReceipt';
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

interface CourseResult {
	readonly posterior: PosteriorTeeRecoveryEvidence;
	readonly assignment: ThreeFactorAssignment;
	readonly trace: RunTrace;
}

async function runCourse(id: (typeof COURSE_IDS)[number]): Promise<CourseResult> {
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
		const { ctx, trace } = createTraceContext(
			loaded.resolved,
			loaded.plan.paramsHash ?? '',
			loaded.plan.ops,
			{ imageId: report.imageId, canonicalFrame: 'G0 canonical detector-input pixels' }
		);
		executeCompiledPlan(loaded.plan, board, ctx, createNodeSink(tmp));
		return {
			posterior: board.get<PosteriorTeeRecoveryEvidence>('posteriorTeeRecovery'),
			assignment: board.get<ThreeFactorAssignment>('assignment'),
			trace
		};
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

	test('blind posterior commits and renders 107 observable/recovered + 1 NULL->phantom across Dev6', async () => {
		const results = new Map<(typeof COURSE_IDS)[number], CourseResult>();
		for (const course of COURSE_IDS) results.set(course, await runCourse(course));

		const total = [...results.values()].reduce(
			(sum, result) => sum + result.posterior.completions.total,
			0
		);
		const phantoms = [...results.values()].reduce(
			(sum, result) => sum + result.posterior.completions.phantom,
			0
		);
		const assigned = [...results.values()].reduce(
			(sum, result) => sum + result.assignment.assignments.length,
			0
		);
		expect(total).toBe(108);
		expect(phantoms).toBe(1);
		expect(assigned).toBe(108);

		for (const { posterior, assignment, trace } of results.values()) {
			expect(assignment.assignments).toHaveLength(18);
			expect(new Set(assignment.assignments.map((row) => row.badgeId)).size).toBe(18);
			expect(new Set(assignment.assignments.map((row) => row.teeId)).size).toBe(18);
			const unit = trace.units.find((candidate) => candidate.id === 'teeBadgeLock');
			expect(unit).toBeDefined();
			const renderedRays = buildPosteriorTeeRecoveryPlan(unit!, trace)
				.layers.flatMap((layer) => layer.drawables)
				.filter(
					(drawable) =>
						drawable.verdict === 'accepted' &&
						drawable.visualRole === 'tee-badge-path' &&
						typeof drawable.ref === 'string' &&
						drawable.ref.startsWith('posteriorTeeRecovery:ray:')
				);
			const teeAt = (xPx: number, yPx: number) =>
				assignment.tees.find(
					(tee) => Math.abs(tee.xPx - xPx) <= 0.5 && Math.abs(tee.yPx - yPx) <= 0.5
				);
			for (const selection of posterior.jointTop[0]?.selections ?? []) {
				if (selection.kind !== 'candidate') continue;
				const rays = renderedRays.filter((ray) =>
					ray.ref?.startsWith(`posteriorTeeRecovery:ray:${encodeURIComponent(selection.badgeId)}:`)
				);
				expect(rays).toHaveLength(1);
				expect(rays[0]?.type).toBe('polyline');
				if (rays[0]?.type === 'polyline') {
					expect(rays[0].path.at(-1)).toEqual([selection.centerXPx, selection.centerYPx]);
				}
				const tee = teeAt(selection.centerXPx, selection.centerYPx);
				expect(
					tee,
					`posterior tee missing from assignment inventory for ${selection.badgeId}`
				).toBeDefined();
				expect(
					assignment.assignments.filter(
						(row) => row.badgeId === selection.badgeId && row.teeId === tee?.detId
					)
				).toHaveLength(1);
			}
			for (const phantom of posterior.phantomProposals) {
				const rays = renderedRays.filter((ray) =>
					ray.ref?.startsWith(`posteriorTeeRecovery:ray:${encodeURIComponent(phantom.badgeId)}:`)
				);
				expect(rays).toHaveLength(1);
				expect(rays[0]?.type).toBe('polyline');
				if (rays[0]?.type === 'polyline') {
					expect(rays[0].path.at(-1)).toEqual([phantom.xPx, phantom.yPx]);
				}
				const tee = teeAt(phantom.xPx, phantom.yPx);
				expect(
					tee,
					`posterior phantom missing from assignment inventory for ${phantom.badgeId}`
				).toBeDefined();
				expect(
					assignment.assignments.filter(
						(row) => row.badgeId === phantom.badgeId && row.teeId === tee?.detId
					)
				).toHaveLength(1);
			}
		}

		const alex = results.get('AlexClark')!.posterior;
		expect(alex.completions.total).toBe(18);
		expect(alex.phantomProposals).toHaveLength(1);
		expect(alex.phantomProposals[0]?.hole).toBe(12);
		expect(alex.jointTop[0]?.selections).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: 'null', hole: '12' })])
		);

		const heritage = results.get('HeritagePark')!.posterior;
		expect(heritage.completions.total).toBe(18);
		expect(heritage.completions.phantom).toBe(0);
		expect(heritage.jointTop[0]?.selections).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: 'candidate', hole: '6' })])
		);

		const outDir = resolve(ROOT, 'artifacts/spikes/posterior-tee-recovery');
		mkdirSync(outDir, { recursive: true });
		writeFileSync(
			resolve(outDir, 'abfeature-dev6.json'),
			JSON.stringify(
				Object.fromEntries([...results].map(([course, result]) => [course, result.posterior])),
				null,
				2
			) + '\n'
		);
		console.log(`DEV6_POSTERIOR_ABFEATURE_COMPLETIONS=${total}`);
		console.log(`DEV6_POSTERIOR_ABFEATURE_PHANTOMS=${phantoms}`);
	}, 600_000);
});
