// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import Page from '../../src/routes/create-graphics/+page.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import {
	createControlPointPair,
	createImageAsset,
	createProjectState
} from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import type { MarkerHitResult } from '../../src/lib/scene';

const NOW = () => new Date('2026-08-03T00:00:00.000Z');

const sceneMock = vi.hoisted(() => ({
	rasterLayer: {},
	controlPointLayer: {},
	interactionLayer: {},
	controlPointGroup: {},
	setImage: vi.fn(),
	applyTransform: vi.fn(),
	setMarkers: vi.fn(),
	setMarkersVisible: vi.fn(),
	setStageSize: vi.fn(),
	markerHitAt: vi.fn(() => null as MarkerHitResult | null),
	clearImage: vi.fn(),
	destroy: vi.fn()
}));

vi.mock('../../src/lib/scene', () => ({
	canvas2dAvailable: () => true,
	createPaneScene: () => sceneMock
}));

function decodeOf(widthPx: number, heightPx: number): DecodeImageFile {
	return async () => ({ image: document.createElement('img'), widthPx, heightPx });
}

function makeEditor(pairCount = 3): ProjectEditor {
	const base = createProjectState({ createId: () => 'project-1', now: NOW });
	const source = createImageAsset({
		id: 'source-1',
		role: 'source-overview',
		fileName: 'source.png',
		mimeType: 'image/png',
		widthPx: 200,
		heightPx: 100
	});
	const target = createImageAsset({
		id: 'target-1',
		role: 'target-basemap',
		fileName: 'target.png',
		mimeType: 'image/png',
		widthPx: 400,
		heightPx: 50
	});
	const pairs = Array.from({ length: pairCount }, (_, i) => {
		const n = i + 1;
		return createControlPointPair({
			id: `pair-${n}`,
			ordinal: n,
			sourceImage: source,
			targetImage: target,
			sourceCoordinates: { xPx: 20 + n, yPx: 10 + n },
			targetCoordinates: { xPx: 40 + n * 2, yPx: 5 + n },
			label: n === 1 ? 'Parking corner' : null,
			now: NOW
		});
	});
	return new ProjectEditor({
		state: { ...base, images: [source, target], controlPointPairs: pairs },
		assets: new Map([
			['source-1', { bytes: new Uint8Array([1]), decoded: document.createElement('img') }],
			['target-1', { bytes: new Uint8Array([2]), decoded: document.createElement('img') }]
		]),
		now: NOW
	});
}

interface Mounted {
	editor: ProjectEditor;
	component: ReturnType<typeof mount>;
	host: HTMLDivElement;
}

function mountPage(editor: ProjectEditor): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(Page, { target: host, props: { editor, decode: decodeOf(200, 100) } });
	return { editor, component, host };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function setGeometry(host: HTMLElement, role: 'source-overview' | 'target-basemap'): void {
	const scene = host.querySelector<HTMLElement>(`[data-testid="pane-scene-${role}"]`);
	if (!scene) throw new Error(`missing scene for ${role}`);
	Object.defineProperties(scene, {
		clientWidth: { configurable: true, value: 1 },
		clientHeight: { configurable: true, value: 1 },
		clientLeft: { configurable: true, value: 0 },
		clientTop: { configurable: true, value: 0 }
	});
	scene.getBoundingClientRect = () =>
		({ left: 0, top: 0, width: 1, height: 1, right: 1, bottom: 1 } as DOMRect);
}

function dispatchClick(host: HTMLElement, role: 'source-overview' | 'target-basemap'): void {
	const scene = host.querySelector<HTMLElement>(`[data-testid="pane-scene-${role}"]`);
	if (!scene) throw new Error(`missing scene for ${role}`);
	const pointerId = 17;
	scene.dispatchEvent(
		new PointerEvent('pointerdown', { button: 0, pointerId, clientX: 0.5, clientY: 0.5, bubbles: true })
	);
	window.dispatchEvent(new PointerEvent('pointerup', { pointerId, clientX: 0.5, clientY: 0.5 }));
}

