import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

const SOURCE = 'scripts/chainspot-lab/bin/lab.mjs';

function coldLauncher() {
	const root = mkdtempSync(join(tmpdir(), 'chainspot-lab-cold-help-'));
	const bin = join(root, 'bin');
	mkdirSync(bin, { recursive: true });
	const launcher = join(bin, 'lab.mjs');
	writeFileSync(launcher, readFileSync(SOURCE, 'utf8'));
	return launcher;
}

function runColdHelp(command: string) {
	const launcher = coldLauncher();
	return spawnSync(process.execPath, [launcher, command, '--help'], {
		encoding: 'utf8',
		env: { ...process.env, NODE_PATH: '' }
	});
}

describe('LAB cold-checkout discoverability', () => {
	for (const [command, expected] of [
		['scope', 'lab scope IMAGE x,y'],
		['search', 'lab search start IMAGE NAME x,y'],
		['traverse', 'lab traverse start IMAGE NAME x,y'],
		['ui', 'lab ui [--port N] [--no-open]'],
		['sweep', 'lab sweep CONFIG.json INPUT... [TRUTH.json]']
	] as const) {
		test(`${command} --help does not need tsx/node_modules`, () => {
			const result = runColdHelp(command);
			expect(result.status).toBe(0);
			expect(result.stderr).toBe('');
			expect(result.stdout).toContain(expected);
			expect(result.stdout).not.toContain('dependencies are not installed');
		});
	}

	test('cold execution failure points at the dependency-free setup command', () => {
		const launcher = coldLauncher();
		const result = spawnSync(process.execPath, [launcher, 'scope', 'course.png', '10,10'], {
			encoding: 'utf8',
			env: { ...process.env, NODE_PATH: '' }
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Run: ./lab setup');
	});
});
