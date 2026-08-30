// FROZEN DEV6 108 — the accepted endpoint baseline.
//
// This pins the FINAL TEE POSITION of all 108 Dev6 holes (6 courses x 18) as
// accepted on sight from the endpoint images, 2026-08-30. It is a
// correct-by-acceptance baseline: the pinned corpus revision carries no
// annotation JSON, so a human reading the rendered endpoints is the oracle,
// and this file is what that acceptance was minted into.
//
// Accepted deliberately, with the reviewer's own words on record:
//   Heritage H1 and H17 "take genuinely INSANE routes to reach the correct
//   badge" — their long teeBadgeLock chordPx is ROUTED PATH LENGTH, not
//   straight-line tee-to-badge distance, and both reach the right badge.
//   They are correct and are frozen as correct.
//
// A failure here names the hole that moved. That is the point: any future
// change that relocates an endpoint has to be looked at by a human and either
// accepted (rewrite the fixture) or rejected (it is a regression).
//
// Regenerate deliberately, never casually:
//   CHAINSPOT_WRITE_FIXTURE=1 CHAINSPOT_CORPUS_ROOT=... \
//     npx vitest run tests/unit/dev6FrozenEndpoints.test.ts

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
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
const CONFIG = resolve(
	ROOT,
	'packages/alg/src/detectors/threeFactor/configs/posterior-tee-recovery-on.json'
);
const FIXTURE = resolve(ROOT, 'tests/fixtures/dev6-frozen-endpoints.json');
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

/** One frozen endpoint. Rounded to whole pixels: the baseline is an accepted
 * LOCATION, not a bit-exact float, and sub-pixel drift is not a regression. */
interface FrozenEndpoint {
	readonly hole: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly source: 'lock' | 'posterior' | 'phantom';
}

interface TeeBadgeLockLike {
	readonly locks: readonly {
		readonly badgeId: string;
		readonly teeId: string;
		readonly hole?: number;
	}[];
}

interface TeeLike {
	readonly detId: string;
	readonly xPx: number;
	readonly yPx: number;
}

