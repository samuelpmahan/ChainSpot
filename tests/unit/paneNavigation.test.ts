import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { createImageAsset, createProjectState } from '../../src/lib/domain/project';
import { ProjectEditor } from '../../src/lib/domain/editor';
import {
	PINCH_GAIN,
	defaultFitTransform,
	resizeViewTransform,
	wheelZoomFactor
} from '../../src/lib/navigation';
import { screenToImage } from '../../src/lib/coords';
import { intakeImageFile } from '../../src/lib/imageIntake';
import Page from '../../src/routes/create-graphics/+page.svelte';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import type { ViewTransformState } from '../../src/lib/coords';

const NOW = () => new Date('2026-08-02T00:00:00.000Z');

let counter = 0;
const nextId = (): string => `nav-${++counter}`;

type Role = 'source-overview' | 'target-basemap';

function makeEditor(): ProjectEditor {
	const state = createProjectState({ createId: () => 'project-1', now: NOW });
	return new ProjectEditor({ state, createId: nextId, now: NOW });
}

function fileOf(name: string, type: string, size = 8): File {
	return new File([new Uint8Array(size).fill(1)], name, { type });
}

/** Decodes to a real jsdom Image element so the pane treats it as a decoded asset. */
function decodeOf(widthPx: number, heightPx: number): DecodeImageFile {
	return async () => {
		const image = document.createElement('img');
		return { image, widthPx, heightPx };
	};
}

interface Mounted {
	editor: ProjectEditor;
	component: ReturnType<typeof mount>;
	host: HTMLDivElement;
}

function mountPage(editor: ProjectEditor, decode: DecodeImageFile): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(Page, {
		target: host,
		props: { editor, decode }
	});
	return { editor, component, host };
}

function setFileInput(input: HTMLInputElement, file: File): void {
	Object.defineProperty(input, 'files', {
		value: [file],
		configurable: true
	});
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function flush(): Promise<void> {
	for (let i = 0; i < 12; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function inputFor(host: HTMLElement, role: Role): HTMLInputElement {
	const input = host.querySelector<HTMLInputElement>(`[data-testid="pane-input-${role}"]`);
	if (!input) throw new Error(`missing pane input for ${role}`);
	return input;
}

function sceneEl(host: HTMLElement, role: Role): HTMLElement {
	const el = host.querySelector<HTMLElement>(`[data-testid="pane-scene-${role}"]`);
	if (!el) throw new Error(`missing pane scene for ${role}`);
	return el;
}

function viewAttrs(host: HTMLElement, role: Role): ViewTransformState {
	const el = sceneEl(host, role);
	return {
		zoom: parseFloat(el.dataset.viewZoom ?? ''),
		panX: parseFloat(el.dataset.viewPanX ?? ''),
		panY: parseFloat(el.dataset.viewPanY ?? '')
	};
}

function expectTransformClose(actual: ViewTransformState, expected: ViewTransformState): void {
	expect(Math.abs(actual.zoom - expected.zoom)).toBeLessThanOrEqual(1e-9);
	expect(Math.abs(actual.panX - expected.panX)).toBeLessThanOrEqual(1e-9);
	expect(Math.abs(actual.panY - expected.panY)).toBeLessThanOrEqual(1e-9);
}

/**
 * Dispatches a wheel event on the given pane's scene element. Plain wheel (the
 * default) pans, matching a two-finger trackpad scroll; pass `ctrlKey: true` to
 * exercise the pinch-zoom path (macOS reports trackpad pinch, and Cmd+scroll, as
 * ctrl/meta+wheel).
 */
function dispatchWheel(
	host: HTMLElement,
	role: Role,
	deltaY: number,
	options: { deltaX?: number; ctrlKey?: boolean; metaKey?: boolean } = {}
): boolean {
	const event = new WheelEvent('wheel', {
		deltaX: options.deltaX ?? 0,
		deltaY,
		ctrlKey: options.ctrlKey ?? false,
		metaKey: options.metaKey ?? false,
		clientX: 40,
		clientY: 30,
		cancelable: true,
		bubbles: true
	});
	return sceneEl(host, role).dispatchEvent(event);
}

function startDrag(host: HTMLElement, role: Role, x: number, y: number): void {
	sceneEl(host, role).dispatchEvent(
		new PointerEvent('pointerdown', { button: 0, clientX: x, clientY: y, bubbles: true })
	);
}

function moveDrag(x: number, y: number): void {
	window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }));
}

