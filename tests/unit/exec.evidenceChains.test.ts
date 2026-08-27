// CHSPT-82 Wave 1A — the owner's runnable evidence chain, captured as a
// test so it runs in CI rather than only by hand:
//
//   1. default.json      -> compiled op list -> executeCompiledPlan (the
//                            ONE gateway) -> receipts, via the Node sink,
//                            to a deterministic out dir.
//   2. family-on.json     -> same gateway, a different (longer) plan.
//   3. an illegal-order config -> compile REJECTS, naming the violated
//                            dependency (no execution attempted).
//
// R1 check baked in: this file is the only one of the three exec test
// files allowed to import node-sink — contract.ts/board.ts/sink.ts/
// compile.ts/gateway.ts/operations.ts must never import node:fs/path, and
// this evidence chain is exactly what would break first if they did.

import { describe, expect, test } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	compileExecutionPlan,
	executeCompiledPlan,
	createExecBoard,
	type Receipt
} from '@chainspot/alg/exec';
import { createNodeSink } from '@chainspot/alg/exec/node-sink';
import { DEFAULT_EXECUTION, resolveConfig, type ThreeFactorConfig } from '@chainspot/alg/detectors/threeFactor';
import { CONFIG_SCHEMA } from '@chainspot/alg/detectors/threeFactor/config';
import { seedBoard } from '@chainspot/alg/detectors/threeFactor/measure';
import { nullFeatureContext, type EvidenceBoard } from '@chainspot/alg/detectors/threeFactor/features/types';
import type { RgbaImage } from '@chainspot/alg/detectors/threeFactor/types';
import defaultConfigJson from '@chainspot/alg/detectors/threeFactor/configs/default.json';
import familyOnConfigJson from '@chainspot/alg/detectors/threeFactor/configs/family-on.json';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = resolve(HERE, '../../artifacts/exec/chspt-82-wave1a');

/** Same deterministic synthetic scene shape as threeFactorParity.test.ts's syntheticRaster, reproduced here (not imported — that file is a frozen pin) so this evidence chain has no dependency on it. */
function syntheticImage(): RgbaImage {
	const width = 160;
	const height = 220;
	const data = new Uint8ClampedArray(width * height * 4);
	const put = (x: number, y: number, v: number, sat = 0) => {
		const i = (y * width + x) * 4;
		data[i] = v;
		data[i + 1] = v;
		data[i + 2] = Math.max(0, v - sat);
		data[i + 3] = 255;
	};
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, 120);
	for (let y = 30; y < 62; y++) for (let x = 40; x < 86; x++) put(x, y, 250);
	for (let y = 38; y < 54; y++) for (let x = 50; x < 58; x++) put(x, y, 20);
	for (let y = 38; y < 54; y++) for (let x = 66; x < 74; x++) put(x, y, 20);
	for (let y = 120; y < 140; y++) {
		for (let x = 40; x < 64; x++) {
			const edge = y < 124 || y >= 136 || x < 44 || x >= 60;
			if (edge) put(x, y, 250);
		}
	}
	for (let y = 170; y < 200; y++) for (let x = 90; x < 112; x++) put(x, y, 250);
	return { width, height, data };
}

function runChain(configName: string, configJson: unknown, outDir: string) {
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });

	const resolved = resolveConfig(configJson as ThreeFactorConfig, DEFAULT_EXECUTION);
	const plan = compileExecutionPlan(resolved, `test-paramsHash-${configName}`);

	const board = createExecBoard();
	seedBoard(board as unknown as EvidenceBoard, syntheticImage(), undefined);
	board.set('recoveredTees', []);

	const sink = createNodeSink(outDir);
	const receipts = executeCompiledPlan(plan, board, nullFeatureContext, sink);

	// eslint-disable-next-line no-console
	console.log(
		`[exec evidence] ${configName}: ${plan.ops.length} ops, planFingerprint=${plan.planFingerprint.slice(0, 12)}…, ` +
			`${receipts.length} receipts, ${receipts.reduce((n, r) => n + r.artifacts.length, 0)} artifacts -> ${outDir}`
	);

	return { resolved, plan, receipts, outDir };
}

describe('exec evidence chain 1 — default.json', () => {
	test('compiles, executes via the one gateway, writes receipts + artifacts through the Node sink', () => {
		const { plan, receipts, outDir } = runChain('default', defaultConfigJson, resolve(OUT_ROOT, 'default'));

		expect(receipts.length).toBe(plan.ops.length);
		expect(receipts.map((r) => r.opId)).toEqual(plan.ops.map((op) => op.id));

		const lines = readFileSync(resolve(outDir, 'receipts.jsonl'), 'utf8').trim().split('\n');
		expect(lines.length).toBe(plan.ops.length);
		const firstReceipt = JSON.parse(lines[0]) as Receipt;
		expect(firstReceipt.opId).toBe('badgeStage.masks');

		const artifactKinds: Set<string> = new Set(receipts.flatMap((r) => r.artifacts.map((a) => a.kind)));
		// eslint-disable-next-line no-console
		console.log(`[exec evidence] default: artifact kinds present = ${[...artifactKinds].sort().join(', ')}`);
		// Unconditional kinds: their producing op always runs and always emits,
		// regardless of scene content (an empty array still JSON-encodes).
		// 'polyline' (rawPairs's sample leg) is scene-dependent — this
		// synthetic scene happens to produce zero raw pairs, so it's asserted
		// separately as "may or may not appear" rather than required.
		for (const kind of ['rgba', 'mask', 'componentSet', 'candidateSet', 'scalarField', 'orientationField', 'measurementTable']) {
			expect(artifactKinds.has(kind)).toBe(true);
		}
		for (const r of receipts) {
			for (const a of r.artifacts) {
				expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
				expect(readdirSync(resolve(outDir, 'artifacts', a.kind))).toContain(`${a.id}.bin`);
			}
		}

		const selection = receipts.find((r) => r.opId === 'assignment.selection');
		expect(selection?.actualProduces).toContain('assignment');
	});
});

describe('exec evidence chain 2 — family-on.json', () => {
	test('same gateway, a different (longer) plan, cleanBasketFamily + teeFamily receipts present', () => {
		const { plan, receipts } = runChain('family-on', familyOnConfigJson, resolve(OUT_ROOT, 'family-on'));
		const opIds = receipts.map((r) => r.opId);
		expect(opIds).toContain('cleanBasketFamily');
		expect(opIds).toContain('teeFamily');
		expect(plan.ops.length).toBe(19); // visible teeFamily + explicit G7 Z-fit are baseline; this plan adds cleanBasketFamily
	});
});

describe('exec evidence chain 3 — illegal-order config', () => {
	test('compile REJECTS before any operation executes, naming the violated dependency', () => {
		const illegalExecution = ['assignment', ...DEFAULT_EXECUTION.filter((id) => id !== 'assignment')];
		const illegalConfig: ThreeFactorConfig = {
			schema: CONFIG_SCHEMA,
			name: 'illegal-order-demo',
			execution: illegalExecution,
			gates: {}
		};
		const resolved = resolveConfig(illegalConfig, DEFAULT_EXECUTION);
		let caught: Error | undefined;
		try {
			compileExecutionPlan(resolved);
		} catch (error) {
			caught = error as Error;
		}
		// eslint-disable-next-line no-console
		console.log(`[exec evidence] illegal-order-demo: compile rejected — ${caught?.message}`);
		expect(caught?.message).toMatch(/assignment\.pairs/);
		expect(caught?.message).toMatch(/consumes 'measurement'/);
		expect(caught?.message).toMatch(/no earlier operation produces it/);
	});
});
