import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { AnnotatedHole } from '../../src/lib/domain/project';
import { intakeImageFile, sha256Hex } from '../../src/lib/imageIntake';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import {
	ANNOTATION_DRAFT_JSON_PATH,
	readAnnotationDraft,
	saveAnnotationDraft
} from '../../src/lib/annotationDraft';

const NOW = () => new Date('2026-08-10T00:00:00.000Z');

let counter = 0;
const nextId = (): string => `asset-${++counter}`;

const SOURCE_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function fileOf(name: string, mime: string, bytes: Uint8Array): File {
	return new File([new Uint8Array(bytes)], name, { type: mime });
}

function decodeOf(widthPx: number, heightPx: number): DecodeImageFile {
	return async () => ({ image: { simulated: true } as unknown as HTMLImageElement, widthPx, heightPx });
}

const RICH_HOLE: AnnotatedHole = {
	id: 'hole-a',
	number: 1,
	tee: { xPx: 10.5, yPx: 20.25 },
	basket: { xPx: 900.75, yPx: 700.5 },
	shots: [{ id: 'shot-1', landing: { xPx: 300, yPx: 250.5 } }],
	corridorBends: [{ xPx: 400, yPx: 300 }],
	corridorWidthPx: 90
};

/** A ProjectEditor with only a source-overview image loaded (annotate-round's world). */
async function sourceOnlyEditor(): Promise<ProjectEditor> {
	const editor = new ProjectEditor({
		state: createProjectState({ createId: () => 'project-1', now: NOW }),
		createId: nextId,
		now: NOW
	});
	const result = await intakeImageFile({
		editor,
		role: 'source-overview',
		file: fileOf('udisc-round.png', 'image/png', SOURCE_BYTES),
		decode: decodeOf(1000, 800),
		createAssetId: nextId,
		hash: sha256Hex
	});
	if (!result.ok) throw new Error('setup: intake failed');
	return editor;
}

interface DownloadCapture {
	blob: Blob | null;
	fileName: string | null;
	download: (blob: Blob, fileName: string) => void;
}

function captureDownload(): DownloadCapture {
	const capture: DownloadCapture = {
		blob: null,
		fileName: null,
		download: (blob, fileName) => {
			capture.blob = blob;
			capture.fileName = fileName;
		}
	};
	return capture;
}

describe('saveAnnotationDraft', () => {
	it('fails with a clear error when no source image is loaded, without touching the download', async () => {
		const editor = new ProjectEditor({
			state: createProjectState({ createId: () => 'project-1', now: NOW }),
			now: NOW
		});
		const capture = captureDownload();
		const result = await saveAnnotationDraft(editor, { download: capture.download });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe('no-source-image');
		expect(capture.blob).toBeNull();
	});

	it('writes a single-image zip with annotation-round.json and the exact source bytes, requiring no target-basemap image', async () => {
		const editor = await sourceOnlyEditor();
		editor.setHoles([RICH_HOLE]);
		const capture = captureDownload();
		const result = await saveAnnotationDraft(editor, { download: capture.download });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.fileName.endsWith('.chainspot-round.zip')).toBe(true);
		expect(capture.blob).not.toBeNull();

		const zipBytes = new Uint8Array(await capture.blob!.arrayBuffer());
		const entries = unzipSync(zipBytes);
		expect(Object.keys(entries).sort()).toEqual([ANNOTATION_DRAFT_JSON_PATH, 'images/source-original.png']);

		const document = JSON.parse(strFromU8(entries[ANNOTATION_DRAFT_JSON_PATH]));
		expect(document.schemaVersion).toBe(1);
		expect(document.holes).toEqual([RICH_HOLE]);
		expect(document.sourceImage.fileName).toBe('udisc-round.png');
		expect(document.sourceImage.widthPx).toBe(1000);
		expect(document.sourceImage.heightPx).toBe(800);
		expect(entries['images/source-original.png']).toEqual(SOURCE_BYTES);
	});

	it('surfaces a download failure as download-failure without losing the archived data', async () => {
		const editor = await sourceOnlyEditor();
		const result = await saveAnnotationDraft(editor, {
			download: () => {
				throw new Error('simulated download rejection');
			}
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe('download-failure');
	});
});

describe('saveAnnotationDraft -> readAnnotationDraft round trip', () => {
	it('round-trips holes and the exact source image bytes with no drift', async () => {
		const editor = await sourceOnlyEditor();
		editor.setHoles([RICH_HOLE]);
		const capture = captureDownload();
		const saved = await saveAnnotationDraft(editor, { download: capture.download });
		if (!saved.ok) throw new Error('setup: save failed');

		const draftFile = new File([capture.blob!], saved.fileName, { type: 'application/zip' });
		const read = await readAnnotationDraft(draftFile);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.holes).toEqual([RICH_HOLE]);
		expect(read.image.fileName).toBe('udisc-round.png');
		expect(read.image.mimeType).toBe('image/png');
		expect(read.image.bytes).toEqual(SOURCE_BYTES);
	});

	it('rejects a corrupt archive', async () => {
		const result = await readAnnotationDraft(
			new File([new Uint8Array([0, 1, 2, 3])], 'broken.chainspot-round.zip', { type: 'application/zip' })
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe('corrupt-archive');
	});

	it('rejects an archive whose source image bytes no longer match the manifest hash', async () => {
		const editor = await sourceOnlyEditor();
		const capture = captureDownload();
		const saved = await saveAnnotationDraft(editor, { download: capture.download });
		if (!saved.ok) throw new Error('setup: save failed');

		const zipBytes = new Uint8Array(await capture.blob!.arrayBuffer());
		const entries = unzipSync(zipBytes);
		entries['images/source-original.png'] = new Uint8Array([9, 9, 9, 9]);
		const { zipSync } = await import('fflate');
		const tampered = zipSync(entries, { level: 6 });
		const draftFile = new File([new Uint8Array(tampered)], saved.fileName, { type: 'application/zip' });

		const result = await readAnnotationDraft(draftFile);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe('hash-mismatch');
	});
});
