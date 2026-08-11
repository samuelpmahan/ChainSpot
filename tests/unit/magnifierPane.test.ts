// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import {
	createControlPointPair,
	createImageAsset,
	createProjectState
} from '../../src/lib/domain/project';
import ImagePane from '../../src/lib/components/ImagePane.svelte';
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
	createPaneScene: () => sceneMock,
	// The real marker-visual helpers stay available to the component.
	...vi.importActual('../../src/lib/scene')
}));

function makeEditor(): ProjectEditor {
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
		fileName: 'target.png',
		mimeType: 'image/png',
		widthPx: 100,
		heightPx: 80
	});
	const pair = createControlPointPair({
		id: 'pair-1',
		ordinal: 1,
		sourceImage: source,
		targetImage: target,
		sourceCoordinates: { xPx: 20, yPx: 30 },
		targetCoordinates: { xPx: 40, yPx: 50 },
		now: NOW
	});
	return new ProjectEditor({
		state: { ...base, images: [source, target], controlPointPairs: [pair] },
		assets: new Map([
			['source-1', { bytes: new Uint8Array([1]), decoded: document.createElement('img') }],
			['target-1', { bytes: new Uint8Array([2]), decoded: document.createElement('img') }]
		]),
		now: NOW
	});
}

async function flush(): Promise<void> {
	for (let i = 0; i < 10; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function setPaneGeometry(scene: HTMLElement): void {
	Object.defineProperties(scene, {
		clientWidth: { configurable: true, value: 100 },
		clientHeight: { configurable: true, value: 80 },
		clientLeft: { configurable: true, value: 0 },
		clientTop: { configurable: true, value: 0 }
	});
	scene.getBoundingClientRect = () =>
		({ left: 0, top: 0, width: 100, height: 80, right: 100, bottom: 80 } as DOMRect);
}

function magnifierFor(host: HTMLElement): HTMLCanvasElement {
	const canvas = host.querySelector<HTMLCanvasElement>('[data-testid="pane-magnifier-source-overview"]');
	if (!canvas) throw new Error('missing magnifier canvas');
	return canvas;
}

function anchorOf(canvas: HTMLCanvasElement): { xPx: string; yPx: string; visible: boolean } {
	return {
		xPx: canvas.dataset.magnifierAnchorX ?? '',
		yPx: canvas.dataset.magnifierAnchorY ?? '',
		visible: canvas.style.display !== 'none'
	};
}

afterEach(() => {
	vi.clearAllMocks();
	document.body.replaceChildren();
});

describe('P0-012 magnifier pane integration', () => {
	it('follows the pointer while placing and is purely transient', async () => {
		const editor = makeEditor();
		const host = document.createElement('div');
		document.body.appendChild(host);
		const component = mount(ImagePane, {
			target: host,
			props: {
				title: 'Source',
				role: 'source-overview',
				editor,
				refresh: 0,
				pairs: editor.state.controlPointPairs,
				placementEnabled: true,
				correctionEnabled: false
			}
		});
		const scene = host.querySelector<HTMLElement>('[data-testid="pane-scene-source-overview"]');
		if (!scene) throw new Error('missing source pane scene');
		setPaneGeometry(scene);
		await flush();

		const baseline = JSON.stringify(editor.state);
		const baselineDirty = editor.isDirty;
		const baselineUndo = editor.canUndo;
		const baselineRedo = editor.canRedo;

		// Fit is zoom 1 for the 100x80 image in a 100x80 pane, so image == screen.
		scene.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 40, bubbles: true }));
		await flush();

		const canvas = magnifierFor(host);
		const anchor = anchorOf(canvas);
		expect(anchor.visible).toBe(true);
		expect(anchor.xPx).toBe('50');
		expect(anchor.yPx).toBe('40');
		// The sampling math is surfaced for the known fixture geometry.
		expect(canvas.dataset.magnifierSourceWidth).toBeTruthy();
		expect(Number(canvas.dataset.magnifierAnchorX)).toBe(50);

		// The magnifier is display-only: no domain, history, or dirty mutation.
		expect(JSON.stringify(editor.state)).toBe(baseline);
		expect(editor.isDirty).toBe(baselineDirty);
		expect(editor.canUndo).toBe(baselineUndo);
		expect(editor.canRedo).toBe(baselineRedo);

		// Leaving the pane hides the transient preview.
		scene.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
		await flush();
		expect(anchorOf(magnifierFor(host)).visible).toBe(false);

		unmount(component);
		host.remove();
	});

	it('anchors the magnifier on the selected marker in correction mode', async () => {
		const editor = makeEditor();
		const host = document.createElement('div');
		document.body.appendChild(host);
		const component = mount(ImagePane, {
			target: host,
			props: {
				title: 'Source',
				role: 'source-overview',
				editor,
				refresh: 0,
				pairs: editor.state.controlPointPairs,
				placementEnabled: false,
				correctionEnabled: true,
				selection: { pairId: 'pair-1', side: 'source' }
			}
		});
		const scene = host.querySelector<HTMLElement>('[data-testid="pane-scene-source-overview"]');
		if (!scene) throw new Error('missing source pane scene');
		setPaneGeometry(scene);
		await flush();

		const anchor = anchorOf(magnifierFor(host));
		expect(anchor.visible).toBe(true);
		expect(anchor.xPx).toBe('20');
		expect(anchor.yPx).toBe('30');

		unmount(component);
		host.remove();
	});

	it('stays hidden in correction mode without a selection', async () => {
		const editor = makeEditor();
		const host = document.createElement('div');
		document.body.appendChild(host);
		const component = mount(ImagePane, {
			target: host,
			props: {
				title: 'Source',
				role: 'source-overview',
				editor,
				refresh: 0,
				pairs: editor.state.controlPointPairs,
				placementEnabled: false,
				correctionEnabled: true
			}
		});
		const scene = host.querySelector<HTMLElement>('[data-testid="pane-scene-source-overview"]');
		if (!scene) throw new Error('missing source pane scene');
		setPaneGeometry(scene);
		await flush();

		expect(anchorOf(magnifierFor(host)).visible).toBe(false);

		unmount(component);
		host.remove();
	});

	it('follows an in-progress marker drag before the release commits', async () => {
		const editor = makeEditor();
		const host = document.createElement('div');
		document.body.appendChild(host);
		const onPointMove = vi.fn(() => ({ ok: true as const }));
		const component = mount(ImagePane, {
			target: host,
			props: {
				title: 'Source',
				role: 'source-overview',
				editor,
				refresh: 0,
				pairs: editor.state.controlPointPairs,
				placementEnabled: false,
				correctionEnabled: true,
				onPointMove
			}
		});
		const scene = host.querySelector<HTMLElement>('[data-testid="pane-scene-source-overview"]');
		if (!scene) throw new Error('missing source pane scene');
		setPaneGeometry(scene);
		await flush();

		sceneMock.markerHitAt.mockReturnValue({ pairId: 'pair-1', side: 'source', kind: 'complete' });
		const baseline = JSON.stringify(editor.state);

		scene.dispatchEvent(
			new PointerEvent('pointerdown', { button: 0, pointerId: 23, clientX: 20, clientY: 30, bubbles: true })
		);
		window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 23, clientX: 35, clientY: 45 }));
		await flush();

		// The preview anchor is the transient drag position, not the stored point.
		const anchor = anchorOf(magnifierFor(host));
		expect(anchor.visible).toBe(true);
		expect(anchor.xPx).toBe('35');
		expect(anchor.yPx).toBe('45');
		expect(JSON.stringify(editor.state)).toBe(baseline);
		expect(editor.canUndo).toBe(false);

		window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 23, clientX: 35, clientY: 45 }));
		await flush();
		expect(onPointMove).toHaveBeenCalledTimes(1);

		unmount(component);
		host.remove();
	});
});
