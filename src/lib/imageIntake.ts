/**
 * ChainSpot local image intake (P0-005).
 *
 * Turns a locally selected `File` into (a) plain image-asset metadata for durable
 * `ProjectState` and (b) a transient browser-decoded image for Konva rendering.
 *
 * Pipeline:
 * 1. MIME validation (PNG/JPEG only) before any decoding.
 * 2. Browser-native decode of the candidate (object URL + `Image.decode()`). The
 *    object URL is revoked immediately after successful or failed decoding, once the
 *    decoded image no longer depends on it.
 * 3. Non-zero intrinsic-dimension validation.
 * 4. Domain mutation through `ProjectEditor` only:
 *    - first image for a role: `assignImage`;
 *    - same-dimension replacement: `replaceImage` with `retainPoints: true` (existing
 *      points are re-targeted, never invalidated);
 *    - different-dimension replacement with affected pairs: explicit user confirmation
 *      before `replaceImage` with `retainPoints: false`; cancellation preserves the
 *      current image, points, history, and the other pane.
 * 5. The decoded image is registered as the asset's transient decoded resource
 *    (`setDecodedResource`) so undo/redo can render the restored original. The
 *    `ProjectEditor` registry releases it once no current, undo, or redo snapshot
 *    references the asset.
 *
 * Lifecycle: an uncommitted candidate's decoded image and bytes are plain references
 * that become unreachable after failure or cancellation, and the object URL was already
 * revoked by the decoder; no explicit teardown is needed. No File, Blob, object URL,
 * decoded image, bytes, or Konva node ever enters durable project state.
 *
 * Decoding is injectable (`decode`) so deterministic tests can simulate browser
 * decoding, decode failures, and zero dimensions without a browser; real Chromium
 * decoding is covered by Playwright.
 */

import { createImageAsset, findImageByRole } from './domain/project';
import type { ImageAsset, ImageRole } from './domain/project';
import type { ProjectEditor } from './domain/editor';

export type ImageOrientation = 'portrait' | 'landscape' | 'square';

export const SUPPORTED_MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/jpg'];

/** Lowercase SHA-256 hex digest, exactly 64 hex characters. */
export type Sha256Hex = string;

/** Native Web Crypto focused SHA-256 of original image bytes; no crypto dependency. */
export type HashBytes = (bytes: Uint8Array) => Promise<Sha256Hex>;

export function isValidSha256Hex(value: unknown): value is Sha256Hex {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** SHA-256 via `globalThis.crypto.subtle`, lowercase 64-hex. */
export const sha256Hex: HashBytes = async (bytes) => {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** Stable bundle image extension by MIME type (PNG/JPEG only). */
export const IMAGE_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg'
};

/**
 * The stable `images/` bundle path for an uploaded original, derived from role and
 * MIME extension (for example `images/source-original.png` / `images/target-original.jpg`).
 */
export function bundlePathFor(role: ImageRole, mimeType: string): string {
	const extension = IMAGE_EXTENSION_BY_MIME[mimeType.toLowerCase()];
	if (!extension) {
		throw new Error(`bundlePathFor: unsupported image MIME type '${mimeType}'`);
	}
	const base = role === 'source-overview' ? 'source-original' : 'target-original';
	return `images/${base}.${extension}`;
}

export const ORIENTATION_LABELS: Readonly<Record<ImageOrientation, string>> = {
	portrait: 'Portrait',
	landscape: 'Landscape',
	square: 'Square'
};

export type IntakeErrorKind =
	| 'unsupported-type'
	| 'decode-failure'
	| 'invalid-dimension'
	| 'read-failure';

export class IntakeError extends Error {
	readonly kind: IntakeErrorKind;

	constructor(kind: IntakeErrorKind, message: string) {
		super(message);
		this.name = 'IntakeError';
		this.kind = kind;
	}
}

export interface DecodedImage {
	/** Browser-native decoded original. Transient only; never enters durable state. */
	image: HTMLImageElement;
	widthPx: number;
	heightPx: number;
}

export type DecodeImageFile = (file: File) => Promise<DecodedImage>;

export function isSupportedMimeType(mimeType: string | null | undefined): boolean {
	return typeof mimeType === 'string' && SUPPORTED_MIME_TYPES.includes(mimeType.toLowerCase());
}

/**
 * Derives the simple orientation from browser-decoded intrinsic dimensions:
 * portrait (height > width), landscape (width > height), or square.
 */
export function deriveOrientation(widthPx: number, heightPx: number): ImageOrientation {
	if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
		throw new Error(
			`deriveOrientation: width and height must be positive finite numbers, got width=${widthPx}, height=${heightPx}`
		);
	}
	if (widthPx === heightPx) return 'square';
	return widthPx > heightPx ? 'landscape' : 'portrait';
}

export interface DecodeEnvironment {
	createObjectUrl: (file: File) => string;
	revokeObjectUrl: (url: string) => void;
	ImageConstructor: typeof Image;
}

/**
 * Browser-native decoding via an object URL and `Image.decode()`. The object URL is
 * revoked in `finally`, immediately after the decode settles, because the decoded
 * image no longer depends on the URL afterwards.
 */
export async function decodeImageFile(file: File): Promise<DecodedImage> {
	return decodeImageFileWith(file, {
		createObjectUrl: (candidate) => URL.createObjectURL(candidate),
		revokeObjectUrl: (url) => URL.revokeObjectURL(url),
		ImageConstructor: Image
	});
}

