/**
 * ChainSpot annotation draft persistence (Annotate Course / Map Round).
 *
 * The two-image `.chainspot.zip` project bundle (`persistence.ts`, schema v3)
 * requires exactly one `source-overview` AND exactly one `target-basemap`
 * image — a load-bearing invariant of the Create Graphics correspondence
 * workflow (`projectSchema.ts`'s `images.cardinality` check). Annotate Round
 * only ever has a source image, so that bundle format can never represent an
 * in-progress annotation draft. This module is a minimal, purpose-built
 * sibling for exactly that single-image case: no control-point pairs, no
 * target image, no schema-v3 cardinality rule.
 *
 *   <name>.chainspot-round.zip
 *   ├── annotation-round.json   (schema v1: source image manifest + holes)
 *   └── source.<ext>            (exact original source-image bytes)
 *
 * Deliberately minimal: a hash mismatch or corrupt archive is a hard failure
 * (no repair flow) since a draft is a disposable working checkpoint, not the
 * archival two-image project bundle.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { AnnotatedHole } from './domain/project';
import type { ProjectEditor } from './domain/editor';
import { findImageByRole } from './domain/project';
import {
	bundlePathFor,
	isSupportedMimeType,
	isValidSha256Hex,
	readFileBytes,
	sha256Hex
} from './imageIntake';
import type { HashBytes, Sha256Hex } from './imageIntake';
import { defaultBundleBlob, downloadBlob, sanitizeFileNameBase } from './persistence';
import type { DownloadBlob } from './persistence';

export const ANNOTATION_DRAFT_JSON_PATH = 'annotation-round.json';

/** The only accepted draft file suffix, lowercase — distinct from `.chainspot.zip` so a draft can never be mistaken for (or opened as) a two-image project bundle. */
export const ANNOTATION_DRAFT_SUFFIX = '.chainspot-round.zip';

export type AnnotationDraftErrorKind =
	| 'no-source-image'
	| 'read-bytes'
	| 'corrupt-archive'
	| 'missing-entry'
	| 'invalid-document'
	| 'hash-mismatch'
	| 'unsupported-mime'
	| 'export-failure'
	| 'download-failure';

export class AnnotationDraftError extends Error {
	readonly kind: AnnotationDraftErrorKind;

