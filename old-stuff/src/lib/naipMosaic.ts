/**
 * ChainSpot NAIP tile-grid fetch and mosaic assembly.
 *
 * Fetches every tile in a `TileGridPlan` and composes the results into one PNG.
 * Placement is pure arithmetic (row/col -> pixel offset) because `planTileGrid`
 * already chose each tile's geographic extent so adjacent tiles butt edge-to-edge —
 * there is no feature matching here, unlike the Stitch Map screenshot compositor.
 */
import { fetchNaipImage, NAIP_EXPORT_SIZE_PX } from './naip';
import type { FetchLike, GeoPoint } from './naip';
import type { TileGridPlan } from './naipGrid';

/** Tiles are fetched a few at a time, out of courtesy to a shared public federal
 * service that enforces no request quota of its own — nothing stops a naive
 * implementation from firing all nine at once, so this module imposes the restraint
 * instead. */
export const TILE_FETCH_CONCURRENCY = 3;
const TILE_FETCH_RETRIES = 2;
const TILE_FETCH_RETRY_DELAY_MS = 500;

export type MosaicFetchErrorKind = 'network' | 'http-error' | 'bad-content-type';

export class MosaicFetchError extends Error {
	readonly kind: MosaicFetchErrorKind;
	readonly tileIndex: number;

	constructor(kind: MosaicFetchErrorKind, tileIndex: number, message: string) {
		super(message);
		this.name = 'MosaicFetchError';
		this.kind = kind;
		this.tileIndex = tileIndex;
	}
}

export type TileGridFetchResult = { ok: true; tiles: Blob[] } | { ok: false; error: MosaicFetchError };

type DelayFn = (ms: number) => Promise<void>;

const defaultDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchTileWithRetry(
	center: GeoPoint,
	radiusMeters: number,
	index: number,
	fetchImpl: FetchLike | undefined,
	delay: DelayFn
): Promise<{ ok: true; blob: Blob } | { ok: false; error: MosaicFetchError }> {
	let lastError: MosaicFetchError | null = null;
	for (let attempt = 0; attempt <= TILE_FETCH_RETRIES; attempt++) {
		const result = await fetchNaipImage(center, radiusMeters, { fetch: fetchImpl });
		if (result.ok) return { ok: true, blob: result.blob };
		lastError = new MosaicFetchError(result.error.kind, index, result.error.message);
		// A "no coverage here" response is a real answer, not a transient failure —
		// retrying the exact same bbox can't produce imagery that doesn't exist.
		if (result.error.kind === 'bad-content-type') break;
		if (attempt < TILE_FETCH_RETRIES) await delay(TILE_FETCH_RETRY_DELAY_MS * (attempt + 1));
	}
	return { ok: false, error: lastError as MosaicFetchError };
}

/**
 * Fetches every tile in `plan.centers`, `TILE_FETCH_CONCURRENCY` at a time. Any tile
 * that still fails after retrying fails the whole grid — a mosaic with a silently
 * blank patch would be worse than asking the user to retry the fetch.
 */
export async function fetchTileGrid(
	plan: TileGridPlan,
	options: { fetch?: FetchLike; delay?: DelayFn } = {}
): Promise<TileGridFetchResult> {
	const { fetch: fetchImpl, delay = defaultDelay } = options;
	const tiles = new Array<Blob | null>(plan.centers.length).fill(null);
	let firstError: MosaicFetchError | null = null;
	let nextIndex = 0;

	async function worker(): Promise<void> {
		for (;;) {
			if (firstError) return;
			const index = nextIndex++;
			if (index >= plan.centers.length) return;
			const result = await fetchTileWithRetry(plan.centers[index], plan.tileRadiusMeters, index, fetchImpl, delay);
			if (!result.ok) {
				firstError ??= result.error;
				return;
			}
			tiles[index] = result.blob;
		}
	}

	const workerCount = Math.min(TILE_FETCH_CONCURRENCY, plan.centers.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));

	if (firstError) return { ok: false, error: firstError };
	return { ok: true, tiles: tiles as Blob[] };
}

export interface MosaicRenderEnv {
	createCanvas(): HTMLCanvasElement;
	toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null>;
}

export const defaultMosaicRenderEnv: MosaicRenderEnv = {
	createCanvas() {
		return document.createElement('canvas');
	},
	toBlob(canvas, type) {
		return new Promise((resolve, reject) => {
			canvas.toBlob((blob) => {
				if (blob) resolve(blob);
				else reject(new Error('Mosaic PNG encoding failed. Try again.'));
			}, type);
		});
	}
};

/**
 * Draws `rows * cols` already-decoded tile images onto one canvas at their computed
 * grid offsets (row-major, matching `TileGridPlan.centers` order) and encodes the
 * result as a PNG. Every tile is exactly `tileSizePx` square already — NAIP's
 * `exportImage` always returns the requested raster size — so each draw is a 1:1
 * copy, never a resample.
 */
export async function composeMosaic(
	images: readonly HTMLImageElement[],
	rows: number,
	cols: number,
	tileSizePx: number = NAIP_EXPORT_SIZE_PX,
	env: MosaicRenderEnv = defaultMosaicRenderEnv
): Promise<Blob> {
	if (images.length !== rows * cols) {
		throw new Error(
			`composeMosaic: expected ${rows * cols} images for a ${rows}x${cols} grid, got ${images.length}.`
		);
	}
	const canvas = env.createCanvas();
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Could not allocate a canvas for the tile mosaic.');
	canvas.width = cols * tileSizePx;
	canvas.height = rows * tileSizePx;

	images.forEach((image, index) => {
		const row = Math.floor(index / cols);
		const col = index % cols;
		context.drawImage(image, col * tileSizePx, row * tileSizePx, tileSizePx, tileSizePx);
	});

	const blob = await env.toBlob(canvas, 'image/png');
	if (!blob) throw new Error('Mosaic PNG encoding failed. Try again.');
	return blob;
}