function endDrag(x: number, y: number): void {
	window.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y }));
}

class FakeResizeObserver {
	static instances: FakeResizeObserver[] = [];
	readonly callback: ResizeObserverCallback;
	disconnected = false;

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		FakeResizeObserver.instances.push(this);
	}

	observe(): void {}

	unobserve(): void {}

	disconnect(): void {
		this.disconnected = true;
	}

	fire(width: number, height: number): void {
		this.callback(
			[{ contentRect: { width, height } } as unknown as ResizeObserverEntry],
			this
		);
	}
}

async function loadBoth(host: HTMLElement, decode: DecodeImageFile): Promise<void> {
	setFileInput(inputFor(host, 'source-overview'), fileOf('s.png', 'image/png'));
	await flush();
	setFileInput(inputFor(host, 'target-basemap'), fileOf('t.jpg', 'image/jpeg'));
	await flush();
}

beforeEach(() => {
	FakeResizeObserver.instances = [];
	vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('pane navigation controls', () => {
	it('shows per-pane Fit and Reset controls that return the pane to its default fit', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(2, 3));
		await flush();

		const sourceFit = host.querySelector<HTMLButtonElement>(
			'[data-testid="pane-fit-source-overview"]'
		);
		const sourceReset = host.querySelector<HTMLButtonElement>(
			'[data-testid="pane-reset-source-overview"]'
		);
		if (!sourceFit || !sourceReset) throw new Error('missing source nav controls');
		expect(sourceFit.disabled).toBe(true);
		expect(sourceReset.disabled).toBe(true);

		setFileInput(inputFor(host, 'source-overview'), fileOf('s.png', 'image/png'));
		await flush();
		expect(sourceFit.disabled).toBe(false);
		expect(sourceReset.disabled).toBe(false);

		// jsdom containers have no layout: default fit is computed for a 1x1 pane.
		const fit = defaultFitTransform(2, 3, 1, 1);
		expectTransformClose(viewAttrs(host, 'source-overview'), fit);

		const beforeZoom = viewAttrs(host, 'source-overview');
		// ctrl+wheel is the pinch-zoom gesture (macOS trackpad pinch, Cmd+scroll).
		const notCanceled = dispatchWheel(host, 'source-overview', -200, { ctrlKey: true });
		expect(notCanceled).toBe(false);
		await flush();
		const zoomed = viewAttrs(host, 'source-overview');
		expect(zoomed.zoom).toBeCloseTo(beforeZoom.zoom * wheelZoomFactor(-200 * PINCH_GAIN), 12);
		// Pointer invariance at (40, 30) in pane-local CSS pixels.
		expect(Math.abs((40 - zoomed.panX) / zoomed.zoom - (40 - beforeZoom.panX) / beforeZoom.zoom)).toBeLessThanOrEqual(1e-9);
		expect(Math.abs((30 - zoomed.panY) / zoomed.zoom - (30 - beforeZoom.panY) / beforeZoom.zoom)).toBeLessThanOrEqual(1e-9);

		sourceFit.click();
		await flush();
		expectTransformClose(viewAttrs(host, 'source-overview'), fit);

		dispatchWheel(host, 'source-overview', -200, { ctrlKey: true });
		await flush();
		sourceReset.click();
		await flush();
		expectTransformClose(viewAttrs(host, 'source-overview'), fit);
		unmount(component);
		host.remove();
	});

	it('keeps source and target navigation fully independent', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(2, 3));
		await loadBoth(host, decodeOf(2, 3));

		const targetBefore = viewAttrs(host, 'target-basemap');
		dispatchWheel(host, 'source-overview', -200, { ctrlKey: true });
		await flush();
		expectTransformClose(viewAttrs(host, 'target-basemap'), targetBefore);
		expect(viewAttrs(host, 'source-overview').zoom).not.toBeCloseTo(targetBefore.zoom, 12);

		const sourceBefore = viewAttrs(host, 'source-overview');
		startDrag(host, 'target-basemap', 50, 40);
		moveDrag(70, 46);
		endDrag(70, 46);
		await flush();
		expectTransformClose(viewAttrs(host, 'source-overview'), sourceBefore);
		const targetAfter = viewAttrs(host, 'target-basemap');
		expect(targetAfter.panX).toBeCloseTo(targetBefore.panX + 20, 9);
		expect(targetAfter.panY).toBeCloseTo(targetBefore.panY + 6, 9);
		unmount(component);
		host.remove();
	});

	it('applies CSS-pixel drag deltas from the drag start, one gesture at a time', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(2, 3));
		await loadBoth(host, decodeOf(2, 3));

		const before = viewAttrs(host, 'source-overview');
		startDrag(host, 'source-overview', 100, 100);
		moveDrag(110, 105);
		moveDrag(130, 108);
		endDrag(130, 108);
		await flush();
		const after = viewAttrs(host, 'source-overview');
		expect(after.panX).toBeCloseTo(before.panX + 30, 9);
		expect(after.panY).toBeCloseTo(before.panY + 8, 9);
		expect(after.zoom).toBe(before.zoom);
		unmount(component);
		host.remove();
	});
});