	constructor(kind: AnnotationDraftErrorKind, message: string) {
		super(message);
		this.name = 'AnnotationDraftError';
		this.kind = kind;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface AnnotationDraftSourceImage {
	fileName: string;
	mimeType: string;
	widthPx: number;
	heightPx: number;
	sha256: Sha256Hex;
	bundlePath: string;
}

interface AnnotationDraftDocument {
	schemaVersion: 1;
	sourceImage: AnnotationDraftSourceImage;
	holes: AnnotatedHole[];
}

function draftFileName(sourceFileName: string): string {
	const base = sanitizeFileNameBase(sourceFileName.replace(/\.[^.]+$/, '') || sourceFileName);
	return `${base}${ANNOTATION_DRAFT_SUFFIX}`;
}

export interface SaveAnnotationDraftOptions {
	hash?: HashBytes;
	download?: DownloadBlob;
	createBlob?: (zipBytes: Uint8Array) => Blob;
}

export type SaveAnnotationDraftResult =
	| { ok: true; fileName: string }
	| { ok: false; error: AnnotationDraftError };

/**
 * Saves the current source image plus every hand-placed hole as a portable
 * `.chainspot-round.zip` draft. The source image bytes are hashed fresh from
 * the editor's asset registry so the manifest always matches the archived
 * bytes exactly, mirroring `persistence.ts`'s `saveProject` guarantee.
 */
export async function saveAnnotationDraft(
	editor: ProjectEditor,
	options: SaveAnnotationDraftOptions = {}
): Promise<SaveAnnotationDraftResult> {
	const { hash = sha256Hex, download = downloadBlob, createBlob = defaultBundleBlob } = options;
	const state = editor.state;
	const sourceImage = findImageByRole(state.images, 'source-overview');
	if (!sourceImage) {
		return {
			ok: false,
			error: new AnnotationDraftError('no-source-image', 'Load a source image before saving.')
		};
	}
	const resource = editor.getAssetResource(sourceImage.id);
	if (!resource) {
		return {
			ok: false,
			error: new AnnotationDraftError(
				'export-failure',
				'Could not save the draft: the source image bytes are no longer available.'
			)
		};
	}

	let sha256: Sha256Hex;
	try {
		sha256 = await hash(resource.bytes);
	} catch (caught) {
		return {
			ok: false,
			error: new AnnotationDraftError(
				'export-failure',
				`Could not save the draft: hashing the source image failed: ${messageOf(caught)}`
			)
		};
	}

	let bundlePath: string;
	try {
		bundlePath = bundlePathFor('source-overview', sourceImage.mimeType);
	} catch (caught) {
		return { ok: false, error: new AnnotationDraftError('export-failure', `Could not save the draft: ${messageOf(caught)}`) };
	}

	const document: AnnotationDraftDocument = {
		schemaVersion: 1,
		sourceImage: {
			fileName: sourceImage.fileName,
			mimeType: sourceImage.mimeType,
			widthPx: sourceImage.widthPx,
			heightPx: sourceImage.heightPx,
			sha256,
			bundlePath
		},
		holes: state.holes
	};

	const files: Record<string, Uint8Array> = {
		[ANNOTATION_DRAFT_JSON_PATH]: strToU8(JSON.stringify(document)),
		[bundlePath]: resource.bytes
	};
	const zipBytes = zipSync(files, { level: 6 });
	const blob = createBlob(zipBytes);
	const fileName = draftFileName(sourceImage.fileName);
	try {
		download(blob, fileName);
	} catch (caught) {
		return {
			ok: false,
			error: new AnnotationDraftError(
				'download-failure',
				`The draft archive was created but the download could not be started: ${messageOf(caught)}`
			)
		};
	}
	return { ok: true, fileName };
}

export interface AnnotationDraftImage {
	readonly fileName: string;
	readonly mimeType: string;
	readonly bytes: Uint8Array;
}

export type ReadAnnotationDraftResult =
	| { ok: true; holes: AnnotatedHole[]; image: AnnotationDraftImage }
	| { ok: false; error: AnnotationDraftError };

export interface ReadAnnotationDraftOptions {
	hash?: HashBytes;
	readBytes?: (file: File) => Promise<Uint8Array>;
}

/** Reads and validates a `.chainspot-round.zip` draft. Never touches the live project. */
export async function readAnnotationDraft(
	file: File,
	options: ReadAnnotationDraftOptions = {}
): Promise<ReadAnnotationDraftResult> {
	const { hash = sha256Hex, readBytes: read = readFileBytes } = options;

	let bytes: Uint8Array;
	try {
		bytes = await read(file);
	} catch {
		return { ok: false, error: new AnnotationDraftError('read-bytes', 'Could not read the selected draft file.') };
	}

	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(bytes);
	} catch {
		return {
			ok: false,
			error: new AnnotationDraftError('corrupt-archive', 'The selected file is not a valid ChainSpot annotation draft.')
		};
	}

	const jsonBytes = entries[ANNOTATION_DRAFT_JSON_PATH];
	if (!jsonBytes) {
		return {
			ok: false,
			error: new AnnotationDraftError('missing-entry', `The archive does not contain '${ANNOTATION_DRAFT_JSON_PATH}'.`)
		};
	}

	let document: AnnotationDraftDocument;
	try {
		document = JSON.parse(strFromU8(jsonBytes)) as AnnotationDraftDocument;
	} catch {
		return { ok: false, error: new AnnotationDraftError('invalid-document', 'The draft document is not valid JSON.') };
	}
	if (
		document.schemaVersion !== 1 ||
		typeof document.sourceImage !== 'object' ||
		document.sourceImage === null ||
		!Array.isArray(document.holes)
	) {
		return {
			ok: false,
			error: new AnnotationDraftError('invalid-document', 'The draft document has an unrecognized shape.')
		};
	}
	const { sourceImage, holes } = document;
	if (!isValidSha256Hex(sourceImage.sha256)) {
		return {
			ok: false,
			error: new AnnotationDraftError('hash-mismatch', 'The source image manifest has an invalid SHA-256 hash.')
		};
	}
	if (!isSupportedMimeType(sourceImage.mimeType)) {
		return {
			ok: false,
			error: new AnnotationDraftError(
				'unsupported-mime',
				`The source image has unsupported MIME type ${JSON.stringify(sourceImage.mimeType)}; ChainSpot supports PNG and JPEG.`
			)
		};
	}

	const imageBytes = entries[sourceImage.bundlePath];
	if (!imageBytes) {
		return {
			ok: false,
			error: new AnnotationDraftError('missing-entry', `The archive does not contain '${sourceImage.bundlePath}'.`)
		};
	}
	let actualHash: Sha256Hex;
	try {
		actualHash = await hash(imageBytes);
	} catch {
		return {
			ok: false,
			error: new AnnotationDraftError('read-bytes', 'Could not hash the source image bytes in the archive.')
		};
	}
	if (actualHash !== sourceImage.sha256) {
		return {
			ok: false,
			error: new AnnotationDraftError(
				'hash-mismatch',
				'The source image bytes in the archive do not match the manifest hash.'
			)
		};
	}

	return {
		ok: true,
		holes,
		image: { fileName: sourceImage.fileName, mimeType: sourceImage.mimeType, bytes: imageBytes }
	};
}
