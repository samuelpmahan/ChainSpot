// @vitest-environment jsdom

/**
 * A hole's own number-badge hit-test must not out-prioritize placement or
 * correction clicks meant for that same hole — see AnnotationWorkspace.svelte's
 * `claimAnnotationPointer`. Live testing on a real course image found the
 * badge's (deliberately generous, see docs/13-inch-pass.md) hit radius
 * silently swallowing a placement click near a hole's own badge, since a
 * badge often sits close to its own tee.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

// Course detection runs automatically the moment a source image loads (an
// $effect watching sourceImage(), not a button) — mocking this module is the
// only way to drive it deterministically without a real
// OffscreenCanvas/worker environment, matching this repo's stated jsdom
// canvas limitation (see README.md and courseRecognitionBanner.test.ts).
const { mockDetectCourseCandidates } = vi.hoisted(() => ({ mockDetectCourseCandidates: vi.fn() }));
vi.mock('$lib/autoAnnotation/basketDetection', () => ({
	detectCourseCandidates: mockDetectCourseCandidates,
	detectBasketCandidates: vi.fn(),
	detectTees: vi.fn(),
	prewarmBasketDetection: vi.fn().mockResolvedValue(undefined)
}));

if (typeof globalThis.Worker === 'undefined') {
	(globalThis as { Worker?: unknown }).Worker = class {};
}

import AnnotationWorkspace from '../../src/lib/components/AnnotationWorkspace.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';

const NOW = () => new Date('2026-08-16T00:00:00.000Z');

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
	const component = mount(AnnotationWorkspace, {
		target: host,
		props: { mode: 'map', sessionKey: 'annotate-course', editor, decode }
	});
	return { editor, component, host };
}

function scene(host: HTMLElement): HTMLElement {
	const element = host.querySelector<HTMLElement>('[data-testid="pane-scene-source-overview"]');
	if (!element) throw new Error('missing source-overview scene');
	return element;
}

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

function dispatchClick(host: HTMLElement, x: number, y: number, pointerId = 51): void {
	const element = scene(host);
	element.dispatchEvent(
		new PointerEvent('pointerdown', { button: 0, pointerId, clientX: x, clientY: y, bubbles: true })
	);
	window.dispatchEvent(new PointerEvent('pointerup', { pointerId, clientX: x, clientY: y }));
}

function view(host: HTMLElement): { zoom: number; panX: number; panY: number } {
	const dataset = scene(host).dataset;
	return { zoom: Number(dataset.viewZoom), panX: Number(dataset.viewPanX), panY: Number(dataset.viewPanY) };
}

function screenPointFor(host: HTMLElement, imageX: number, imageY: number): { x: number; y: number } {
	const { zoom, panX, panY } = view(host);
	return { x: imageX * zoom + panX, y: imageY * zoom + panY };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 16; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function loadImage(host: HTMLElement): Promise<void> {
	setGeometry(host);
	const input = host.querySelector<HTMLInputElement>('[data-testid="pane-input-source-overview"]');
	if (!input) throw new Error('missing source input');
	Object.defineProperty(input, 'files', {
		configurable: true,
		value: [new File([new Uint8Array([1, 2, 3, 4])], 'course.png', { type: 'image/png' })]
	});
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await flush();
}

function sidebarHoleButton(host: HTMLElement, number: number): HTMLButtonElement {
	const button = host.querySelector<HTMLButtonElement>(`[data-testid="sidebar-hole-${number}"]`);
	if (!button) throw new Error(`missing sidebar-hole-${number}`);
	return button;
}

function badgeHole(number: number, xPx: number, yPx: number, candidateIndex: number) {
	return {
		number,
		numberBadge: { candidateIndex, xPx, yPx, confidence: 0.9, cost: 0 },
		confidence: 0.9,
		status: 'incomplete' as const,
		failures: []
	};
}

let mounted: Mounted | null = null;
afterEach(() => {
	if (mounted) {
		unmount(mounted.component);
		mounted.host.remove();
	}
	mounted = null;
	mockDetectCourseCandidates.mockClear();
});

describe("a hole's own number badge does not out-prioritize placement on that hole", () => {
	it("clicking near the active hole's own badge places the tee, not a no-op re-select", async () => {
		mockDetectCourseCandidates.mockResolvedValue({
			numberDetection: { candidates: [{ label: 1, xPx: 40, yPx: 40, widthPx: 12, heightPx: 12 }] },
			tees: [],
			baskets: [],
			grammar: {
				holes: [badgeHole(1, 40, 40, 0)],
				failures: [],
				unassigned: { numberBadgeCandidateIndexes: [], teeCandidateIndexes: [], basketCandidateIndexes: [] }
			}
		});

		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);
		await flush();

		sidebarHoleButton(host, 1).click();
		await flush();

		// Click right at the badge's own position -- close enough that, before
		// this fix, numberCandidateHitAt's generous radius claimed it as a
		// (no-op) re-select of the already-active hole 1, instead of placing
		// the tee.
		const at = screenPointFor(host, 40, 40);
		dispatchClick(host, at.x, at.y);
		await flush();

		expect(host.querySelector('[data-testid="tee-marker-1"]')).not.toBeNull();
	});

	it("clicking a different hole's badge still selects it (cross-hole selection is unaffected)", async () => {
		mockDetectCourseCandidates.mockResolvedValue({
			numberDetection: {
				candidates: [
					{ label: 1, xPx: 40, yPx: 40, widthPx: 12, heightPx: 12 },
					{ label: 2, xPx: 160, yPx: 160, widthPx: 12, heightPx: 12 }
				]
			},
			tees: [],
			baskets: [],
			grammar: {
				holes: [badgeHole(1, 40, 40, 0), badgeHole(2, 160, 160, 1)],
				failures: [],
				unassigned: { numberBadgeCandidateIndexes: [], teeCandidateIndexes: [], basketCandidateIndexes: [] }
			}
		});

		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(200, 200));
		mounted = { editor, component, host };
		await loadImage(host);
		await flush();

		sidebarHoleButton(host, 1).click();
		await flush();

		const at = screenPointFor(host, 160, 160);
		dispatchClick(host, at.x, at.y);
		await flush();

		expect(host.querySelector('[data-testid="placement-banner"]')?.textContent).toContain('Hole 2');
		expect(host.querySelector('[data-testid="tee-marker-2"]')).toBeNull();
	});
});