function selectSide(host: HTMLElement, pairId: string, side: 'source' | 'target'): void {
	const button = host.querySelector<HTMLButtonElement>(`[data-testid="pair-${side}-${pairId}"]`);
	if (!button) throw new Error(`missing ${side} control for ${pairId}`);
	button.click();
}

function mode(host: HTMLElement): string | undefined {
	return host.querySelector<HTMLElement>('[data-testid="app-shell"]')?.dataset.correspondenceMode;
}

function latestMarker(pairId: string, side: string): Record<string, unknown> | null {
	for (let i = sceneMock.setMarkers.mock.calls.length - 1; i >= 0; i -= 1) {
		const markers = sceneMock.setMarkers.mock.calls[i][0] as Array<Record<string, unknown>>;
		const found = markers.find((marker) => marker.pairId === pairId && marker.side === side);
		if (found) return found;
	}
	return null;
}

function pendingMarkerPresent(): boolean {
	for (let i = sceneMock.setMarkers.mock.calls.length - 1; i >= 0; i -= 1) {
		const markers = sceneMock.setMarkers.mock.calls[i][0] as Array<Record<string, unknown>>;
		if (markers.some((marker) => marker.id === 'pending-source-marker')) return true;
	}
	return false;
}

function selectedSideClasses(host: HTMLElement, pairId: string): { row: boolean; source: boolean; target: boolean } {
	const row = host.querySelector(`[data-testid="pair-row"][data-pair-id="${pairId}"]`);
	const source = host.querySelector(`[data-testid="pair-source-${pairId}"]`);
	const target = host.querySelector(`[data-testid="pair-target-${pairId}"]`);
	return {
		row: row?.classList.contains('selected') ?? false,
		source: source?.classList.contains('selected') ?? false,
		target: target?.classList.contains('selected') ?? false
	};
}

async function labelType(host: HTMLElement, pairId: string, value: string): Promise<void> {
	const input = host.querySelector<HTMLInputElement>(`[data-testid="pair-label-${pairId}"]`);
	if (!input) throw new Error(`missing label input for ${pairId}`);
	input.focus();
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	input.dispatchEvent(new Event('blur', { bubbles: true }));
	await flush();
}

afterEach(() => {
	vi.clearAllMocks();
	sceneMock.markerHitAt.mockReturnValue(null);
	document.body.replaceChildren();
});

describe('P0-009 list/canvas selection sync', () => {
	it('selecting from the list drives the canvas markers and the inspector', async () => {
		const editor = makeEditor(3);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		selectSide(host, 'pair-2', 'source');
		await flush();

		expect(editor.state.controlPointPairs[1].id).toBe('pair-2');
		expect(latestMarker('pair-2', 'source')?.selected).toBe(true);
		expect(latestMarker('pair-2', 'target')?.selected).toBe(false);
		const classes = selectedSideClasses(host, 'pair-2');
		expect(classes.row).toBe(true);
		expect(classes.source).toBe(true);
		expect(classes.target).toBe(false);
		expect(host.querySelector('[data-testid="point-inspector"]')?.textContent).toContain(
			'Pair 2 · Source point'
		);

		unmount(component);
	});

	it('canvas marker selection highlights the list row and exact side', async () => {
		const editor = makeEditor(3);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		sceneMock.markerHitAt.mockReturnValue({ pairId: 'pair-3', side: 'target', kind: 'complete' });
		dispatchClick(host, 'source-overview');
		await flush();

		const classes = selectedSideClasses(host, 'pair-3');
		expect(classes.row).toBe(true);
		expect(classes.target).toBe(true);
		expect(classes.source).toBe(false);
		expect(host.querySelector('[data-testid="point-inspector"]')?.textContent).toContain(
			'Pair 3 · Target point'
		);

		unmount(component);
	});

	it('selection uses stable pair identity and follows reorder', async () => {
		const editor = makeEditor(3);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		selectSide(host, 'pair-3', 'target');
		await flush();
		expect(host.querySelector('[data-testid="point-inspector"]')?.textContent).toContain('Pair 3');

		host.querySelector<HTMLButtonElement>('[data-testid="pair-up-pair-3"]')?.click();
		await flush();
		// Reorder regenerated the ordinal (pair-3 is now second) but identity is stable:
		// selection still describes the pair-3 target, which is what the highlight shows.
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-3')?.ordinal).toBe(2);
		const classes = selectedSideClasses(host, 'pair-3');
		expect(classes.row).toBe(true);
		expect(classes.target).toBe(true);
		expect(host.querySelector('[data-testid="point-inspector"]')?.textContent).toContain('Pair 2');

		unmount(component);
	});
});

