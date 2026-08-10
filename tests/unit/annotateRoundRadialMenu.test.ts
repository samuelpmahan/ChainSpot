import { describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import Page from '../../src/routes/annotate-round/+page.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import { radialWedges } from '../../src/lib/radialMenu';

// Must match the RADIAL_HUB_RADIUS_PX / RADIAL_OUTER_RADIUS_PX constants in
// +page.svelte — there is no shared export, since they're page-local tuning.
const HUB_RADIUS_PX = 20;
const OUTER_RADIUS_PX = 62;

const NOW = () => new Date('2026-08-10T00:00:00.000Z');

function decodeOf(widthPx: number, heightPx: number): DecodeImageFile {
	return async () => ({ image: document.createElement('img'), widthPx, heightPx });
}

function makeEditor(): ProjectEditor {
	const state = createProjectState({ createId: () => 'project-1', now: NOW });
	return new ProjectEditor({ state, now: NOW });
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

function scene(host: HTMLElement): HTMLElement {
	const element = host.querySelector<HTMLElement>('[data-testid="pane-scene-source-overview"]');
	if (!element) throw new Error('missing source-overview scene');
	return element;
}

/** Places the scene's origin at (0,0) in viewport coordinates, one-to-one with clientX/Y. */
function setGeometry(host: HTMLElement): void {
	const element = scene(host);
	Object.defineProperties(element, {
		clientWidth: { configurable: true, value: 400 },
		clientHeight: { configurable: true, value: 400 },
		clientLeft: { configurable: true, value: 0 },
		clientTop: { configurable: true, value: 0 }
	});
	element.getBoundingClientRect = () =>
		({ left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400 }) as DOMRect;
}

function dispatchClick(host: HTMLElement, x: number, y: number): void {
	const element = scene(host);
	const pointerId = 31;
	element.dispatchEvent(
		new PointerEvent('pointerdown', { button: 0, pointerId, clientX: x, clientY: y, bubbles: true })
	);
	window.dispatchEvent(new PointerEvent('pointerup', { pointerId, clientX: x, clientY: y }));
}

function view(host: HTMLElement): { zoom: number; panX: number; panY: number } {
	const dataset = scene(host).dataset;
	return {
		zoom: Number(dataset.viewZoom),
		panX: Number(dataset.viewPanX),
		panY: Number(dataset.viewPanY)
	};
}

function screenPointFor(host: HTMLElement, imageX: number, imageY: number): { x: number; y: number } {
	const { zoom, panX, panY } = view(host);
	return { x: imageX * zoom + panX, y: imageY * zoom + panY };
}

/** Screen offset of a given wedge, relative to the menu's anchor point — independent of zoom by design. */
function wedgeOffset(actionCount: number, index: number): { dx: number; dy: number } {
	const layout = radialWedges(actionCount, { hubRadius: HUB_RADIUS_PX, outerRadius: OUTER_RADIUS_PX });
	const wedge = layout.wedges[index];
	return { dx: wedge.labelX, dy: wedge.labelY };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 16; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function setUpHoleWithImage(host: HTMLElement, editor: ProjectEditor): Promise<void> {
	const input = host.querySelector<HTMLInputElement>('[data-testid="pane-input-source-overview"]');
	if (!input) throw new Error('missing source input');
	Object.defineProperty(input, 'files', {
		configurable: true,
		value: [new File([new Uint8Array([1, 2, 3, 4])], 'course.png', { type: 'image/png' })]
	});
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await flush();
	setGeometry(host);
	void editor;

	host.querySelector<HTMLButtonElement>('[data-testid="hole-add"]')?.click();
	await flush();
}

describe('Annotate Round radial menu', () => {
	it('opens on an empty-space click with a wedge per point kind not yet on the hole, and places a tee', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await setUpHoleWithImage(host, editor);

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();

		const clickAt = screenPointFor(host, 50, 50);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-wedge-tee"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-wedge-basket"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-wedge-shot"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-wedge-bend"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).toBeNull();

		const teeOffset = wedgeOffset(4, 0);
		dispatchClick(host, clickAt.x + teeOffset.dx, clickAt.y + teeOffset.dy);
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();

		unmount(component);
		host.remove();
	});

	it('opens a delete-only menu on an existing marker and removes just that point', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await setUpHoleWithImage(host, editor);

		const clickAt = screenPointFor(host, 60, 60);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		const teeOffset = wedgeOffset(4, 0);
		dispatchClick(host, clickAt.x + teeOffset.dx, clickAt.y + teeOffset.dy);
		await flush();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();

		// Click directly on the placed tee (no drag) to open its delete menu.
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-wedge-delete"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-wedge-tee"]')).toBeNull();

		const deleteOffset = wedgeOffset(1, 0);
		dispatchClick(host, clickAt.x + deleteOffset.dx, clickAt.y + deleteOffset.dy);
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).toBeNull();

		unmount(component);
		host.remove();
	});

	it('dismisses without acting when the hub (cancel) is clicked', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await setUpHoleWithImage(host, editor);

		const clickAt = screenPointFor(host, 40, 40);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		expect(host.querySelector('[data-testid="radial-menu"]')).not.toBeNull();

		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();
		expect(host.querySelector('[data-testid="tee-marker-1"]')).toBeNull();
		expect(host.querySelector('[data-testid="basket-marker-1"]')).toBeNull();

		unmount(component);
		host.remove();
	});

	it('Escape dismisses an open menu without acting', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await setUpHoleWithImage(host, editor);

		const clickAt = screenPointFor(host, 70, 70);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		expect(host.querySelector('[data-testid="radial-menu"]')).not.toBeNull();

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();

		unmount(component);
		host.remove();
	});
});
