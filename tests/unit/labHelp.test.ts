import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
	coverageForCatalog,
	EXECUTABLE_SWEEP_GATES
} from '../../scripts/chainspot-lab/help/catalog.mjs';
import { completionCandidates } from '../../scripts/chainspot-lab/help/render.mjs';
import { SWEEP_THROUGH_GATES } from '../../scripts/chainspot-lab/sweep/gateVocabulary';

const CLI = resolve('scripts/chainspot-lab/bin/lab.mjs');

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
	return spawnSync(process.execPath, [CLI, ...args], {
		cwd: resolve('.'), encoding: 'utf8', env: { ...process.env, ...env }
	});
}

describe('LAB contextual help catalog', () => {
	test('covers the supported root, shell, option, and documented leaf surface', () => {
		const coverage = coverageForCatalog();
		expect(coverage.commandCount).toBe(14);
		expect(coverage.shellCount).toBe(4);
		expect(coverage.missingRoots).toEqual([]);
		expect(coverage.missingShell).toEqual([]);
		expect(Object.values(coverage.missingOptions).flat()).toEqual([]);
		expect(Object.values(coverage.missingLeaves).flat()).toEqual([]);
		expect(EXECUTABLE_SWEEP_GATES).toEqual([...SWEEP_THROUGH_GATES]);
	});

	test('root, exact, nested, local, and exhaustive help are catalog-backed', () => {
		const root = run(['--help']);
		expect(root.status).toBe(0);
		expect((root.stdout.match(/^  (setup|set|tutorial|ui|scope|search|traverse|invariants|detectors|gates|cases|compile|sweep|orient)\b/gm) ?? []).length).toBe(14);
		expect(root.stdout).toContain('history');
		expect(root.stdout).toContain('run-script');
		expect(root.stdout).toContain('exit | quit');

		const nested = run(['help', 'scope', 'path']);
		const local = run(['scope', 'path', '--help']);
		expect(nested.status).toBe(0);
		expect(local.status).toBe(0);
		expect(local.stdout).toBe(nested.stdout);
		expect(nested.stdout).toContain('SCOPE PATH');
		const positionalLocal = run(['scope', 'full', 'course.png', '--help']);
		expect(positionalLocal.status).toBe(0);
		expect(positionalLocal.stdout).toContain('SCOPE FULL');
		const pin = run(['help', 'search', 'pin', 'keep']);
		expect(pin.status).toBe(0);
		expect(pin.stdout).toContain('SEARCH PIN KEEP');
		const i22 = run(['help', 'i22-basket-family-signal']);
		expect(i22.status).toBe(0);
		expect(i22.stdout).toContain('INTERNAL_API_ONLY');
		const setShow = run(['help', 'set', 'show']);
		expect(setShow.status).toBe(0);
		expect(setShow.stdout).toContain('SET SHOW');
		const corpusRoot = run(['help', 'set', 'corpusRoot']);
		expect(corpusRoot.status).toBe(0);
		expect(corpusRoot.stdout).toContain('SET CORPUS');

		const exhaustive = run(['help', '--all']);
		expect(exhaustive.status).toBe(0);
		expect(exhaustive.stdout).toContain('REGISTERED_NONEXECUTING');
		expect(exhaustive.stdout).toContain('PARKED_UNREGISTERED');
	});

	test('unknown command/option errors give local suggestions and gate vocabulary', () => {
		const command = run(['scop']);
		expect(command.status).toBe(2);
		expect(command.stderr).toContain("Did you mean 'scope'?");

		const option = run(['sweep', '--throug', 'G3', 'config.json', 'input.png']);
		expect(option.status).toBe(2);
		expect(option.stderr).toContain("Did you mean '--through'?");
		expect(option.stderr).toContain('Gate vocabulary');

		const gate = run(['sweep', '--through', 'shared', 'config.json', 'input.png']);
		expect(gate.status).toBe(2);
		expect(gate.stderr).toContain('shared');
		expect(gate.stderr).toContain('not an execution cutoff');

		const localAction = run(['search', 'strt']);
		expect(localAction.status).toBe(2);
		expect(localAction.stderr).toContain("Did you mean 'start'?");
		expect(localAction.stderr).toContain('Valid local names');
		const leafOption = run(['search', 'keep', 'pin-name', '--bad']);
		expect(leafOption.status).toBe(2);
		expect(leafOption.stderr).toContain('Valid local options: (none)');
		const incompletePin = run(['search', 'pin', 'maybe']);
		expect(incompletePin.status).toBe(2);
		expect(incompletePin.stderr).toContain('needs an x,y coordinate');
		expect(incompletePin.stderr).toContain('Valid local forms');
		const logOption = run(['search', 'log', 'trail', '--page', 'P']);
		expect(logOption.status).toBe(2);
		expect(logOption.stderr).toContain('Valid local options: (none)');
		const scopeLeafOption = run(['scope', 'path', 'course.png', 'line', '1,1', '--hole', '3']);
		expect(scopeLeafOption.status).toBe(2);
		expect(scopeLeafOption.stderr).toContain('Valid local options');

		const gateHelp = run(['help', 'gate-vocabulary']);
		expect(gateHelp.stdout).toContain('LAB knowledge catalog');
		expect(gateHelp.stdout).toContain('Engine execution');
		expect(run(['help', 'sweep', 'through']).stdout).toContain('CLI_ONLY');
		expect(run(['sweep', '--through', 'G3', '--help']).stdout).toContain('SWEEP THROUGH');
		expect(run(['help', 'fourLaneSensor']).stdout).toContain('REGISTERED_NONEXECUTING');
		expect(completionCandidates('help scope p')).toEqual(expect.arrayContaining(['path', 'point']));
		expect(completionCandidates('search page n')).toContain('new');
	});

	test('help here reads config/search summaries without writes, operations, or truth suggestions in blind mode', () => {
		const root = mkdtempSync(join(tmpdir(), 'chainspot-lab-help-here-'));
		const config = join(root, 'config.json');
		const state = join(root, 'search-state.json');
		writeFileSync(config, JSON.stringify({ version: 1, course: 'DashsTrack', vars: {} }));
		writeFileSync(state, JSON.stringify({ pages: { p: {} }, trails: { t: {} }, traversals: {} }));
		const before = [readFileSync(config, 'utf8'), readFileSync(state, 'utf8')];
		const result = run(['help', 'here'], { LAB_CONFIG: config, LAB_SEARCH_STATE: state, LAB_BLIND_TEST: '1' });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('zero writes; zero algorithm operations; no Annotation/truth read');
		expect(result.stdout).toContain('Blind mode: truth-assisted suggestions are suppressed.');
		expect(result.stdout).not.toContain('scope hN --truth');
		expect([readFileSync(config, 'utf8'), readFileSync(state, 'utf8')]).toEqual(before);
		expect(statSync(config).size).toBe(before[0].length);
	});
});