describe('P0-009 label editing integration', () => {
	it('commits labels through the domain with one history entry and exact undo/redo', async () => {
		const editor = makeEditor(3);
		editor.markSaved();
		const baseline = JSON.stringify(editor.state);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		await labelType(host, 'pair-2', 'Pond edge');
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2')?.label).toBe(
			'Pond edge'
		);
		expect(host.querySelector('[data-testid="dirty-indicator"]')?.textContent).toContain(
			'Unsaved changes'
		);
		expect(editor.canUndo).toBe(true);
		expect(editor.canRedo).toBe(false);

		host.querySelector<HTMLButtonElement>('[data-testid="undo"]')?.click();
		await flush();
		expect(JSON.stringify(editor.state)).toBe(baseline);
		expect(editor.canUndo).toBe(false);
		expect(host.querySelector('[data-testid="dirty-indicator"]')).toBeNull();

		host.querySelector<HTMLButtonElement>('[data-testid="redo"]')?.click();
		await flush();
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2')?.label).toBe(
			'Pond edge'
		);
		expect(host.querySelector('[data-testid="dirty-indicator"]')).toBeTruthy();

		await labelType(host, 'pair-2', 'Pond');
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2')?.label).toBe('Pond');
		host.querySelector<HTMLButtonElement>('[data-testid="undo"]')?.click();
		await flush();
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2')?.label).toBe(
			'Pond edge'
		);
		host.querySelector<HTMLButtonElement>('[data-testid="undo"]')?.click();
		await flush();
		expect(JSON.stringify(editor.state)).toBe(baseline);

		unmount(component);
	});

	it('clears a label to null through the domain', async () => {
		const editor = makeEditor(3);
		editor.markSaved();
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		await labelType(host, 'pair-1', '');
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-1')?.label).toBeNull();
		expect(editor.isDirty).toBe(true);

		unmount(component);
	});
});

