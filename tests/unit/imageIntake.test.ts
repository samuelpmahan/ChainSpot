import { describe, expect, it, vi } from 'vitest';
import { createProjectState } from '../../src/lib/domain/project';
import { ProjectEditor } from '../../src/lib/domain/editor';
import {
	IntakeError,
	decodeImageFileWith,
	deriveOrientation,
	intakeImageFile,
	isSupportedMimeType,
	SUPPORTED_MIME_TYPES
} from '../../src/lib/imageIntake';
import type { DecodeImageFile } from '../../src/lib/imageIntake';

const NOW = () => new Date('2026-08-02T00:00:00.000Z');

let counter = 0;
const nextId = (): string => `intake-${++counter}`;

function makeEmptyEditor(): ProjectEditor {
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

describe('supported MIME types', () => {
	it('accepts exactly PNG and JPEG, case-insensitively', () => {
		expect(SUPPORTED_MIME_TYPES).toEqual(['image/png', 'image/jpeg', 'image/jpg']);
		for (const mime of [
			'image/png',
			'image/PNG',
			'image/jpeg',
			'image/JPG',
			'image/jpg'
		]) {
			expect(isSupportedMimeType(mime)).toBe(true);
		}
		for (const mime of [null, undefined, '', 'image/webp', 'image/gif', 'text/plain', 'application/pdf']) {
			expect(isSupportedMimeType(mime)).toBe(false);
		}
	});
});

describe('orientation derivation', () => {
	it('derives portrait, landscape, and square from intrinsic dimensions', () => {
		expect(deriveOrientation(2, 3)).toBe('portrait');
		expect(deriveOrientation(5, 4)).toBe('landscape');
		expect(deriveOrientation(100, 100)).toBe('square');
	});

	it('rejects non-positive or non-finite dimensions', () => {
		for (const [w, h] of [[0, 3], [2, 0], [-1, 3], [Number.NaN, 3], [2, Infinity]]) {
			expect(() => deriveOrientation(w, h)).toThrow(/positive finite/);
		}
	});
});

describe('decodeImageFileWith', () => {
	class FakeImage {
		src = '';
		naturalWidth = 2;
		naturalHeight = 3;
		async decode(): Promise<void> {}
	}

	it('revokes the object URL immediately after a successful decode', async () => {
		const revoked: string[] = [];
		const result = await decodeImageFileWith(fileOf('a.png', 'image/png'), {
			createObjectUrl: () => 'blob:fake-a',
			revokeObjectUrl: (url) => revoked.push(url),
			ImageConstructor: FakeImage as unknown as typeof Image
		});
		expect(result.widthPx).toBe(2);
		expect(result.heightPx).toBe(3);
		expect(revoked).toEqual(['blob:fake-a']);
	});

	it('revokes the object URL after a failed decode and does not return an image', async () => {
		class FailingImage extends FakeImage {
			override async decode(): Promise<void> {
				throw new Error('decode failed');
			}
		}
		const revoked: string[] = [];
		await expect(
			decodeImageFileWith(fileOf('a.png', 'image/png'), {
				createObjectUrl: () => 'blob:fake-b',
				revokeObjectUrl: (url) => revoked.push(url),
				ImageConstructor: FailingImage as unknown as typeof Image
			})
		).rejects.toThrow('decode failed');
		expect(revoked).toEqual(['blob:fake-b']);
	});
});

describe('first image assignment', () => {
	it('assigns a PNG source with correct role and intrinsic metadata', async () => {
		const editor = makeEmptyEditor();
		const result = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('udisc-overview.png', 'image/png'),
			decode: decodeOf(2, 3),
			createAssetId: nextId
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.status).toBe('assigned');
		expect(result.asset.role).toBe('source-overview');
		expect(result.asset.fileName).toBe('udisc-overview.png');
		expect(result.asset.mimeType).toBe('image/png');
		expect(result.asset.widthPx).toBe(2);
		expect(result.asset.heightPx).toBe(3);

		const state = editor.state;
		expect(state.images).toHaveLength(1);
		expect(state.images[0].id).toBe(result.asset.id);
		expect(editor.canUndo).toBe(true);
		expect(editor.canRedo).toBe(false);
	});

	it('assigns a JPEG target independently', async () => {
		const editor = makeEmptyEditor();
		const result = await intakeImageFile({
			editor,
			role: 'target-basemap',
			file: fileOf('clean-map.jpg', 'image/jpeg'),
			decode: decodeOf(5, 4),
			createAssetId: nextId
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.status).toBe('assigned');
		expect(result.asset.role).toBe('target-basemap');
		expect(result.asset.fileName).toBe('clean-map.jpg');
		expect(result.asset.mimeType).toBe('image/jpeg');
		expect(result.asset.widthPx).toBe(5);
		expect(result.asset.heightPx).toBe(4);
	});

	it('assigns both roles and registers the decoded resources for rendering', async () => {
		const editor = makeEmptyEditor();
		const source = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('s.png', 'image/png'),
			decode: decodeOf(2, 3),
			createAssetId: nextId
		});
		const target = await intakeImageFile({
			editor,
			role: 'target-basemap',
			file: fileOf('t.jpg', 'image/jpeg'),
			decode: decodeOf(5, 4),
			createAssetId: nextId
		});
		expect(source.ok && target.ok).toBe(true);
		if (!source.ok || !target.ok) return;

		expect(editor.state.images.map((image) => image.role)).toEqual([
			'source-overview',
			'target-basemap'
		]);
		expect(editor.getAssetResource(source.asset.id)?.bytes).toEqual(
			new Uint8Array(8).fill(1)
		);
		expect(editor.getAssetResource(source.asset.id)?.decoded).toEqual({
			simulated: true
		});
		expect(editor.getAssetResource(target.asset.id)?.decoded).toEqual({
			simulated: true
		});
		expect(editor.state.controlPointPairs).toEqual([]);
	});
});

