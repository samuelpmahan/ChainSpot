/**
 * Shared Node-only browser-surface shims for headlessly running
 * `basketDetection.worker.ts`'s real `PANCAKE_STACK_ONLY` branch outside a
 * browser/worker context. Extracted from `pancake-harness.ts` so
 * `cv-replay-run.ts` can reuse the exact same plumbing rather than
 * duplicating it.
 *
 * Justification for the shims being safe: in the `PANCAKE_STACK_ONLY` branch
 * the worker only ever calls `new OffscreenCanvas(bitmap.width,
 * bitmap.height)` then `drawImage(bitmap, 0, 0)` with no scale/offset args
 * (full-resolution raster + template rasterization) -- i.e. every draw is
 * an identity copy at 1:1 scale. `grayscaleRaster`'s `MAX_ANALYSIS_DIM`
 * resize path is dead code on this branch and is not exercised.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export class FakeImageBitmap {
	constructor(
		public width: number,
		public height: number,
		public rgba: Uint8ClampedArray
	) {}
	close() {}
}

class FakeCanvasContext {
	constructor(
		private width: number,
		private height: number,
		private buf: Uint8ClampedArray
	) {}
	drawImage(bitmap: FakeImageBitmap, dx: number, dy: number, dw?: number, dh?: number) {
		const w = dw ?? bitmap.width;
		const h = dh ?? bitmap.height;
		if (dx !== 0 || dy !== 0 || w !== bitmap.width || h !== bitmap.height || w !== this.width || h !== this.height) {
			throw new Error(
				`fakeBrowser: OffscreenCanvas shim only supports identity 1:1 draws (got dx=${dx} dy=${dy} dw=${w} dh=${h} bitmap=${bitmap.width}x${bitmap.height} canvas=${this.width}x${this.height})`
			);
		}
		this.buf.set(bitmap.rgba);
	}
	getImageData(_x: number, _y: number, _w: number, _h: number) {
		return { data: this.buf };
	}
}

class FakeOffscreenCanvas {
	private buf: Uint8ClampedArray;
	constructor(
		public width: number,
		public height: number
	) {
		this.buf = new Uint8ClampedArray(width * height * 4);
	}
	getContext() {
		return new FakeCanvasContext(this.width, this.height, this.buf);
	}
}

export function installFakeBrowserGlobals(): void {
	(globalThis as any).OffscreenCanvas = FakeOffscreenCanvas;
	(globalThis as any).createImageBitmap = async (blob: Blob) => {
		const buf = Buffer.from(await blob.arrayBuffer());
		const { width, height, rgba } = await decodeImageBuffer(buf, blob.type || '');
		return new FakeImageBitmap(width, height, rgba);
	};
}

export async function decodeImageBuffer(
	buf: Buffer,
	contentType: string
): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> {
	if (contentType.includes('png')) {
		const png = PNG.sync.read(buf);
		return {
			width: png.width,
			height: png.height,
			rgba: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength)
		};
	}
	const decoded = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 2048 });
	return {
		width: decoded.width,
		height: decoded.height,
		rgba: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength)
	};
}

export function contentTypeFor(path: string): string {
	const ext = extname(path).toLowerCase();
	if (ext === '.png') return 'image/png';
	if (ext === '.json') return 'application/json';
	if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
	return 'application/octet-stream';
}

/** Serves `<projectRoot>/static` on an ephemeral local port -- the worker fetches CV templates from it via the URL it's given as `basePath`. */
export async function startStaticServer(projectRoot: string): Promise<{ basePath: string; server: Server }> {
	const staticRoot = join(projectRoot, 'static');
	const server = createServer(async (req, res) => {
		try {
			const filePath = join(staticRoot, decodeURIComponent(req.url ?? ''));
			const data = await readFile(filePath);
			res.writeHead(200, { 'content-type': contentTypeFor(filePath) });
			res.end(data);
		} catch {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('fakeBrowser: server did not bind a port');
	return { basePath: `http://127.0.0.1:${address.port}`, server };
}

/**
 * Installs `self` with a captured-response `postMessage` and drives the real
 * worker module's `onmessage` with a `detect-course` request, resolving with
 * whatever the worker posts back (progress messages are routed to
 * `onProgress` and excluded from the resolved value).
 */
export function installFakeWorkerSelf(onProgress?: (message: any) => void): {
	dispatch: (data: any) => Promise<any>;
} {
	let resolveCaptured: ((msg: any) => void) | null = null;
	let capturedPromise = new Promise<any>((resolve) => {
		resolveCaptured = resolve;
	});
	(globalThis as any).self = {
		postMessage: (msg: any) => {
			if (msg && msg.kind === 'progress') {
				onProgress?.(msg);
				return;
			}
			resolveCaptured?.(msg);
		},
		onmessage: null as any
	};
	return {
		dispatch: async (data: any) => {
			capturedPromise = new Promise<any>((resolve) => {
				resolveCaptured = resolve;
			});
			(globalThis as any).self.onmessage({ data });
			return capturedPromise;
		}
	};
}

/** Loads a bare image file (png/jpg) as a `FakeImageBitmap`. */
export async function loadImageBitmap(path: string): Promise<FakeImageBitmap> {
	const raw = await readFile(path);
	const { width, height, rgba } = await decodeImageBuffer(raw, contentTypeFor(path));
	return new FakeImageBitmap(width, height, rgba);
}