describe('P0-009 reorder integration', () => {
	it('regenerates ordinals in the list and markers while preserving ids and coordinates', async () => {
		const editor = makeEditor(3);
		editor.markSaved();
		const baseline = JSON.stringify(editor.state);
		const reorderSpy = vi.spyOn(editor, 'reorderPairs');
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		host.querySelector<HTMLButtonElement>('[data-testid="pair-down-pair-1"]')?.click();
		await flush();

		expect(reorderSpy).toHaveBeenCalledTimes(1);
		expect(editor.state.controlPointPairs.map((pair) => pair.id)).toEqual([
			'pair-2',
			'pair-1',
			'pair-3'
		]);
		expect(editor.state.controlPointPairs.map((pair) => pair.ordinal)).toEqual([1, 2, 3]);
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2')?.ordinal).toBe(1);
		// IDs, coordinates, labels, and enabled state are preserved.
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-1')?.source).toEqual({
			imageId: 'source-1',
			xPx: 21,
			yPx: 11
		});
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-1')?.label).toBe(
			'Parking corner'
		);
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-1')?.enabled).toBe(true);
		// List ordinals update.
		expect(host.querySelector('[data-testid="pair-ordinal-pair-2"]')?.textContent).toBe('1');
		expect(host.querySelector('[data-testid="pair-ordinal-pair-1"]')?.textContent).toBe('2');
		// Konva marker labels update through the scene adapter.
		expect(latestMarker('pair-2', 'source')?.ordinal).toBe(1);
		expect(latestMarker('pair-1', 'source')?.ordinal).toBe(2);

		host.querySelector<HTMLButtonElement>('[data-testid="undo"]')?.click();
		await flush();
		expect(JSON.stringify(editor.state)).toBe(baseline);

		host.querySelector<HTMLButtonElement>('[data-testid="redo"]')?.click();
		await flush();
		expect(editor.state.controlPointPairs.map((pair) => pair.id)).toEqual([
			'pair-2',
			'pair-1',
			'pair-3'
		]);

		unmount(component);
	});

	it('supports multiple reorders and boundary no-ops without extra history', async () => {
		const editor = makeEditor(3);
		editor.markSaved();
		const baseline = JSON.stringify(editor.state);
		const reorderSpy = vi.spyOn(editor, 'reorderPairs');
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		// Boundary buttons are disabled at the ends.
		expect((host.querySelector('[data-testid="pair-up-pair-1"]') as HTMLButtonElement).disabled).toBe(true);
		expect((host.querySelector('[data-testid="pair-down-pair-3"]') as HTMLButtonElement).disabled).toBe(true);

		host.querySelector<HTMLButtonElement>('[data-testid="pair-up-pair-3"]')?.click();
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="pair-up-pair-3"]')?.click();
		await flush();
		expect(editor.state.controlPointPairs.map((pair) => pair.id)).toEqual([
			'pair-3',
			'pair-1',
			'pair-2'
		]);
		expect(editor.state.controlPointPairs.map((pair) => pair.ordinal)).toEqual([1, 2, 3]);
		expect(reorderSpy).toHaveBeenCalledTimes(2);

		host.querySelector<HTMLButtonElement>('[data-testid="undo"]')?.click();
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="undo"]')?.click();
		await flush();
		expect(JSON.stringify(editor.state)).toBe(baseline);

		unmount(component);
	});

	it('reorders the selected pair with Ctrl/Cmd+Arrow without breaking nudge', async () => {
		const editor = makeEditor(3);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		selectSide(host, 'pair-2', 'source');
		await flush();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true, bubbles: true }));
		await flush();
		expect(editor.state.controlPointPairs.map((pair) => pair.id)).toEqual([
			'pair-2',
			'pair-1',
			'pair-3'
		]);
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2')?.ordinal).toBe(1);
		// Plain arrow still nudges rather than reordering.
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		await flush();
		expect(editor.state.controlPointPairs.map((pair) => pair.id)).toEqual([
			'pair-2',
			'pair-1',
			'pair-3'
		]);
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2')?.source.xPx).toBe(23);

		unmount(component);
	});
});

describe('P0-009 enable/disable integration', () => {
	it('toggles enabled through the domain action with undo/redo and a distinct state', async () => {
		const editor = makeEditor(3);
		editor.markSaved();
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		const checkbox = host.querySelector<HTMLInputElement>('[data-testid="pair-enabled-pair-2"]');
		checkbox?.click();
		await flush();

		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2')?.enabled).toBe(false);
		expect(editor.isDirty).toBe(true);
		const row2 = host.querySelector('[data-testid="pair-row"][data-pair-id="pair-2"]');
		expect(row2?.classList.contains('disabled-pair')).toBe(true);
		expect(latestMarker('pair-2', 'source')?.enabled).toBe(false);

		// Disabled pairs remain selectable and editable.
		selectSide(host, 'pair-2', 'source');
		await flush();
		expect(host.querySelector('[data-testid="point-inspector"]')).toBeTruthy();

		host.querySelector<HTMLButtonElement>('[data-testid="undo"]')?.click();
		await flush();
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2')?.enabled).toBe(true);
		host.querySelector<HTMLButtonElement>('[data-testid="redo"]')?.click();
		await flush();
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2')?.enabled).toBe(false);

		unmount(component);
	});
});