describe('intake failures', () => {
	it('rejects an unsupported MIME type without mutating the project', async () => {
		const editor = makeEmptyEditor();
		const result = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('notes.txt', 'text/plain'),
			decode: decodeOf(2, 3),
			createAssetId: nextId
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBeInstanceOf(IntakeError);
		expect(result.error.kind).toBe('unsupported-type');
		expect(editor.state.images).toEqual([]);
		expect(editor.canUndo).toBe(false);
	});

	it('reports a decode failure for corrupt data', async () => {
		const editor = makeEmptyEditor();
		const result = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('broken.png', 'image/png'),
			decode: decodeOf(0, 0, true),
			createAssetId: nextId
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe('decode-failure');
		expect(editor.state.images).toEqual([]);
		expect(editor.canUndo).toBe(false);
	});

	it('rejects zero or negative decoded dimensions through a controlled decoder', async () => {
		for (const [w, h] of [[0, 3], [2, 0]]) {
			const editor = makeEmptyEditor();
			const result = await intakeImageFile({
				editor,
				role: 'source-overview',
				file: fileOf('zero.png', 'image/png'),
				decode: decodeOf(w, h),
				createAssetId: nextId
			});
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.kind).toBe('invalid-dimension');
			expect(editor.state.images).toEqual([]);
		}
	});

	it('keeps a valid image in the other role intact when one role fails', async () => {
		const editor = makeEmptyEditor();
		const source = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('s.png', 'image/png'),
			decode: decodeOf(2, 3),
			createAssetId: nextId
		});
		const before = JSON.stringify(editor.state);

		const failed = await intakeImageFile({
			editor,
			role: 'target-basemap',
			file: fileOf('broken.jpg', 'image/jpeg'),
			decode: decodeOf(0, 0, true),
			createAssetId: nextId
		});
		expect(failed.ok).toBe(false);
		expect(JSON.stringify(editor.state)).toBe(before);
		expect(editor.state.images.map((image) => image.role)).toEqual(['source-overview']);
		expect(editor.getAssetResource(source.ok ? source.asset.id : '')?.decoded).toEqual({
			simulated: true
		});
	});
});

