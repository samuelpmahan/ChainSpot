import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

const LAB = 'scripts/chainspot-lab';
const SOURCE = `${LAB}/bin/lab.mjs`;

function coldLauncher() {
	const root = mkdtempSync(join(tmpdir(), 'chainspot-lab-cold-help-'));
	const bin = join(root, 'bin');
	mkdirSync(bin, { recursive: true });
	const launcher = join(bin, 'lab.mjs');
	writeFileSync(launcher, readFileSync(SOURCE, 'utf8'));
	mkdirSync(join(root, 'context'), { recursive: true });
	writeFileSync(join(root, 'context', 'context.mjs'), readFileSync(`${LAB}/context/context.mjs`, 'utf8'));
	cpSync(`${LAB}/help`, join(root, 'help'), { recursive: true });
	cpSync(`${LAB}/courses`, join(root, 'courses'), { recursive: true });
	return { launcher, root };
}

function runColdHelp(command: string) {
	const { launcher, root } = coldLauncher();
	return spawnSync(process.execPath, [launcher, command, '--help'], {
		encoding: 'utf8',
		env: { ...process.env, NODE_PATH: '', LAB_CONFIG: join(root, 'config.json') }
	});
}

describe('LAB cold-checkout discoverability', () => {
	for (const [command, expected] of [
		['set', 'lab set COURSE'],
		['tutorial', 'lab tutorial'],
		['scope', 'lab scope hN [--truth]'],
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

	test('course selection itself works cold and persists DT -> DashsTrack', () => {
		const { launcher, root } = coldLauncher();
		const config = join(root, 'config.json');
		const result = spawnSync(process.execPath, [launcher, 'set', 'DT'], {
			encoding: 'utf8',
			env: { ...process.env, NODE_PATH: '', LAB_CONFIG: config }
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('course -> DashsTrack');
		expect(JSON.parse(readFileSync(config, 'utf8')).course).toBe('DashsTrack');
	});

	test('tutorial is executable from a completely cold checkout', () => {
		const { launcher, root } = coldLauncher();
		const result = spawnSync(process.execPath, [launcher, 'tutorial'], {
			encoding: 'utf8',
			env: { ...process.env, NODE_PATH: '', LAB_CONFIG: join(root, 'config.json') }
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('./lab set DT');
		expect(result.stdout).toContain('./lab scope h1 --truth');
	});

	test('cold TypeScript execution failure points at the dependency-free setup command', () => {
		const { launcher, root } = coldLauncher();
		const result = spawnSync(process.execPath, [launcher, 'scope', 'course.png', '10,10'], {
			encoding: 'utf8',
			env: { ...process.env, NODE_PATH: '', LAB_CONFIG: join(root, 'config.json') }
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Run: ./lab setup');
	});

	test('a persisted truth-tainted command log blocks a later blind/test execution before tsx is touched', () => {
		const { launcher, root } = coldLauncher();
		const commandLog = join(root, 'commands.jsonl');
		writeFileSync(commandLog, JSON.stringify({ argv: ['scope', 'h1', '--truth'], taints: ['truth'] }) + '\n');
		const result = spawnSync(process.execPath, [launcher, 'scope', 'course.png', '10,10'], {
			encoding: 'utf8',
			env: {
				...process.env,
				NODE_PATH: '',
				LAB_CONFIG: join(root, 'config.json'),
				LAB_COMMAND_LOG: commandLog,
				LAB_TEST_RUN: '1'
			}
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('LAB TRUTH-TAINT');
		expect(result.stderr).toContain('scope h1 --truth');
		expect(result.stderr).not.toContain('runtime dependencies are not installed');
	});
});