describe('P0-009 delete integration', () => {
	it('deletes through the visible row control with selection cleared and exact undo/redo', async () => {
		const editor = makeEditor(3);
		editor.markSaved();
		const baseline = JSON.stringify(editor.state);
		const deletedPair = JSON.stringify(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2'));
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		selectSide(host, 'pair-2', 'target');
		await flush();
		expect(host.querySelector('[data-testid="point-inspector"]')).toBeTruthy();

		host.querySelector<HTMLButtonElement>('[data-testid="pair-delete-pair-2"]')?.click();
		await flush();
		expect(editor.state.controlPointPairs.map((pair) => pair.id)).toEqual(['pair-1', 'pair-3']);
		expect(editor.isDirty).toBe(true);
		expect(host.querySelector('[data-testid="point-inspector"]')).toBeNull();
		expect(host.querySelector('[data-testid="pair-row"][data-pair-id="pair-2"]')).toBeNull();

		host.querySelector<HTMLButtonElement>('[data-testid="undo"]')?.click();
		await flush();
		expect(JSON.stringify(editor.state)).toBe(baseline);
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2')).toBeTruthy();
		expect(JSON.stringify(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2'))).toBe(
			deletedPair
		);
		// Selection history is not restored, which is allowed.
		expect(host.querySelector('[data-testid="point-inspector"]')).toBeNull();

		unmount(component);
	});

	it('deletes with Delete/Backspace only when safe and never in editable fields', async () => {
		const editor = makeEditor(3);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		selectSide(host, 'pair-1', 'source');
		await flush();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
		await flush();
		expect(editor.state.controlPointPairs.map((pair) => pair.id)).toEqual(['pair-2', 'pair-3']);

		selectSide(host, 'pair-3', 'source');
		await flush();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
		await flush();
		expect(editor.state.controlPointPairs.map((pair) => pair.id)).toEqual(['pair-2']);

		// Delete inside a label input must be suppressed.
		const labelInput = host.querySelector<HTMLInputElement>('[data-testid="pair-label-pair-2"]');
		if (!labelInput) throw new Error('missing label input');
		labelInput.focus();
		labelInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
		await flush();
		expect(editor.state.controlPointPairs.map((pair) => pair.id)).toEqual(['pair-2']);

		// Delete with no selection is a no-op.
		labelInput.blur();
		await flush();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
		await flush();
		expect(editor.state.controlPointPairs.map((pair) => pair.id)).toEqual(['pair-2']);

		unmount(component);
	});

	it('clears selection when an undo/redo removes the selected pair id', async () => {
		const editor = makeEditor(3);
		editor.markSaved();
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		selectSide(host, 'pair-3', 'target');
		host.querySelector<HTMLButtonElement>('[data-testid="pair-delete-pair-3"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="point-inspector"]')).toBeNull();

		host.querySelector<HTMLButtonElement>('[data-testid="undo"]')?.click();
		await flush();
		selectSide(host, 'pair-3', 'target');
		await flush();
		expect(host.querySelector('[data-testid="point-inspector"]')).toBeTruthy();

		host.querySelector<HTMLButtonElement>('[data-testid="redo"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="point-inspector"]')).toBeNull();

		unmount(component);
	});
});

