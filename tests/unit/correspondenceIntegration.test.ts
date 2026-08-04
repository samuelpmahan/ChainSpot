import { describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { createImageAsset, createProjectState } from '../../src/lib/domain/project';
import { ProjectEditor } from '../../src/lib/domain/editor';
import Page from '../../src/routes/+page.svelte';
import type { DecodeImageFile } from '../../src/lib/imageIntake';

const NOW = () => new Date('2026-08-02T00:00:00.000Z');
let counter = 0;
const nextId = (): string => `correspondence-${++counter}`;

function fileOf(name: string, type: string, size = 8): File {
	return new File([new Uint8Array(size).fill(1)], name, { type });
}

function decodeOf(widthPx: number, heightPx: number): DecodeImageFile {
	return async () => ({ image: document.createElement('img'), widthPx, heightPx });
}

function decodeByName(): DecodeImageFile {
	return async (file) => ({
		image: document.createElement('img'),
		widthPx: file.name.includes('wide') ? 120 : 100,
		heightPx: 80
	});
}

function makeEditor(): ProjectEditor {
	return new ProjectEditor({
		state: createProjectState({ createId: () => 'project-1', now: NOW }),
		createId: nextId,
		now: NOW
	});
}

function makeEditorWithBothImages(): ProjectEditor {
	const base = createProjectState({ createId: () => 'project-1', now: NOW });
	const source = createImageAsset({
		id: 'source-1',
		role: 'source-overview',
		fileName: 'source.png',
		mimeType: 'image/png',
		widthPx: 100,
		heightPx: 80
	});
	const target = createImageAsset({
		id: 'target-1',
		role: 'target-basemap',
		fileName: 'target.jpg',
		mimeType: 'image/jpeg',
		widthPx: 120,
		heightPx: 60
	});
	return new ProjectEditor({
		state: { ...base, images: [source, target] },
		assets: new Map([
			['source-1', { bytes: new Uint8Array([1]), decoded: document.createElement('img') }],
			['target-1', { bytes: new Uint8Array([2]), decoded: document.createElement('img') }]
		]),
		createId: nextId,
		now: NOW
	});
}

interface Mounted {
	editor: ProjectEditor;
	component: ReturnType<typeof mount>;
	host: HTMLDivElement;
}

function mountPage(editor: ProjectEditor, decode: DecodeImageFile): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(Page, { target: host, props: { editor, decode } });
	return { editor, component, host };
}

function inputFor(host: HTMLElement, role: 'source-overview' | 'target-basemap'): HTMLInputElement {
	const input = host.querySelector<HTMLInputElement>(`[data-testid="pane-input-${role}"]`);
	if (!input) throw new Error(`missing input for ${role}`);
	return input;
}

function sceneFor(host: HTMLElement, role: 'source-overview' | 'target-basemap'): HTMLElement {
	const scene = host.querySelector<HTMLElement>(`[data-testid="pane-scene-${role}"]`);
	if (!scene) throw new Error(`missing scene for ${role}`);
	return scene;
}

function setGeometry(host: HTMLElement, role: 'source-overview' | 'target-basemap'): void {
	const scene = sceneFor(host, role);
	Object.defineProperties(scene, {
		clientWidth: { configurable: true, value: 1 },
		clientHeight: { configurable: true, value: 1 },
		clientLeft: { configurable: true, value: 0 },
		clientTop: { configurable: true, value: 0 }
	});
	scene.getBoundingClientRect = () =>
		({ left: 0, top: 0, width: 1, height: 1, right: 1, bottom: 1 } as DOMRect);
}

function dispatchClick(host: HTMLElement, role: 'source-overview' | 'target-basemap', x = 0.5, y = 0.5): void {
	const scene = sceneFor(host, role);
	const pointerId = 17;
	scene.dispatchEvent(
		new PointerEvent('pointerdown', {
			button: 0,
			pointerId,
			clientX: x,
			clientY: y,
			bubbles: true
		})
	);
	window.dispatchEvent(
		new PointerEvent('pointerup', { pointerId, clientX: x, clientY: y })
	);
}

