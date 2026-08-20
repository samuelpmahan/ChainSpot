import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');

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

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

// --- tiny.png: 2x3 portrait, 8-bit RGB, solid red ---
function buildPng(width, height) {
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
      raw[offset] = 255; // R
      raw[offset + 1] = 0; // G
      raw[offset + 2] = 0; // B
    }
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeBytes = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, crc]);
  };

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// --- tiny.jpg: 5x4 landscape baseline JPEG, YCbCr 4:4:4, solid black ---
const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99
];

const CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99
];

const DC_LENGTHS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_SYMBOLS = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b];
const AC_LENGTHS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_SYMBOLS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa
];

function buildJpeg(width, height) {
  const segment = (marker, payload) =>
    Buffer.concat([Buffer.from([0xff, marker]), u16(payload.length + 2), payload]);

  const app0 = Buffer.concat([
    Buffer.from('JFIF\0', 'ascii'),
    Buffer.from([0x01, 0x01, 0x00]),
    u16(1),
    u16(1),
    Buffer.from([0x00, 0x00])
  ]);

  const dqt = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from(LUMA_Q),
    Buffer.from([0x01]),
    Buffer.from(CHROMA_Q)
  ]);

  const sof0 = Buffer.concat([
    Buffer.from([0x08]),
    u16(height),
    u16(width),
    Buffer.from([0x03]),
    Buffer.from([0x01, 0x11, 0x00]),
    Buffer.from([0x02, 0x11, 0x01]),
    Buffer.from([0x03, 0x11, 0x01])
  ]);

  const dht = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from(DC_LENGTHS),
    Buffer.from(DC_SYMBOLS),
    Buffer.from([0x10]),
    Buffer.from(AC_LENGTHS),
    Buffer.from(AC_SYMBOLS)
  ]);

  const sos = Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from([0x01, 0x00]),
    Buffer.from([0x02, 0x00]),
    Buffer.from([0x03, 0x00]),
    Buffer.from([0x00, 0x3f, 0x00])
  ]);

  // Entropy-coded data for one MCU per component (flat blocks).
  // Y: DC diff 0 (category 0, code "00") + EOB ("1010") -> 0b00101011 = 0x2b
  const entropyY = Buffer.from([0x2b]);
  // Cb/Cr: DC diff 1024 (category 11, code "111111110" + magnitude "10000000000") + EOB.
  // Bitstream bytes ff 40 0a with the required 0x00 byte-stuffing after 0xff.
  const entropyChroma = Buffer.from([0xff, 0x00, 0x40, 0x0a]);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, app0),
    segment(0xdb, dqt),
    segment(0xc0, sof0),
    segment(0xc4, dht),
    segment(0xda, sos),
    entropyY,
    entropyChroma,
    entropyChroma,
    Buffer.from([0xff, 0xd9])
  ]);
}

mkdirSync(fixturesDir, { recursive: true });

const png = buildPng(2, 3);
const jpeg = buildJpeg(5, 4);

writeFileSync(join(fixturesDir, 'tiny.png'), png);
writeFileSync(join(fixturesDir, 'tiny.jpg'), jpeg);

console.log(`tiny.png: 2x3 portrait, image/png, ${png.length} bytes`);
console.log(`tiny.jpg: 5x4 landscape, image/jpeg, ${jpeg.length} bytes`);
