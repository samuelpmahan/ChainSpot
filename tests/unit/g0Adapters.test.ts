// Tests for the two G0 decode adapters (packages/alg/src/adapters/{node,browser}.ts),
// which both produce InputAsset (packages/alg/src/g0/inputAsset.ts) from raw
// file bytes.
//
// Environment constraint (see vitest.config.ts: `environment: 'node'`, and
// AGENTS.md's testing-layout note that canvas output is untestable in
// jsdom): this suite runs with NO DOM globals available, so decodeBrowserFile
// (which needs File, crypto.subtle, createImageBitmap, OffscreenCanvas)
// cannot be exercised here at all. Everything below therefore only runs
// decodeNodeFile.
//
// What "cross-adapter parity" means here, concretely:
//   - PROVEN (by the tests below, against decodeNodeFile): imageId is the
//     sha256 hex of the raw source file bytes, and is completely insensitive
//     to how those bytes decode into pixels — two files with identical
//     decoded pixels but different encoded bytes get different imageIds.
//   - NOT PROVEN: that decodeBrowserFile computes the same imageId as
//     decodeNodeFile for the same file, or that the two adapters' RGBA output
//     agrees byte-for-byte. Both adapters read the SAME source (see each
//     file's header comment / packages/alg/src/g0/inputAsset.ts), and by
//     inspection both hash the raw byte buffer before any decode happens
//     (browser.ts: crypto.subtle.digest('SHA-256', bytes) where bytes =
//     file.arrayBuffer(); node.ts: createHash('sha256').update(bytes) where
//     bytes = readFile(filePath)) — but that is a code-reading claim, not
//     something this suite runs and checks. A real runtime cross-adapter
//     parity check needs a browser-environment test (Playwright) or a jsdom
//     run with canvas mocked, which AGENTS.md explicitly says not to add.
import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { decodeNodeFile } from '@chainspot/alg/adapters/node';

/** A tiny, deterministic RGBA pixel grid used to build fixture PNGs. */
const PIXELS: readonly (readonly [number, number, number, number])[] = [
	[10, 20, 30, 255],
	[40, 50, 60, 200],
	[70, 80, 90, 128],
	[100, 110, 120, 64],
	[150, 160, 170, 32],
	[200, 210, 220, 0]
];
const WIDTH = 3;
const HEIGHT = 2;

/** Encode PIXELS as a real PNG via pngjs's own encoder — never hand-craft PNG bytes. */
function encodeFixturePng(deflateLevel: number): Buffer {
	const png = new PNG({ width: WIDTH, height: HEIGHT });
	for (let i = 0; i < PIXELS.length; i++) {
		const o = i * 4;
		const [r, g, b, a] = PIXELS[i];
		png.data[o] = r;
		png.data[o + 1] = g;
		png.data[o + 2] = b;
		png.data[o + 3] = a;
	}
	return PNG.sync.write(png, { deflateLevel });
}

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'g0-adapters-test-'));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('decodeNodeFile (PNG)', () => {
	test('decodes pixels, sizes, sourceByteLength, and a byte-derived imageId', async () => {
		const bytes = encodeFixturePng(6);
		const filePath = join(dir, 'fixture.png');
		await writeFile(filePath, bytes);

		const asset = await decodeNodeFile(filePath);

		const expectedImageId = createHash('sha256').update(bytes).digest('hex');
		expect(asset.imageId).toBe(expectedImageId);
		expect(asset.imageId).toMatch(/^[0-9a-f]{64}$/);

		expect(asset.widthPx).toBe(WIDTH);
		expect(asset.heightPx).toBe(HEIGHT);
		expect(asset.rgba).toBeInstanceOf(Uint8ClampedArray);
		expect(asset.rgba.length).toBe(asset.widthPx * asset.heightPx * 4);
		expect(Array.from(asset.rgba)).toEqual(PIXELS.flat());

		const onDisk = await stat(filePath);
		expect(asset.sourceByteLength).toBe(onDisk.size);
		expect(asset.sourceByteLength).toBe(bytes.byteLength);
	});

	test('rejects an unsupported file extension without touching the filesystem further', async () => {
		const filePath = join(dir, 'not-an-image.txt');
		await writeFile(filePath, 'hello');
		await expect(decodeNodeFile(filePath)).rejects.toThrow(/unsupported file extension/);
	});
});

describe('imageId is derived from source bytes, not decoded pixels', () => {
	test('two encodings of the identical pixel grid get different imageIds', async () => {
		// Same WIDTH/HEIGHT/PIXELS, but two different deflate levels produce two
		// different byte streams for the same decoded image content.
		const bytesLow = encodeFixturePng(0);
		const bytesHigh = encodeFixturePng(9);
		expect(Buffer.compare(bytesLow, bytesHigh)).not.toBe(0); // sanity: bytes really do differ

		const pathLow = join(dir, 'same-pixels-low.png');
		const pathHigh = join(dir, 'same-pixels-high.png');
		await writeFile(pathLow, bytesLow);
		await writeFile(pathHigh, bytesHigh);

		const assetLow = await decodeNodeFile(pathLow);
		const assetHigh = await decodeNodeFile(pathHigh);

		// Decoded pixels agree (same picture)...
		expect(Array.from(assetLow.rgba)).toEqual(Array.from(assetHigh.rgba));
		expect(assetLow.widthPx).toBe(assetHigh.widthPx);
		expect(assetLow.heightPx).toBe(assetHigh.heightPx);
		// ...but imageId (and sourceByteLength) track the raw bytes, not the pixels.
		expect(assetLow.imageId).not.toBe(assetHigh.imageId);
		expect(assetLow.sourceByteLength).not.toBe(assetHigh.sourceByteLength);
	});
});
