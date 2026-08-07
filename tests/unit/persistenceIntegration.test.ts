import { describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import { intakeImageFile, sha256Hex } from '../../src/lib/imageIntake';
import type { DecodeImageFile, HashBytes } from '../../src/lib/imageIntake';
import { createProjectBundle } from '../../src/lib/persistence';
import Page from '../../src/routes/create-graphics/+page.svelte';
import type { DownloadBlob } from '../../src/lib/persistence';

const NOW = () => new Date('2026-08-02T00:00:00.000Z');

let counter = 0;
const nextId = (): string => `int-${++counter}`;

const SRC = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const TGT = new Uint8Array([9, 8, 7, 6]);
const WIDE = new Uint8Array([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);

const DIMS: Record<string, { widthPx: number; heightPx: number }> = {
	'a.png': { widthPx: 2, heightPx: 3 },
	'b.jpg': { widthPx: 5, heightPx: 4 },
	'udisc.png': { widthPx: 2, heightPx: 3 },
	'map.jpg': { widthPx: 5, heightPx: 4 },
	'wide.png': { widthPx: 9, heightPx: 9 }
};

const decode: DecodeImageFile = async (file) => {
	const dims = DIMS[file.name];
	if (!dims) throw new Error(`no dims for ${file.name}`);
	return { image: { from: file.name } as unknown as HTMLImageElement, widthPx: dims.widthPx, heightPx: dims.heightPx };
};

function fileOf(name: string, mime: string, bytes: Uint8Array): File {
	return new File([new Uint8Array(bytes)], name, { type: mime });
}

async function seedEditor(opts: { sourceName?: string; targetName?: string; sourceBytes?: Uint8Array; targetBytes?: Uint8Array } = {}): Promise<ProjectEditor> {
	const editor = new ProjectEditor({
		state: createProjectState({ createId: () => 'project-1', now: NOW }),
		createId: nextId,
		now: NOW
	});
	const sourceName = opts.sourceName ?? 'a.png';
	const targetName = opts.targetName ?? 'b.jpg';
	const source = await intakeImageFile({
		editor,
		role: 'source-overview',
		file: fileOf(sourceName, 'image/png', opts.sourceBytes ?? SRC),
		decode,
		createAssetId: nextId,
		hash: sha256Hex
	});
	const target = await intakeImageFile({
		editor,
		role: 'target-basemap',
		file: fileOf(targetName, 'image/jpeg', opts.targetBytes ?? TGT),
		decode,
		createAssetId: nextId,
		hash: sha256Hex
	});
	if (!source.ok || !target.ok) throw new Error('seed failed');
	return editor;
}

interface Mounted {
	editor: ProjectEditor;
	component: ReturnType<typeof mount>;
	host: HTMLDivElement;
}

function mountPage(editor: ProjectEditor, download: DownloadBlob, hash: HashBytes = sha256Hex): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(Page, {
		target: host,
		props: { editor, decode, hash, download }
	});
	return { editor, component, host };
}

function el(host: HTMLElement, testId: string): HTMLElement | null {
	return host.querySelector(`[data-testid="${testId}"]`);
}

function inputEl(host: HTMLElement, testId: string): HTMLInputElement {
	const input = el(host, testId);
	if (!input || !(input instanceof HTMLInputElement)) throw new Error(`missing input ${testId}`);
	return input;
}

function setFileInput(input: HTMLInputElement, file: File): void {
	Object.defineProperty(input, 'files', {
		value: [file],
		configurable: true
	});
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function flush(): Promise<void> {
	for (let i = 0; i < 16; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function bundleFileFrom(editor: ProjectEditor, name = 'round.chainspot.zip'): Promise<File> {
	const created = await createProjectBundle(editor);
	expect(created.ok).toBe(true);
	if (!created.ok) throw new Error('bundle creation failed');
	return new File([new Uint8Array(created.bundle.zipBytes)], name, { type: 'application/zip' });
}

async function bundleWithOnlyProjectJson(editor: ProjectEditor, targetBytes: Uint8Array = TGT): Promise<File> {
	const created = await createProjectBundle(editor);
	if (!created.ok) throw new Error('bundle creation failed');
	const { project, images, controlPointPairs, viewState } = created.bundle.document;
	const doc = { schemaVersion: 1, project, images, controlPointPairs, viewState };
	return new File(
		[
			zipSync(
				{
					'project.json': strToU8(JSON.stringify(doc)),
					'images/target-original.jpg': targetBytes
				} as Record<string, Uint8Array>,
				{ level: 6 }
			)
		],
		'missing.chainspot.zip',
		{ type: 'application/zip' }
	);
}

describe('Save project (F)', () => {
	it('saves a .chainspot.zip, marks the checkpoint clean, and clears the dirty indicator', async () => {
		const editor = await seedEditor();
		editor.renameProject('My Round');
		const download = vi.fn();
		const { component, host } = mountPage(editor, download as unknown as DownloadBlob);
		await flush();
		expect(editor.isDirty).toBe(true);
		expect(el(host, 'dirty-indicator')).toBeTruthy();

		el(host, 'save-project')?.click();
		await flush();

		expect(download).toHaveBeenCalledTimes(1);
		const [blob, fileName] = download.mock.calls[0];
		expect(String(fileName)).toMatch(/My Round\.chainspot\.zip$/);
		expect(blob.type).toBe('application/zip');

		const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
		expect(Object.keys(entries).sort()).toEqual([
			'images/source-original.png',
			'images/target-original.jpg',
			'project.json'
		]);
		expect([...entries['images/source-original.png']]).toEqual([...SRC]);
		expect([...entries['images/target-original.jpg']]).toEqual([...TGT]);
		const manifest = JSON.parse(strFromU8(entries['project.json']));
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.images[0].sha256).toBe(await sha256Hex(SRC));
		expect(manifest.images[1].sha256).toBe(await sha256Hex(TGT));

		expect(editor.isDirty).toBe(false);
		expect(el(host, 'dirty-indicator')).toBeNull();
		expect(el(host, 'save-error')).toBeNull();
		unmount(component);
		host.remove();
	});

	it('a save failure keeps the project dirty and usable; a retry succeeds', async () => {
		const editor = await seedEditor();
		const download = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error('download blocked');
			})
			.mockImplementationOnce(() => undefined);
		const { component, host } = mountPage(editor, download as unknown as DownloadBlob);
		await flush();

		el(host, 'save-project')?.click();
		await flush();
		expect(el(host, 'save-error')).toBeTruthy();
		expect(el(host, 'save-error')?.textContent).toMatch(/download could not be started/);
		expect(editor.isDirty).toBe(true);
		expect(el(host, 'dirty-indicator')).toBeTruthy();
		expect(editor.canUndo).toBe(true);

		el(host, 'save-project')?.click();
		await flush();
		expect(download).toHaveBeenCalledTimes(2);
		expect(el(host, 'save-error')).toBeNull();
		expect(editor.isDirty).toBe(false);
		expect(el(host, 'dirty-indicator')).toBeNull();
		unmount(component);
		host.remove();
	});

	it('a project without both images fails save specifically without downloading', async () => {
		const editor = new ProjectEditor({
			state: createProjectState({ createId: () => 'project-1', now: NOW }),
			createId: nextId,
			now: NOW
		});
		await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('a.png', 'image/png', SRC),
			decode,
			createAssetId: nextId,
			hash: sha256Hex
		});
		const download = vi.fn();
		const { component, host } = mountPage(editor, download as unknown as DownloadBlob);
		await flush();

		el(host, 'save-project')?.click();
		await flush();

		expect(download).not.toHaveBeenCalled();
		expect(el(host, 'save-error')).toBeTruthy();
		expect(editor.isDirty).toBe(true);
		unmount(component);
		host.remove();
	});

	it('never marks a save checkpoint when the state changed during the async save; retry guidance is shown', async () => {
		const editor = await seedEditor();
		const downloads: Array<[Blob, string]> = [];
		const download = (blob: Blob, name: string) => downloads.push([blob, name]);
		let releaseFirstHash!: (hash: string) => void;
		const gate = new Promise<string>((resolve) => {
			releaseFirstHash = resolve;
		});
		let calls = 0;
		const deferredHash: HashBytes = async (bytes) => {
			calls += 1;
			if (calls === 1) return await gate;
			return sha256Hex(bytes);
		};

		const { component, host } = mountPage(editor, download as unknown as DownloadBlob, deferredHash);
		await flush();
		expect(editor.isDirty).toBe(true);

		// Start the save; its first image hash is deferred, so the archive is built from
		// the start snapshot while a live rename lands before hashing resolves.
		el(host, 'save-project')?.click();
		await flush();
		editor.renameProject('Newer Name');
		await tick();
		releaseFirstHash(await sha256Hex(SRC));
		await flush();

		expect(downloads).toHaveLength(1);
		const [blob, fileName] = downloads[0];
		// Filename and archive project name come from the start-of-save snapshot.
		expect(String(fileName)).toBe('Untitled Project.chainspot.zip');
		const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
		const manifest = JSON.parse(strFromU8(entries['project.json']));
		expect(manifest.project.name).toBe('Untitled Project');

		// The newer state was NOT checkpointed: the project stays dirty and the save
		// guidance tells the user the bundle holds the earlier state and to save again.
		expect(editor.state.project.name).toBe('Newer Name');
		expect(editor.isDirty).toBe(true);
		expect(el(host, 'dirty-indicator')).toBeTruthy();
		expect(el(host, 'save-error')).toBeTruthy();
		expect(el(host, 'save-error')?.textContent).toMatch(/changed while saving/);
		expect(el(host, 'save-error')?.textContent).toMatch(/save again/);

		// A normal retry succeeds and clears the guidance once the state matches.
		el(host, 'save-project')?.click();
		await flush();
		expect(downloads).toHaveLength(2);
		expect(editor.isDirty).toBe(false);
		expect(el(host, 'dirty-indicator')).toBeNull();
		expect(el(host, 'save-error')).toBeNull();
		expect(String(downloads[1][1])).toBe('Newer Name.chainspot.zip');
		unmount(component);
		host.remove();
	});

	it('a pending pair never saves silently: dialog can preserve or cancel-then-save', async () => {
		const editor = await seedEditor();
		const download = vi.fn();
		const { component, host } = mountPage(editor, download as unknown as DownloadBlob);
		await flush();

		el(host, 'add-correspondence')?.click();
		await flush();
		expect(el(host, 'app-shell')?.getAttribute('data-correspondence-mode')).toBe('add-source');

		const undoBefore = editor.canUndo;
		el(host, 'save-project')?.click();
		await flush();
		expect(el(host, 'pending-save-dialog')).toBeTruthy();
		expect(download).not.toHaveBeenCalled();

		el(host, 'pending-save-cancel')?.click();
		await flush();
		expect(el(host, 'pending-save-dialog')).toBeNull();
		expect(el(host, 'app-shell')?.getAttribute('data-correspondence-mode')).toBe('add-source');
		expect(download).not.toHaveBeenCalled();
		expect(editor.canUndo).toBe(undoBefore);

		el(host, 'save-project')?.click();
		await flush();
		expect(el(host, 'pending-save-dialog')).toBeTruthy();
		el(host, 'pending-save-proceed')?.click();
		await flush();

		expect(el(host, 'app-shell')?.getAttribute('data-correspondence-mode')).toBe('neutral');
		expect(download).toHaveBeenCalledTimes(1);
		expect(editor.canUndo).toBe(undoBefore);
		expect(editor.isDirty).toBe(false);
		expect(el(host, 'dirty-indicator')).toBeNull();
		unmount(component);
		host.remove();
	});
});

