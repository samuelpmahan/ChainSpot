/**
 * Runs the REAL production pancake pipeline (basketDetection.worker.ts,
 * PANCAKE_STACK_ONLY branch: P1-P6.2) against a .chainspot.zip fixture,
 * entirely in Node, by polyfilling only the browser-only surface the
 * worker touches (OffscreenCanvas/createImageBitmap/self.postMessage) with
 * thin identity-copy shims -- no detection logic is reimplemented. See
 * `scripts/lib/fakeBrowser.ts` for the shims themselves and the safety
 * justification (shared with `cv-replay-run.ts`).
 *
 * Usage: npx tsx pancake-harness.ts <path-to-chainspot.zip> <projectRoot>
 */
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { unzipSync } from 'fflate';
import jpeg from 'jpeg-js';
import {
	FakeImageBitmap,
	contentTypeFor,
	decodeImageBuffer,
	installFakeBrowserGlobals,
	installFakeWorkerSelf,
	startStaticServer
} from './lib/fakeBrowser';

const [, , zipPathArg, projectRootArg] = process.argv;
if (!zipPathArg || !projectRootArg) {
	console.error('Usage: npx tsx pancake-harness.ts <path-to-chainspot.zip> <projectRoot>');
	process.exit(1);
}
const projectRoot = projectRootArg;
const zipPath = zipPathArg;

installFakeBrowserGlobals();

async function main() {
	const { basePath, server } = await startStaticServer(projectRoot);

	const { dispatch } = installFakeWorkerSelf((msg) => {
		console.error(`[progress] ${msg.progress?.stage}: ${msg.progress?.message} (${Math.round(msg.progress?.elapsedMs ?? 0)}ms)`);
	});

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
	const result = await dispatch(request);
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
