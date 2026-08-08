/**
 * ChainSpot portable project bundle persistence (P0-011).
 *
 * One focused module owns the portable ZIP bundle boundary using `fflate` (the only
 * persistence dependency):
 *
 *   <project>.chainspot.zip
 *   ├── project.json                 (schema v1; P0-010 serialize/parse only)
 *   └── images/<role>-original.<ext> (exact original bytes, stable manifest paths)
 *
 * Export (`saveProject`/`createProjectBundle`): `serializeProjectState` (P0-010) is the
 * only JSON path. The two current images' exact original bytes are read from the
 * `ProjectEditor` transient asset registry, re-hashed with native Web Crypto SHA-256,
 * and written so the manifest hash always equals the archived bytes. Download uses
 * native Blob/object-URL/temporary-anchor mechanics with an injectable boundary.
 *
 * Import (`readProjectBundle`): native File APIs -> `fflate` unzip -> P0-010 parse ->
 * path/entry/hash validation -> decode through the existing injected decode boundary
 * (PNG/JPEG, intrinsic dimensions exact) -> atomic replacement through a fresh
 * `ProjectEditor` with `markSaved`. Every non-repair failure leaves the live project,
 * images, bytes, history, dirty state, selection, and pending state unchanged.
 *
 * Repair (`readProjectBundle` -> `resolveRepairWithBytes`/`resolveRepairWithFile`/
 * `resolveRepairWithArchivedBytes`): a missing or hash-mismatched bundled image never
 * opens or substitutes a blank canvas. An inspectable transient candidate (project
 * name, pair count, role, path, expected hash, reason) is produced and is promoted to a
 * full open only through explicit acceptance: an exact hash+decode/type/dimension
 * match completes the original atomically with unchanged metadata and coordinates; any
 * differing image is an explicit replacement with a new normal intake id, metadata,
 * hash, and path, following the P0-005/P0-004 replacement rules (same dimension
 * re-targets points; different dimension with affected pairs requires explicit discard
 * confirmation). Cancelling repair clears only transient state.
 *
 * Boundaries: no backend, network, IndexedDB, filesystem sync, storage provider,
 * autosave, recent list, migration, or custom ZIP code. Hashes are native focused
 * SHA-256 (`globalThis.crypto.subtle`) lowercase 64-hex; no crypto dependency.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createImageAsset } from './domain/project';
import type { ImageAsset, ImageRole, ProjectState } from './domain/project';
import { ProjectEditor } from './domain/editor';
import type { AssetResource } from './domain/editor';
import { parseProjectJson, serializeProjectState } from './projectSchema';
import type { ProjectDocumentV3, ProjectSchemaError } from './projectSchema';
import {
	bundlePathFor,
	decodeImageFile,
	isSupportedMimeType,
	isValidSha256Hex,
	readFileBytes,
	sha256Hex
} from './imageIntake';
import type { DecodeImageFile, DecodedImage, HashBytes, Sha256Hex } from './imageIntake';

export const PROJECT_JSON_PATH = 'project.json' as const;

/** The only accepted bundle file suffix, lowercase. */
export const BUNDLE_SUFFIX = '.chainspot.zip' as const;

export type { HashBytes, Sha256Hex };

export type PersistenceErrorKind =
	| 'read-bytes'
	| 'corrupt-archive'
	| 'missing-json'
	| 'project-json'
	| 'path'
	| 'extra-entries'
	| 'hash-metadata'
	| 'unsupported-mime'
	| 'decode-failure'
	| 'dimension-mismatch'
	| 'export-failure'
	| 'download-failure';

/** A focused persistence/repair failure with a stable kind and an optional P0-010 cause. */
export class PersistenceError extends Error {
	readonly kind: PersistenceErrorKind;
	readonly schemaError?: ProjectSchemaError;

