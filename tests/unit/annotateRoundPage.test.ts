// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

// No existing unit test in this repo mounts a page that navigates, so there is
// no established pattern to follow for $app/navigation; this is the first.
// vi.mock is hoisted above every import (and above ordinary top-level const
// declarations), so the mock function itself must be created inside
// vi.hoisted() to be safely initialized before the factory runs.
const { mockGoto } = vi.hoisted(() => ({ mockGoto: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: mockGoto }));

import Page from '../../src/routes/annotate-round/+page.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import {
	consumePendingAnnotatedRound,
	getPendingAnnotatedRound
} from '../../src/lib/session';

const NOW = () => new Date('2026-08-06T00:00:00.000Z');

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

function inputEl(host: HTMLElement, testId: string): HTMLInputElement {
	const input = host.querySelector(`[data-testid="${testId}"]`);
	if (!input || !(input instanceof HTMLInputElement)) throw new Error(`missing input ${testId}`);
	return input;
}

function setFileInput(input: HTMLInputElement, file: File): void {
	Object.defineProperty(input, 'files', { value: [file], configurable: true });
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function flush(): Promise<void> {
	for (let i = 0; i < 16; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

afterEach(() => {
	document.body.replaceChildren();
	consumePendingAnnotatedRound();
	mockGoto.mockClear();
});

describe('Annotate Round Done gate and handoff', () => {
	it('gates Done on a loaded source image and, on click, writes an AnnotatedRound carrying that image into the pending session slot', async () => {
		const editor = makeEditor();
		const decode = decodeOf(640, 480);
		const { component, host } = mountPage(editor, decode);
		await flush();

		const doneButton = host.querySelector<HTMLButtonElement>('[data-testid="annotate-done"]');
		if (!doneButton) throw new Error('missing annotate-done button');
		expect(doneButton.disabled).toBe(true);
		expect(getPendingAnnotatedRound()).toBeNull();

		const fileInput = inputEl(host, 'pane-input-source-overview');
		setFileInput(
			fileInput,
			new File([new Uint8Array([1, 2, 3, 4])], 'udisc-round.png', { type: 'image/png' })
		);
		await flush();

		expect(doneButton.disabled).toBe(false);

		doneButton.click();
		await flush();

		expect(mockGoto).toHaveBeenCalledWith('/create-graphics');
		const pending = getPendingAnnotatedRound();
		expect(pending).not.toBeNull();
		expect(pending?.sourceImage.fileName).toBe('udisc-round.png');
		expect(pending?.sourceImage.mimeType).toBe('image/png');
		expect(pending?.sourceImage.widthPx).toBe(640);
		expect(pending?.sourceImage.heightPx).toBe(480);
		expect(pending?.holes).toEqual([]);
		expect(pending?.walkingPath).toBeUndefined();

		unmount(component);
		host.remove();
	});
});

describe('Annotate Round keyboard controls and visible labels', () => {
	it('keeps all standard hole tabs visible and adds post-18 holes with the plus control', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(640, 480));
		await flush();

		expect(host.querySelectorAll('[data-testid^="hole-select-"]')).toHaveLength(18);
		const plus = host.querySelector<HTMLButtonElement>('[data-testid="hole-add-beyond"]');
		if (!plus) throw new Error('missing post-18 hole control');
		expect(plus.getAttribute('aria-label')).toContain('beyond');
		plus.click();
		await flush();

		expect(host.querySelector('[data-testid="annotate-round"]')?.getAttribute('data-hole-count')).toBe('1');
		expect(host.querySelector('[data-testid="hole-bar"]')?.textContent).toContain('Hole 19');
		expect(host.querySelector<HTMLButtonElement>('[data-testid="hole-select-19"]')).not.toBeNull();

		unmount(component);
		host.remove();
	});

	it('uses visible labels and keyboard shortcuts for hole creation', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(640, 480));
		await flush();

		const addButton = host.querySelector<HTMLButtonElement>('[data-testid="hole-add"]');
		if (!addButton) throw new Error('missing hole-add button');
		expect(addButton.textContent).toContain('Add hole');
		expect(addButton.textContent).toContain('A');
		expect(addButton.textContent).toContain('N');
		expect(addButton.getAttribute('aria-keyshortcuts')).toBe('A N');
		for (const button of host.querySelectorAll('button')) {
			expect(button.textContent?.trim()).not.toBe('');
		}

		for (const [key, expectedCount] of [
			['a', '1'],
			['A', '2'],
			['n', '3'],
			['N', '4']
		] as const) {
			const addEvent = new KeyboardEvent('keydown', {
				key,
				bubbles: true,
				cancelable: true
			});
			window.dispatchEvent(addEvent);
			await flush();
			expect(addEvent.defaultPrevented).toBe(true);
			expect(host.querySelector('[data-testid="annotate-round"]')?.getAttribute('data-hole-count')).toBe(expectedCount);
		}

		const repeated = new KeyboardEvent('keydown', {
			key: 'n',
			repeat: true,
			bubbles: true,
			cancelable: true
		});
		window.dispatchEvent(repeated);
		await flush();
		expect(host.querySelector('[data-testid="annotate-round"]')?.getAttribute('data-hole-count')).toBe('4');

		const widthInput = inputEl(host, 'corridor-width');
		widthInput.focus();
		const inputEvent = new KeyboardEvent('keydown', {
			key: 'n',
			bubbles: true,
			cancelable: true
		});
		widthInput.dispatchEvent(inputEvent);
		await flush();
		expect(inputEvent.defaultPrevented).toBe(false);
		expect(host.querySelector('[data-testid="annotate-round"]')?.getAttribute('data-hole-count')).toBe('4');

		unmount(component);
		host.remove();
	});

	it('restores focus to a surviving hole or Add hole after removing a focused hole', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(640, 480));
		await flush();

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
		await flush();

		const removeSecond = host.querySelector<HTMLButtonElement>('[data-testid="hole-remove-2"]');
		if (!removeSecond) throw new Error('missing hole-remove-2 button');
		removeSecond.focus();
		removeSecond.click();
		await flush();
		expect(document.activeElement).toBe(
			host.querySelector('[data-testid="hole-select-1"]')
		);

		const removeFirst = host.querySelector<HTMLButtonElement>('[data-testid="hole-remove-1"]');
		if (!removeFirst) throw new Error('missing hole-remove-1 button');
		removeFirst.focus();
		removeFirst.click();
		await flush();
		expect(document.activeElement).toBe(host.querySelector('[data-testid="hole-add"]'));

		unmount(component);
		host.remove();
	});
});

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
	const pointerId = 41;
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