/** Injectable form of `decodeImageFile` for deterministic tests. */
export async function decodeImageFileWith(
	file: File,
	env: DecodeEnvironment
): Promise<DecodedImage> {
	const url = env.createObjectUrl(file);
	const image = new env.ImageConstructor();
	try {
		image.src = url;
		await image.decode();
		return { image, widthPx: image.naturalWidth, heightPx: image.naturalHeight };
	} finally {
		env.revokeObjectUrl(url);
	}
}

export interface IntakeImageFileOptions {
	editor: ProjectEditor;
	role: ImageRole;
	file: File;
	/** Injectable browser decoder; defaults to the object-URL `Image.decode()` path. */
	decode?: DecodeImageFile;
	/**
	 * Called only when the replacement dimensions differ and existing pairs on the
	 * role's image would be discarded. Returning false cancels the replacement.
	 */
	confirmDiscard?: (affectedPairCount: number) => boolean | Promise<boolean>;
	createAssetId?: () => string;
	/**
	 * Injectable SHA-256 of the exact original bytes; defaults to native Web Crypto.
	 * The digest is computed before any `assignImage`/`replaceImage` mutation and is
	 * stored as the asset manifest `sha256`.
	 */
	hash?: HashBytes;
}

export type IntakeStatus =
	| 'assigned'
	| 'replaced-retained'
	| 'replaced-discarded'
	| 'cancelled';

export type IntakeResult =
	| { ok: true; status: IntakeStatus; asset: ImageAsset }
	| { ok: false; error: IntakeError };

/** Reads a `File` into a `Uint8Array` via `arrayBuffer()` with a FileReader fallback. */
export async function readFileBytes(file: File): Promise<Uint8Array> {
	if (typeof file.arrayBuffer === 'function') {
		return new Uint8Array(await file.arrayBuffer());
	}
	return await new Promise<Uint8Array>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(file);
	});
}

/**
 * Decodes and validates a candidate before mutating the project. A failed or
 * cancelled intake never touches project state, history, or the other role.
 *
 * The exact original bytes are read and hashed (native focused SHA-256) before any
 * mutation, so the manifest `sha256` always represents the loaded original bytes and
 * a read/hash failure is atomic: nothing is registered and no domain state changes.
 */
export async function intakeImageFile(options: IntakeImageFileOptions): Promise<IntakeResult> {
	const {
		editor,
		role,
		file,
		decode = decodeImageFile,
		confirmDiscard = () => false,
		createAssetId = () => globalThis.crypto.randomUUID(),
		hash = sha256Hex
	} = options;

	if (!isSupportedMimeType(file.type)) {
		return {
			ok: false,
			error: new IntakeError(
				'unsupported-type',
				`Unsupported file type "${file.type || 'unknown'}": ChainSpot accepts PNG and JPEG images.`
			)
		};
	}

	let decoded: DecodedImage;
	try {
		decoded = await decode(file);
	} catch {
		return {
			ok: false,
			error: new IntakeError('decode-failure', `Could not decode "${file.name}".`)
		};
	}

	const { widthPx, heightPx } = decoded;
	if (
		!Number.isFinite(widthPx) ||
		!Number.isFinite(heightPx) ||
		widthPx <= 0 ||
		heightPx <= 0
	) {
		return {
			ok: false,
			error: new IntakeError(
				'invalid-dimension',
				`"${file.name}" decoded with invalid dimensions (${widthPx} x ${heightPx}); width and height must be greater than zero.`
			)
		};
	}

	let bytes: Uint8Array;
	try {
		bytes = await readFileBytes(file);
	} catch {
		return {
			ok: false,
			error: new IntakeError('read-failure', `Could not read the bytes of "${file.name}".`)
		};
	}

	let sha256: Sha256Hex;
	try {
		sha256 = await hash(bytes);
	} catch {
		return {
			ok: false,
			error: new IntakeError(
				'read-failure',
				`Could not hash the bytes of "${file.name}". The image was not changed.`
			)
		};
	}

	const asset = createImageAsset({
		id: createAssetId(),
		role,
		fileName: file.name,
		mimeType: file.type,
		widthPx,
		heightPx,
		sha256,
		bundlePath: bundlePathFor(role, file.type)
	});

	const current = findImageByRole(editor.state.images, role);
	if (!current) {
		editor.assignImage({ role, asset, bytes });
		editor.setDecodedResource(asset.id, decoded.image);
		return { ok: true, status: 'assigned', asset };
	}

	const sameDimensions = current.widthPx === widthPx && current.heightPx === heightPx;
	const affectedCount = editor.state.controlPointPairs.filter(
		(pair) => pair.source.imageId === current.id || pair.target.imageId === current.id
	).length;

	if (sameDimensions) {
		editor.replaceImage({ role, asset, bytes, retainPoints: true });
		editor.setDecodedResource(asset.id, decoded.image);
		return { ok: true, status: 'replaced-retained', asset };
	}

	if (affectedCount > 0) {
		const confirmed = await confirmDiscard(affectedCount);
		if (!confirmed) {
			return { ok: true, status: 'cancelled', asset };
		}
	}

	editor.replaceImage({ role, asset, bytes });
	editor.setDecodedResource(asset.id, decoded.image);
	return { ok: true, status: 'replaced-discarded', asset };
}