	constructor(kind: PersistenceErrorKind, message: string, schemaError?: ProjectSchemaError) {
		super(message);
		this.name = 'PersistenceError';
		this.kind = kind;
		this.schemaError = schemaError;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function error(kind: PersistenceErrorKind, message: string, schemaError?: ProjectSchemaError): PersistenceError {
	return new PersistenceError(kind, message, schemaError);
}

/** Copies bytes into an `ArrayBuffer`-backed view so TS lib types accept them as `BlobPart`. */
function blobPartOf(bytes: Uint8Array): BlobPart {
	return new Uint8Array(bytes);
}

function isSchemaError(value: unknown): value is ProjectSchemaError {
	return (
		typeof value === 'object' &&
		value !== null &&
		'category' in value &&
		'code' in value &&
		'path' in value &&
		'message' in value
	);
}

/**
 * Safe bundle path: non-empty name directly under `images/`, no absolute path, `..`,
 * backslash, NUL, nested directories, or `project.json` collision.
 */
export function isSafeBundlePath(path: unknown): path is string {
	if (typeof path !== 'string' || path.length === 0) return false;
	if (!path.startsWith('images/')) return false;
	const name = path.slice('images/'.length);
	if (name.length === 0) return false;
	if (name === PROJECT_JSON_PATH) return false;
	if (path.includes('..')) return false;
	if (path.includes('\\')) return false;
	if (path.includes('\0')) return false;
	if (path.startsWith('/')) return false;
	if (name.includes('/')) return false;
	return true;
}

/** Conservative project-name-derived base for a bundle filename, with a stable fallback. */
export function sanitizeFileNameBase(name: string): string {
	const cleaned = name
		.replace(/[^A-Za-z0-9._ -]/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^[.\- ]+|[.\- ]+$/g, '')
		.trim();
	return cleaned.length > 0 ? cleaned.slice(0, 80) : 'chainspot-project';
}

/** Bundle filename: sanitized base plus the lowercase `.chainspot.zip` suffix. */
export function projectFileName(projectName: string): string {
	return `${sanitizeFileNameBase(projectName)}${BUNDLE_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Export / save
// ---------------------------------------------------------------------------

export interface ExportImageFile {
	readonly path: string;
	readonly bytes: Uint8Array;
	readonly sha256: Sha256Hex;
}

export interface ExportBundle {
	readonly document: ProjectDocumentV3;
	readonly text: string;
	readonly images: ExportImageFile[];
	readonly zipBytes: Uint8Array;
	/** Exact plain `ProjectState` snapshot captured when the save started. */
	readonly savedState: ProjectState;
}

export type CreateProjectBundleResult =
	| { ok: true; bundle: ExportBundle }
	| { ok: false; error: PersistenceError };

export interface CreateProjectBundleOptions {
	hash?: HashBytes;
}

/**
 * Builds the `.chainspot.zip` bytes (exactly `project.json` plus the two originals at
 * their manifest paths) with the manifest hashes recomputed from the archived bytes.
 *
 * The exact plain `ProjectState` is snapshotted once, before any await, and the archive
 * is derived from that snapshot only. Live edits that land while hashing is in flight
 * therefore never leak into the archive or the returned `savedState`, and the caller can
 * compare its own current state against `savedState` to decide whether the checkpoint
 * still applies. Never mutates the editor or touches history/dirty state.
 */
export async function createProjectBundle(
	editor: ProjectEditor,
	options: CreateProjectBundleOptions = {}
): Promise<CreateProjectBundleResult> {
	const { hash = sha256Hex } = options;
	const savedState = editor.state;
	let document: ProjectDocumentV3;
	try {
		document = serializeProjectState(savedState);
	} catch (caught) {
		const schemaError = isSchemaError(caught) ? caught : undefined;
		return {
			ok: false,
			error: error('export-failure', `Could not save the project: ${messageOf(caught)}`, schemaError)
		};
	}

	const images: ExportImageFile[] = [];
	const files: Record<string, Uint8Array> = {};
	const paths = new Set<string>();
	for (let index = 0; index < document.images.length; index += 1) {
		const manifest = document.images[index];
		const resource = editor.getAssetResource(manifest.id);
		if (!resource) {
			return {
				ok: false,
				error: error(
					'export-failure',
					`Could not save the project: original bytes for the ${manifest.role} image are not available.`
				)
			};
		}
		let sha256: Sha256Hex;
		try {
			sha256 = await hash(resource.bytes);
		} catch (caught) {
			return {
				ok: false,
				error: error('export-failure', `Could not save the project: hashing the ${manifest.role} image failed: ${messageOf(caught)}`)
			};
		}
		let path: string;
		try {
			path = bundlePathFor(manifest.role, manifest.mimeType);
		} catch (caught) {
			return { ok: false, error: error('export-failure', `Could not save the project: ${messageOf(caught)}`) };
		}
		if (paths.has(path)) {
			return { ok: false, error: error('export-failure', `Could not save the project: duplicate bundle path '${path}'.`) };
		}
		paths.add(path);
		document.images[index] = { ...manifest, sha256, bundlePath: path };
		images.push({ path, bytes: resource.bytes, sha256 });
		files[path] = resource.bytes;
	}

	const text = JSON.stringify(document);
	files[PROJECT_JSON_PATH] = strToU8(text);
	const zipBytes = zipSync(files, { level: 6 });
	return { ok: true, bundle: { document, text, images, zipBytes, savedState } };
}

export type DownloadBlob = (blob: Blob, fileName: string) => void;

/** Native download via Blob, object URL, and a temporary anchor; the URL is revoked. */
export function downloadBlob(blob: Blob, fileName: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = fileName;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function defaultBundleBlob(zipBytes: Uint8Array): Blob {
	return new Blob([blobPartOf(zipBytes)], { type: 'application/zip' });
}

export interface SaveProjectOptions extends CreateProjectBundleOptions {
	download?: DownloadBlob;
	createBlob?: (zipBytes: Uint8Array) => Blob;
}

export type SaveProjectResult =
	| { ok: true; fileName: string; savedState: ProjectState }
	| { ok: false; error: PersistenceError };

/**
 * Creates the archive and starts the download. The filename and the returned
 * `savedState` are always derived from the start-of-save snapshot (`ExportBundle`), never
 * from a later `editor.state`, so a rename or any edit during the async save cannot leak
 * into the bundle or its suggested name. The caller (`+page.svelte`) calls `markSaved`
 * only when its current state still exactly matches `savedState`; a failure preserves
 * state/history/decoded/dirty state and can be retried.
 */
export async function saveProject(
	editor: ProjectEditor,
	options: SaveProjectOptions = {}
): Promise<SaveProjectResult> {
	const created = await createProjectBundle(editor, options);
	if (!created.ok) return created;
	const blob = (options.createBlob ?? defaultBundleBlob)(created.bundle.zipBytes);
	const fileName = projectFileName(created.bundle.document.project.name);
	try {
		(options.download ?? downloadBlob)(blob, fileName);
	} catch (caught) {
		return {
			ok: false,
			error: error(
				'download-failure',
				`The project archive was created but the download could not be started: ${messageOf(caught)}`
			)
		};
	}
	return { ok: true, fileName, savedState: created.bundle.savedState };
}

// ---------------------------------------------------------------------------
// Import / open
// ---------------------------------------------------------------------------

export interface RepairIssue {
	readonly image: ImageAsset;
	readonly path: string;
	readonly expectedHash: Sha256Hex | null;
	readonly reason: 'missing' | 'hash-mismatch';
	/** Verified archived bytes for a `hash-mismatch` issue (never auto-accepted). */
	readonly archivedBytes?: Uint8Array;
}

export interface RepairCandidate {
	/** The parsed plain project; inspectable without replacing the live project. */
	readonly state: ProjectState;
	readonly issues: RepairIssue[];
	/** Verified images (manifest id -> exact bytes + decoded) safe to inspect. */
	readonly verified: ReadonlyMap<string, { bytes: Uint8Array; decoded: unknown }>;
}

export type OpenResult =
	| { ok: true; state: ProjectState; assets: ReadonlyMap<string, AssetResource> }
	| { ok: false; kind: 'repair'; candidate: RepairCandidate }
	| { ok: false; kind: 'failure'; error: PersistenceError };

export interface ReadProjectBundleOptions {
	decode?: DecodeImageFile;
	hash?: HashBytes;
	readBytes?: (file: File) => Promise<Uint8Array>;
}

async function decodeVerifiedImage(
	image: ImageAsset,
	bytes: Uint8Array,
	decode: DecodeImageFile
): Promise<unknown | PersistenceError> {
	if (!isSupportedMimeType(image.mimeType)) {
		return error(
			'unsupported-mime',
			`The ${image.role} image has unsupported MIME type ${JSON.stringify(image.mimeType)}; ChainSpot supports PNG and JPEG.`
		);
	}
	const file = new File([blobPartOf(bytes)], image.fileName || image.id, { type: image.mimeType });
	let decoded: DecodedImage;
	try {
		decoded = await decode(file);
	} catch {
		return error('decode-failure', `The ${image.role} image in the archive could not be decoded.`);
	}
	if (decoded.widthPx !== image.widthPx || decoded.heightPx !== image.heightPx) {
		return error(
			'dimension-mismatch',
			`The ${image.role} image decodes as ${decoded.widthPx} x ${decoded.heightPx} but the project manifest declares ${image.widthPx} x ${image.heightPx}.`
		);
	}
	return decoded.image;
}

/**
 * Parses and validates a selected bundle without touching the live project. Returns a
 * ready-to-open plain state plus assets, an inspectable repair candidate, or a
 * non-repair failure that leaves the current project unchanged.
 */
export async function readProjectBundle(
	file: File,
	options: ReadProjectBundleOptions = {}
): Promise<OpenResult> {
	const { decode = decodeImageFile, hash = sha256Hex, readBytes: read = readFileBytes } = options;

	let bytes: Uint8Array;
	try {
		bytes = await read(file);
	} catch {
		return { ok: false, kind: 'failure', error: error('read-bytes', 'Could not read the selected project file.') };
	}

	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(bytes);
	} catch {
		return {
			ok: false,
			kind: 'failure',
			error: error('corrupt-archive', 'The selected file is not a valid ChainSpot project archive.')
		};
	}

	const jsonBytes = entries[PROJECT_JSON_PATH];
	if (!jsonBytes) {
		return {
			ok: false,
			kind: 'failure',
			error: error('missing-json', `The archive does not contain '${PROJECT_JSON_PATH}'.`)
		};
	}
	const parsed = parseProjectJson(strFromU8(jsonBytes));
	if (!parsed.ok) {
		return {
			ok: false,
			kind: 'failure',
			error: error('project-json', `The project document could not be opened: ${parsed.error.message}`, parsed.error)
		};
	}
	const state = parsed.state;

	const pathOwners = new Map<string, ImageAsset>();
	for (const image of state.images) {
		if (!isSafeBundlePath(image.bundlePath)) {
			return {
				ok: false,
				kind: 'failure',
				error: error('path', `The ${image.role} image has an unsafe bundle path ${JSON.stringify(image.bundlePath)}.`)
			};
		}
		if (pathOwners.has(image.bundlePath as string)) {
			return {
				ok: false,
				kind: 'failure',
				error: error('path', `The project references the bundle path '${image.bundlePath}' more than once.`)
			};
		}
		pathOwners.set(image.bundlePath as string, image);
		if (!isValidSha256Hex(image.sha256)) {
			return {
				ok: false,
				kind: 'failure',
				error: error('hash-metadata', `The ${image.role} image manifest has an invalid SHA-256 hash.`)
			};
		}
	}
	if (pathOwners.size !== 2) {
		return {
			ok: false,
			kind: 'failure',
			error: error('path', 'The project must reference exactly two image bundle paths.')
		};
	}

	const allowedEntries = new Set<string>([PROJECT_JSON_PATH, ...pathOwners.keys()]);
	const extraEntries = Object.keys(entries).filter((key) => !allowedEntries.has(key));
	if (extraEntries.length > 0) {
		const listed = extraEntries.slice(0, 5).join(', ');
		return {
			ok: false,
			kind: 'failure',
			error: error(
				'extra-entries',
				`The archive contains unexpected entries${extraEntries.length > 5 ? ` (${extraEntries.length} total)` : ''}: ${listed}${extraEntries.length > 5 ? ', …' : ''}.`
			)
		};
	}

	const issues: RepairIssue[] = [];
	const verified: Map<string, { bytes: Uint8Array; decoded: unknown }> = new Map();
	const toDecode: Array<{ image: ImageAsset; bytes: Uint8Array }> = [];
	for (const image of state.images) {
		const path = image.bundlePath as string;
		const entry = entries[path];
		if (!entry) {
			issues.push({ image, path, expectedHash: image.sha256, reason: 'missing' });
			continue;
		}
		let actualHash: Sha256Hex;
		try {
			actualHash = await hash(entry);
		} catch {
			return {
				ok: false,
				kind: 'failure',
				error: error('read-bytes', `Could not hash the ${image.role} image bytes in the archive.`)
			};
		}
		if (actualHash !== image.sha256) {
			issues.push({ image, path, expectedHash: image.sha256, reason: 'hash-mismatch', archivedBytes: entry });
			continue;
		}
		toDecode.push({ image, bytes: entry });
	}

	if (issues.length > 0) {
		for (const { image, bytes } of toDecode) {
			const decoded = await decodeVerifiedImage(image, bytes, decode);
			if (decoded instanceof PersistenceError) {
				return { ok: false, kind: 'failure', error: decoded };
			}
			verified.set(image.id, { bytes, decoded });
		}
		return { ok: false, kind: 'repair', candidate: { state, issues, verified } };
	}

	const assets = new Map<string, AssetResource>();
	for (const { image, bytes } of toDecode) {
		const decoded = await decodeVerifiedImage(image, bytes, decode);
		if (decoded instanceof PersistenceError) {
			return { ok: false, kind: 'failure', error: decoded };
		}
		assets.set(image.id, { bytes, decoded });
	}
	return { ok: true, state, assets };
}

// ---------------------------------------------------------------------------
// Repair resolution
// ---------------------------------------------------------------------------

export interface RepairResolutionBytes {
	readonly role: ImageRole;
	readonly bytes: Uint8Array;
	readonly fileName: string;
	readonly mimeType: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly decoded: unknown;
	readonly sha256: Sha256Hex;
}

export type RepairResolutionResult =
	| { ok: true; state: ProjectState; assets: ReadonlyMap<string, AssetResource> }
	| { ok: false; kind: 'discard-confirm'; role: ImageRole; affectedCount: number }
	| { ok: false; kind: 'incomplete'; candidate: RepairCandidate }
	| { ok: false; kind: 'error'; error: PersistenceError };

export interface ResolveRepairBytesOptions {
	createAssetId?: () => string;
	/** When true, discard affected pairs for a different-dimension replacement without confirmation. */
	discard?: boolean;
	/** Deterministic timestamp source for the temporary domain replacement. */
	now?: () => Date;
}

/** Assets map for the temporary domain editor, built only from verified candidate images. */
function verifiedAssets(candidate: RepairCandidate): ReadonlyMap<string, AssetResource> {
	const assets = new Map<string, AssetResource>();
	for (const [id, resource] of candidate.verified) {
		assets.set(id, { bytes: resource.bytes, decoded: resource.decoded });
	}
	return assets;
}

function openResultFrom(
	state: ProjectState,
	verified: Map<string, { bytes: Uint8Array; decoded: unknown }>
): RepairResolutionResult {
	const assets = new Map<string, AssetResource>();
	for (const image of state.images) {
		const resource = verified.get(image.id);
		if (!resource) {
			return {
				ok: false,
				kind: 'error',
				error: error('decode-failure', `Original bytes for the ${image.role} image are not available to complete the open.`)
			};
		}
		assets.set(image.id, { bytes: resource.bytes, decoded: resource.decoded });
	}
	return { ok: true, state, assets };
}

/**
 * Resolves one repair issue with already-read, hashed, and decoded bytes. An exact
 * hash/type/dimension match keeps the original manifest image (metadata and coordinates
 * unchanged). Any other image is an explicit replacement applied through the existing
 * domain mutation boundary (`ProjectEditor.replaceImage`, with `retainPoints: true` for
 * same dimensions and `false` only after explicit discard confirmation for different
 * dimensions) on a minimal temporary editor built from the candidate state and verified
 * assets; the temporary history is discarded. Returns a full open, an updated candidate
 * when other issues remain, a discard confirmation, or a structured error.
 */
export function resolveRepairWithBytes(
	candidate: RepairCandidate,
	input: RepairResolutionBytes,
	options: ResolveRepairBytesOptions = {}
): RepairResolutionResult {
	const manifest = candidate.state.images.find((image) => image.role === input.role);
	if (!manifest) {
		return { ok: false, kind: 'error', error: error('path', `The project has no ${input.role} image to repair.`) };
	}
	if (!candidate.issues.some((issue) => issue.image.role === input.role)) {
		return { ok: false, kind: 'error', error: error('path', `The ${input.role} image is not part of this open repair.`) };
	}

	const exact =
		input.sha256 === manifest.sha256 &&
		input.widthPx === manifest.widthPx &&
		input.heightPx === manifest.heightPx &&
		input.mimeType.toLowerCase() === (manifest.mimeType ?? '').toLowerCase();

	if (exact) {
		// Exact hash/type/dimension: the original manifest image, metadata, and
		// coordinates stay untouched; only the resolved bytes/decoded are added
		// transiently for the final open.
		const verified = new Map(candidate.verified);
		verified.set(manifest.id, { bytes: input.bytes, decoded: input.decoded });
		const remaining = candidate.issues.filter((issue) => issue.image.role !== input.role);
		if (remaining.length > 0) {
			return { ok: false, kind: 'incomplete', candidate: { state: candidate.state, issues: remaining, verified } };
		}
		return openResultFrom(candidate.state, verified);
	}

	// Explicit replacement. The domain boundary owns every point rule: same dimensions
	// re-target points (`retainPoints: true`), different dimensions with affected pairs
	// require the existing explicit discard confirmation (`retainPoints: false`).
	const sameDimensions = manifest.widthPx === input.widthPx && manifest.heightPx === input.heightPx;
	const affectedCount = candidate.state.controlPointPairs.filter(
		(pair) => pair.source.imageId === manifest.id || pair.target.imageId === manifest.id
	).length;
	if (!sameDimensions && affectedCount > 0 && !options.discard) {
		return { ok: false, kind: 'discard-confirm', role: input.role, affectedCount };
	}

	const createAssetId = options.createAssetId ?? (() => globalThis.crypto.randomUUID());
	const replacement = createImageAsset({
		id: createAssetId(),
		role: input.role,
		fileName: input.fileName,
		mimeType: input.mimeType,
		widthPx: input.widthPx,
		heightPx: input.heightPx,
		sha256: input.sha256,
		bundlePath: bundlePathFor(input.role, input.mimeType)
	});

	// Minimal temporary editor over the parsed candidate so replacement runs through the
	// domain mutation boundary (validation, point re-targeting/discard, asset registry).
	// Its history is local and discarded; nothing here touches the live project.
	let temporary: ProjectEditor;
	try {
		temporary = new ProjectEditor({
			state: candidate.state,
			assets: verifiedAssets(candidate),
			now: options.now
		});
	} catch (caught) {
		return { ok: false, kind: 'error', error: error('path', `Could not prepare the replacement: ${messageOf(caught)}`) };
	}

	try {
		temporary.replaceImage({
			role: input.role,
			asset: replacement,
			bytes: input.bytes,
			retainPoints: sameDimensions
		});
		temporary.setDecodedResource(replacement.id, input.decoded);
	} catch (caught) {
		// The domain boundary rejected the replacement atomically (for example a
		// colliding injected replacement asset id): the candidate and live project are
		// untouched and a structured error is returned, never an exception.
		return { ok: false, kind: 'error', error: error('path', `The replacement image could not be applied: ${messageOf(caught)}`) };
	}

	const state = temporary.state;
	const remaining = candidate.issues.filter((issue) => issue.image.role !== input.role);
	const unresolvedIds = new Set(remaining.map((issue) => issue.image.id));
	// Preserve prior verified resources that are still relevant and add the replacement
	// resource from the domain editor (the old manifest-id entry is gone from the new
	// state). Images represented by remaining repair issues are still unresolved and are
	// not required here; only the final open requires a resource for every image.
	const verified = new Map<string, { bytes: Uint8Array; decoded: unknown }>();
	for (const image of state.images) {
		if (unresolvedIds.has(image.id)) continue;
		const resource = temporary.getAssetResource(image.id);
		if (!resource) {
			return {
				ok: false,
				kind: 'error',
				error: error('decode-failure', `Original bytes for the ${image.role} image are not available to complete the open.`)
			};
		}
		verified.set(image.id, { bytes: resource.bytes, decoded: resource.decoded });
	}

	if (remaining.length > 0) {
		return { ok: false, kind: 'incomplete', candidate: { state, issues: remaining, verified } };
	}
	return openResultFrom(state, verified);
}

export interface ResolveRepairFileOptions extends ResolveRepairBytesOptions {
	decode?: DecodeImageFile;
	hash?: HashBytes;
	readBytes?: (file: File) => Promise<Uint8Array>;
}

/** Reads, decodes, and hashes a locally supplied PNG/JPEG, then resolves the repair. */
export async function resolveRepairWithFile(
	candidate: RepairCandidate,
	file: File,
	role: ImageRole,
	options: ResolveRepairFileOptions = {}
): Promise<RepairResolutionResult> {
	const { decode = decodeImageFile, hash = sha256Hex, readBytes: read = readFileBytes } = options;
	if (!isSupportedMimeType(file.type)) {
		return {
			ok: false,
			kind: 'error',
			error: error('unsupported-mime', `"${file.name}" is not a PNG or JPEG image.`)
		};
	}
	let decoded: DecodedImage;
	try {
		decoded = await decode(file);
	} catch {
		return { ok: false, kind: 'error', error: error('decode-failure', `Could not decode "${file.name}".`) };
	}
	if (
		!Number.isFinite(decoded.widthPx) ||
		!Number.isFinite(decoded.heightPx) ||
		decoded.widthPx <= 0 ||
		decoded.heightPx <= 0
	) {
		return { ok: false, kind: 'error', error: error('decode-failure', `"${file.name}" decoded with invalid dimensions.`) };
	}
	let bytes: Uint8Array;
	try {
		bytes = await read(file);
	} catch {
		return { ok: false, kind: 'error', error: error('read-bytes', `Could not read the bytes of "${file.name}".`) };
	}
	let sha256: Sha256Hex;
	try {
		sha256 = await hash(bytes);
	} catch {
		return { ok: false, kind: 'error', error: error('read-bytes', `Could not hash the bytes of "${file.name}".`) };
	}
	return resolveRepairWithBytes(
		candidate,
		{
			role,
			bytes,
			fileName: file.name,
			mimeType: file.type,
			widthPx: decoded.widthPx,
			heightPx: decoded.heightPx,
			decoded: decoded.image,
			sha256
		},
		options
	);
}

export interface ResolveRepairArchivedOptions extends ResolveRepairBytesOptions {
	decode?: DecodeImageFile;
	hash?: HashBytes;
}

/**
 * Explicitly uses the archived bytes of a `hash-mismatch` image as a replacement (never
 * automatic): the archived bytes are validated and decoded, then treated as a normal
 * new intake image under the P0-005/P0-004 point rules.
 */
export async function resolveRepairWithArchivedBytes(
	candidate: RepairCandidate,
	role: ImageRole,
	options: ResolveRepairArchivedOptions = {}
): Promise<RepairResolutionResult> {
	const issue = candidate.issues.find(
		(candidateIssue) => candidateIssue.image.role === role && candidateIssue.reason === 'hash-mismatch'
	);
	if (!issue?.archivedBytes) {
		return { ok: false, kind: 'error', error: error('path', `The ${role} image has no archived bytes to use.`) };
	}
	const { decode = decodeImageFile, hash = sha256Hex } = options;
	const file = new File([blobPartOf(issue.archivedBytes)], issue.image.fileName || `${role}-archived`, {
		type: issue.image.mimeType
	});
	let decoded: DecodedImage;
	try {
		decoded = await decode(file);
	} catch {
		return { ok: false, kind: 'error', error: error('decode-failure', `The archived ${role} image bytes could not be decoded.`) };
	}
	let sha256: Sha256Hex;
	try {
		sha256 = await hash(issue.archivedBytes);
	} catch {
		return { ok: false, kind: 'error', error: error('read-bytes', `Could not hash the archived ${role} image bytes.`) };
	}
	return resolveRepairWithBytes(
		candidate,
		{
			role,
			bytes: issue.archivedBytes,
			fileName: issue.image.fileName || `${role}-archived`,
			mimeType: issue.image.mimeType,
			widthPx: decoded.widthPx,
			heightPx: decoded.heightPx,
			decoded: decoded.image,
			sha256
		},
		options
	);
}
