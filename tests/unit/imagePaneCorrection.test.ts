import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import {
	createControlPointPair,
	createImageAsset,
	createProjectState
} from '../../src/lib/domain/project';
import ImagePane from '../../src/lib/components/ImagePane.svelte';

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
	markerHitAt: vi.fn(() => ({ pairId: 'pair-1', side: 'source', kind: 'complete' })),
	clearImage: vi.fn(),
	destroy: vi.fn()
}));

vi.mock('../../src/lib/scene', () => ({
	canvas2dAvailable: () => true,
	createPaneScene: () => sceneMock
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
		fileName: 'target.jpg',
		mimeType: 'image/jpeg',
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
	for (let i = 0; i < 8; i += 1) {
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

afterEach(() => {
	vi.clearAllMocks();
	document.body.replaceChildren();
});

describe('P0-008 ImagePane correction interaction', () => {
	it('keeps pointer previews out of the callback and commits once on release', async () => {
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
				correctionEnabled: true,
				onPointMove
			}
		});

		const scene = host.querySelector<HTMLElement>('[data-testid="pane-scene-source-overview"]');
		if (!scene) throw new Error('missing source pane scene');
		setPaneGeometry(scene);
		await flush();
		const baseline = JSON.stringify(editor.state);

		scene.dispatchEvent(
			new PointerEvent('pointerdown', {
				button: 0,
				pointerId: 23,
				clientX: 20,
				clientY: 30,
				bubbles: true
			})
		);
		window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 23, clientX: 27, clientY: 36 }));
		window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 23, clientX: 31, clientY: 39 }));
		window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 23, clientX: 35, clientY: 45 }));

		expect(onPointMove).not.toHaveBeenCalled();
		expect(JSON.stringify(editor.state)).toBe(baseline);
		expect(editor.canUndo).toBe(false);

		window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 23, clientX: 35, clientY: 45 }));

		expect(onPointMove).toHaveBeenCalledTimes(1);
		expect(onPointMove).toHaveBeenCalledWith({
			selection: { pairId: 'pair-1', side: 'source' },
			coordinates: { xPx: 35, yPx: 45 }
		});
		unmount(component);
	});

	it('never commits a marker drag that a second touch interrupts into a pinch (H1: onClaimedPointerCancel now wired)', async () => {
		// Distinct non-zero pointerIds and an explicit 'touch' pointerType are
		// required to reach ImageViewport's pinch branch at all: jsdom defaults
		// pointerType to '' and every other helper in this suite dispatches
		// pointerId 0, so this path was never exercised before.
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
				correctionEnabled: true,
				onPointMove
			}
		});

		const scene = host.querySelector<HTMLElement>('[data-testid="pane-scene-source-overview"]');
		if (!scene) throw new Error('missing source pane scene');
		setPaneGeometry(scene);
		await flush();
		const baseline = JSON.stringify(editor.state);

		// Start a marker drag with one finger.
		scene.dispatchEvent(
			new PointerEvent('pointerdown', {
				button: 0,
				pointerId: 11,
				pointerType: 'touch',
				clientX: 20,
				clientY: 30,
				bubbles: true
			})
		);
		window.dispatchEvent(
			new PointerEvent('pointermove', {
				pointerId: 11,
				pointerType: 'touch',
				clientX: 27,
				clientY: 36
			})
		);

		// A second finger lands inside the viewport: ImageViewport's pinch
		// branch takes over, cancelling the claimed marker drag via
		// onClaimedPointerCancel -> onMarkerCancel.
		scene.dispatchEvent(
			new PointerEvent('pointerdown', {
				button: 0,
				pointerId: 12,
				pointerType: 'touch',
				clientX: 90,
				clientY: 10,
				bubbles: true
			})
		);
		await flush();

		// The original finger keeps moving and lifts, as it would mid-pinch.
		// Pre-fix, ImagePane's own (still-attached) window listeners would see
		// this and commit a move computed against a transform the pinch had
		// already changed underneath it.
		window.dispatchEvent(
			new PointerEvent('pointermove', {
				pointerId: 11,
				pointerType: 'touch',
				clientX: 60,
				clientY: 65
			})
		);
		window.dispatchEvent(
			new PointerEvent('pointerup', { pointerId: 11, pointerType: 'touch', clientX: 60, clientY: 65 })
		);
		await flush();

		expect(onPointMove).not.toHaveBeenCalled();
		expect(JSON.stringify(editor.state)).toBe(baseline);
		expect(editor.canUndo).toBe(false);

		window.dispatchEvent(
			new PointerEvent('pointerup', { pointerId: 12, pointerType: 'touch', clientX: 90, clientY: 10 })
		);
		await flush();
		unmount(component);
	});

	it('an 8px touch drift on a marker stays a tap, not an accidental drag (pointer-type-aware click slop)', async () => {
		// Same threshold that governs ImageViewport's own click-vs-pan arbitration
		// also governs this claimed marker-drag gesture: at the old flat 4px slop
		// an 8px finger drift would have crossed the threshold and committed a
		// move; at the touch slop (10px) it must not.
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
				correctionEnabled: true,
				onPointMove
			}
		});

		const scene = host.querySelector<HTMLElement>('[data-testid="pane-scene-source-overview"]');
		if (!scene) throw new Error('missing source pane scene');
		setPaneGeometry(scene);
		await flush();

		scene.dispatchEvent(
			new PointerEvent('pointerdown', {
				button: 0,
				pointerId: 21,
				pointerType: 'touch',
				clientX: 20,
				clientY: 30,
				bubbles: true
			})
		);
		window.dispatchEvent(
			new PointerEvent('pointermove', {
				pointerId: 21,
				pointerType: 'touch',
				clientX: 28,
				clientY: 30 // 8px, under the 10px touch slop
			})
		);
		window.dispatchEvent(
			new PointerEvent('pointerup', { pointerId: 21, pointerType: 'touch', clientX: 28, clientY: 30 })
		);
		await flush();

		expect(onPointMove).not.toHaveBeenCalled();
		unmount(component);
	});

	it('an 11px touch drift on a marker does commit as a drag (past the touch slop)', async () => {
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
				correctionEnabled: true,
				onPointMove
			}
		});

		const scene = host.querySelector<HTMLElement>('[data-testid="pane-scene-source-overview"]');
		if (!scene) throw new Error('missing source pane scene');
		setPaneGeometry(scene);
		await flush();

		scene.dispatchEvent(
			new PointerEvent('pointerdown', {
				button: 0,
				pointerId: 22,
				pointerType: 'touch',
				clientX: 20,
				clientY: 30,
				bubbles: true
			})
		);
		window.dispatchEvent(
			new PointerEvent('pointermove', {
				pointerId: 22,
				pointerType: 'touch',
				clientX: 31,
				clientY: 30 // 11px, over the 10px touch slop
			})
		);
		window.dispatchEvent(
			new PointerEvent('pointerup', { pointerId: 22, pointerType: 'touch', clientX: 31, clientY: 30 })
		);
		await flush();

		expect(onPointMove).toHaveBeenCalledTimes(1);
		unmount(component);
	});
});