describe('navigation and domain refreshes', () => {
	it('survives unrelated domain refreshes such as project rename and its undo', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(2, 3));
		await loadBoth(host, decodeOf(2, 3));

		dispatchWheel(host, 'source-overview', -200, { ctrlKey: true });
		dispatchWheel(host, 'source-overview', -200, { ctrlKey: true });
		await flush();
		const sourceBefore = viewAttrs(host, 'source-overview');
		expect(sourceBefore.zoom).toBeGreaterThan(1);

		const nameInput = host.querySelector<HTMLInputElement>('[data-testid="project-name"]');
		if (!nameInput) throw new Error('missing project name input');
		nameInput.value = 'Sample Round';
		nameInput.dispatchEvent(new Event('change', { bubbles: true }));
		await flush();
		expectTransformClose(viewAttrs(host, 'source-overview'), sourceBefore);

		editor.undo();
		await (component as unknown as { refresh: () => void }).refresh();
		await flush();
		expectTransformClose(viewAttrs(host, 'source-overview'), sourceBefore);
		unmount(component);
		host.remove();
	});

	it('resets only the replaced pane to fit; the other pane keeps its view', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(2, 3));
		await loadBoth(host, decodeOf(2, 3));

		dispatchWheel(host, 'source-overview', -200, { ctrlKey: true });
		dispatchWheel(host, 'source-overview', -200, { ctrlKey: true });
		dispatchWheel(host, 'target-basemap', 200, { ctrlKey: true });
		dispatchWheel(host, 'target-basemap', 200, { ctrlKey: true });
		await flush();
		const targetBefore = viewAttrs(host, 'target-basemap');
		expect(viewAttrs(host, 'source-overview').zoom).not.toBeCloseTo(1 / 3, 12);

		setFileInput(inputFor(host, 'source-overview'), fileOf('s-v2.png', 'image/png'));
		await flush();

		expectTransformClose(viewAttrs(host, 'source-overview'), defaultFitTransform(2, 3, 1, 1));
		expectTransformClose(viewAttrs(host, 'target-basemap'), targetBefore);
		unmount(component);
		host.remove();
	});

	it('establishes default fit when the decoded resource arrives after the asset id', async () => {
		const asset = createImageAsset({
			id: 'img-source',
			role: 'source-overview',
			fileName: 's.png',
			mimeType: 'image/png',
			widthPx: 2,
			heightPx: 3
		});
		const state = createProjectState({ createId: () => 'project-1', now: NOW });
		state.images = [asset];
		const editor = new ProjectEditor({
			state,
			assets: new Map([['img-source', { bytes: new Uint8Array([1, 2, 3]), decoded: null }]])
		});
		const { component, host } = mountPage(editor, decodeOf(2, 3));
		await flush();

		// No decoded resource yet: no fit is established and nothing is cleared.
		expectTransformClose(viewAttrs(host, 'source-overview'), { zoom: 1, panX: 0, panY: 0 });

		editor.setDecodedResource('img-source', document.createElement('img'));
		await (component as unknown as { refresh: () => void }).refresh();
		await flush();
		expectTransformClose(viewAttrs(host, 'source-overview'), defaultFitTransform(2, 3, 1, 1));
		unmount(component);
		host.remove();
	});
});