describe('P0-009 history shortcuts', () => {
	it('supports Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, and Ctrl+Y with editable suppression', async () => {
		const editor = makeEditor(3);
		editor.markSaved();
		const baseline = JSON.stringify(editor.state);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		await labelType(host, 'pair-2', 'Pond edge');
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2')?.label).toBe(
			'Pond edge'
		);

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
		await flush();
		expect(JSON.stringify(editor.state)).toBe(baseline);

		window.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true })
		);
		await flush();
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2')?.label).toBe(
			'Pond edge'
		);

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
		await flush();
		expect(JSON.stringify(editor.state)).toBe(baseline);

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
		await flush();
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2')?.label).toBe(
			'Pond edge'
		);

		// Editable context: Ctrl+Z inside the project name field must not undo the domain.
		const nameInput = host.querySelector<HTMLInputElement>('[data-testid="project-name"]');
		if (!nameInput) throw new Error('missing project name input');
		nameInput.focus();
		nameInput.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })
		);
		await flush();
		expect(editor.state.controlPointPairs.find((pair) => pair.id === 'pair-2')?.label).toBe(
			'Pond edge'
		);

		unmount(component);
	});

	it('clears redo after a divergent edit from an undone state', async () => {
		const editor = makeEditor(3);
		editor.markSaved();
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		await labelType(host, 'pair-2', 'Pond edge');
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
		await flush();
		expect(editor.canRedo).toBe(true);

		await labelType(host, 'pair-1', 'New label');
		await flush();
		expect(editor.canRedo).toBe(false);
		expect((host.querySelector('[data-testid="redo"]') as HTMLButtonElement).disabled).toBe(true);

		unmount(component);
	});
});

describe('P0-009 overlay visibility', () => {
	it('hide/show is transient: no domain, history, dirty, or selection change', async () => {
		const editor = makeEditor(3);
		editor.markSaved();
		const baselineJson = JSON.stringify(editor.state);
		const baselineDirty = editor.isDirty;
		const baselineUndo = editor.canUndo;
		const baselineRedo = editor.canRedo;
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		selectSide(host, 'pair-1', 'source');
		await flush();
		const markersBeforeHide = sceneMock.setMarkers.mock.calls.at(-1)?.[0];

		host.querySelector<HTMLButtonElement>('[data-testid="toggle-markers"]')?.click();
		await flush();
		expect(sceneMock.setMarkersVisible.mock.calls.at(-1)?.[0]).toBe(false);
		expect(JSON.stringify(editor.state)).toBe(baselineJson);
		expect(editor.isDirty).toBe(baselineDirty);
		expect(editor.canUndo).toBe(baselineUndo);
		expect(editor.canRedo).toBe(baselineRedo);
		// The authoritative marker data is unchanged; only layer visibility toggles.
		expect(JSON.stringify(sceneMock.setMarkers.mock.calls.at(-1)?.[0])).toBe(
			JSON.stringify(markersBeforeHide)
		);
		// Selection and inspector stay even though markers are hidden.
		const classes = selectedSideClasses(host, 'pair-1');
		expect(classes.row).toBe(true);
		expect(host.querySelector('[data-testid="point-inspector"]')).toBeTruthy();

		host.querySelector<HTMLButtonElement>('[data-testid="toggle-markers"]')?.click();
		await flush();
		expect(sceneMock.setMarkersVisible.mock.calls.at(-1)?.[0]).toBe(true);
		expect(JSON.stringify(editor.state)).toBe(baselineJson);

		unmount(component);
	});

	it('hiding markers does not cancel a pending correspondence', async () => {
		const editor = makeEditor(3);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview');
		await flush();
		expect(mode(host)).toBe('add-target');
		expect(pendingMarkerPresent()).toBe(true);

		host.querySelector<HTMLButtonElement>('[data-testid="toggle-markers"]')?.click();
		await flush();
		expect(mode(host)).toBe('add-target');
		expect(pendingMarkerPresent()).toBe(true);
		// The list is display-only while creating so pending state cannot be broken.
		expect((host.querySelector('[data-testid="pair-up-pair-1"]') as HTMLButtonElement).disabled).toBe(true);

		dispatchClick(host, 'target-basemap');
		await flush();
		expect(editor.state.controlPointPairs).toHaveLength(4);
		expect(mode(host)).toBe('neutral');
		expect(host.querySelector<HTMLElement>('[data-testid="app-shell"]')?.dataset.completePairCount).toBe(
			'4'
		);

		unmount(component);
	});
});
