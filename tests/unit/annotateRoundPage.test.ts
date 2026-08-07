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
} from '../../src/lib/annotatedRoundSession';

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
