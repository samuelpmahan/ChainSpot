import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createChainSpotReplayAdapterWithEvidence } from './toph-replay-adapter-real-evidence';

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
	const projectRoot = resolve(process.cwd());
	const tophDir = resolve(process.argv[2] ?? '../toph');
	const imagePath = resolve(projectRoot, 'resources/cv-fixtures/TheRec-stitched.png');
	const truthPath = resolve(projectRoot, 'resources/cv-fixtures/the-rec.json');
	const sessionDir = resolve(projectRoot, '.toph-sessions/real-evidence-proof');
	rmSync(sessionDir, { recursive: true, force: true });

	const adapter = await createChainSpotReplayAdapterWithEvidence({ imagePath, projectRoot, tophDir, truthPath });
	const replayUrl = pathToFileURL(resolve(tophDir, 'src/replay/index.ts')).href;
	const { openReplaySession } = (await import(replayUrl)) as typeof import('/workspace/toph/src/replay/index.js');
	const session = await openReplaySession(sessionDir, adapter);
	const baseline = await session.baseline();
	const trace = await session.loadTrace(baseline.runId);
	const labelmaps = await session.loadLabelmaps(baseline.runId);

	const manifest = (await session.loadManifest(baseline.runId)) as { stages?: Array<{ id: number; name: string }> };
	const stageId = (name: string): number => {
		const stage = manifest.stages?.find((entry) => entry.name === name);
		assert(stage, `missing stage ${name}`);
		return stage.id;
	};
	const invocationId = (name: string): number => {
		const id = stageId(name);
		const invocation = trace.stages.find((entry) => entry.stageId === id);
		assert(invocation, `missing invocation for ${name}`);
		return invocation.invocationId;
	};

	assert(labelmaps && labelmaps.length > 0, 'P1 bright-component labelmap was not persisted');
	const p1 = (trace.evidence ?? []).filter((entry) => entry.stageInvocationId === invocationId('p1.rawObjectMask'));
	assert(p1.some((entry) => entry.shapes.some((shape) => shape.t === 'component')), 'P1 has no real component-pixel evidence');
	assert(p1.some((entry) => entry.shapes.some((shape) => shape.t === 'bbox')), 'P1 has no component bbox evidence');

	const p61 = (trace.evidence ?? []).filter((entry) => entry.stageInvocationId === invocationId('p6.lowParAssignment'));
	assert(p61.some((entry) => entry.shapes.some((shape) => shape.t === 'angle')), 'P6.1 has no forward-angle geometry');
	assert(p61.some((entry) => entry.shapes.filter((shape) => shape.t === 'segment').length >= 2), 'P6.1 has no tee→badge→basket geometry');

	const p62 = (trace.evidence ?? []).filter((entry) => entry.stageInvocationId === invocationId('p6.swapAdjudication'));
	const swap = p62.find((entry) => entry.label?.includes('Holes 7/8') && entry.label.includes('Ribbon swap improvement'));
	assert(swap, 'P6.2 did not expose the canonical H7/H8 swap decision');
	assert(swap.decision === 'SWAP', `expected H7/H8 SWAP, got ${String(swap.decision)}`);
	assert(typeof swap.value === 'number' && swap.value >= 20, `expected H7/H8 improvement >= 20, got ${String(swap.value)}`);
	const offsetSegments = p62.filter((entry) => /ribbon ↔/.test(entry.label ?? '')).flatMap((entry) => entry.shapes.filter((shape) => shape.t === 'segment'));
	assert(offsetSegments.length >= 4, `expected four P6.2 nearest-component distance segments, got ${offsetSegments.length}`);

	console.log(`PASS real evidence: P1=${p1.length} observations; P6.1=${p61.length}; P6.2=${p62.length}; H7/H8 improvement=${swap.value}px`);
	console.log(`run=${baseline.runId}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exit(1);
});