import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
	SLOT_FILE_NAMES,
	SLOT_ORIGINS,
	TILE_H,
	TILE_W,
	buildGrayRaster,
	buildLargeGrayRaster,
	rgbFromRaster
} from '../tests/helpers/smartMap.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'smart-import');
const largeDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'smart-import-large');

// --- CRC-32 (ISO 3309), required by PNG chunks ---
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
	let c = n;
	for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	crcTable[n] = c >>> 0;
}

function crc32(bytes) {
	let c = 0xffffffff;
	for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typeBytes = Buffer.from(type, 'ascii');
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
	return Buffer.concat([length, typeBytes, data, crc]);
}

function buildPng(width, height, rgb) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: RGB

	const rowBytes = 1 + width * 3;
	const raw = Buffer.alloc(rowBytes * height);
	for (let y = 0; y < height; y += 1) {
		const rowStart = y * rowBytes;
		raw[rowStart] = 0; // filter: none
		for (let x = 0; x < width; x += 1) {
			const offset = rowStart + 1 + x * 3;
			raw[offset] = rgb[(y * width + x) * 3];
			raw[offset + 1] = rgb[(y * width + x) * 3 + 1];
			raw[offset + 2] = rgb[(y * width + x) * 3 + 2];
		}
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

function writeTiles(dir, rasterForSlot, label) {
	mkdirSync(dir, { recursive: true });
	for (const slot of Object.keys(SLOT_FILE_NAMES)) {
		const raster = rasterForSlot(slot);
		const { widthPx, heightPx, rgb } = rgbFromRaster(raster);
		const png = buildPng(widthPx, heightPx, rgb);
		const name = SLOT_FILE_NAMES[slot];
		writeFileSync(join(dir, name), png);
		console.log(`${label}/${name}: ${widthPx}x${heightPx}, image/png, ${png.length} bytes`);
	}
}

// Strong set (P1-001): the default coherent 25%-overlap capture with shared
// chrome bands. Kept at the fixture root for backward compatibility.
writeTiles(fixturesDir, (slot) => buildGrayRaster(slot), 'strong');

// Weak-but-recoverable set (P1-002): reduced 17.5% overlap, below ChainSpot's
// intended 20-30%; content still matches, so the best attempt loads with a
// "weak horizontal/vertical overlap" review warning.
const WEAK_ORIGINS = {
	'upper-left': { x: 0, y: 0 },
	'upper-right': { x: 165, y: 0 },
	'lower-left': { x: 0, y: 165 },
	'lower-right': { x: 165, y: 165 }
};
writeTiles(join(fixturesDir, 'weak'), (slot) => buildGrayRaster(slot, { origin: WEAK_ORIGINS[slot] }), 'weak');

// Incompatible set (P1-002): every pairwise match is credible, but the
// lower-right tile is displaced so the redundant lower-right paths disagree and
// the vertical step is inconsistent -> contradictory lower-right + mixed zoom.
const INCOMPATIBLE_ORIGINS = {
	'upper-left': { x: 0, y: 0 },
	'upper-right': { x: SLOT_ORIGINS['upper-right'].x, y: 0 },
	'lower-left': { x: 0, y: SLOT_ORIGINS['lower-left'].y },
	'lower-right': { x: SLOT_ORIGINS['lower-right'].x, y: SLOT_ORIGINS['lower-right'].y - 10 }
};
writeTiles(join(fixturesDir, 'incompatible'), (slot) =>
	buildGrayRaster(slot, { origin: INCOMPATIBLE_ORIGINS[slot] })
, 'incompatible');

console.log('Wrote strong, weak, and incompatible smart-import sets.');

// Optional large set for Chromium performance measurement (P1-002). Generated
// on demand with `--large`; the perf script uses it to time decode + analysis
// on representative full-size tiles.
if (process.argv.includes('--large')) {
	writeTiles(largeDir, (slot) => buildLargeGrayRaster(slot), 'large');
	console.log('Wrote 4 large smart-import tiles to tests/fixtures/smart-import-large/.');
} else {
	console.log('Large set skipped (run with --large to generate it).');
}

console.log(
	`Documented layout: ${TILE_W}x${TILE_H} tiles, 25% overlap (${TILE_W - SLOT_ORIGINS['upper-right'].x}px per edge).`
);
