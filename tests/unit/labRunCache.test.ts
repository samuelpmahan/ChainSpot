import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LabRunCache, jsonCodec } from '../../scripts/chainspot-lab/runCache';

const cleanup: string[] = [];
afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('LabRunCache', () => {
	it('reuses unaffected upstream stages and invalidates only the changed dependency chain', () => {
		const root = mkdtempSync(join(tmpdir(), 'chainspot-lab-cache-'));
		cleanup.push(root);
		const repoRoot = join(root, 'repo');
		const cacheRoot = join(root, 'cache');
		mkdirSync(repoRoot, { recursive: true });
		const inputPath = join(root, 'course.png');
		writeFileSync(inputPath, 'same raster bytes');
		writeFileSync(join(repoRoot, 'g1.ts'), 'g1-v1');
		writeFileSync(join(repoRoot, 'g2.ts'), 'g2-v1');
		writeFileSync(join(repoRoot, 'g3.ts'), 'g3-v1');

		let g1Calls = 0;
		let g2Calls = 0;
		let g3Calls = 0;
		const computeG1 = () => ({ value: ++g1Calls });
		const computeG2 = () => ({ value: ++g2Calls });
		const computeG3 = () => ({ value: ++g3Calls });
		const codec = jsonCodec<{ value: number }>();

		const first = new LabRunCache({ inputPath, cacheRoot, repoRoot });
		const g1a = first.stage({ name: 'g1', dependencies: ['g1.ts'], codec, compute: computeG1 });
		const g2a = first.stage({ name: 'g2', upstream: [g1a.key], dependencies: ['g2.ts'], codec, compute: computeG2 });
		const g3a = first.stage({ name: 'g3', upstream: [g2a.key], dependencies: ['g3.ts'], codec, compute: computeG3 });
		expect([g1a.cacheHit, g2a.cacheHit, g3a.cacheHit]).toEqual([false, false, false]);

		const second = new LabRunCache({ inputPath, cacheRoot, repoRoot });
		const g1b = second.stage({ name: 'g1', dependencies: ['g1.ts'], codec, compute: computeG1 });
		const g2b = second.stage({ name: 'g2', upstream: [g1b.key], dependencies: ['g2.ts'], codec, compute: computeG2 });
		const g3b = second.stage({ name: 'g3', upstream: [g2b.key], dependencies: ['g3.ts'], codec, compute: computeG3 });
		expect([g1b.cacheHit, g2b.cacheHit, g3b.cacheHit]).toEqual([true, true, true]);
		expect([g1Calls, g2Calls, g3Calls]).toEqual([1, 1, 1]);

		// A G3-only implementation change must not make G1/G2 expensive again.
		writeFileSync(join(repoRoot, 'g3.ts'), 'g3-v2');
		const third = new LabRunCache({ inputPath, cacheRoot, repoRoot });
		const g1c = third.stage({ name: 'g1', dependencies: ['g1.ts'], codec, compute: computeG1 });
		const g2c = third.stage({ name: 'g2', upstream: [g1c.key], dependencies: ['g2.ts'], codec, compute: computeG2 });
		const g3c = third.stage({ name: 'g3', upstream: [g2c.key], dependencies: ['g3.ts'], codec, compute: computeG3 });
		expect([g1c.cacheHit, g2c.cacheHit, g3c.cacheHit]).toEqual([true, true, false]);
		expect([g1Calls, g2Calls, g3Calls]).toEqual([1, 1, 2]);

		// An upstream change must invalidate itself and every stage that consumes its key.
		writeFileSync(join(repoRoot, 'g1.ts'), 'g1-v2');
		const fourth = new LabRunCache({ inputPath, cacheRoot, repoRoot });
		const g1d = fourth.stage({ name: 'g1', dependencies: ['g1.ts'], codec, compute: computeG1 });
		const g2d = fourth.stage({ name: 'g2', upstream: [g1d.key], dependencies: ['g2.ts'], codec, compute: computeG2 });
		expect([g1d.cacheHit, g2d.cacheHit]).toEqual([false, false]);
		expect([g1Calls, g2Calls]).toEqual([2, 2]);
	});
});
