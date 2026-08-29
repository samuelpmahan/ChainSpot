// What this does: runs the real default production sweep for one or more dev
// courses and writes a human-readable tee chain-of-custody receipt for each
// one to artifacts/custody-receipts/<Course>.custody.receipt.txt.
// How to run it: from the repo root, `node --import tsx
// scripts/chainspot-lab/custody-receipt-tool.ts [Course...]` — with no course
// names it runs all six Dev6 courses. This is a plain script, not a `lab`
// subcommand — there is no new CLI surface here.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	createExecBoard,
	executeCompiledPlan,
	type CompiledExecutionPlan
} from '@chainspot/alg/exec';
import { createNodeSink } from '@chainspot/alg/exec/node-sink';
import { canonicalJson, sha256Hex } from '@chainspot/alg/detectors/threeFactor';
import { createTraceContext, resolveConfiguredParams } from '@chainspot/alg/detectors/threeFactor/engine';
import { seedBoard } from '@chainspot/alg/detectors/threeFactor/measure';
import type { EvidenceBoard } from '@chainspot/alg/detectors/threeFactor/features/types';
import type { ThreeFactorAssignment } from '@chainspot/alg/detectors/threeFactor/types';
import { buildChainOfCustody } from '@chainspot/alg/detectors/threeFactor';
import { makeTraceRunId, sealTrace } from '@chainspot/alg/detectors/threeFactor/features/traceIdentity';

import { loadConfig } from './sweep/configIo';
import { canonicalizeInputs } from './sweep/inputShim';
import { DEFAULT_CORPUS_ROOT, COURSE_MANIFEST_DIR } from './context/context.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const CONFIG_PATH = resolve(
	REPO_ROOT,
	'packages/alg/dist/detectors/threeFactor/configs/default.json'
);
const OUT_DIR = resolve(REPO_ROOT, 'artifacts/custody-receipts');

const DEV6 = ['AlexClark', 'DashsTrack', 'HeritagePark', 'Lenard', 'NorthPark', 'TowneLake'] as const;

interface CourseManifest {
	readonly course: string;
	readonly devDir: string;
	readonly corpusDir?: string;
	readonly image: string;
}

function loadManifest(course: string): CourseManifest {
	const path = resolve(COURSE_MANIFEST_DIR, `${course}.json`);
	return JSON.parse(readFileSync(path, 'utf-8'));
}

function tierLabel(originKind: string): string {
	switch (originKind) {
		case 'visible-ring':
			return 'ring';
		case 'visible-component':
			return 'component';
		case 'recovered':
			return 'recovered';
		default:
			return originKind;
	}
}

async function runCourse(course: string): Promise<string> {
	const manifest = loadManifest(course);
	const courseDir = resolve(DEFAULT_CORPUS_ROOT, manifest.corpusDir ?? 'dev', manifest.devDir);
	const inputPath = resolve(courseDir, manifest.image);

	const firstLoad = loadConfig(CONFIG_PATH);
	const paramsHash = await sha256Hex(canonicalJson(firstLoad.resolved));
	const loaded = loadConfig(CONFIG_PATH, paramsHash);
	const plan: CompiledExecutionPlan = loaded.plan;

	const { report, image } = await canonicalizeInputs([inputPath], undefined);

	const board = createExecBoard();
	seedBoard(board as unknown as EvidenceBoard, image, resolveConfiguredParams(undefined, loaded.resolved));
	board.set('recoveredTees', []);
	board.set('straightTestTruthAssistance', { mode: 'blind', locks: [] });

	const sink = createNodeSink(resolve(OUT_DIR, '_scratch', course));
	const { ctx, trace } = createTraceContext(loaded.resolved, plan.paramsHash ?? '', plan.ops, {
		imageId: report.imageId,
		canonicalFrame: 'G0 canonical detector-input pixels'
	});
	executeCompiledPlan(plan, board, ctx, sink);

	const runId = makeTraceRunId(report.imageId, plan.paramsHash ?? '', plan.planFingerprint);
	const sealedTrace = sealTrace(trace, { runId, imageId: report.imageId });
	const assignment = board.get<ThreeFactorAssignment>('assignment');

	const custody = buildChainOfCustody(assignment, sealedTrace);

	const lines: string[] = [];
	lines.push(`CHAIN OF CUSTODY — ${course}`);
	lines.push(`schema=${custody.schema} runId=${custody.runId ?? 'UNKNOWN'} imageId=${custody.imageId ?? 'UNKNOWN'}`);
	lines.push(`traceAvailable=${custody.traceAvailable}`);
	lines.push(`totalTees=${custody.tees.length}`);
	lines.push('');

	let visible = 0;
	let recovered = 0;
	let assigned = 0;
	let unassigned = 0;
	let withGaps = 0;

	for (const tee of custody.tees) {
		if (tee.originKind === 'recovered') recovered += 1;
		else visible += 1;
		const assignmentEvent = tee.events.find((event): event is Extract<typeof event, { kind: 'assignment' }> => event.kind === 'assignment');
		const hole = assignmentEvent?.hole ?? null;
		if (hole) assigned += 1;
		else unassigned += 1;
		if (tee.gaps.length > 0) withGaps += 1;

		lines.push(`tee=${tee.teeId} tier=${tierLabel(tee.originKind)} hole=${hole ?? 'UNASSIGNED'}`);
		lines.push(`  summary: ${tee.summary}`);
		lines.push(`  evidenceRefs: ${tee.evidenceRefs.join(', ')}`);
		if (tee.gaps.length > 0) {
			for (const gap of tee.gaps) lines.push(`  GAP: ${gap}`);
		} else {
			lines.push('  GAP: none (lineage complete)');
		}
		if (assignmentEvent) {
			lines.push(
				`  assignment: producer=${assignmentEvent.producerUnit} badge=${assignmentEvent.badgeId} basket=${assignmentEvent.basketId} score=${assignmentEvent.score} rank=${assignmentEvent.rank} ownership=${assignmentEvent.ownership}`
			);
		} else {
			lines.push('  assignment: UNASSIGNED (no assignment event in this run)');
		}
		lines.push(`  events: ${tee.events.length}`);
		lines.push('');
	}

	lines.push('COUNTS');
	lines.push(`  total=${custody.tees.length} visible=${visible} recovered=${recovered}`);
	lines.push(`  assigned=${assigned} unassigned=${unassigned}`);
	lines.push(`  chainsWithGaps=${withGaps}`);
	lines.push('');

	mkdirSync(OUT_DIR, { recursive: true });
	const outPath = resolve(OUT_DIR, `${course}.custody.receipt.txt`);
	writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');
	return outPath;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const courses = args.length ? args : [...DEV6];
	for (const course of courses) {
		const outPath = await runCourse(course);
		console.log(`[custody-receipt] ${course} -> ${outPath}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
