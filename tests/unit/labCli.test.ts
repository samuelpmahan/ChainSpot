import { describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = resolve('scripts/chainspot-lab/bin/lab.mjs');

function run(args: string[]) {
	return spawnSync(process.execPath, [CLI, ...args], {
		cwd: resolve('.'),
		encoding: 'utf8'
	});
}

describe('LAB npm CLI dispatcher', () => {
	test('root help is available before LAB npm dependencies are installed', () => {
		const result = run(['--help']);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('LAB — tools for seeing, measuring, testing, and learning ChainSpot CV');
		expect(result.stdout).toContain('scope');
		expect(result.stdout).toContain('sweep');
		expect(result.stdout).toContain('run-script');
		expect(result.stdout).toContain('sweep` remains the algorithm execution path');
	});

	test('run-script feeds commands through the same built-in dispatcher', () => {
		const dir = mkdtempSync(join(tmpdir(), 'chainspot-lab-cli-'));
		const script = join(dir, 'discover.lab');
		writeFileSync(script, '# discover without running CV\nhelp scope\nhelp sweep\n');
		const result = run(['run-script', script]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('SCOPE — inspect image regions');
		expect(result.stdout).toContain('SWEEP — the only LAB command that executes the algorithm');
		expect(result.stdout).toContain('lab[2]> help scope');
	});
});
