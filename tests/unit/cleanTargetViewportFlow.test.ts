// @vitest-environment jsdom

/**
 * CHSPT-68: the Fetch Clean Target flow lives inside the Clean target pane.
 * These tests prove the WIRING with an injected editor and mocked fetch:
 * modal-driven fetch and single commit route through the normal intake path,
 * the per-fetch-shape ground-scale rule survives the move, the coverage
 * check appears when course geometry exits the aerial, and the
 * geo-referenced re-fetch preserves placed pairs by remapping them.
 * They deliberately do NOT claim pointer/overlay/raster behavior — that is
 * browser-verified per the task's Proof Plan.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import Page from '../../src/routes/create-graphics/+page.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import { intakeImageFile } from '../../src/lib/imageIntake';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import type { AnnotatedHole } from '../../src/lib/domain/annotatedRound';

const NOW = () => new Date('2026-08-10T00:00:00.000Z');
const SOURCE_SIZE = 2000;
const NAIP_SIZE = 2048;

let counter = 0;
const nextId = (): string => `flow-${++counter}`;

function makeEditor(): ProjectEditor {
	const state = createProjectState({ createId: () => 'project-1', now: NOW });
	return new ProjectEditor({ state, createId: nextId, now: NOW });
}

function decodeOf(widthPx: number, heightPx: number): DecodeImageFile {
	return async () => ({ image: document.createElement('img'), widthPx, heightPx });
}

async function seedSource(editor: ProjectEditor): Promise<void> {
	const result = await intakeImageFile({
		editor,
		role: 'source-overview',
		file: new File([new Uint8Array(8).fill(1)], 'source.png', { type: 'image/png' }),
		decode: decodeOf(SOURCE_SIZE, SOURCE_SIZE),
		createAssetId: nextId
	});
	if (!result.ok) throw new Error('seed source intake failed');
}

interface Mounted {
	editor: ProjectEditor;
	component: ReturnType<typeof mount> & { refresh?: () => void };
	host: HTMLDivElement;
}

function mountPage(editor: ProjectEditor, decode: DecodeImageFile): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(Page, { target: host, props: { editor, decode } });
	return { editor, component, host };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 16; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function click(host: HTMLElement, testId: string): void {
	const button = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
	if (!button) throw new Error(`missing ${testId}`);
	button.click();
}

function stubNaipFetch(): ReturnType<typeof vi.fn> {
	const fetchSpy = vi.fn(async (url: string | URL | Request) => {
		const href = String(url);
		if (!href.includes('basemap.nationalmap.gov')) throw new Error(`unexpected fetch: ${href}`);
		return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
			status: 200,
			headers: { 'content-type': 'image/png' }
		});
	});
	vi.stubGlobal('fetch', fetchSpy);
	return fetchSpy;
}

/** Modal → advanced "Fetch this spot" (default Dash's Track inputs) → in-pane preview. */
async function fetchPreviewViaModal(host: HTMLElement): Promise<void> {
	click(host, 'open-location-search');
	await flush();
	click(host, 'naip-fetch-button');
	await flush();
	if (!host.querySelector('[data-testid="naip-preview"]')) {
		throw new Error('expected the in-pane aerial preview after the modal fetch');
	}
}

/** Two-pair seed whose similarity transform (scale 2.048) pushes far course points off the raster. */
function seedCourseAndPairs(editor: ProjectEditor): void {
	const holes: AnnotatedHole[] = [
		{
			id: 'hole-1',
			number: 1,
			tee: { xPx: 100, yPx: 100 },
			basket: { xPx: 1900, yPx: 1900 },
			shots: [],
			corridorBends: [],
			corridorWidthPx: 40
		}
	];
	editor.setHoles(holes);
	editor.addPair({ sourceCoordinates: { xPx: 0, yPx: 0 }, targetCoordinates: { xPx: 0, yPx: 0 } });
	editor.addPair({
		sourceCoordinates: { xPx: 1000, yPx: 0 },
		targetCoordinates: { xPx: 2047, yPx: 0 }
	});
}