async function endpointsFor(id: (typeof COURSE_IDS)[number]): Promise<FrozenEndpoint[]> {
	const loaded = loadConfig(CONFIG);
	const course = JSON.parse(
		readFileSync(resolve(ROOT, 'scripts/chainspot-lab/courses', `${id}.json`), 'utf8')
	) as { devDir: string; image: string };
	const { image, report } = await canonicalizeInputs(
		[resolve(CORPUS, 'dev', course.devDir, course.image)],
		undefined
	);
	const board = createExecBoard();
	seedBoard(
		board as unknown as EvidenceBoard,
		image,
		resolveConfiguredParams(undefined, loaded.resolved)
	);
	board.set('recoveredTees', []);
	board.set('straightTestTruthAssistance', { mode: 'blind', locks: [] });
	const tmp = mkdtempSync(resolve(tmpdir(), `dev6-frozen-${id}-`));
	try {
		const { ctx } = createTraceContext(loaded.resolved, loaded.plan.paramsHash ?? '', loaded.plan.ops, {
			imageId: report.imageId,
			canonicalFrame: 'G0 canonical detector-input pixels'
		});
		executeCompiledPlan(loaded.plan, board, ctx, createNodeSink(tmp));

		const posterior = board.get<PosteriorTeeRecoveryEvidence>('posteriorTeeRecovery');
		const teeBadge = board.get<TeeBadgeLockLike>('teeBadgeLock');
		const teeById = new Map(
			board.get<readonly TeeLike[]>('assignment.tees').map((tee) => [tee.detId, tee])
		);
		const reopened = new Set(posterior.targetBadgeIds);

		const byHole = new Map<number, FrozenEndpoint>();
		// Frozen locks the posterior left alone.
		for (const lock of teeBadge.locks) {
			if (reopened.has(lock.badgeId) || lock.hole === undefined) continue;
			const tee = teeById.get(lock.teeId);
			if (!tee) continue;
			byHole.set(lock.hole, {
				hole: lock.hole,
				xPx: Math.round(tee.xPx),
				yPx: Math.round(tee.yPx),
				source: 'lock'
			});
		}
		// Posterior-selected replacements.
		for (const selection of posterior.jointTop[0]?.selections ?? []) {
			if (selection.kind !== 'candidate') continue;
			const hole = Number(selection.hole);
			if (!Number.isInteger(hole)) continue;
			byHole.set(hole, {
				hole,
				xPx: Math.round(selection.centerXPx),
				yPx: Math.round(selection.centerYPx),
				source: 'posterior'
			});
		}
		// Synthesized phantoms.
		for (const phantom of posterior.phantomProposals) {
			byHole.set(phantom.hole, {
				hole: phantom.hole,
				xPx: Math.round(phantom.xPx),
				yPx: Math.round(phantom.yPx),
				source: 'phantom'
			});
		}
		return [...byHole.values()].sort((a, b) => a.hole - b.hole);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Fail on a broken ENVIRONMENT with a different, actionable message than a
 * genuine endpoint drift. Without this the first symptom of a missing corpus
 * is an ENOENT (or a garbage decode of a Git LFS pointer stub) thrown deep
 * inside the image decoder -- which reads exactly like the algorithm broke.
 * A freeze that cannot tell "your checkout is wrong" from "a tee moved" is
 * worse than no freeze. */
function preflight(): void {
	if (!existsSync(CORPUS)) {
		throw new Error(
			`Dev6 corpus not found at ${CORPUS}. Set CHAINSPOT_CORPUS_ROOT to your ` +
				`chainspot-corpus checkout (pinned revision 2b5913d3f1f6d8f97b0324721a4c5201bd3ed819). ` +
				`This is an environment problem, NOT an endpoint drift.`
		);
	}
	for (const id of COURSE_IDS) {
		const course = JSON.parse(
			readFileSync(resolve(ROOT, 'scripts/chainspot-lab/courses', `${id}.json`), 'utf8')
		) as { devDir: string; image: string };
		const path = resolve(CORPUS, 'dev', course.devDir, course.image);
		if (!existsSync(path)) {
			throw new Error(`Dev6 corpus is missing ${id} at ${path}. Environment problem, not drift.`);
		}
		// A Git LFS pointer is a ~130-byte text file starting with this line.
		// Decoding one yields a meaningless failure far from here.
		const head = readFileSync(path).subarray(0, 42).toString('utf8');
		if (head.startsWith('version https://git-lfs.github.com')) {
			throw new Error(
				`${id} at ${path} is a Git LFS POINTER, not an image. Run \`git lfs pull\` in the ` +
					`corpus checkout. Environment problem, NOT an endpoint drift.`
			);
		}
	}
}

describe('Dev6 frozen 108 endpoint baseline', () => {
	test('all 108 endpoints match the accepted baseline', async () => {
		preflight();
		const actual: Record<string, FrozenEndpoint[]> = {};
		for (const id of COURSE_IDS) actual[id] = await endpointsFor(id);

		const total = Object.values(actual).reduce((sum, rows) => sum + rows.length, 0);
		expect(total).toBe(108);
		for (const id of COURSE_IDS) {
			// Every hole 1..18 present exactly once — a course that silently drops
			// a hole must fail here, not quietly total to 108 some other way.
			expect(actual[id]!.map((row) => row.hole)).toEqual(
				Array.from({ length: 18 }, (_, index) => index + 1)
			);
		}

		if (process.env.CHAINSPOT_WRITE_FIXTURE === '1' || !existsSync(FIXTURE)) {
			mkdirSync(dirname(FIXTURE), { recursive: true });
			writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + '\n');
		}
		const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, FrozenEndpoint[]>;
		for (const id of COURSE_IDS) {
			// Per-course so a failure names the course and the hole that moved.
			expect(actual[id], `${id} endpoints drifted from the frozen baseline`).toEqual(expected[id]);
		}
	}, 900_000);
});
