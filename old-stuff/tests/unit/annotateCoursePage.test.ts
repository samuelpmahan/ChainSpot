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

import AnnotationWorkspace from '../../src/lib/components/AnnotationWorkspace.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import {
	consumePendingAnnotatedRound,
	getPendingAnnotatedRound,
	setPendingHandoff
} from '../../src/lib/session';
import { annotationNavState, requestAnnotationDone } from '../../src/lib/annotationNav.svelte';

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

/** Mounts the shared workspace with `mode="map"` — this file exercises the Annotate Course route. */
function mountPage(editor: ProjectEditor, decode: DecodeImageFile): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(AnnotationWorkspace, {
		target: host,
		props: { mode: 'map', sessionKey: 'annotate-course', editor, decode }
	});
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

describe('Annotate Course Done gate and handoff', () => {
	it('gates Done on a loaded source image and, on click, writes an AnnotatedRound carrying that image into the pending session slot', async () => {
		// The "Done" control itself lives in the shared app header
		// (+layout.svelte), not in this component — the header drives it
		// through annotationNav.svelte's request/callback indirection, so this
		// test does the same rather than reaching for a nonexistent in-component
		// button (see annotationNav.svelte.ts).
		const editor = makeEditor();
		const decode = decodeOf(640, 480);
		const { component, host } = mountPage(editor, decode);
		await flush();

		expect(annotationNavState.canFinish).toBe(false);
		expect(getPendingAnnotatedRound()).toBeNull();

		const fileInput = inputEl(host, 'pane-input-source-overview');
		setFileInput(
			fileInput,
			new File([new Uint8Array([1, 2, 3, 4])], 'udisc-course.png', { type: 'image/png' })
		);
		await flush();

		expect(annotationNavState.canFinish).toBe(true);

		requestAnnotationDone();
		await flush();

		expect(mockGoto).toHaveBeenCalledWith('/create-graphics');
		const pending = getPendingAnnotatedRound();
		expect(pending).not.toBeNull();
		expect(pending?.sourceImage.fileName).toBe('udisc-course.png');
		expect(pending?.sourceImage.mimeType).toBe('image/png');
		expect(pending?.sourceImage.widthPx).toBe(640);
		expect(pending?.sourceImage.heightPx).toBe(480);
		expect(pending?.holes).toEqual([]);
		expect(pending?.walkingPath).toBeUndefined();

		unmount(component);
		host.remove();
	});
});

describe('Annotate Course pending-handoff destination filtering', () => {
	// Both Annotate Course and Map Round accept a 'source-overview'-role image
	// (see `PendingHandoffDestination` in `$lib/session.ts`), so the handoff's
	// `destination` field — not the role — is what decides which route's banner
	// claims it. This is the load-bearing mechanism behind the route split: two
	// real destinations sharing one image role must never cross-claim.
	//
	// Reading the module-level pending-handoff slot is gated on
	// `participatesInSession`, which stays false whenever an editor is
	// injected (see `mountPage` above) — exactly to keep other tests in this
	// file from observing session leakage. These two tests need the real
	// slot, so they mount without an injected editor instead, following the
	// same pattern as `annotatedRoundReceipt.test.ts`'s `mountPage`.
	function mountForHandoff(decode: DecodeImageFile): { component: ReturnType<typeof mount>; host: HTMLDivElement } {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const component = mount(AnnotationWorkspace, {
			target: host,
			props: { mode: 'map', sessionKey: 'annotate-course', decode }
		});
		return { component, host };
	}

	afterEach(() => {
		document.body.replaceChildren();
	});

	it('ignores a pending handoff destined for Map Round — no banner, no auto-import', async () => {
		setPendingHandoff({
			blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
			fileName: 'round.png',
			targetRole: 'source-overview',
			destination: 'map-round'
		});
		const { component, host } = mountForHandoff(decodeOf(200, 200));
		await flush();

		expect(host.querySelector('[data-testid="pending-handoff"]')).toBeNull();
		expect(host.querySelector('[data-testid="pane-filename-source-overview"]')).toBeNull();

		unmount(component);
	});

	it('auto-imports a pending handoff destined for Annotate Course (safe arrival: no image, no holes yet)', async () => {
		setPendingHandoff({
			blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
			fileName: 'course.png',
			targetRole: 'source-overview',
			destination: 'annotate-course'
		});
		const { component, host } = mountForHandoff(decodeOf(200, 200));
		await flush();

		// A safe (empty-editor) arrival auto-imports without ever showing the
		// banner — see `canAutoImportHandoffSafely`.
		expect(host.querySelector('[data-testid="pending-handoff"]')).toBeNull();
		expect(host.querySelector('[data-testid="pane-filename-source-overview"]')?.textContent).toContain(
			'course.png'
		);

		unmount(component);
	});
});
