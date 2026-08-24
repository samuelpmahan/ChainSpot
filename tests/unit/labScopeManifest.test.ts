import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadScopeManifest, resolveManifestCasePaths } from '../../scripts/chainspot-lab/scope/manifest';
import { defaultScopeTemplate, SCOPE_TEMPLATES } from '../../scripts/chainspot-lab/scope/templates';
import { consumeViewOptions, DEFAULT_SCOPE_VIEW, resolveScopeView } from '../../scripts/chainspot-lab/scope/viewOptions';

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

	test('manifest may tune view settings without creating a second config system', () => {
		const path = writeManifest({
			image: 'course.png',
			scopes: [{ point: [10, 20], view: { forensicWidePx: 240, forensicMidPx: 120, forensicTightPx: 60, grid: false } }]
		});
		const request = loadScopeManifest(path).cases[0].scopes[0];
		expect(resolveScopeView(request.view)).toMatchObject({ forensicWidePx: 240, forensicMidPx: 120, forensicTightPx: 60, grid: false });
	});

	test('requires exactly one visual request kind', () => {
		const path = writeManifest({
			image: 'course.png',
			scopes: [{ point: [1, 2], box: [0, 0, 10, 10] }]
		});
		expect(() => loadScopeManifest(path)).toThrow(/exactly one/);
	});
});

describe('LAB scope AutoCrop/template seam', () => {
	test('defaults to regional 800px Context, request+100 Local, then three forensic views', () => {
		expect(Object.keys(SCOPE_TEMPLATES)).toEqual(['default']);
		const panels = defaultScopeTemplate.panels({
			imageWidth: 2000,
			imageHeight: 2000,
			request: {
				name: 'p',
				kind: 'point',
				focus: { x: 1000, y: 1000, w: 1, h: 1 },
				points: [[1000, 1000]],
				template: 'default',
				color: 0
			}
		});
		expect(panels.map((panel) => panel.name)).toEqual(['context', 'local', 'forensic-wide', 'forensic-mid', 'forensic-tight']);
		expect(panels.map((panel) => panel.outputPx)).toEqual([800, 640, 240, 240, 240]);
		expect(panels[0].source.w).toBe(800);
		expect(panels[0].source.h).toBe(800);
		expect(panels[1].source.w).toBe(101);
		expect(panels[1].source.h).toBe(101);
		expect(panels.slice(2).map((panel) => panel.source.w)).toEqual([192, 96, 48]);
		expect(panels.slice(0, 2).every((panel) => panel.resampling === 'bilinear' && panel.grid)).toBe(true);
		expect(panels.slice(2).every((panel) => panel.resampling === 'nearest' && !panel.grid)).toBe(true);
	});

	test('Local captures active geometry plus 100 total px in width and height', () => {
		const panels = defaultScopeTemplate.panels({
			imageWidth: 2000,
			imageHeight: 2000,
			request: {
				name: 'hole-like',
				kind: 'path',
				focus: { x: 500, y: 600, w: 300, h: 450 },
				points: [[500, 600], [650, 800], [800, 1050]],
				template: 'default',
				color: 0
			}
		});
		expect(panels[1].source).toMatchObject({ x: 450, y: 550, w: 400, h: 550 });
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

	test('--no-grid and forensic spans are simple CLI overrides', () => {
		const args = ['--no-grid', '--fw', '240', '--fm', '120', '--ft', '60'];
		const view = resolveScopeView(consumeViewOptions(args));
		expect(args).toEqual([]);
		expect(view).toMatchObject({ grid: false, forensicWidePx: 240, forensicMidPx: 120, forensicTightPx: 60 });
		expect(DEFAULT_SCOPE_VIEW.grid).toBe(true);
	});
});