async function loadImage(host: HTMLElement): Promise<void> {
	const input = inputEl(host, 'pane-input-source-overview');
	setFileInput(input, new File([new Uint8Array([1, 2, 3, 4])], 'course.png', { type: 'image/png' }));
	await flush();
	setGeometry(host);
}

describe('Annotate Round mode toggle', () => {
	it('defaults to Map mode; switching to Round mode changes the actions an empty-space click offers', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await loadImage(host);

		const mapButton = host.querySelector<HTMLButtonElement>('[data-testid="annotation-mode-map"]');
		const roundButton = host.querySelector<HTMLButtonElement>('[data-testid="annotation-mode-round"]');
		if (!mapButton || !roundButton) throw new Error('missing mode toggle buttons');
		expect(mapButton.getAttribute('aria-pressed')).toBe('true');
		expect(roundButton.getAttribute('aria-pressed')).toBe('false');

		host.querySelector<HTMLButtonElement>('[data-testid="hole-add"]')?.click();
		await flush();

		const clickAt = screenPointFor(host, 50, 50);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		expect(host.querySelector('[data-testid="radial-action-tee"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-action-basket"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-action-bend"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-action-shot"]')).toBeNull();
		expect(host.querySelector('[data-testid="radial-action-walk"]')).toBeNull();
		// Dismiss via Escape before switching modes.
		host
			.querySelector('[data-testid="radial-menu"]')
			?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		await flush();
		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();

		roundButton.click();
		await flush();
		expect(roundButton.getAttribute('aria-pressed')).toBe('true');
		expect(mapButton.getAttribute('aria-pressed')).toBe('false');

		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		expect(host.querySelector('[data-testid="radial-action-tee"]')).toBeNull();
		expect(host.querySelector('[data-testid="radial-action-basket"]')).toBeNull();
		expect(host.querySelector('[data-testid="radial-action-bend"]')).toBeNull();
		expect(host.querySelector('[data-testid="radial-action-shot"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="radial-action-walk"]')).not.toBeNull();

		unmount(component);
		host.remove();
	});
});

