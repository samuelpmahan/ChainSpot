import { describe, expect, it } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { createProjectState } from '../../src/lib/domain/project';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { intakeImageFile } from '../../src/lib/imageIntake';
import Page from '../../src/routes/+page.svelte';
import type { DecodeImageFile, DecodedImage } from '../../src/lib/imageIntake';

const NOW = () => new Date('2026-08-02T00:00:00.000Z');

let counter = 0;
const nextId = (): string => `scene-${++counter}`;

function makeEditor(): ProjectEditor {
	const state = createProjectState({ createId: () => 'project-1', now: NOW });
	return new ProjectEditor({ state, createId: nextId, now: NOW });
}

function fileOf(name: string, type: string, size = 8): File {
	return new File([new Uint8Array(size).fill(1)], name, { type });
}

function decodeOf(widthPx: number, heightPx: number, fail = false): DecodeImageFile {
	return async () => {
		if (fail) throw new Error('simulated decode failure');
		return { image: { simulated: true } as unknown as HTMLImageElement, widthPx, heightPx };
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

function inputFor(host: HTMLElement, role: 'source-overview' | 'target-basemap'): HTMLInputElement {
	const input = host.querySelector<HTMLInputElement>(`[data-testid="pane-input-${role}"]`);
	if (!input) throw new Error(`missing pane input for ${role}`);
	return input;
}

function addCorrespondenceButton(host: HTMLElement): HTMLButtonElement {
	const button = host.querySelector<HTMLButtonElement>('[data-testid="add-correspondence"]');
	if (!button) throw new Error('missing add-correspondence button');
	return button;
}

describe('two-pane scene workspace', () => {
	it('gates Add correspondence until both images have loaded', async () => {
		const { editor, component, host } = mountPage(makeEditor(), decodeOf(2, 3));

		expect(addCorrespondenceButton(host).disabled).toBe(true);

		await tick();
		setFileInput(inputFor(host, 'source-overview'), fileOf('s.png', 'image/png'));
		await flush();
		expect(addCorrespondenceButton(host).disabled).toBe(true);

		setFileInput(inputFor(host, 'target-basemap'), fileOf('t.png', 'image/png'));
		await flush();
		expect(addCorrespondenceButton(host).disabled).toBe(false);

		expect(editor.state.images).toHaveLength(2);
		unmount(component);
		host.remove();
	});

	it('shows metadata after a source-only upload and leaves the target pane empty', async () => {
		const { editor, component, host } = mountPage(makeEditor(), decodeOf(2, 3));

		setFileInput(inputFor(host, 'source-overview'), fileOf('udisc-overview.png', 'image/png'));
		await flush();

		expect(host.querySelector('[data-testid="pane-filename-source-overview"]')?.textContent).toBe(
			'udisc-overview.png'
		);
		expect(host.querySelector('[data-testid="pane-dimensions-source-overview"]')?.textContent).toContain(
			'2 × 3'
		);
		expect(host.querySelector('[data-testid="pane-orientation-source-overview"]')?.textContent).toBe(
			'Portrait'
		);
		expect(host.querySelector('[data-testid="pane-status-source-overview"]')?.textContent).toBe(
			'Image loaded'
		);

		expect(host.querySelector('[data-testid="pane-empty-target-basemap"]')).toBeTruthy();
		expect(host.querySelector('[data-testid="pane-filename-target-basemap"]')).toBeNull();

		expect(editor.state.images).toHaveLength(1);
		expect(editor.state.images[0].role).toBe('source-overview');
		unmount(component);
		host.remove();
	});

	it('rejects an unsupported MIME type without clearing the other pane', async () => {
		const { editor, component, host } = mountPage(makeEditor(), decodeOf(2, 3));

		setFileInput(inputFor(host, 'source-overview'), fileOf('s.png', 'image/png'));
		await flush();

		setFileInput(inputFor(host, 'source-overview'), fileOf('notes.txt', 'text/plain'));
		await flush();

		expect(host.querySelector('[data-testid="pane-error-source-overview"]')?.textContent).toMatch(
			/Unsupported file type/
		);
		expect(host.querySelector('[data-testid="pane-filename-source-overview"]')?.textContent).toBe(
			's.png'
		);
		expect(host.querySelector('[data-testid="pane-empty-target-basemap"]')).toBeTruthy();
		expect(editor.state.images).toHaveLength(1);
		unmount(component);
		host.remove();
	});

	it('reports a decode failure for corrupt data', async () => {
		const { editor, component, host } = mountPage(makeEditor(), decodeOf(0, 0, true));

		setFileInput(inputFor(host, 'source-overview'), fileOf('broken.png', 'image/png'));
		await flush();

		expect(host.querySelector('[data-testid="pane-error-source-overview"]')?.textContent).toMatch(
			/Could not decode/
		);
		expect(host.querySelector('[data-testid="pane-empty-source-overview"]')).toBeTruthy();
		expect(editor.state.images).toEqual([]);
		expect(editor.canUndo).toBe(false);
		unmount(component);
		host.remove();
	});

	it('reports invalid decoded dimensions without mutating state', async () => {
		const { editor, component, host } = mountPage(makeEditor(), decodeOf(0, 3));

		setFileInput(inputFor(host, 'target-basemap'), fileOf('zero.png', 'image/png'));
		await flush();

		expect(host.querySelector('[data-testid="pane-error-target-basemap"]')?.textContent).toMatch(
			/invalid dimensions/
		);
		expect(editor.state.images).toEqual([]);
		expect(host.querySelector('[data-testid="pane-empty-source-overview"]')).toBeTruthy();
		unmount(component);
		host.remove();
	});

	it('shows a loading state while decoding is in progress', async () => {
		const { component, host } = mountPage(
			makeEditor(),
			() => new Promise<DecodedImage>(() => {})
		);

		setFileInput(inputFor(host, 'source-overview'), fileOf('slow.png', 'image/png'));
		await flush();

		expect(host.querySelector('[data-testid="pane-loading-source-overview"]')).toBeTruthy();
		expect(host.querySelector('[data-testid="pane-status-source-overview"]')?.textContent).toBe(
			'Loading image…'
		);
		expect(host.querySelector('[data-testid="pane-empty-source-overview"]')).toBeNull();
		unmount(component);
		host.remove();
	});

	it('marks the project dirty on rename and restores through domain undo', async () => {
		const editor = makeEditor();
		editor.markSaved();
		const { component, host } = mountPage(editor, decodeOf(2, 3));
		await flush();
		expect(host.querySelector('[data-testid="dirty-indicator"]')).toBeNull();

		const nameInput = host.querySelector<HTMLInputElement>('[data-testid="project-name"]');
		if (!nameInput) throw new Error('missing project name input');
		nameInput.value = 'Sample Round';
		nameInput.dispatchEvent(new Event('change', { bubbles: true }));
		await flush();

		expect(editor.state.project.name).toBe('Sample Round');
		expect(host.querySelector('[data-testid="dirty-indicator"]')?.textContent).toContain(
			'Unsaved changes'
		);
		expect(nameInput.value).toBe('Sample Round');

		editor.undo();
		await (component as unknown as { refresh: () => void }).refresh();
		await flush();
		expect(editor.state.project.name).toBe('Untitled Project');
		expect(host.querySelector('[data-testid="dirty-indicator"]')).toBeNull();
		expect(nameInput.value).toBe('Untitled Project');

		editor.redo();
		await (component as unknown as { refresh: () => void }).refresh();
		await flush();
		expect(editor.state.project.name).toBe('Sample Round');
		expect(nameInput.value).toBe('Sample Round');
		expect(host.querySelector('[data-testid="dirty-indicator"]')).toBeTruthy();
		unmount(component);
		host.remove();
	});

	it('asks for confirmation on a different-dimension replacement; cancel preserves image and points', async () => {
		const editor = makeEditor();
		await seedBothWithPair(editor);
		const { component, host } = mountPage(editor, decodeOf(4, 5));
		await flush();
		const pairId = editor.state.controlPointPairs[0].id;
		const oldSourceId = editor.state.images.find((image) => image.role === 'source-overview')?.id;

		setFileInput(inputFor(host, 'source-overview'), fileOf('s-wide.jpg', 'image/jpeg'));
		await flush();

		const dialog = host.querySelector('[data-testid="discard-confirmation"]');
		expect(dialog).toBeTruthy();
		expect(dialog?.textContent).toContain('1 correspondence point');

		const cancel = host.querySelector<HTMLButtonElement>('[data-testid="discard-confirm-cancel"]');
		cancel?.click();
		await flush();

		expect(host.querySelector('[data-testid="discard-confirmation"]')).toBeNull();
		expect(host.querySelector('[data-testid="pane-filename-source-overview"]')?.textContent).toBe(
			's.png'
		);
		expect(editor.state.images.find((image) => image.role === 'source-overview')?.id).toBe(
			oldSourceId
		);
		expect(editor.state.controlPointPairs.map((pair) => pair.id)).toEqual([pairId]);
		unmount(component);
		host.remove();
	});

	it('replaces the image and discards affected points after confirmation', async () => {
		const editor = makeEditor();
		await seedBothWithPair(editor);
		const { component, host } = mountPage(editor, decodeOf(4, 5));
		await flush();

		setFileInput(inputFor(host, 'source-overview'), fileOf('s-wide.jpg', 'image/jpeg'));
		await flush();
		expect(host.querySelector('[data-testid="discard-confirmation"]')).toBeTruthy();

		const accept = host.querySelector<HTMLButtonElement>('[data-testid="discard-confirm-accept"]');
		accept?.click();
		await flush();

		expect(host.querySelector('[data-testid="discard-confirmation"]')).toBeNull();
		expect(host.querySelector('[data-testid="pane-filename-source-overview"]')?.textContent).toBe(
			's-wide.jpg'
		);
		expect(editor.state.controlPointPairs).toEqual([]);
		expect(editor.state.images.find((image) => image.role === 'source-overview')?.widthPx).toBe(4);
		unmount(component);
		host.remove();
	});

	it('retains points without confirmation on a same-dimension replacement', async () => {
		const editor = makeEditor();
		await seedBothWithPair(editor);
		const { component, host } = mountPage(editor, decodeOf(2, 3));
		await flush();
		const pairId = editor.state.controlPointPairs[0].id;
		const oldSourceId = editor.state.images.find(
			(image) => image.role === 'source-overview'
		)?.id;

		setFileInput(inputFor(host, 'source-overview'), fileOf('s-v2.png', 'image/png'));
		await flush();

		expect(host.querySelector('[data-testid="discard-confirmation"]')).toBeNull();
		expect(host.querySelector('[data-testid="pane-filename-source-overview"]')?.textContent).toBe(
			's-v2.png'
		);
		const source = editor.state.images.find((image) => image.role === 'source-overview');
		expect(source?.id).not.toBe(oldSourceId);
		expect(editor.state.controlPointPairs).toHaveLength(1);
		expect(editor.state.controlPointPairs[0].id).toBe(pairId);
		expect(editor.state.controlPointPairs[0].source.imageId).toBe(source?.id);
		expect(editor.state.controlPointPairs[0].source.xPx).toBe(1);
		unmount(component);
		host.remove();
	});

	it('unmounts cleanly without leaking pane DOM', async () => {
		const editor = makeEditor();
		const { component, host } = mountPage(editor, decodeOf(2, 3));
		setFileInput(inputFor(host, 'source-overview'), fileOf('s.png', 'image/png'));
		await flush();
		expect(host.querySelector('[data-testid="pane-source-overview"]')).toBeTruthy();

		unmount(component);
		expect(host.querySelector('[data-testid="pane-source-overview"]')).toBeNull();
		expect(host.children.length).toBe(0);
		host.remove();
	});
});

async function seedBothWithPair(editor: ProjectEditor): Promise<void> {
	await editorInject(editor, 'source-overview', 's.png', 'image/png', 2, 3);
	await editorInject(editor, 'target-basemap', 't.png', 'image/png', 300, 400);
	editor.addPair({
		sourceCoordinates: { xPx: 1, yPx: 1 },
		targetCoordinates: { xPx: 10, yPx: 10 }
	});
}

async function editorInject(
	editor: ProjectEditor,
	role: 'source-overview' | 'target-basemap',
	name: string,
	mime: string,
	widthPx: number,
	heightPx: number
): Promise<void> {
	const result = await intakeImageFile({
		editor,
		role,
		file: fileOf(name, mime),
		decode: decodeOf(widthPx, heightPx),
		createAssetId: nextId
	});
	if (!result.ok) throw new Error('seed intake failed');
}