describe('image replacement', () => {
	async function editorWithSourceAndPair(): Promise<{
		editor: ProjectEditor;
		sourceId: string;
		targetId: string;
		pairId: string;
	}> {
		const editor = makeEmptyEditor();
		const source = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('s.png', 'image/png', 10),
			decode: decodeOf(2, 3),
			createAssetId: nextId
		});
		const target = await intakeImageFile({
			editor,
			role: 'target-basemap',
			file: fileOf('t.png', 'image/png', 20),
			decode: decodeOf(300, 400),
			createAssetId: nextId
		});
		if (!source.ok || !target.ok) throw new Error('setup failed');
		editor.addPair({
			sourceCoordinates: { xPx: 1, yPx: 1 },
			targetCoordinates: { xPx: 10, yPx: 10 }
		});
		return {
			editor,
			sourceId: source.asset.id,
			targetId: target.asset.id,
			pairId: editor.state.controlPointPairs[0].id
		};
	}

	it('preserves the current same-role image when a replacement fails', async () => {
		const { editor, sourceId } = await editorWithSourceAndPair();
		const before = JSON.stringify(editor.state);
		const historyBefore = { canUndo: editor.canUndo, canRedo: editor.canRedo };

		const result = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('bad.png', 'text/plain'),
			decode: decodeOf(4, 5),
			createAssetId: nextId
		});
		expect(result.ok).toBe(false);
		expect(JSON.stringify(editor.state)).toBe(before);
		expect(editor.canUndo).toBe(historyBefore.canUndo);
		expect(editor.canRedo).toBe(historyBefore.canRedo);
		expect(editor.state.images.find((image) => image.id === sourceId)).toBeTruthy();
	});

	it('retains points on a same-dimension replacement', async () => {
		const { editor, sourceId, pairId } = await editorWithSourceAndPair();
		const result = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('s-v2.png', 'image/png', 11),
			decode: decodeOf(2, 3),
			createAssetId: nextId
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.status).toBe('replaced-retained');

		const state = editor.state;
		expect(state.images.find((image) => image.role === 'source-overview')?.id).toBe(
			result.asset.id
		);
		expect(state.controlPointPairs).toHaveLength(1);
		const pair = state.controlPointPairs[0];
		expect(pair.id).toBe(pairId);
		expect(pair.source.imageId).toBe(result.asset.id);
		expect(pair.source.xPx).toBe(1);
		expect(pair.source.yPx).toBe(1);
		expect(editor.getAssetResource(result.asset.id)?.decoded).toEqual({ simulated: true });
	});

	it('asks for confirmation with the affected count when dimensions differ', async () => {
		const { editor } = await editorWithSourceAndPair();
		const confirmDiscard = vi.fn(async (count: number) => {
			expect(count).toBe(1);
			return true;
		});
		const result = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('s-wide.jpg', 'image/jpeg', 12),
			decode: decodeOf(4, 5),
			confirmDiscard,
			createAssetId: nextId
		});
		expect(confirmDiscard).toHaveBeenCalledTimes(1);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.status).toBe('replaced-discarded');
		expect(editor.state.controlPointPairs).toEqual([]);
		expect(editor.state.images.find((image) => image.role === 'source-overview')?.id).toBe(
			result.asset.id
		);
	});

	it('preserves image, points, and history when the confirmation is cancelled', async () => {
		const { editor, sourceId, pairId } = await editorWithSourceAndPair();
		const before = JSON.stringify(editor.state);
		const historyBefore = { canUndo: editor.canUndo, canRedo: editor.canRedo };
		const confirmDiscard = vi.fn(async () => false);

		const result = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('s-wide.jpg', 'image/jpeg', 12),
			decode: decodeOf(4, 5),
			confirmDiscard,
			createAssetId: nextId
		});
		expect(confirmDiscard).toHaveBeenCalledTimes(1);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.status).toBe('cancelled');
		expect(JSON.stringify(editor.state)).toBe(before);
		expect(editor.state.images.find((image) => image.id === sourceId)?.widthPx).toBe(2);
		expect(editor.state.controlPointPairs.map((pair) => pair.id)).toEqual([pairId]);
		expect(editor.canUndo).toBe(historyBefore.canUndo);
		expect(editor.canRedo).toBe(historyBefore.canRedo);
		expect(editor.getAssetResource(result.asset.id)).toBeUndefined();
	});

	it('does not ask for confirmation when no points would be discarded', async () => {
		const editor = makeEmptyEditor();
		await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('s.png', 'image/png', 10),
			decode: decodeOf(2, 3),
			createAssetId: nextId
		});
		const confirmDiscard = vi.fn(async () => true);
		const result = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('s-wide.jpg', 'image/jpeg', 12),
			decode: decodeOf(4, 5),
			confirmDiscard,
			createAssetId: nextId
		});
		expect(confirmDiscard).not.toHaveBeenCalled();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.status).toBe('replaced-discarded');
	});

	it('restores metadata, bytes, and decoded resources through replacement undo/redo', async () => {
		const editor = makeEmptyEditor();
		const source = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('a.png', 'image/png', 10),
			decode: decodeOf(2, 3),
			createAssetId: nextId
		});
		await intakeImageFile({
			editor,
			role: 'target-basemap',
			file: fileOf('t.png', 'image/png', 20),
			decode: decodeOf(300, 400),
			createAssetId: nextId
		});
		if (!source.ok) return;
		const firstBytes = editor.getAssetResource(source.asset.id)?.bytes;
		const firstDecoded = editor.getAssetResource(source.asset.id)?.decoded;

		const replacement = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('a-v2.jpg', 'image/jpeg', 30),
			decode: decodeOf(2, 3),
			createAssetId: nextId
		});
		if (!replacement.ok) return;
		const secondBytes = editor.getAssetResource(replacement.asset.id)?.bytes;
		const secondDecoded = editor.getAssetResource(replacement.asset.id)?.decoded;

		expect(editor.state.images.find((image) => image.role === 'source-overview')?.fileName).toBe(
			'a-v2.jpg'
		);

		editor.undo();
		const undone = editor.state;
		expect(undone.images.find((image) => image.role === 'source-overview')?.id).toBe(
			source.asset.id
		);
		expect(editor.getAssetResource(source.asset.id)?.bytes).toEqual(firstBytes);
		expect(editor.getAssetResource(source.asset.id)?.decoded).toBe(firstDecoded);
		expect(editor.getAssetResource(source.asset.id)?.decoded).toEqual({ simulated: true });

		editor.redo();
		const redone = editor.state;
		expect(redone.images.find((image) => image.role === 'source-overview')?.id).toBe(
			replacement.asset.id
		);
		expect(editor.getAssetResource(replacement.asset.id)?.bytes).toEqual(secondBytes);
		expect(editor.getAssetResource(replacement.asset.id)?.decoded).toBe(secondDecoded);
	});
});

