import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, test } from 'vitest';

const tidyScript = resolve('scripts/tidy.mjs');

function git(root: string, ...args: string[]) {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function run(root: string, ...args: string[]) {
	const result = spawnSync(process.execPath, [tidyScript, ...args], {
		cwd: root,
		encoding: 'utf8'
	});
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function initRoot() {
	const root = mkdtempSync(join(tmpdir(), 'chainspot-tidy-'));
	git(root, 'init', '-q');
	git(root, 'config', 'user.email', 'tidy@example.test');
	git(root, 'config', 'user.name', 'Tidy Test');
	writeFileSync(join(root, 'tidy.manifest.yaml'), 'stages: {}\n');
	git(root, 'add', '.');
	git(root, 'commit', '-qm', 'empty manifest');
	return root;
}

function enroll() {
	const root = initRoot();
	const clean = join(root, 'stages/S0/clean');
	mkdirSync(clean, { recursive: true });
	writeFileSync(join(clean, 'stage.txt'), 'full -> cropped\n');
	const added = run(root, 'add', '-id', 'S0', '-cleanDir', 'stages/S0/clean');
	expect(added.status, added.output).toBe(0);
	git(root, 'add', '.');
	git(root, 'commit', '-qm', 'enroll S0');
	return { root, clean };
}

function u32(value: number) {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32BE(value);
	return buffer;
}

function u64(value: number) {
	const buffer = Buffer.alloc(8);
	buffer.writeBigUInt64BE(BigInt(value));
	return buffer;
}

function hashDirectory(root: string) {
	function files(cursor: string): string[] {
		return readdirSync(cursor)
			.sort()
			.flatMap((name) => {
				const path = join(cursor, name);
				return statSync(path).isDirectory() ? files(path) : [path];
			});
	}
	const hash = createHash('sha256');
	for (const file of files(root).sort()) {
		const path = Buffer.from(relative(root, file).split(sep).join('/'));
		const contents = readFileSync(file);
		hash.update(u32(path.length));
		hash.update(path);
		hash.update(u64(contents.length));
		hash.update(contents);
	}
	return `sha256:${hash.digest('hex')}`;
}

function replaceManifest(root: string, pattern: RegExp, replacement: string) {
	const path = join(root, 'tidy.manifest.yaml');
	writeFileSync(path, readFileSync(path, 'utf8').replace(pattern, replacement));
}

describe('tidy frozen Stage custody', () => {
	test('empty valid manifest passes', () => {
		const root = initRoot();
		const result = run(root, 'check');
		expect(result.status, result.output).toBe(0);
		expect(result.output).toContain('manifest.stages ............... PASS 0');
		expect(result.output).toContain('\nTIDY\n');
	});

	test('add enrolls a clean Stage at 0.1.0', () => {
		const root = initRoot();
		mkdirSync(join(root, 'stages/S0/clean'), { recursive: true });
		writeFileSync(join(root, 'stages/S0/clean/stage.txt'), 'surface\n');
		const result = run(root, 'add', '-id', 'S0', '-cleanDir', 'stages/S0/clean');
		expect(result.status, result.output).toBe(0);
		expect(readFileSync(join(root, 'tidy.manifest.yaml'), 'utf8')).toContain('version: 0.1.0');
		expect(result.output).toContain('ADDED S0 0.1.0');
	});

	test('untouched frozen surface passes', () => {
		const { root } = enroll();
		expect(run(root, 'check').status).toBe(0);
	});

	test('edit outside a declared clean surface passes', () => {
		const { root } = enroll();
		writeFileSync(join(root, 'notes.txt'), 'outside\n');
		expect(run(root, 'check').status).toBe(0);
	});

	test('edit inside clean fails', () => {
		const { root, clean } = enroll();
		writeFileSync(join(clean, 'stage.txt'), 'changed\n');
		expect(run(root, 'check').status).toBe(1);
	});

	test('adding a file inside clean fails', () => {
		const { root, clean } = enroll();
		writeFileSync(join(clean, 'new.txt'), 'new\n');
		expect(run(root, 'check').status).toBe(1);
	});

	test('deleting a file inside clean fails', () => {
		const { root, clean } = enroll();
		rmSync(join(clean, 'stage.txt'));
		expect(run(root, 'check').status).toBe(1);
	});

	test('renaming a file inside clean fails', () => {
		const { root, clean } = enroll();
		renameSync(join(clean, 'stage.txt'), join(clean, 'renamed.txt'));
		expect(run(root, 'check').status).toBe(1);
	});

	test('exactly reverting clean to its HEAD state passes', () => {
		const { root, clean } = enroll();
		writeFileSync(join(clean, 'stage.txt'), 'changed\n');
		writeFileSync(join(clean, 'stage.txt'), 'full -> cropped\n');
		expect(run(root, 'check').status).toBe(0);
	});

	test('fixing the hash without bumping the version fails history', () => {
		const { root, clean } = enroll();
		writeFileSync(join(clean, 'stage.txt'), 'changed\n');
		replaceManifest(root, /hash: sha256:[0-9a-f]{64}/, `hash: ${hashDirectory(clean)}`);
		const result = run(root, 'check');
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/S0\.hash\.manifest .* PASS/);
		expect(result.output).toMatch(/S0\.version\.history .* FAIL/);
	});

	test('bumping the version while leaving a stale hash fails', () => {
		const { root, clean } = enroll();
		writeFileSync(join(clean, 'stage.txt'), 'changed\n');
		replaceManifest(root, /version: 0\.1\.0/, 'version: 0.1.1');
		const result = run(root, 'check');
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/S0\.hash\.manifest .* FAIL/);
	});

	test('malformed semver fails', () => {
		const { root } = enroll();
		replaceManifest(root, /version: 0\.1\.0/, 'version: S0');
		expect(run(root, 'check').status).toBe(1);
	});

	test('regressed semver fails', () => {
		const { root } = enroll();
		replaceManifest(root, /version: 0\.1\.0/, 'version: 0.0.9');
		expect(run(root, 'check').status).toBe(1);
	});

	test('tidy up with the correct expected-current version bumps, rehashes, and passes', () => {
		const { root, clean } = enroll();
		writeFileSync(join(clean, 'stage.txt'), 'additive change\n');
		const result = run(root, 'up', '-v', 'MINOR:0.1.0');
		expect(result.status, result.output).toBe(0);
		expect(result.output).toContain('PROMOTED S0 0.1.0 → 0.2.0');
		expect(run(root, 'check').status).toBe(0);
	});

	test('tidy up with the wrong guard refuses without mutation', () => {
		const { root, clean } = enroll();
		writeFileSync(join(clean, 'stage.txt'), 'changed\n');
		const manifest = readFileSync(join(root, 'tidy.manifest.yaml'), 'utf8');
		const result = run(root, 'up', '-v', 'PATCH:0.0.9');
		expect(result.status).toBe(2);
		expect(result.output).toContain('REFUSED');
		expect(readFileSync(join(root, 'tidy.manifest.yaml'), 'utf8')).toBe(manifest);
	});

	test('tidy up promotes every changed Stage as one guarded batch', () => {
		const root = initRoot();
		for (const id of ['S0', 'S1']) {
			const clean = join(root, `stages/${id}/clean`);
			mkdirSync(clean, { recursive: true });
			writeFileSync(join(clean, 'stage.txt'), `${id} baseline\n`);
			const added = run(root, 'add', '-id', id, '-cleanDir', `stages/${id}/clean`);
			expect(added.status, added.output).toBe(0);
		}
		git(root, 'add', '.');
		git(root, 'commit', '-qm', 'enroll two stages');
		writeFileSync(join(root, 'stages/S0/clean/stage.txt'), 'S0 adds PxC object\n');
		writeFileSync(join(root, 'stages/S1/clean/stage.txt'), 'S1 consumes PxC object\n');

		const result = run(
			root,
			'up',
			'-v',
			'S0=MINOR:0.1.0',
			'-v',
			'S1=PATCH:0.1.0'
		);
		expect(result.status, result.output).toBe(0);
		expect(result.output).toContain('PROMOTED S0 0.1.0 → 0.2.0');
		expect(result.output).toContain('PROMOTED S1 0.1.0 → 0.1.1');
		expect(result.output).toContain('PROMOTED BATCH 2');
		expect(run(root, 'check').status).toBe(0);
	});

	test('incomplete batch guard refuses without mutating any Stage', () => {
		const root = initRoot();
		for (const id of ['S0', 'S1']) {
			const clean = join(root, `stages/${id}/clean`);
			mkdirSync(clean, { recursive: true });
			writeFileSync(join(clean, 'stage.txt'), `${id} baseline\n`);
			expect(run(root, 'add', '-id', id, '-cleanDir', `stages/${id}/clean`).status).toBe(0);
		}
		git(root, 'add', '.');
		git(root, 'commit', '-qm', 'enroll two stages');
		writeFileSync(join(root, 'stages/S0/clean/stage.txt'), 'changed S0\n');
		writeFileSync(join(root, 'stages/S1/clean/stage.txt'), 'changed S1\n');
		const before = readFileSync(join(root, 'tidy.manifest.yaml'), 'utf8');

		const result = run(root, 'up', '-v', 'S0=MINOR:0.1.0');
		expect(result.status).toBe(2);
		expect(result.output).toContain('missing=[S1]');
		expect(readFileSync(join(root, 'tidy.manifest.yaml'), 'utf8')).toBe(before);
	});

	test('corrupt manifest clearly fails and tidy up does not mutate it', () => {
		const root = initRoot();
		const corrupt = 'stages:\n this is not the manifest\n';
		writeFileSync(join(root, 'tidy.manifest.yaml'), corrupt);
		const checked = run(root, 'check');
		expect(checked.status).toBe(1);
		expect(checked.output).toMatch(/manifest\.parse .* FAIL/);
		const promoted = run(root, 'up', '-v', 'PATCH:0.1.0');
		expect(promoted.status).toBe(2);
		expect(readFileSync(join(root, 'tidy.manifest.yaml'), 'utf8')).toBe(corrupt);
	});

	test('removing a frozen Stage from the manifest fails custody', () => {
		const { root } = enroll();
		writeFileSync(join(root, 'tidy.manifest.yaml'), 'stages: {}\n');
		const result = run(root, 'check');
		expect(result.status).toBe(1);
		expect(result.output).toMatch(/S0\.manifest\.custody .* FAIL/);
	});
});
