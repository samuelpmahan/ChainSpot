import { describe, expect, test } from 'vitest';
import { composeMosaic, fetchTileGrid, TILE_FETCH_CONCURRENCY } from '../../src/lib/naipMosaic';
import type { MosaicRenderEnv } from '../../src/lib/naipMosaic';
import type { TileGridPlan } from '../../src/lib/naipGrid';
import type { FetchLike } from '../../src/lib/naip';

const noDelay = async () => {};

function pngResponse(): Response {
	return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
		status: 200,
		headers: { 'content-type': 'image/png' }
	});
}

describe('fetchTileGrid', () => {
	test('fetches every tile in the plan and returns one blob per center, in order', async () => {
		const plan: TileGridPlan = {
			rows: 1,
			cols: 2,
			tileRadiusMeters: 150,
			centers: [
				{ lat: 45, lon: -93 },
				{ lat: 45, lon: -92.9 }
			]
		};
		const urls: string[] = [];
		const okFetch: FetchLike = async (url) => {
			urls.push(String(url));
			return pngResponse();
		};
		const result = await fetchTileGrid(plan, { fetch: okFetch });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.tiles).toHaveLength(2);
			for (const tile of result.tiles) expect(tile.size).toBeGreaterThan(0);
		}
		expect(urls).toHaveLength(2);
		// Each tile's request must carry a distinct bbox (they're at different lon).
		const bboxes = urls.map((url) => new URL(url).searchParams.get('bbox'));
		expect(new Set(bboxes).size).toBe(2);
	});

	test('retries a transient network failure and still succeeds', async () => {
		let attempts = 0;
		const flaky: FetchLike = async () => {
			attempts++;
			if (attempts === 1) throw new TypeError('Failed to fetch');
			return pngResponse();
		};
		const plan: TileGridPlan = { rows: 1, cols: 1, tileRadiusMeters: 150, centers: [{ lat: 45, lon: -93 }] };
		const result = await fetchTileGrid(plan, { fetch: flaky, delay: noDelay });
		expect(result.ok).toBe(true);
		expect(attempts).toBe(2);
	});

	test('does not retry a no-coverage (bad-content-type) response — retrying the same bbox can\'t help', async () => {
		let calls = 0;
		const noCoverage: FetchLike = async () => {
			calls++;
			return new Response(JSON.stringify({ error: 'no imagery' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		};
		const plan: TileGridPlan = { rows: 1, cols: 1, tileRadiusMeters: 150, centers: [{ lat: 45, lon: -93 }] };
		const result = await fetchTileGrid(plan, { fetch: noCoverage, delay: noDelay });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe('bad-content-type');
			expect(result.error.tileIndex).toBe(0);
		}
		expect(calls).toBe(1);
	});

	test('a tile that never recovers fails the whole grid with a typed error', async () => {
		const alwaysFail: FetchLike = async () => {
			throw new TypeError('Failed to fetch');
		};
		const plan: TileGridPlan = {
			rows: 1,
			cols: 2,
			tileRadiusMeters: 150,
			centers: [
				{ lat: 45, lon: -93 },
				{ lat: 45, lon: -92.9 }
			]
		};
		const result = await fetchTileGrid(plan, { fetch: alwaysFail, delay: noDelay });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe('network');
	});

	test('never runs more than TILE_FETCH_CONCURRENCY tiles in flight at once', async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const plan: TileGridPlan = {
			rows: 3,
			cols: 3,
			tileRadiusMeters: 150,
			centers: Array.from({ length: 9 }, (_, index) => ({ lat: 45, lon: -93 + index * 0.01 }))
		};
		const trackingFetch: FetchLike = async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight--;
			return pngResponse();
		};
		const result = await fetchTileGrid(plan, { fetch: trackingFetch });
		expect(result.ok).toBe(true);
		expect(maxInFlight).toBeLessThanOrEqual(TILE_FETCH_CONCURRENCY);
	});
});

describe('composeMosaic', () => {
	test('draws each image at its computed grid offset with no resampling', async () => {
		const drawCalls: Array<{ dx: number; dy: number; dWidth: number; dHeight: number }> = [];
		const context = {
			drawImage(_image: HTMLImageElement, dx: number, dy: number, dWidth: number, dHeight: number): void {
				drawCalls.push({ dx, dy, dWidth, dHeight });
			}
		};
		const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
		const env: MosaicRenderEnv = { createCanvas: () => canvas, toBlob: async () => new Blob(['mosaic']) };
		const images = Array.from({ length: 4 }, () => ({}) as HTMLImageElement);

		const blob = await composeMosaic(images, 2, 2, 100, env);

		expect(canvas.width).toBe(200);
		expect(canvas.height).toBe(200);
		expect(drawCalls.map((call) => [call.dx, call.dy])).toEqual([
			[0, 0],
			[100, 0],
			[0, 100],
			[100, 100]
		]);
		expect(drawCalls.every((call) => call.dWidth === 100 && call.dHeight === 100)).toBe(true);
		expect(blob.size).toBeGreaterThan(0);
	});

	test('rejects an image count that does not match rows x cols', async () => {
		const env: MosaicRenderEnv = {
			createCanvas: () => ({ getContext: () => ({ drawImage() {} }) }) as unknown as HTMLCanvasElement,
			toBlob: async () => new Blob()
		};
		await expect(composeMosaic([{} as HTMLImageElement], 2, 2, 100, env)).rejects.toThrow(/expected 4/);
	});
});
