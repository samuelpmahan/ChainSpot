/**
 * End-to-end proof of the Toph <-> ChainSpot counterfactual-replay slice,
 * driven entirely through the real replay machinery (openReplaySession /
 * replay / grid / firstDivergentStage / stagesEquivalentThrough) -- no
 * bespoke re-implementation.
 *
 * Usage: npx tsx scripts/toph-replay-proof.ts [--toph-dir <path>] [--out <dir>]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createChainSpotReplayAdapter } from './toph-replay-adapter';

function parseArgs(argv: readonly string[]) {
	const get = (flag: string): string | undefined => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	return {
		tophDir: get('--toph-dir') ?? process.env.TOPH_DIR ?? '/workspace/toph',
		outDir: get('--out') ?? '/tmp/claude-0/-home-user-ChainSpot/fb5fce95-80be-585b-af38-d95355ff8f7e/scratchpad/proof'
	};
}

interface FinalAssignment {
	holeNumber: number;
	assignedBasketIndex: number | null;
}

function holeAssignment(final: unknown, holeNumber: number): number | null {
	const list = final as FinalAssignment[];
	return list.find((a) => a.holeNumber === holeNumber)?.assignedBasketIndex ?? null;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const tophDir = resolve(args.tophDir);
	const outDir = resolve(args.outDir);
	mkdirSync(outDir, { recursive: true });

	const replayUrl = new URL('src/replay/index.ts', `file://${tophDir}/`).href;
	const { openReplaySession, firstDivergentStage, stagesEquivalentThrough, diffConfig } = (await import(
		replayUrl
	)) as typeof import('/workspace/toph/src/replay/index.js');

	const projectRoot = resolve(__dirnameCompat());
	const sessionDir = resolve(outDir, 'session');
	rmSync(sessionDir, { recursive: true, force: true });

	const adapter = await createChainSpotReplayAdapter({
		imagePath: resolve(projectRoot, 'resources/cv-fixtures/TheRec-stitched.png'),
		projectRoot,
		tophDir,
		truthPath: resolve(projectRoot, 'resources/cv-fixtures/the-rec.json')
	});

	const session = await openReplaySession(sessionDir, adapter);

	const narrative: string[] = [];
	narrative.push('# Toph <-> ChainSpot counterfactual replay proof\n');
	narrative.push(`Session dir: \`${sessionDir}\`\n`);

	// --- baseline ---
	const baseline = await session.baseline();
	writeFileSync(resolve(outDir, 'run-baseline.json'), JSON.stringify(baseline, null, 2));
	const baselineFinal = await session.loadFinal(baseline.runId);
	writeFileSync(resolve(outDir, 'final-baseline.json'), JSON.stringify(baselineFinal, null, 2));

	// --- manual toggle: p6.swap.enabled = false ---
	const swapOff = await session.replay(baseline.runId, { 'p6.swap.enabled': false }, 'swap-off');
	writeFileSync(resolve(outDir, 'run-swap-off.json'), JSON.stringify(swapOff, null, 2));
	const swapOffFinal = await session.loadFinal(swapOff.runId);
	writeFileSync(resolve(outDir, 'final-swap-off.json'), JSON.stringify(swapOffFinal, null, 2));

	// --- grid: minRibbonImprovementPx over [0, 100, 300] ---
	const gridRuns = await session.grid(baseline.runId, { 'p6.swap.minRibbonImprovementPx': [0, 100, 300] });
	writeFileSync(resolve(outDir, 'run-grid.json'), JSON.stringify(gridRuns, null, 2));

	// --- manual-toggle === one-point-grid equivalence check ---
	const gridSwapOff = await session.grid(baseline.runId, { 'p6.swap.enabled': [false] });
	writeFileSync(resolve(outDir, 'run-grid-swap-off.json'), JSON.stringify(gridSwapOff, null, 2));
	const gridSwapOffRun = gridSwapOff[0];
	// `summary.wallMs` is wall-clock timing -- non-deterministic noise that varies
	// run-to-run even under an identical config -- so it is deliberately excluded from
	// the equivalence comparison below; every other summary key must match exactly.
	const stripWallMs = (summary: Record<string, unknown>) => {
		const { wallMs: _wallMs, ...rest } = summary;
		return rest;
	};
	const equivalence = {
		patchEqual: JSON.stringify(gridSwapOffRun.patch) === JSON.stringify(swapOff.patch),
		effectiveConfigEqual: JSON.stringify(gridSwapOffRun.effectiveConfig) === JSON.stringify(swapOff.effectiveConfig),
		summaryEqualExcludingWallMs:
			JSON.stringify(stripWallMs(gridSwapOffRun.summary)) === JSON.stringify(stripWallMs(swapOff.summary)),
		gridWallMs: gridSwapOffRun.summary.wallMs,
		manualWallMs: swapOff.summary.wallMs
	};
	writeFileSync(resolve(outDir, 'equivalence-check.json'), JSON.stringify({ manual: swapOff, grid: gridSwapOffRun, equivalence }, null, 2));

	// --- traces + divergence ---
	const baselineTrace = await session.loadTrace(baseline.runId);
	const swapOffTrace = await session.loadTrace(swapOff.runId);
	const divergence = firstDivergentStage(baselineTrace, swapOffTrace);
	const manifest = (await session.loadManifest(baseline.runId)) as { stages: { id: number; name: string }[] };
	const divergentStageName = divergence ? manifest.stages.find((s) => s.id === divergence.stageId)?.name : null;

	// stagesEquivalentThrough p6.lowParAssignment (both should agree there since only the swap phase differs)
	const lowParStageId = manifest.stages.find((s) => s.name === 'p6.lowParAssignment')?.id;
	const baselineLowParInv = baselineTrace.stages.find((s) => s.stageId === lowParStageId);
	const swapOffLowParInv = swapOffTrace.stages.find((s) => s.stageId === lowParStageId);
	const lowParEquivalent =
		baselineLowParInv && swapOffLowParInv
			? stagesEquivalentThrough(
					{ trace: baselineTrace, invocationId: baselineLowParInv.invocationId },
					{ trace: swapOffTrace, invocationId: swapOffLowParInv.invocationId }
				)
			: 'MISSING INVOCATION';

	const configDiff = diffConfig(baseline.effectiveConfig, swapOff.effectiveConfig);

	writeFileSync(
		resolve(outDir, 'divergence.json'),
		JSON.stringify({ divergence, divergentStageName, lowParEquivalent, configDiff }, null, 2)
	);

	// --- narrative ---
	narrative.push('## Runs\n');
	narrative.push('| runId | parent | patch | hole7->basket | hole8->basket | swapsApplied |');
	narrative.push('|---|---|---|---|---|---|');
	const rowFor = (label: string, run: typeof baseline, final: unknown) => {
		const h7 = holeAssignment(final, 7);
		const h8 = holeAssignment(final, 8);
		narrative.push(
			`| ${run.runId.slice(0, 8)} (${label}) | ${run.parentRunId?.slice(0, 8) ?? 'none'} | ${JSON.stringify(run.patch)} | ${h7} | ${h8} | ${run.summary['p62.swapsApplied']} |`
		);
	};
	rowFor('baseline', baseline, baselineFinal);
	rowFor('swap-off', swapOff, swapOffFinal);
	for (const run of gridRuns) {
		const final = await session.loadFinal(run.runId);
		rowFor(`grid(minRibbonImprovementPx=${JSON.stringify(run.patch)})`, run, final);
	}
	rowFor('grid(swap.enabled=[false])', gridSwapOffRun, await session.loadFinal(gridSwapOffRun.runId));

	narrative.push('\n## Divergence\n');
	narrative.push(`firstDivergentStage(baseline, swapOff) => stageId=${divergence?.stageId}, seq=${divergence?.seq}, name="${divergentStageName}"`);
	narrative.push(`EXPECTED: p6.swapAdjudication -- ${divergentStageName === 'p6.swapAdjudication' ? 'MATCH' : 'MISMATCH'}`);
	narrative.push(`stagesEquivalentThrough(p6.lowParAssignment): ${JSON.stringify(lowParEquivalent)} (null = equivalent, as expected)`);

	narrative.push('\n## Baseline final assignment (7,8)\n');
	narrative.push(`hole7 -> basket${holeAssignment(baselineFinal, 7)}, hole8 -> basket${holeAssignment(baselineFinal, 8)} (expect 3,4 swapped)`);
	narrative.push('\n## swap-off final assignment (7,8)\n');
	narrative.push(`hole7 -> basket${holeAssignment(swapOffFinal, 7)}, hole8 -> basket${holeAssignment(swapOffFinal, 8)} (expect original gated 4,3 -- unswapped)`);

	narrative.push('\n## Grid over p6.swap.minRibbonImprovementPx = [0, 100, 300]\n');
	for (const run of gridRuns) {
		const final = await session.loadFinal(run.runId);
		narrative.push(
			`- patch=${JSON.stringify(run.patch)}: swapsApplied=${run.summary['p62.swapsApplied']}, hole7->basket${holeAssignment(final, 7)}, hole8->basket${holeAssignment(final, 8)}`
		);
	}
	narrative.push('\nEXPECTED: threshold 0 and 100 swap (ribbon improvement ~236px clears both), threshold 300 does not swap.');

	narrative.push('\n## Manual-toggle === one-point-grid equivalence\n');
	narrative.push('`grid(baseline, {"p6.swap.enabled":[false]})` vs manual `replay(baseline, {"p6.swap.enabled":false})`, ignoring runId/createdAt:\n');
	narrative.push('```json');
	narrative.push(JSON.stringify(equivalence, null, 2));
	narrative.push('```');
	narrative.push(
		equivalence.patchEqual && equivalence.effectiveConfigEqual && equivalence.summaryEqualExcludingWallMs
			? '\nMATCH: grid and manual replay are equivalent (wallMs excluded -- wall-clock timing, expected to differ run-to-run).'
			: '\nMISMATCH -- investigate.'
	);

	narrative.push(`\n## Session run list (${session.list().length} total)\n`);
	for (const run of session.list()) {
		narrative.push(`- ${run.runId} parent=${run.parentRunId ?? 'none'} patch=${JSON.stringify(run.patch)} label=${run.label ?? ''}`);
	}

	writeFileSync(resolve(outDir, 'PROOF.md'), narrative.join('\n') + '\n');
	console.log(narrative.join('\n'));
	console.log(`\nAll outputs written to ${outDir}`);
	console.log(`Session dir for viewer/screenshots: ${sessionDir}`);
}

// tsx runs this as an ESM module (no __dirname); resolve this repo's root relative to the
// script's own location instead.
function __dirnameCompat(): string {
	return new URL('..', import.meta.url).pathname;
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
