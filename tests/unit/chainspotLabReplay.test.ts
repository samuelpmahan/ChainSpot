import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { LabConfig } from '../../scripts/chainspot-lab/config';
import { runStepTwoReplay } from '../../scripts/chainspot-lab/executor';
import { collectStatusReport } from '../../scripts/chainspot-lab/status';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const corpusRoot = process.env.CHAINSPOT_CORPUS_ROOT ?? resolve(repoRoot, '../chainspot-corpus');
const dashsTrackRaster = join(corpusRoot, 'dev', 'DashsTrack', 'DashsTrack-full.jpg');
const temporaryRoots: string[] = [];

function testConfig(): LabConfig {
	const evidenceRoot = join(tmpdir(), `chainspot-lab-replay-${crypto.randomUUID()}`);
	mkdirSync(evidenceRoot, { recursive: true });
	temporaryRoots.push(evidenceRoot);
	return {
		repoRoot,
		corpus: { path: corpusRoot, source: 'environment' },
		evidenceStore: { path: evidenceRoot, source: 'environment' },
		ledgerPath: join(evidenceRoot, 'ledger.sqlite')
	};
}

function objectPayloadPath(root: string, hash: string): string {
	return join(root, 'objects', 'sha256', hash.slice(0, 2), hash.slice(2), 'payload.bin');
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!existsSync(dashsTrackRaster))('Step 2 real-pixel Replay chain', () => {
	it('proves cold execution, replay hits, descendant invalidation, and corruption detection', () => {
		const config = testConfig();
		const cold = runStepTwoReplay(config);
		expect(cold.course).toBe('DashsTrack');
		expect(cold.ablationId).toBe('step2-dashstrack');
		expect(cold.nodes.map((node) => node.cacheStatus)).toEqual(['miss', 'miss', 'miss']);
		expect(cold.output.sourceWidth).toBe(1290);
		expect(cold.output.sourceHeight).toBe(2091);
		expect(cold.output.brightPixelCount).toBeGreaterThan(0);
		expect(cold.output.darkPixelCount).toBeGreaterThan(0);

		const replay = runStepTwoReplay(config);
		expect(replay.runId).not.toBe(cold.runId);
		expect(replay.experimentHash).toBe(cold.experimentHash);
		expect(replay.nodes.map((node) => node.cacheStatus)).toEqual(['hit', 'hit', 'hit']);
		expect(replay.nodes.map((node) => node.outputHash)).toEqual(
			cold.nodes.map((node) => node.outputHash)
		);

		const changedViewport = runStepTwoReplay(config, {
			viewportParametersOverride: {
				strategy: 'explicit-insets',
				topInsetPx: 1,
				bottomInsetPx: 0
			}
		});
		expect(changedViewport.nodes.map((node) => node.cacheStatus)).toEqual(['hit', 'miss', 'miss']);
		expect(changedViewport.nodes[0].outputHash).toBe(cold.nodes[0].outputHash);
		expect(changedViewport.nodes[1].outputHash).not.toBe(cold.nodes[1].outputHash);
		expect(changedViewport.nodes[2].outputHash).not.toBe(cold.nodes[2].outputHash);

		const maskPayloadPath = objectPayloadPath(
			config.evidenceStore.path,
			cold.nodes[2].outputHash
		);
		const corrupted = readFileSync(maskPayloadPath);
		corrupted[corrupted.byteLength - 1] ^= 0xff;
		writeFileSync(maskPayloadPath, corrupted);
		expect(() => runStepTwoReplay(config)).toThrow(/payload digest mismatch/);

		const status = collectStatusReport(config);
		expect(status.ledger?.counts.runs).toBe(4);
		expect(status.ledger?.latestRuns[0].status).toBe('failed');
		expect(status.ledger?.latestRuns[0].nodes.map((node) => [node.nodeId, node.status, node.cacheStatus]))
			.toEqual([
				['raster.decode', 'completed', 'hit'],
				['viewport.crop', 'completed', 'hit'],
				['mask.bright-dark', 'failed', 'hit']
			]);
	});
});
