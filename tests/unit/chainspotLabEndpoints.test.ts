import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { LabConfig } from '../../scripts/chainspot-lab/config';
import { LabReadService } from '../../scripts/chainspot-lab/service';
import { runStepThreeBaseline } from '../../scripts/chainspot-lab/step3Executor';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const corpusRoot = process.env.CHAINSPOT_CORPUS_ROOT ?? resolve(repoRoot, '../chainspot-corpus');
const dashsTrackRaster = join(corpusRoot, 'dev', 'DashsTrack', 'DashsTrack-full.jpg');
const temporaryRoots: string[] = [];

function testConfig(): LabConfig {
	const evidenceRoot = join(tmpdir(), `chainspot-lab-endpoints-${crypto.randomUUID()}`);
	mkdirSync(evidenceRoot, { recursive: true });
	temporaryRoots.push(evidenceRoot);
	return {
		repoRoot,
		corpus: { path: corpusRoot, source: 'environment' },
		evidenceStore: { path: evidenceRoot, source: 'environment' },
		ledgerPath: join(evidenceRoot, 'ledger.sqlite')
	};
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!existsSync(dashsTrackRaster))('Step 3 five-course endpoint Replay substrate', () => {
	it('preserves baseline behavior, lineage, replay, and chrome-only invalidation', () => {
		const config = testConfig();
		const cold = runStepThreeBaseline(config);
		expect(cold.cache).toEqual({ hits: 0, misses: 45 });
		expect(cold.cases.map((entry) => ({
			caseId: entry.caseId,
			truth: entry.evaluation.truthCount,
			raw: entry.evaluation.rawTeeCandidateCount,
			chrome: entry.evaluation.chromeSuppressedCount,
			free: entry.evaluation.freeTeeCandidateCount,
			teeRecall: entry.evaluation.teeRecallCount,
			teeMisses: entry.evaluation.teeMissHoleNumbers,
			basketRecall: entry.evaluation.basketRecallCount
		}))).toEqual([
			{ caseId: 'AlexClark-full', truth: 3, raw: 33, chrome: 8, free: 25, teeRecall: 3, teeMisses: [], basketRecall: 3 },
			{ caseId: 'DashsTrack-full', truth: 18, raw: 29, chrome: 10, free: 19, teeRecall: 18, teeMisses: [], basketRecall: 18 },
			{ caseId: 'HeritagePark-full', truth: 18, raw: 54, chrome: 8, free: 46, teeRecall: 15, teeMisses: [5, 6, 10], basketRecall: 18 },
			{ caseId: 'Lenard-full', truth: 18, raw: 63, chrome: 7, free: 56, teeRecall: 18, teeMisses: [], basketRecall: 18 },
			{ caseId: 'TowneLake-full', truth: 18, raw: 32, chrome: 3, free: 29, teeRecall: 18, teeMisses: [], basketRecall: 18 }
		]);
		expect(cold.cases.map((entry) => [entry.caseId, entry.historicalReference?.matches])).toEqual([
			['AlexClark-full', false],
			['DashsTrack-full', false],
			['HeritagePark-full', true],
			['Lenard-full', true],
			['TowneLake-full', true]
		]);

		const replay = runStepThreeBaseline(config);
		expect(replay.runId).not.toBe(cold.runId);
		expect(replay.experimentHash).toBe(cold.experimentHash);
		expect(replay.cache).toEqual({ hits: 45, misses: 0 });
		expect(replay.cases.flatMap((entry) => entry.nodes.map((node) => node.outputHash)))
			.toEqual(cold.cases.flatMap((entry) => entry.nodes.map((node) => node.outputHash)));

		const noChrome = runStepThreeBaseline(config, { chromeImplementationId: 'chrome.none' });
		expect(noChrome.experimentHash).not.toBe(cold.experimentHash);
		expect(noChrome.cache).toEqual({ hits: 30, misses: 15 });
		for (const entry of noChrome.cases) {
			expect(entry.nodes.map((node) => [node.nodeType, node.cacheStatus])).toEqual([
				['raster.decode', 'hit'],
				['viewport.crop', 'hit'],
				['mask.bright-dark', 'hit'],
				['components.bright', 'hit'],
				['badges.detect', 'hit'],
				['baskets.sprite-match', 'hit'],
				['chrome.attribute', 'miss'],
				['tees.candidates', 'miss'],
				['endpoints.evaluate', 'miss']
			]);
		}

		const reads = new LabReadService(config);
		const shown = reads.showRun(cold.runId);
		expect(shown.nodes).toHaveLength(45);
		const endpointQuery = reads.queryEndpointRun(cold.runId);
		expect(endpointQuery.cases).toHaveLength(5);
		expect(endpointQuery.cases.map((entry) => entry.evaluation.course)).toEqual([
			'AlexClark', 'DashsTrack', 'Heritage', 'Lenard', 'TowneLake'
		]);

		const database = new DatabaseSync(config.ledgerPath, { readOnly: true });
		const relations = database.prepare(`
			SELECT relation, COUNT(*) AS count
			FROM entity_lineage GROUP BY relation ORDER BY relation
		`).all() as Array<{ relation: string; count: number }>;
		expect(relations.map((row) => row.relation)).toEqual(expect.arrayContaining([
			'attributed-to-screen-chrome',
			'classified-from-component',
			'derived-from-origin',
			'groups-component',
			'supported-by-component'
		]));
		expect(relations.every((row) => row.count > 0)).toBe(true);
		const runEntityLinks = database.prepare(
			'SELECT COUNT(*) AS count FROM run_node_entities WHERE run_id = ?'
		).get(cold.runId) as { count: number };
		expect(runEntityLinks.count).toBeGreaterThan(0);
		database.close();
	}, 60_000);
});
