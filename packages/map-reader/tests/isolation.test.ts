// The package must not be able to reach into the app. If it could, "the app and
// the algorithm can diverge on separate branches" would stop being true the
// first time someone imported a Svelte store from a detector.
//
// This walks the package's own source and fails on any import that escapes it,
// and on any dependency the package has not declared. It is the mechanical half
// of the boundary; surface.test.ts is the other half.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(packageRoot, 'src');

const sourceFiles = globSync('**/*.ts', { cwd: sourceRoot }).map((rel) => join(sourceRoot, rel));

function importSpecifiers(file: string): string[] {
	const text = readFileSync(file, 'utf8');
	// Covers `import ... from 'x'`, `export ... from 'x'`, and `import('x')`.
	return [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

describe('package isolation', () => {
	it('has source files to check', () => {
		expect(sourceFiles.length).toBeGreaterThan(10);
	});

	it('never imports a path outside the package', () => {
		const escapes: string[] = [];
		for (const file of sourceFiles) {
			for (const specifier of importSpecifiers(file)) {
				if (!specifier.startsWith('.')) continue;
				const target = resolve(dirname(file), specifier);
				if (!target.startsWith(sourceRoot)) {
					escapes.push(`${relative(packageRoot, file)} -> ${specifier}`);
				}
			}
		}
		expect(escapes).toEqual([]);
	});

	it('imports no bare module the package has not declared', () => {
		const declared = new Set([
			...Object.keys(
				JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).dependencies ?? {}
			),
			'node:path',
			'node:url'
		]);
		const undeclared: string[] = [];
		for (const file of sourceFiles) {
			for (const specifier of importSpecifiers(file)) {
				if (specifier.startsWith('.')) continue;
				const bare = specifier.startsWith('@')
					? specifier.split('/').slice(0, 2).join('/')
					: specifier.split('/')[0];
				if (!declared.has(bare)) undeclared.push(`${relative(packageRoot, file)} -> ${specifier}`);
			}
		}
		expect(undeclared).toEqual([]);
	});

	it('pulls in no browser or Node runtime global', () => {
		// Comments are prose and routinely contain words like "window"; strip them
		// before looking for real member access on a runtime global.
		const stripComments = (text: string) =>
			text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

		const banned: readonly [string, RegExp][] = [
			['document', /(?:^|[^.\w$])document\s*\./],
			['window', /(?:^|[^.\w$])window\s*\./],
			['localStorage', /(?:^|[^.\w$])localStorage\b/],
			['process.env', /(?:^|[^.\w$])process\s*\.\s*env\b/],
			['require()', /(?:^|[^.\w$])require\s*\(/]
		];

		const leaks: string[] = [];
		for (const file of sourceFiles) {
			const code = stripComments(readFileSync(file, 'utf8'));
			for (const [name, pattern] of banned) {
				if (pattern.test(code)) leaks.push(`${relative(packageRoot, file)}: ${name}`);
			}
		}
		expect(leaks).toEqual([]);
	});
});
