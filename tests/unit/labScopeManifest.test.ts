import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadScopeManifest, resolveManifestCasePaths } from '../../scripts/chainspot-lab/scope/manifest';
import { defaultScopeTemplate, SCOPE_TEMPLATES } from '../../scripts/chainspot-lab/scope/templates';

function writeManifest(value: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), 'chainspot-scope-'));
	const path = join(dir, 'manifest.json');
	writeFileSync(path, JSON.stringify(value));
	return path;
}

describe('LAB scope manifest', () => {
	test('annotation is optional and absence remains a blind case', () => {
		const path = writeManifest({
			version: 1,
			cases: [{ name: 'blind', image: 'course.png', scopes: [{ name: 'candidate', point: [10, 20] }] }]
		});
		const loaded = loadScopeManifest(path);
		expect(loaded.cases).toHaveLength(1);
		expect(loaded.cases[0].annotation).toBeUndefined();
		expect(loaded.cases[0].scopes[0].point).toEqual([10, 20]);
	});

	test('resolves image and explicit annotation relative to the manifest', () => {
		const path = writeManifest({
			image: 'images/course.png',
			annotation: 'truth/course.annotation.json',
			scopes: [{ hole: 5 }]
		});
		const loaded = loadScopeManifest(path);
		const resolved = resolveManifestCasePaths(loaded.dir, loaded.cases[0]);
		expect(resolved.image).toBe(join(loaded.dir, 'images/course.png'));
		expect(resolved.annotation).toBe(join(loaded.dir, 'truth/course.annotation.json'));
		expect(resolved.scopes[0].hole).toBe(5);
	});

	test('requires exactly one visual request kind', () => {
		const path = writeManifest({
			image: 'course.png',
			scopes: [{ point: [1, 2], box: [0, 0, 10, 10] }]
		});
		expect(() => loadScopeManifest(path)).toThrow(/exactly one/);
	});
});

describe('LAB scope template seam', () => {
	test('ships one deliberately boring default template with a 1→1→3 nearest-neighbor progression', () => {
		expect(Object.keys(SCOPE_TEMPLATES)).toEqual(['default']);
		const panels = defaultScopeTemplate.panels({
			imageWidth: 1000,
			imageHeight: 1000,
			request: {
				name: 'p',
				kind: 'point',
				focus: { x: 500, y: 500, w: 1, h: 1 },
				points: [[500, 500]],
				template: 'default',
				color: 0
			}
		});
		expect(panels.map((p) => p.name)).toEqual(['context', 'local', 'forensic-wide', 'forensic-mid', 'forensic-tight']);
		expect(panels.every((p) => p.nearestNeighbor)).toBe(true);
		expect(panels.map((p) => p.outputPx)).toEqual([320, 320, 160, 160, 160]);
		expect(panels[0].source.w).toBeGreaterThan(panels[1].source.w);
		expect(panels.slice(2).map((p) => p.source.w)).toEqual([96, 48, 24]);
	});

	test('locks all three forensic zooms to the previous path point', () => {
		const panels = defaultScopeTemplate.panels({
			imageWidth: 1000,
			imageHeight: 1000,
			request: {
				name: 'trail',
				kind: 'path',
				focus: { x: 100, y: 100, w: 500, h: 500 },
				points: [[100, 100], [300, 400], [600, 600]],
				template: 'default',
				color: 0
			}
		});
		for (const panel of panels.slice(2)) {
			expect(panel.source.x + panel.source.w / 2).toBe(300);
			expect(panel.source.y + panel.source.h / 2).toBe(400);
		}
	});
});
