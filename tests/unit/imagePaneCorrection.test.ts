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
});
