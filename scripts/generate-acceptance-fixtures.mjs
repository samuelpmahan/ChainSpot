import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
	let c = n;
	for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	crcTable[n] = c >>> 0;
}

function crc32(bytes) {
	let c = 0xffffffff;
	for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
	const typeBytes = Buffer.from(type, 'ascii');
	const body = Buffer.concat([typeBytes, data]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, checksum]);
}

function buildPng(width, height, draw) {
	const pixels = Buffer.alloc(width * height * 3, 0);

	function setPixel(x, y, color) {
		if (x < 0 || y < 0 || x >= width || y >= height) return;
		const offset = (y * width + x) * 3;
		pixels[offset] = color[0];
		pixels[offset + 1] = color[1];
		pixels[offset + 2] = color[2];
	}

	function fillRect(x, y, rectWidth, rectHeight, color) {
		for (let row = y; row < y + rectHeight; row += 1) {
			for (let column = x; column < x + rectWidth; column += 1) setPixel(column, row, color);
		}
	}

	function line(x1, y1, x2, y2, color, thickness = 1) {
		const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
		for (let step = 0; step <= steps; step += 1) {
			const x = Math.round(x1 + ((x2 - x1) * step) / Math.max(steps, 1));
			const y = Math.round(y1 + ((y2 - y1) * step) / Math.max(steps, 1));
			for (let dy = -thickness; dy <= thickness; dy += 1) {
				for (let dx = -thickness; dx <= thickness; dx += 1) setPixel(x + dx, y + dy, color);
			}
		}
	}

	function ellipse(centerX, centerY, radiusX, radiusY, color) {
		for (let y = centerY - radiusY; y <= centerY + radiusY; y += 1) {
			for (let x = centerX - radiusX; x <= centerX + radiusX; x += 1) {
				const dx = (x - centerX) / radiusX;
				const dy = (y - centerY) / radiusY;
				if (dx * dx + dy * dy <= 1) setPixel(x, y, color);
			}
		}
	}

	function landmark(x, y) {
		const dark = [38, 53, 38];
		const accent = [231, 76, 60];
		ellipse(x, y, 9, 9, [250, 247, 224]);
		line(x - 8, y, x + 8, y, dark, 1);
		line(x, y - 8, x, y + 8, dark, 1);
		ellipse(x, y, 3, 3, accent);
	}

	draw({ fillRect, line, ellipse, landmark });

	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const rowBytes = width * 3 + 1;
	const raw = Buffer.alloc(rowBytes * height);
	for (let y = 0; y < height; y += 1) {
		raw[y * rowBytes] = 0;
		pixels.copy(raw, y * rowBytes + 1, y * width * 3, (y + 1) * width * 3);
	}
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk('IHDR', header),
		pngChunk('IDAT', deflateSync(raw)),
		pngChunk('IEND', Buffer.alloc(0))
	]);
}

function drawSource({ fillRect, line, ellipse, landmark }) {
	const grass = [202, 220, 177];
	const grid = [184, 205, 164];
	const road = [227, 216, 183];
	const water = [123, 184, 205];
	fillRect(0, 0, 640, 420, grass);
	for (let x = 20; x < 640; x += 40) line(x, 0, x, 420, grid);
	for (let y = 20; y < 420; y += 40) line(0, y, 640, y, grid);
	line(0, 365, 190, 300, road, 5);
	line(190, 300, 370, 325, road, 5);
	line(370, 325, 640, 240, road, 5);
	line(35, 70, 150, 120, [110, 153, 96], 3);
	line(150, 120, 285, 175, [110, 153, 96], 3);
	line(285, 175, 410, 145, [110, 153, 96], 3);
	line(410, 145, 590, 185, [110, 153, 96], 3);
	ellipse(470, 300, 72, 38, water);
	ellipse(470, 300, 62, 29, [145, 199, 216]);
	for (const tree of [[55, 330], [240, 85], [315, 365], [575, 70], [600, 350]]) ellipse(tree[0], tree[1], 15, 12, [72, 119, 71]);
	for (const point of [[90, 70], [520, 65], [120, 330], [350, 205], [560, 350]]) landmark(point[0], point[1]);
}

function drawTarget({ fillRect, line, ellipse, landmark }) {
	const grass = [176, 207, 153];
	const grid = [156, 190, 137];
	const road = [218, 199, 164];
	const water = [91, 168, 198];
	fillRect(0, 0, 960, 540, grass);
	for (let x = 30; x < 960; x += 60) line(x, 0, x, 540, grid);
	for (let y = 30; y < 540; y += 60) line(0, y, 960, y, grid);
	line(0, 465, 285, 385, road, 6);
	line(285, 385, 555, 420, road, 6);
	line(555, 420, 960, 300, road, 6);
	line(50, 95, 225, 155, [92, 143, 85], 4);
	line(225, 155, 430, 220, [92, 143, 85], 4);
	line(430, 220, 615, 180, [92, 143, 85], 4);
	line(615, 180, 885, 240, [92, 143, 85], 4);
	ellipse(705, 385, 108, 50, water);
	ellipse(705, 385, 95, 40, [111, 183, 210]);
	for (const tree of [[85, 420], [360, 110], [470, 470], [860, 95], [900, 455]]) ellipse(tree[0], tree[1], 22, 17, [59, 111, 63]);
	for (const point of [[140, 90], [780, 80], [170, 420], [520, 270], [840, 420]]) landmark(point[0], point[1]);
}

mkdirSync(fixturesDir, { recursive: true });
writeFileSync(join(fixturesDir, 'acceptance-source-overview.png'), buildPng(640, 420, drawSource));
writeFileSync(join(fixturesDir, 'acceptance-clean-map.png'), buildPng(960, 540, drawTarget));

console.log('acceptance-source-overview.png: 640x420 PNG with five landmarks');
console.log('acceptance-clean-map.png: 960x540 PNG with five landmarks');