describe('durable serialization stays plain', () => {
	it('serializes only plain metadata with no File, Blob, URL, bytes, decoded image, or Konva node', async () => {
		const editor = makeEmptyEditor();
		await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('s.png', 'image/png'),
			decode: decodeOf(2, 3),
			createAssetId: nextId
		});
		await intakeImageFile({
			editor,
			role: 'target-basemap',
			file: fileOf('t.jpg', 'image/jpeg'),
			decode: decodeOf(5, 4),
			createAssetId: nextId
		});

		const serialized = JSON.stringify(editor.state);
		const roundTripped = JSON.parse(serialized);
		expect(roundTripped).toEqual(editor.state);
		expect(serialized).not.toMatch(/blob:|data:image/);
		expect(serialized).not.toMatch(/simulated/);
		expect(roundTripped.images).toHaveLength(2);

		for (const image of roundTripped.images) {
			expect(typeof image.fileName).toBe('string');
			expect(typeof image.widthPx).toBe('number');
			expect(typeof image.heightPx).toBe('number');
			// P0-011: intake populates the manifest hash (native SHA-256, lowercase
			// 64-hex) and the stable images/ bundle path before any mutation.
			expect(image.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(image.bundlePath).toBe(
				image.role === 'source-overview'
					? 'images/source-original.png'
					: 'images/target-original.jpg'
			);
		}
	});
});

describe('temporary resource cleanup', () => {
	it('registers nothing after a decode failure', async () => {
		const editor = makeEmptyEditor();
		const result = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('broken.png', 'image/png'),
			decode: decodeOf(0, 0, true),
			createAssetId: nextId
		});
		expect(result.ok).toBe(false);
		expect(editor.getAssetResource('intake-1')).toBeUndefined();
		expect(editor.state.images).toEqual([]);
	});

	it('registers nothing for an uncommitted cancelled candidate', async () => {
		const { editor } = await (async () => {
			const e = makeEmptyEditor();
			await intakeImageFile({
				editor: e,
				role: 'source-overview',
				file: fileOf('s.png', 'image/png'),
				decode: decodeOf(2, 3),
				createAssetId: nextId
			});
			await intakeImageFile({
				editor: e,
				role: 'target-basemap',
				file: fileOf('t.png', 'image/png'),
				decode: decodeOf(300, 400),
				createAssetId: nextId
			});
			e.addPair({
				sourceCoordinates: { xPx: 1, yPx: 1 },
				targetCoordinates: { xPx: 10, yPx: 10 }
			});
			return { editor: e };
		})();
		const idsBefore = editor.state.images.map((image) => image.id);

		const result = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('s-wide.jpg', 'image/jpeg'),
			decode: decodeOf(4, 5),
			confirmDiscard: async () => false,
			createAssetId: nextId
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.status).toBe('cancelled');
		expect(editor.state.images.map((image) => image.id)).toEqual(idsBefore);
		expect(editor.getAssetResource(result.asset.id)).toBeUndefined();
	});

	it('releases a decoded resource only once no current or history state references it', async () => {
		const editor = makeEmptyEditor();
		const first = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('a.png', 'image/png', 10),
			decode: decodeOf(2, 3),
			createAssetId: nextId
		});
		if (!first.ok) return;
		const firstId = first.asset.id;
		expect(editor.getAssetResource(firstId)?.decoded).toBeTruthy();

		const second = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('b.png', 'image/png', 11),
			decode: decodeOf(2, 3),
			createAssetId: nextId
		});
		if (!second.ok) return;
		const secondId = second.asset.id;
		expect(editor.getAssetResource(firstId)?.decoded).toBeTruthy();

		editor.undo();
		expect(editor.state.images.find((image) => image.id === firstId)).toBeTruthy();
		expect(editor.getAssetResource(firstId)?.decoded).toBeTruthy();
		expect(editor.getAssetResource(secondId)?.decoded).toBeTruthy();

		editor.renameProject('divergent edit');
		expect(editor.getAssetResource(secondId)).toBeUndefined();
		expect(editor.getAssetResource(firstId)?.decoded).toBeTruthy();
	});
});