describe('Open project (F)', () => {
	it('opens a valid bundle atomically: fresh editor, clean checkpoint, empty undo/redo, restored panes and pairs', async () => {
		const source = await seedEditor({ sourceName: 'udisc.png', targetName: 'map.jpg' });
		source.renameProject('Sample Round');
		source.addPair({ sourceCoordinates: { xPx: 1, yPx: 1 }, targetCoordinates: { xPx: 2, yPx: 2 } });
		source.addPair({ sourceCoordinates: { xPx: 0, yPx: 0 }, targetCoordinates: { xPx: 4, yPx: 3 } });
		const bundle = await bundleFileFrom(source);

		const editor = await seedEditor();
		const original = editor;
		const { component, host } = mountPage(editor, vi.fn() as unknown as DownloadBlob);
		await flush();

		setFileInput(inputEl(host, 'open-project-input'), bundle);
		await flush();

		const next = (component as unknown as { getEditor: () => ProjectEditor }).getEditor();
		expect(next).not.toBe(original);
		expect(next.state.project.name).toBe('Sample Round');
		expect(next.state.controlPointPairs).toHaveLength(2);
		expect(next.state.controlPointPairs[0].source.xPx).toBe(1);
		expect(next.state.controlPointPairs[1].target.xPx).toBe(4);
		expect(next.state.images[0].fileName).toBe('udisc.png');
		expect(next.state.images[1].fileName).toBe('map.jpg');
		expect(next.isDirty).toBe(false);
		expect(next.canUndo).toBe(false);
		expect(next.canRedo).toBe(false);

		expect(el(host, 'dirty-indicator')).toBeNull();
		expect((el(host, 'undo') as HTMLButtonElement).disabled).toBe(true);
		expect((el(host, 'redo') as HTMLButtonElement).disabled).toBe(true);
		expect(el(host, 'pane-filename-source-overview')?.textContent).toBe('udisc.png');
		expect(el(host, 'pane-filename-target-basemap')?.textContent).toBe('map.jpg');
		expect(host.querySelectorAll('[data-testid="pair-row"]')).toHaveLength(2);
		expect(el(host, 'open-error')).toBeNull();
		unmount(component);
		host.remove();
	});

	it('a non-repair open failure leaves the live project, pending state, and dirty flag unchanged', async () => {
		const editor = await seedEditor();
		editor.addPair({ sourceCoordinates: { xPx: 1, yPx: 1 }, targetCoordinates: { xPx: 2, yPx: 2 } });
		const original = editor;
		const stateBefore = JSON.stringify(editor.state);
		const { component, host } = mountPage(editor, vi.fn() as unknown as DownloadBlob);
		await flush();

		el(host, 'add-correspondence')?.click();
		await flush();
		expect(el(host, 'app-shell')?.getAttribute('data-correspondence-mode')).toBe('add-source');

		setFileInput(inputEl(host, 'open-project-input'), new File([new Uint8Array([1, 2, 3])], 'bad.chainspot.zip', { type: 'application/zip' }));
		await flush();

		expect(el(host, 'open-error')).toBeTruthy();
		expect((component as unknown as { getEditor: () => ProjectEditor }).getEditor()).toBe(original);
		expect(JSON.stringify(original.state)).toBe(stateBefore);
		expect(el(host, 'app-shell')?.getAttribute('data-correspondence-mode')).toBe('add-source');
		expect(el(host, 'dirty-indicator')).toBeTruthy();
		expect(host.querySelectorAll('[data-testid="pair-row"]')).toHaveLength(1);
		unmount(component);
		host.remove();
	});

	it('opens a missing-image bundle into a repair state that cancel leaves untouched', async () => {
		const source = await seedEditor({ sourceName: 'udisc.png', targetName: 'map.jpg' });
		source.addPair({ sourceCoordinates: { xPx: 1, yPx: 1 }, targetCoordinates: { xPx: 2, yPx: 2 } });
		const bundle = await bundleWithOnlyProjectJson(source);

		const editor = await seedEditor();
		const original = editor;
		const { component, host } = mountPage(editor, vi.fn() as unknown as DownloadBlob);
		await flush();

		setFileInput(inputEl(host, 'open-project-input'), bundle);
		await flush();

		expect(el(host, 'repair-dialog')).toBeTruthy();
		expect(el(host, 'repair-dialog')?.textContent).toContain('Untitled Project');
		expect(el(host, 'repair-dialog')?.textContent).toContain('1 correspondence pair');
		expect(el(host, 'repair-issue')).toBeTruthy();
		expect(el(host, 'repair-issue')?.getAttribute('data-role')).toBe('source-overview');
		expect(el(host, 'repair-path-source-overview')?.textContent).toBe('images/source-original.png');
		expect(el(host, 'repair-hash-source-overview')?.textContent).toMatch(/^[0-9a-f]{64}$/);
		expect(el(host, 'repair-issue')?.textContent).toMatch(/Missing image/);

		el(host, 'repair-cancel')?.click();
		await flush();
		expect(el(host, 'repair-dialog')).toBeNull();
		expect((component as unknown as { getEditor: () => ProjectEditor }).getEditor()).toBe(original);
		expect(original.state.controlPointPairs).toHaveLength(0);
		unmount(component);
		host.remove();
	});

	it('resolves a missing image with an exact local file and opens atomically', async () => {
		const source = await seedEditor({ sourceName: 'udisc.png', targetName: 'map.jpg' });
		source.addPair({ sourceCoordinates: { xPx: 1, yPx: 1 }, targetCoordinates: { xPx: 2, yPx: 2 } });
		const bundle = await bundleWithOnlyProjectJson(source);

		const editor = await seedEditor();
		const original = editor;
		const { component, host } = mountPage(editor, vi.fn() as unknown as DownloadBlob);
		await flush();

		setFileInput(inputEl(host, 'open-project-input'), bundle);
		await flush();
		expect(el(host, 'repair-dialog')).toBeTruthy();

		setFileInput(inputEl(host, 'repair-input-source-overview'), fileOf('udisc.png', 'image/png', SRC));
		await flush();

		expect(el(host, 'repair-dialog')).toBeNull();
		const next = (component as unknown as { getEditor: () => ProjectEditor }).getEditor();
		expect(next).not.toBe(original);
		expect(next.state.controlPointPairs).toHaveLength(1);
		expect(next.state.controlPointPairs[0].source.xPx).toBe(1);
		expect(next.isDirty).toBe(false);
		expect(next.canUndo).toBe(false);
		unmount(component);
		host.remove();
	});

	it('a different-dimension repair replacement confirms discard; cancel preserves repair and accept completes', async () => {
		const source = await seedEditor({ sourceName: 'udisc.png', targetName: 'map.jpg' });
		source.addPair({ sourceCoordinates: { xPx: 1, yPx: 1 }, targetCoordinates: { xPx: 2, yPx: 2 } });
		const bundle = await bundleWithOnlyProjectJson(source);

		const editor = await seedEditor();
		const original = editor;
		const { component, host } = mountPage(editor, vi.fn() as unknown as DownloadBlob);
		await flush();

		setFileInput(inputEl(host, 'open-project-input'), bundle);
		await flush();
		expect(el(host, 'repair-dialog')).toBeTruthy();

		setFileInput(inputEl(host, 'repair-input-source-overview'), fileOf('wide.png', 'image/png', WIDE));
		await flush();
		expect(el(host, 'repair-discard-confirmation')).toBeTruthy();
		expect(el(host, 'repair-discard-confirmation')?.textContent).toContain('1 correspondence point');

		el(host, 'repair-discard-cancel')?.click();
		await flush();
		expect(el(host, 'repair-discard-confirmation')).toBeNull();
		expect(el(host, 'repair-dialog')).toBeTruthy();
		expect((component as unknown as { getEditor: () => ProjectEditor }).getEditor()).toBe(original);

		setFileInput(inputEl(host, 'repair-input-source-overview'), fileOf('wide.png', 'image/png', WIDE));
		await flush();
		expect(el(host, 'repair-discard-confirmation')).toBeTruthy();
		el(host, 'repair-discard-accept')?.click();
		await flush();

		expect(el(host, 'repair-dialog')).toBeNull();
		expect(el(host, 'repair-discard-confirmation')).toBeNull();
		const next = (component as unknown as { getEditor: () => ProjectEditor }).getEditor();
		expect(next).not.toBe(original);
		expect(next.state.controlPointPairs).toHaveLength(0);
		expect(next.state.images.find((image) => image.role === 'source-overview')?.widthPx).toBe(9);
		expect(next.isDirty).toBe(false);
		unmount(component);
		host.remove();
	});

	it('a hash-mismatch requires an explicit action and using the archived bytes replaces the image', async () => {
		const source = await seedEditor({ sourceName: 'udisc.png', targetName: 'map.jpg' });
		source.addPair({ sourceCoordinates: { xPx: 1, yPx: 1 }, targetCoordinates: { xPx: 2, yPx: 2 } });
		const created = await createProjectBundle(source);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const { project, images, controlPointPairs, viewState } = created.bundle.document;
		const doc = {
			schemaVersion: 1,
			project,
			images: images.map((image) =>
				image.role === 'source-overview' ? { ...image, sha256: 'b'.repeat(64) } : image
			),
			controlPointPairs,
			viewState
		};
		const bundle = new File(
			[zipSync(
				{
					'project.json': strToU8(JSON.stringify(doc)),
					'images/source-original.png': SRC,
					'images/target-original.jpg': TGT
				} as Record<string, Uint8Array>,
				{ level: 6 }
			)],
			'mismatch.chainspot.zip',
			{ type: 'application/zip' }
		);

		const editor = await seedEditor();
		const original = editor;
		const { component, host } = mountPage(editor, vi.fn() as unknown as DownloadBlob);
		await flush();

		setFileInput(inputEl(host, 'open-project-input'), bundle);
		await flush();
		expect(el(host, 'repair-dialog')).toBeTruthy();
		expect(el(host, 'repair-issue')?.textContent).toMatch(/Image hash mismatch/);
		expect(el(host, 'repair-archived-source-overview')).toBeTruthy();

		// The archive is never auto-accepted.
		expect((component as unknown as { getEditor: () => ProjectEditor }).getEditor()).toBe(original);

		el(host, 'repair-archived-source-overview')?.click();
		await flush();

		expect(el(host, 'repair-dialog')).toBeNull();
		const next = (component as unknown as { getEditor: () => ProjectEditor }).getEditor();
		expect(next).not.toBe(original);
		const nextSource = next.state.images.find((image) => image.role === 'source-overview');
		expect(nextSource?.sha256).toBe(await sha256Hex(SRC));
		expect(next.state.controlPointPairs).toHaveLength(1);
		expect(next.state.controlPointPairs[0].source.imageId).toBe(nextSource?.id);
		expect(next.isDirty).toBe(false);
		unmount(component);
		host.remove();
	});

	it('a malformed open keeps the live project fully intact with a visible specific error', async () => {
		const editor = await seedEditor();
		const original = editor;
		const stateBefore = JSON.stringify(editor.state);
		const { component, host } = mountPage(editor, vi.fn() as unknown as DownloadBlob);
		await flush();

		const bad = new File(
			[zipSync({ 'project.json': strToU8('{oops') } as Record<string, Uint8Array>, { level: 6 })],
			'bad.chainspot.zip',
			{ type: 'application/zip' }
		);
		setFileInput(inputEl(host, 'open-project-input'), bad);
		await flush();

		expect(el(host, 'open-error')).toBeTruthy();
		expect((component as unknown as { getEditor: () => ProjectEditor }).getEditor()).toBe(original);
		expect(JSON.stringify(original.state)).toBe(stateBefore);
		expect(el(host, 'dirty-indicator')).toBeTruthy();
		unmount(component);
		host.remove();
	});
});
