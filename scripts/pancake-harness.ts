/**
 * Runs the REAL production pancake pipeline (basketDetection.worker.ts,
 * PANCAKE_STACK_ONLY branch: P1-P6.2) against a .chainspot.zip fixture,
 * entirely in Node, by polyfilling only the browser-only surface the
 * worker touches (OffscreenCanvas/createImageBitmap/self.postMessage) with
 * thin identity-copy shims -- no detection logic is reimplemented.
 *
 * Justification for the shims being safe: in the PANCAKE_STACK_ONLY branch
 * the worker only ever calls `new OffscreenCanvas(bitmap.width,
 * bitmap.height)` then `drawImage(bitmap, 0, 0)` with no scale/offset args
 * (full-resolution raster + template rasterization) -- i.e. every draw is
 * an identity copy at 1:1 scale. grayscaleRaster's MAX_ANALYSIS_DIM resize
 * path is dead code on this branch and is not exercised.
 *
 * Usage: npx tsx pancake-harness.ts <path-to-chainspot.zip> <projectRoot>
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { unzipSync } from 'fflate';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const [, , zipPathArg, projectRootArg] = process.argv;
if (!zipPathArg || !projectRootArg) {
	console.error('Usage: npx tsx pancake-harness.ts <path-to-chainspot.zip> <projectRoot>');
	process.exit(1);
}
const projectRoot = projectRootArg;
const zipPath = zipPathArg;

class FakeImageBitmap {
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
				`pancake-harness: OffscreenCanvas shim only supports identity 1:1 draws (got dx=${dx} dy=${dy} dw=${w} dh=${h} bitmap=${bitmap.width}x${bitmap.height} canvas=${this.width}x${this.height})`
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
(globalThis as any).OffscreenCanvas = FakeOffscreenCanvas;

async function decodeImageBuffer(buf: Buffer, contentType: string) {
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

(globalThis as any).createImageBitmap = async (blob: Blob) => {
	const buf = Buffer.from(await blob.arrayBuffer());
	const { width, height, rgba } = await decodeImageBuffer(buf, blob.type || '');
	return new FakeImageBitmap(width, height, rgba);
};

let resolveCaptured: ((msg: any) => void) | null = null;
const capturedPromise = new Promise<any>((resolve) => {
	resolveCaptured = resolve;
});
(globalThis as any).self = {
	postMessage: (msg: any) => {
		if (msg && msg.kind === 'progress') {
			console.error(`[progress] ${msg.progress?.stage}: ${msg.progress?.message} (${Math.round(msg.progress?.elapsedMs ?? 0)}ms)`);
			return;
		}
		resolveCaptured?.(msg);
	},
	onmessage: null as any
};

function contentTypeFor(path: string): string {
	const ext = extname(path).toLowerCase();
	if (ext === '.png') return 'image/png';
	if (ext === '.json') return 'application/json';
	if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
	return 'application/octet-stream';
}

async function main() {
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
	if (!address || typeof address === 'string') throw new Error('server did not bind a port');
	const basePath = `http://127.0.0.1:${address.port}`;

	// Import the worker module AFTER globals are set (top-level code sets self.onmessage).
	await import(join(projectRoot, 'src/lib/autoAnnotation/basketDetection.worker.ts'));

	let bitmap: FakeImageBitmap;
	if (extname(zipPath).toLowerCase() === '.zip') {
		const entries = unzipSync(await readFile(zipPath));
		const bytes = entries['images/source-original.jpg'];
		if (!bytes) throw new Error(`${zipPath} has no images/source-original.jpg`);
		const decoded = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 2048 });
		bitmap = new FakeImageBitmap(
			decoded.width,
			decoded.height,
			new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength)
		);
	} else {
		const raw = await readFile(zipPath);
		const { width, height, rgba } = await decodeImageBuffer(raw, contentTypeFor(zipPath));
		bitmap = new FakeImageBitmap(width, height, rgba);
	}

	const request = {
		kind: 'detect-course',
		token: 'pancake-harness',
		basePath,
		bitmap,
		widthPx: bitmap.width,
		heightPx: bitmap.height
	};

	const startedAt = Date.now();
	(globalThis as any).self.onmessage({ data: request });
	const result = await capturedPromise;
	const wallMs = Date.now() - startedAt;
	server.close();

	if (!result.ok) {
		console.error('DETECTION FAILED:', result.message);
		process.exit(1);
	}
	console.log(
		JSON.stringify(
			{ wallMs, course: result.course },
			(_key, value) => (value instanceof Uint8Array || value instanceof Uint8ClampedArray ? undefined : value)
		)
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
