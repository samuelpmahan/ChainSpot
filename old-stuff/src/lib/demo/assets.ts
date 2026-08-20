/**
 * ChainSpot demo asset loading.
 *
 * Turns a catalogued demo asset into an ordinary `File`, indistinguishable from
 * one the visitor picked themselves: same name, same MIME type, same bytes. The
 * demo then feeds that `File` into the product's real intake functions, so a
 * demo run exercises the identical validation, decoding, and error paths a
 * customer's own screenshots would.
 *
 * MIME type is validated against `SUPPORTED_MIME_TYPES` here rather than trusted
 * from the response, because a static host that serves a `.png` as
 * `application/octet-stream` would otherwise produce an "unsupported file type"
 * error deep inside intake, where a prospective customer would reasonably read
 * it as the product failing. Failures are returned as thrown `DemoAssetError`s
 * with the asset named, so the guide can say which file could not be loaded.
 */
import { SUPPORTED_MIME_TYPES } from '../imageIntake';
import { demoAssetUrl } from './catalog';
import type { DemoAsset } from './catalog';

export type DemoAssetErrorKind = 'network' | 'http-error' | 'unsupported-type' | 'empty';

export class DemoAssetError extends Error {
	readonly kind: DemoAssetErrorKind;
	readonly fileName: string;

	constructor(kind: DemoAssetErrorKind, fileName: string, message: string) {
		super(message);
		this.name = 'DemoAssetError';
		this.kind = kind;
		this.fileName = fileName;
	}
}

export type FetchLike = typeof fetch;

/**
 * Fetches one demo asset as a `File`. The catalogued MIME type wins over the
 * response's `Content-Type`: the catalog is repository-controlled and the header
 * is host-controlled.
 */
export async function fetchDemoFile(
	asset: DemoAsset,
	fetchImpl: FetchLike = fetch
): Promise<File> {
	if (!SUPPORTED_MIME_TYPES.includes(asset.mimeType)) {
		throw new DemoAssetError(
			'unsupported-type',
			asset.fileName,
			`Demo asset "${asset.fileName}" declares unsupported type "${asset.mimeType}".`
		);
	}

	let response: Response;
	try {
		response = await fetchImpl(demoAssetUrl(asset));
	} catch (cause) {
		throw new DemoAssetError(
			'network',
			asset.fileName,
			`Could not reach the demo asset "${asset.fileName}": ${
				cause instanceof Error ? cause.message : String(cause)
			}`
		);
	}

	if (!response.ok) {
		throw new DemoAssetError(
			'http-error',
			asset.fileName,
			`Demo asset "${asset.fileName}" responded ${response.status}.`
		);
	}

	const bytes = await response.arrayBuffer();
	if (bytes.byteLength === 0) {
		throw new DemoAssetError(
			'empty',
			asset.fileName,
			`Demo asset "${asset.fileName}" was empty.`
		);
	}

	return new File([bytes], asset.fileName, { type: asset.mimeType });
}

/**
 * Fetches several assets concurrently, preserving catalog order. One failure
 * fails the whole batch: a partial set would reach Stitch Map's Smart Import as
 * a wrong-file-count rejection, which reads as a product defect rather than the
 * asset-loading problem it is.
 */
export async function fetchDemoFiles(
	assets: readonly DemoAsset[],
	fetchImpl: FetchLike = fetch
): Promise<File[]> {
	return Promise.all(assets.map((asset) => fetchDemoFile(asset, fetchImpl)));
}