describe('navigation never touches durable domain state', () => {
	it('leaves isDirty, history, and the whole domain state unchanged after pan/zoom/fit/reset/resize', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(2, 3));
		await loadBoth(host, decodeOf(2, 3));
		editor.markSaved();

		const baseline = {
			isDirty: editor.isDirty,
			canUndo: editor.canUndo,
			canRedo: editor.canRedo,
			stateJson: JSON.stringify(editor.state)
		};
		expect(baseline.isDirty).toBe(false);
		expect(editor.state.viewState).toBeNull();

		// Exercises both wheel branches: ctrl+wheel zoom and plain-wheel pan.
		dispatchWheel(host, 'source-overview', -200, { ctrlKey: true });
		startDrag(host, 'source-overview', 50, 40);
		moveDrag(90, 60);
		endDrag(90, 60);
		host
			.querySelector<HTMLButtonElement>('[data-testid="pane-fit-source-overview"]')
			?.click();
		host
			.querySelector<HTMLButtonElement>('[data-testid="pane-reset-source-overview"]')
			?.click();
		dispatchWheel(host, 'target-basemap', 200);
		const observer = FakeResizeObserver.instances[0];
		observer.fire(500, 300);
		await flush();

		expect(editor.isDirty).toBe(baseline.isDirty);
		expect(editor.canUndo).toBe(baseline.canUndo);
		expect(editor.canRedo).toBe(baseline.canRedo);
		expect(JSON.stringify(editor.state)).toBe(baseline.stateJson);
		expect(editor.state.viewState).toBeNull();
		unmount(component);
		host.remove();
	});
});

describe('resize behavior', () => {
	it('recomputes default fit on resize while at default fit', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(2, 3));
		await loadBoth(host, decodeOf(2, 3));

		const observer = FakeResizeObserver.instances[0];
		observer.fire(300, 200);
		await flush();

		expectTransformClose(
			viewAttrs(host, 'source-overview'),
			defaultFitTransform(2, 3, 300, 200)
		);
		unmount(component);
		host.remove();
	});

	it('uses captured old geometry when the first ResizeObserver callback reports a new size', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(2, 3));
		await loadBoth(host, decodeOf(2, 3));

		// Initial jsdom geometry is 1x1 and the image is fit to it. By the time a
		// real ResizeObserver callback runs, clientWidth already reflects the new
		// layout; the component must still remember that the prior fit used 1x1.
		const sourceScene = sceneEl(host, 'source-overview');
		Object.defineProperty(sourceScene, 'clientWidth', { configurable: true, value: 300 });
		Object.defineProperty(sourceScene, 'clientHeight', { configurable: true, value: 200 });
		FakeResizeObserver.instances[0].fire(300, 200);
		await flush();

		expectTransformClose(
			viewAttrs(host, 'source-overview'),
			defaultFitTransform(2, 3, 300, 200)
		);
		unmount(component);
		host.remove();
	});

	it('keeps zoom and the image point under the pane center when resizing from a custom view', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(2, 3));
		await loadBoth(host, decodeOf(2, 3));

		FakeResizeObserver.instances[0].fire(300, 200);
		await flush();
		dispatchWheel(host, 'source-overview', -200, { ctrlKey: true });
		await flush();
		const custom = viewAttrs(host, 'source-overview');
		expect(custom.zoom).not.toBeCloseTo(defaultFitTransform(2, 3, 300, 200).zoom, 12);

		FakeResizeObserver.instances[0].fire(400, 250);
		await flush();
		const resized = viewAttrs(host, 'source-overview');
		const expected = resizeViewTransform(custom, 2, 3, 300, 200, 400, 250);
		expectTransformClose(resized, expected);

		const anchor = screenToImage({ x: 150, y: 100 }, custom);
		const after = screenToImage({ x: 200, y: 125 }, resized);
		expect(Math.abs(after.xPx - anchor.xPx)).toBeLessThanOrEqual(1e-9);
		expect(Math.abs(after.yPx - anchor.yPx)).toBeLessThanOrEqual(1e-9);
		unmount(component);
		host.remove();
	});
});