function setFileInput(input: HTMLInputElement, file: File): void {
	Object.defineProperty(input, 'files', { configurable: true, value: [file] });
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function flush(): Promise<void> {
	for (let i = 0; i < 12; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function loadBoth(host: HTMLElement, decode: DecodeImageFile): Promise<void> {
	setFileInput(inputFor(host, 'source-overview'), fileOf('source.png', 'image/png'));
	await flush();
	setFileInput(inputFor(host, 'target-basemap'), fileOf('target.jpg', 'image/jpeg'));
	await flush();
	setGeometry(host, 'source-overview');
	setGeometry(host, 'target-basemap');
}

function mode(host: HTMLElement): string | undefined {
	return host.querySelector<HTMLElement>('[data-testid="app-shell"]')?.dataset.correspondenceMode;
}

describe('P0-007 correspondence integration', () => {
	it('shows exact guidance, creates a pending source, and completes one pair', async () => {
		const editor = makeEditorWithBothImages();
		editor.markSaved();
		const { component, host } = mountPage(editor, decodeOf(100, 80));
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="correspondence-guidance"]')?.textContent).toContain(
			'Click a landmark in the UDisc source image.'
		);
		dispatchClick(host, 'source-overview');
		await flush();
		expect(mode(host)).toBe('add-target');
		expect(host.querySelector('[data-testid="correspondence-guidance"]')?.textContent).toContain(
			'Click the same landmark in the clean target image.'
		);
		expect(host.querySelector('[data-testid="app-shell"]')?.getAttribute('data-pending-source')).toBe('true');

		const sourceView = sceneFor(host, 'source-overview').dataset;
		const targetView = sceneFor(host, 'target-basemap').dataset;
		dispatchClick(host, 'target-basemap');
		await flush();

		expect(editor.state.controlPointPairs).toHaveLength(1);
		expect(editor.state.controlPointPairs[0].id).toBeTruthy();
		expect(editor.state.controlPointPairs[0].ordinal).toBe(1);
		expect(editor.state.controlPointPairs[0].source.xPx).toBeCloseTo(
			(0.5 - Number(sourceView.viewPanX)) / Number(sourceView.viewZoom),
			10
		);
		expect(editor.state.controlPointPairs[0].target.xPx).toBeCloseTo(
			(0.5 - Number(targetView.viewPanX)) / Number(targetView.viewZoom),
			10
		);
		expect(editor.state.controlPointPairs[0].source.imageId).toBe('source-1');
		expect(editor.state.controlPointPairs[0].target.imageId).toBe('target-1');
		expect(mode(host)).toBe('neutral');
		expect(host.querySelector<HTMLElement>('[data-testid="app-shell"]')?.dataset.completePairCount).toBe('1');

		unmount(component);
		host.remove();
	});

	it('cancels without changing state, dirty state, or undo/redo availability', async () => {
		const editor = makeEditorWithBothImages();
		editor.markSaved();
		const baseline = JSON.stringify(editor.state);
		const baselineDirty = editor.isDirty;
		const baselineUndo = editor.canUndo;
		const baselineRedo = editor.canRedo;
		const { component, host } = mountPage(editor, decodeOf(100, 80));
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview');
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="cancel-correspondence"]')?.click();
		await flush();

		expect(JSON.stringify(editor.state)).toBe(baseline);
		expect(editor.isDirty).toBe(baselineDirty);
		expect(editor.canUndo).toBe(baselineUndo);
		expect(editor.canRedo).toBe(baselineRedo);
		expect(mode(host)).toBe('neutral');

		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview');
		await flush();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await flush();
		expect(mode(host)).toBe('neutral');
		expect(JSON.stringify(editor.state)).toBe(baseline);

		unmount(component);
		host.remove();
	});

	it('keeps target guidance and pending state when addPair fails', async () => {
		const editor = makeEditorWithBothImages();
		vi.spyOn(editor, 'addPair').mockImplementation(() => {
			throw new Error('simulated add failure');
		});
		const { component, host } = mountPage(editor, decodeOf(100, 80));
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview');
		await flush();
		dispatchClick(host, 'target-basemap');
		await flush();

		expect(mode(host)).toBe('add-target');
		expect(host.querySelector('[data-testid="correspondence-guidance"]')?.textContent).toContain(
			'Click the same landmark in the clean target image.'
		);
		expect(host.querySelector('[data-testid="correspondence-error"]')?.textContent).toContain(
			'simulated add failure'
		);
		expect(editor.state.controlPointPairs).toHaveLength(0);

		unmount(component);
		host.remove();
	});

	it('ignores an out-of-image click before emitting a placement', async () => {
		const editor = makeEditorWithBothImages();
		const { component, host } = mountPage(editor, decodeOf(100, 80));
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview', 0.5, 0);
		await flush();

		expect(mode(host)).toBe('add-source');
		expect(host.querySelector('[data-testid="pane-interaction-error-source-overview"]')?.textContent).toContain(
			'original image bounds'
		);
		expect(editor.state.controlPointPairs).toHaveLength(0);

		unmount(component);
		host.remove();
	});

	it('cancels pending creation after successful image replacement but preserves it after failed intake', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(100, 80));
		await loadBoth(host, decodeOf(100, 80));

		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview');
		await flush();
		expect(mode(host)).toBe('add-target');

		setFileInput(inputFor(host, 'target-basemap'), fileOf('target-v2.jpg', 'image/jpeg'));
		await flush();
		expect(mode(host)).toBe('neutral');

		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview');
		await flush();
		expect(mode(host)).toBe('add-target');
		setFileInput(inputFor(host, 'target-basemap'), fileOf('broken.txt', 'text/plain'));
		await flush();
		expect(mode(host)).toBe('add-target');
		expect(host.querySelector('[data-testid="correspondence-guidance"]')?.textContent).toContain(
			'Click the same landmark in the clean target image.'
		);

		unmount(component);
		host.remove();
	});

	it('cancels after a successful same-dimension source replacement', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(100, 80));
		await loadBoth(host, decodeOf(100, 80));

		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview');
		await flush();
		expect(mode(host)).toBe('add-target');

		setFileInput(inputFor(host, 'source-overview'), fileOf('source-v2.png', 'image/png'));
		await flush();
		expect(mode(host)).toBe('neutral');
		expect(host.querySelector('[data-testid="app-shell"]')?.getAttribute('data-pending-source')).toBe('false');
		expect(host.querySelector('[data-testid="pane-filename-source-overview"]')?.textContent).toBe(
			'source-v2.png'
		);

		unmount(component);
		host.remove();
	});

	it('cancels stale completion after an external source replacement bypasses the intake callback', async () => {
		const editor = makeEditorWithBothImages();
		const { component, host } = mountPage(editor, decodeOf(100, 80));
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview');
		await flush();
		expect(mode(host)).toBe('add-target');

		const replacement = createImageAsset({
			id: 'source-external-replacement',
			role: 'source-overview',
			fileName: 'external.png',
			mimeType: 'image/png',
			widthPx: 100,
			heightPx: 80
		});
		editor.replaceImage({
			role: 'source-overview',
			asset: replacement,
			bytes: new Uint8Array([3]),
			retainPoints: true
		});
		await (component as unknown as { refresh: () => void }).refresh();
		await flush();

		dispatchClick(host, 'target-basemap');
		await flush();
		expect(editor.state.controlPointPairs).toHaveLength(0);
		expect(mode(host)).toBe('neutral');
		expect(host.querySelector('[data-testid="correspondence-error"]')?.textContent).toContain(
			'Restart correspondence creation'
		);

		unmount(component);
		host.remove();
	});

	it('preserves pending state when the user cancels a replacement', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeByName());
		await loadBoth(host, decodeByName());
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		// Create an existing pair so a different-dimension replacement requires confirmation.
		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview');
		await flush();
		dispatchClick(host, 'target-basemap');
		await flush();
		expect(editor.state.controlPointPairs).toHaveLength(1);

		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview', 0.25, 0.5);
		await flush();
		expect(mode(host)).toBe('add-target');

		setFileInput(inputFor(host, 'source-overview'), fileOf('source-wide.png', 'image/png'));
		await flush();
		expect(host.querySelector('[data-testid="discard-confirmation"]')).toBeTruthy();
		host.querySelector<HTMLButtonElement>('[data-testid="discard-confirm-cancel"]')?.click();
		await flush();

		expect(mode(host)).toBe('add-target');
		expect(host.querySelector('[data-testid="app-shell"]')?.getAttribute('data-pending-source')).toBe('true');
		expect(host.querySelector('[data-testid="correspondence-guidance"]')?.textContent).toContain(
			'Click the same landmark in the clean target image.'
		);
		expect(editor.state.controlPointPairs).toHaveLength(1);

		unmount(component);
		host.remove();
	});

	it('proves pair completion adds exactly one history entry', async () => {
		const editor = makeEditorWithBothImages();
		editor.markSaved();
		const baselineJson = JSON.stringify(editor.state);
		const { component, host } = mountPage(editor, decodeOf(100, 80));
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview');
		await flush();
		dispatchClick(host, 'target-basemap');
		await flush();
		const completedJson = JSON.stringify(editor.state);
		expect(editor.state.controlPointPairs).toHaveLength(1);
		expect(editor.canUndo).toBe(true);
		expect(editor.canRedo).toBe(false);

		expect(editor.undo()).toBe(true);
		expect(JSON.stringify(editor.state)).toBe(baselineJson);
		expect(editor.canUndo).toBe(false);
		expect(editor.canRedo).toBe(true);

		expect(editor.redo()).toBe(true);
		expect(JSON.stringify(editor.state)).toBe(completedJson);
		expect(editor.canUndo).toBe(true);
		expect(editor.canRedo).toBe(false);

		unmount(component);
		host.remove();
	});
});