afterEach(() => {
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

describe('CHSPT-68 clean-target in-pane flow', () => {
	it('commits the previewed aerial through the normal intake path with one button', async () => {
		stubNaipFetch();
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(NAIP_SIZE, NAIP_SIZE));
		await flush();

		await fetchPreviewViaModal(host);
		expect(host.querySelector('[data-testid="location-modal"]')).toBeNull();

		click(host, 'naip-use');
		await flush();

		// Preview gone; the pane is the normal viewport with the committed image.
		expect(host.querySelector('[data-testid="naip-preview"]')).toBeNull();
		expect(
			host.querySelector('[data-testid="pane-filename-target-basemap"]')?.textContent
		).toContain('naip-aerial.png');
		const target = editor.state.images.find((image) => image.role === 'target-basemap');
		expect(target).toBeDefined();
		expect(target?.widthPx).toBe(NAIP_SIZE);
		// Routed through intakeImageFile: the asset carries a manifest hash and undo works.
		expect(target?.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(editor.canUndo).toBe(true);
		// Replace/re-fetch stays reachable without a resurrected section.
		expect(host.querySelector('[data-testid="open-location-search"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="naip-fetch"]')).toBeNull();

		unmount(component);
		host.remove();
	});

	it('discarding the preview lands on a usable pane, not a dead end', async () => {
		stubNaipFetch();
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(NAIP_SIZE, NAIP_SIZE));
		await flush();

		await fetchPreviewViaModal(host);
		click(host, 'naip-discard');
		await flush();

		expect(host.querySelector('[data-testid="naip-preview"]')).toBeNull();
		expect(host.querySelector('[data-testid="clean-target-invite"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="open-location-search"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="pane-choose-target-basemap"]')).not.toBeNull();

		unmount(component);
		host.remove();
	});

	it('radius-fetch commit keeps the known ground scale; a direct upload never gains one (per-fetch-shape rule)', async () => {
		stubNaipFetch();
		const editor = makeEditor();
		await seedSource(editor);
		const { component, host } = mountPage(editor, decodeOf(NAIP_SIZE, NAIP_SIZE));
		await flush();

		await fetchPreviewViaModal(host);
		click(host, 'naip-use');
		await flush();

		seedCourseAndPairs(editor);
		(component as { refresh: () => void }).refresh();
		await flush();

		// Radius-based NAIP commit: hole graphics show real distances.
		expect(host.querySelector('[data-testid="hole-graphics-ground-scale"]')).not.toBeNull();

		// Replace the target with a plain upload of identical dimensions: the
		// ground scale must clear (an uploaded image has no known scale).
		const input = host.querySelector<HTMLInputElement>('[data-testid="pane-input-target-basemap"]');
		if (!input) throw new Error('missing target pane input');
		Object.defineProperty(input, 'files', {
			value: [new File([new Uint8Array(8).fill(2)], 'upload.png', { type: 'image/png' })],
			configurable: true
		});
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await flush();
		// Same dimensions but pairs exist → the discard confirmation appears; accept it.
		click(host, 'discard-confirm-accept');
		await flush();

		expect(host.querySelector('[data-testid="hole-graphics-ground-scale"]')).toBeNull();

		unmount(component);
		host.remove();
	});

	it('warns when course geometry exits the aerial, and the geo-referenced re-fetch preserves remapped pairs', async () => {
		const fetchSpy = stubNaipFetch();
		const editor = makeEditor();
		await seedSource(editor);
		const { component, host } = mountPage(editor, decodeOf(NAIP_SIZE, NAIP_SIZE));
		await flush();

		await fetchPreviewViaModal(host);
		click(host, 'naip-use');
		await flush();

		seedCourseAndPairs(editor);
		const pairsBefore = editor.state.controlPointPairs;
		expect(pairsBefore).toHaveLength(2);
		(component as { refresh: () => void }).refresh();
		await flush();

		// Basket (1900,1900) x scale ~2.047 = (~3889,~3889): outside the 2048 raster.
		const warning = host.querySelector('[data-testid="coverage-warning"]');
		expect(warning).not.toBeNull();
		const refetchButton = host.querySelector<HTMLButtonElement>('[data-testid="coverage-refetch"]');
		expect(refetchButton).not.toBeNull();

		const callsBefore = fetchSpy.mock.calls.length;
		refetchButton?.click();
		await flush();

		// A wider fetch actually happened.
		const newCalls = fetchSpy.mock.calls.slice(callsBefore).map((call) => String(call[0]));
		expect(newCalls.some((href) => href.includes('basemap.nationalmap.gov'))).toBe(true);

		// Pairs SURVIVED: same ids, same source coordinates, remapped targets.
		const pairsAfter = editor.state.controlPointPairs;
		expect(pairsAfter).toHaveLength(2);
		expect(pairsAfter.map((pair) => pair.id)).toEqual(pairsBefore.map((pair) => pair.id));
		expect(pairsAfter[0].source).toMatchObject({ xPx: 0, yPx: 0 });
		expect(pairsAfter[1].source).toMatchObject({ xPx: 1000, yPx: 0 });
		// The wider raster shrinks pixel distances: the far pair moved inward.
		expect(pairsAfter[1].target.xPx).toBeLessThan(2048);
		expect(pairsAfter[1].target.xPx).toBeGreaterThan(0);
		for (const pair of pairsAfter) {
			expect(pair.target.xPx).toBeGreaterThanOrEqual(0);
			expect(pair.target.yPx).toBeGreaterThanOrEqual(0);
			expect(pair.target.xPx).toBeLessThanOrEqual(NAIP_SIZE);
			expect(pair.target.yPx).toBeLessThanOrEqual(NAIP_SIZE);
		}

		// End-to-end signal that remap and expansion agree: the recomputed
		// alignment now maps the whole course INSIDE the new aerial.
		expect(host.querySelector('[data-testid="coverage-warning"]')).toBeNull();
		// Still the radius fetch shape: ground scale survives the re-fetch.
		expect(host.querySelector('[data-testid="hole-graphics-ground-scale"]')).not.toBeNull();

		unmount(component);
		host.remove();
	});

	it('a non-geo-referenced target gets the warning with stated cost, but no automatic re-fetch', async () => {
		stubNaipFetch();
		const editor = makeEditor();
		await seedSource(editor);
		// Upload path (no retained fetch geometry): seed the target directly.
		const uploadResult = await intakeImageFile({
			editor,
			role: 'target-basemap',
			file: new File([new Uint8Array(8).fill(3)], 'upload.png', { type: 'image/png' }),
			decode: decodeOf(NAIP_SIZE, NAIP_SIZE),
			createAssetId: nextId
		});
		if (!uploadResult.ok) throw new Error('seed target intake failed');
		seedCourseAndPairs(editor);

		const { component, host } = mountPage(editor, decodeOf(NAIP_SIZE, NAIP_SIZE));
		await flush();
		void component;

		const warning = host.querySelector('[data-testid="coverage-warning"]');
		expect(warning).not.toBeNull();
		expect(host.querySelector('[data-testid="coverage-refetch"]')).toBeNull();
		// Never silent: the cost of re-doing is stated in plain language.
		expect(warning?.textContent).toContain('discards its placed points');

		unmount(component);
		host.remove();
	});
});
