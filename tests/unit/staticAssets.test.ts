import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * @sveltejs/adapter-static copies everything under static/ verbatim into the
 * deployed site (see docs/asset-conventions.md) — there is no build-time
 * pruning of unreferenced files. This test is the enforcement mechanism for
 * that doc's rule 1: every file under static/ must be covered by an explicit
 * allowlist entry naming what fetches it, or the test fails. Adding a file to
 * static/ without adding it here is exactly the mistake that shipped ~25 MB
 * of unreferenced scratch assets to production (architecture-teardown.md
 * §9); this test turns that mistake into a red test instead of a
 * code-review hope.
 */

const STATIC_ROOT = join(process.cwd(), 'static');

interface AllowlistEntry {
	/** Directory prefix (trailing slash) or exact static/-relative path (POSIX separators). */
	readonly path: string;
	readonly reason: string;
}

const ALLOWLIST: readonly AllowlistEntry[] = [
	{ path: 'favicon.svg', reason: 'browser tab icon, fetched by the browser itself' },
	{
		path: '.nojekyll',
		reason: 'read by GitHub Pages to disable Jekyll processing of the _app/ output directory'
	},
	{
		path: 'resources/chainspot_cv_templates/',
		reason:
			'CV template set + manifest.json, fetched at runtime by the basket/course-detection worker; ' +
			'also includes the round-landing-glyph-*.png templates, which are CLI-read only (scripts/detect-landing-droplets.ts)'
	},
	{
		path: 'resources/demo/dashs-track/',
		reason:
			'guided-demo course captures + README, lazily fetched by /demo arming (see src/lib/demo/assets.ts)'
	}
];

function walk(dir: string): string[] {
	const entries = readdirSync(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...walk(fullPath));
		} else if (entry.isFile()) {
			files.push(fullPath);
		}
	}
	return files;
}

function toStaticRelativePosix(absolutePath: string): string {
	// Normalize to forward slashes so the allowlist is platform-independent.
	return relative(STATIC_ROOT, absolutePath).replace(/\\/g, '/');
}

function isAllowed(staticRelativePath: string): boolean {
	return ALLOWLIST.some((entry) =>
		entry.path.endsWith('/')
			? staticRelativePath.startsWith(entry.path)
			: staticRelativePath === entry.path
	);
}

describe('static/ deployment allowlist', () => {
	it('static/ exists and is non-empty (sanity check that the walk ran)', () => {
		expect(statSync(STATIC_ROOT).isDirectory()).toBe(true);
		expect(walk(STATIC_ROOT).length).toBeGreaterThan(0);
	});

	it('every file under static/ is covered by an explicit allowlist entry', () => {
		const files = walk(STATIC_ROOT).map(toStaticRelativePosix).sort();
		const unlisted = files.filter((file) => !isAllowed(file));

		expect(
			unlisted,
			`Found file(s) under static/ not covered by the allowlist in this test. ` +
				`Everything under static/ is deployed verbatim (see docs/asset-conventions.md) — ` +
				`either remove the file, or add it to ALLOWLIST with a one-line reason.\n` +
				`Unlisted: ${unlisted.join(', ')}`
		).toEqual([]);
	});

	it('every allowlist entry matches at least one real file (no stale entries)', () => {
		const files = walk(STATIC_ROOT).map(toStaticRelativePosix);
		for (const entry of ALLOWLIST) {
			const matches = entry.path.endsWith('/')
				? files.some((file) => file.startsWith(entry.path))
				: files.includes(entry.path);
			expect(matches, `Allowlist entry "${entry.path}" (${entry.reason}) matches no file under static/`).toBe(
				true
			);
		}
	});
});
