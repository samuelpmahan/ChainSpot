// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import Page from '../../src/routes/create-graphics/+page.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import {
	createControlPointPair,
	createImageAsset,
	createProjectState
} from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';

const NOW = () => new Date('2026-08-03T00:00:00.000Z');

function decodeOf(widthPx: number, heightPx: number): DecodeImageFile {
	return async () => ({ image: document.createElement('img'), widthPx, heightPx });
}

function makeEditor(pairCount = 3, clustered = false): ProjectEditor {
	const base = createProjectState({ createId: () => 'project-1', now: NOW });
	const source = createImageAsset({
		id: 'source-1',
		role: 'source-overview',
		fileName: 'source.png',
		mimeType: 'image/png',
		widthPx: 1000,
		heightPx: 1000
	});
	const target = createImageAsset({
		id: 'target-1',
		role: 'target-basemap',
		fileName: 'target.png',
		mimeType: 'image/png',
		widthPx: 1000,
		heightPx: 1000
	});
	const pairs = Array.from({ length: pairCount }, (_, i) => {
		const n = i + 1;
		const spread = n * 200;
		return createControlPointPair({
			id: `pair-${n}`,
			ordinal: n,
			sourceImage: source,
			targetImage: target,
			// Clustered fixtures stack all source points within 30px so coverage and
			// near-duplicate warnings fire together; distributed fixtures spread them.
			sourceCoordinates: clustered
				? { xPx: 10 + n, yPx: 10 + n }
				: { xPx: spread, yPx: spread },
			targetCoordinates: clustered ? { xPx: 20, yPx: 20 } : { xPx: 1000 - spread, yPx: 1000 - spread },
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

function mountPage(editor: ProjectEditor, decode: DecodeImageFile = decodeOf(1000, 1000)): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(Page, { target: host, props: { editor, decode } });
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

function appShell(host: HTMLElement): HTMLElement {
	const shell = host.querySelector<HTMLElement>('[data-testid="app-shell"]');
	if (!shell) throw new Error('missing app shell');
	return shell;
}

function textOf(host: HTMLElement, testId: string): string {
	return host.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.textContent?.trim() ?? '';
}

function warnings(host: HTMLElement): string[] {
	return Array.from(host.querySelectorAll<HTMLElement>('[data-testid="diagnostic-warning"]')).map(
		(node) => node.textContent ?? ''
	);
}

afterEach(() => {
	document.body.replaceChildren();
});

describe('P0-012 counts through add/cancel/delete/undo/redo', () => {
	it('updates complete and pending counts and copy through the full lifecycle', async () => {
		const editor = makeEditor(2);
		editor.markSaved();
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		expect(appShell(host).dataset.completePairCount).toBe('2');
		expect(appShell(host).dataset.pendingPairCount).toBe('0');
		expect(textOf(host, 'pair-count-text')).toBe('2 complete pairs');

		// Add: a pending half-pair appears but never as a complete pair.
		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview');
		await flush();
		expect(appShell(host).dataset.completePairCount).toBe('2');
		expect(appShell(host).dataset.pendingPairCount).toBe('1');
		expect(textOf(host, 'pair-count-text')).toBe('2 complete pairs · 1 pending point');
		expect(host.querySelector('[data-testid="pending-guidance"]')).toBeTruthy();

		// Complete the pair: pending disappears and complete grows.
		dispatchClick(host, 'target-basemap');
		await flush();
		expect(editor.state.controlPointPairs).toHaveLength(3);
		expect(appShell(host).dataset.completePairCount).toBe('3');
		expect(appShell(host).dataset.pendingPairCount).toBe('0');
		expect(textOf(host, 'pair-count-text')).toBe('3 complete pairs');
		expect(host.querySelector('[data-testid="pending-guidance"]')).toBeNull();

		// Cancel path: transient pending is dropped without touching complete.
		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview');
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="cancel-correspondence"]')?.click();
		await flush();
		expect(appShell(host).dataset.completePairCount).toBe('3');
		expect(appShell(host).dataset.pendingPairCount).toBe('0');

		// Delete a durable pair through the list.
		host.querySelector<HTMLButtonElement>('[data-testid="pair-delete-pair-2"]')?.click();
		await flush();
		expect(editor.state.controlPointPairs).toHaveLength(2);
		expect(appShell(host).dataset.completePairCount).toBe('2');

		// Undo restores the deleted pair; redo removes it again.
		host.querySelector<HTMLButtonElement>('[data-testid="undo"]')?.click();
		await flush();
		expect(editor.state.controlPointPairs).toHaveLength(3);
		expect(appShell(host).dataset.completePairCount).toBe('3');
		host.querySelector<HTMLButtonElement>('[data-testid="redo"]')?.click();
		await flush();
		expect(editor.state.controlPointPairs).toHaveLength(2);
		expect(appShell(host).dataset.completePairCount).toBe('2');

		unmount(component);
		host.remove();
	});

	it('drives readiness copy from the deterministic pair-count thresholds', async () => {
		const editor = makeEditor(1);
		editor.markSaved();
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();
		expect(textOf(host, 'readiness-text')).toBe(
			'A future similarity registration will need 2 complete pairs.'
		);

		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview');
		await flush();
		dispatchClick(host, 'target-basemap');
		await flush();
		expect(textOf(host, 'readiness-text')).toBe(
			'Enough complete pairs (2) for a future similarity registration.'
		);

		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview');
		await flush();
		dispatchClick(host, 'target-basemap');
		await flush();
		expect(textOf(host, 'readiness-text')).toBe(
			'Enough complete pairs (3) for a future affine registration.'
		);

		unmount(component);
		host.remove();
	});
});

describe('P0-012 warnings are non-mutating', () => {
	it('shows clustered and near-duplicate warnings that leave domain, history, and dirty state untouched', async () => {
		const editor = makeEditor(3, true);
		editor.markSaved();
		const baseline = JSON.stringify(editor.state);
		const baselineDirty = editor.isDirty;
		const baselineUndo = editor.canUndo;
		const baselineRedo = editor.canRedo;
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		const active = warnings(host);
		expect(active.some((warning) => warning.includes('coverage warning'))).toBe(true);
		expect(active.some((warning) => warning.includes('near-duplicate warning'))).toBe(true);

		// The diagnostics panel only derives; it never mutates anything.
		expect(JSON.stringify(editor.state)).toBe(baseline);
		expect(editor.isDirty).toBe(baselineDirty);
		expect(editor.canUndo).toBe(baselineUndo);
		expect(editor.canRedo).toBe(baselineRedo);

		// Warnings are non-blocking: creation, edit, save, and open all stay usable.
		expect((host.querySelector('[data-testid="add-correspondence"]') as HTMLButtonElement).disabled).toBe(false);
		expect((host.querySelector('[data-testid="pair-up-pair-2"]') as HTMLButtonElement).disabled).toBe(false);
		expect((host.querySelector('[data-testid="save-project"]') as HTMLButtonElement).disabled).toBe(false);
		expect((host.querySelector('[data-testid="open-project"]') as HTMLButtonElement).disabled).toBe(false);

		unmount(component);
		host.remove();
	});

	it('shows no warnings for distributed fixtures', async () => {
		const editor = makeEditor(3, false);
		editor.markSaved();
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		expect(warnings(host)).toEqual([]);

		unmount(component);
		host.remove();
	});

	it('keeps domain state unchanged while a pending half-pair is visible with guidance', async () => {
		const editor = makeEditor(2);
		editor.markSaved();
		const baseline = JSON.stringify(editor.state);
		const { component, host } = mountPage(editor);
		setGeometry(host, 'source-overview');
		setGeometry(host, 'target-basemap');
		await flush();

		host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]')?.click();
		await flush();
		dispatchClick(host, 'source-overview');
		await flush();

		const guidance = host.querySelector<HTMLElement>('[data-testid="pending-guidance"]');
		expect(guidance?.textContent).toContain('not saved yet');
		expect(guidance?.textContent).toContain('Escape');
		expect(JSON.stringify(editor.state)).toBe(baseline);
		expect(editor.isDirty).toBe(false);
		expect(editor.canUndo).toBe(false);

		unmount(component);
		host.remove();
	});
});