describe('Annotate Round walking path', () => {
	it('in Round mode with no hole selected, an empty-space click offers only the walk action and places a walk vertex', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await loadImage(host);

		host.querySelector<HTMLButtonElement>('[data-testid="annotation-mode-round"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="hole-bar-current-label"]')?.textContent).toContain(
			'No hole selected'
		);

		const clickAt = screenPointFor(host, 40, 40);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();

		expect(host.querySelector('[data-testid="radial-action-shot"]')).toBeNull();
		expect(host.querySelector('[data-testid="radial-action-walk"]')).not.toBeNull();

		host.querySelector<HTMLButtonElement>('[data-testid="radial-action-walk"]')?.click();
		await flush();

		expect(host.querySelector('[data-testid="radial-menu"]')).toBeNull();
		expect(host.querySelector('[data-testid="walk-vertex-0"]')).not.toBeNull();

		unmount(component);
		host.remove();
	});

	it('Done includes walkingPath once at least one vertex was captured', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		await loadImage(host);

		host.querySelector<HTMLButtonElement>('[data-testid="annotation-mode-round"]')?.click();
		await flush();

		const clickAt = screenPointFor(host, 60, 60);
		dispatchClick(host, clickAt.x, clickAt.y);
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="radial-action-walk"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="walk-vertex-0"]')).not.toBeNull();

		host.querySelector<HTMLButtonElement>('[data-testid="annotate-done"]')?.click();
		await flush();

		const pending = getPendingAnnotatedRound();
		expect(pending?.walkingPath).toBeDefined();
		expect(pending?.walkingPath).toHaveLength(1);

		unmount(component);
		host.remove();
	});
});

describe('Annotate Round corridor width — applies to all holes', () => {
	it('changing the width control updates every hole, not just the active one', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(640, 480));
		await flush();

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
		await flush();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
		await flush();
		expect(host.querySelector('[data-testid="annotate-round"]')?.getAttribute('data-hole-count')).toBe('2');

		// Hole 2 is active (most recently added). Changing the width here must
		// carry over to hole 1 as well, per UDisc-parity: one width, every hole.
		const widthInput = inputEl(host, 'corridor-width');
		widthInput.value = '120';
		widthInput.dispatchEvent(new Event('change', { bubbles: true }));
		await flush();

		host.querySelector<HTMLButtonElement>('[data-testid="hole-select-1"]')?.click();
		await flush();
		expect(inputEl(host, 'corridor-width').value).toBe('120');

		host.querySelector<HTMLButtonElement>('[data-testid="hole-select-2"]')?.click();
		await flush();
		expect(inputEl(host, 'corridor-width').value).toBe('120');

		unmount(component);
		host.remove();
	});

	it('a newly added hole inherits the width currently in use, not the bare default', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(640, 480));
		await flush();

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
		await flush();

		const widthInput = inputEl(host, 'corridor-width');
		widthInput.value = '95';
		widthInput.dispatchEvent(new Event('change', { bubbles: true }));
		await flush();

		// Hole 2 is created after the width change, and must start life at 95
		// (the width in use) rather than the DEFAULT_CORRIDOR_WIDTH_PX fallback.
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
		await flush();
		expect(host.querySelector('[data-testid="annotate-round"]')?.getAttribute('data-hole-count')).toBe('2');
		expect(inputEl(host, 'corridor-width').value).toBe('95');

		unmount(component);
		host.remove();
	});
});