describe('wheel page-scroll prevention', () => {
	it('prevents default only when an image is loaded and the gesture carries a nonzero delta', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(2, 3));
		await flush();

		// No image: wheel is not handled and must not be prevented.
		expect(dispatchWheel(host, 'source-overview', -200)).toBe(true);
		expectTransformClose(viewAttrs(host, 'source-overview'), { zoom: 1, panX: 0, panY: 0 });

		setFileInput(inputFor(host, 'source-overview'), fileOf('s.png', 'image/png'));
		await flush();

		// All-zero delta: not handled, not prevented.
		expect(dispatchWheel(host, 'source-overview', 0)).toBe(true);
		expectTransformClose(viewAttrs(host, 'source-overview'), defaultFitTransform(2, 3, 1, 1));

		// Plain wheel (no ctrl/meta): handled and prevented, and pans rather than zooms.
		expect(dispatchWheel(host, 'source-overview', -200)).toBe(false);
		await flush();
		const panned = viewAttrs(host, 'source-overview');
		const fit = defaultFitTransform(2, 3, 1, 1);
		expect(panned.zoom).toBe(fit.zoom);
		expect(panned.panY).toBeCloseTo(fit.panY + 200, 9);
		expect(panned.panX).toBeCloseTo(fit.panX, 9);

		// ctrl+wheel: handled, prevented, and zooms at the pointer instead of panning.
		const beforeZoom = viewAttrs(host, 'source-overview');
		expect(dispatchWheel(host, 'source-overview', -200, { ctrlKey: true })).toBe(false);
		await flush();
		expect(viewAttrs(host, 'source-overview').zoom).toBeCloseTo(
			beforeZoom.zoom * wheelZoomFactor(-200 * PINCH_GAIN),
			12
		);
		unmount(component);
		host.remove();
	});

	it('prevents default for a horizontal-only scroll, blocking the macOS back-swipe that would otherwise destroy the session', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(2, 3));
		await flush();
		setFileInput(inputFor(host, 'source-overview'), fileOf('s.png', 'image/png'));
		await flush();

		// deltaY === 0 with a nonzero deltaX is exactly the shape of the two-finger
		// horizontal swipe macOS interprets as browser history navigation when left
		// unhandled. It must now be consumed and panned, never left to bubble.
		const before = viewAttrs(host, 'source-overview');
		expect(dispatchWheel(host, 'source-overview', 0, { deltaX: 50 })).toBe(false);
		await flush();
		const after = viewAttrs(host, 'source-overview');
		expect(after.zoom).toBe(before.zoom);
		expect(after.panX).toBeCloseTo(before.panX - 50, 9);
		expect(after.panY).toBeCloseTo(before.panY, 9);
		unmount(component);
		host.remove();
	});
});

describe('resource lifecycle cleanup', () => {
	it('removes window drag listeners, container listeners, and disconnects the ResizeObserver on unmount', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(2, 3));
		await loadBoth(host, decodeOf(2, 3));

		startDrag(host, 'source-overview', 50, 40);
		moveDrag(60, 50);

		const windowRemoveSpy = vi.spyOn(window, 'removeEventListener');
		const sceneRemoveSpy = vi.spyOn(sceneEl(host, 'source-overview'), 'removeEventListener');

		unmount(component);

		const removedTypes = windowRemoveSpy.mock.calls.map((call) => call[0]);
		expect(removedTypes).toContain('pointermove');
		expect(removedTypes).toContain('pointerup');
		expect(removedTypes).toContain('pointercancel');

		const elementRemovedTypes = sceneRemoveSpy.mock.calls.map((call) => call[0]);
		expect(elementRemovedTypes).toContain('wheel');
		expect(elementRemovedTypes).toContain('pointerdown');

		expect(FakeResizeObserver.instances.length).toBeGreaterThan(0);
		for (const instance of FakeResizeObserver.instances) {
			expect(instance.disconnected).toBe(true);
		}

		// No listeners remain: a late window drag event must be a no-op, not an error.
		expect(() => window.dispatchEvent(new PointerEvent('pointermove', { clientX: 99, clientY: 99 }))).not.toThrow();
		host.remove();
	});
});
