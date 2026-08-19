// Node-side raster decoding for the NuThing experiment scripts.
//
// Parity runs consume the .rgba.bin dumps written by p1_trace.py so both
// implementations see bit-identical input (decoder variance is measured
// separately). PNG/JPEG decoding is also supported for standalone runs.

import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import type { RgbaImage } from '../../src/lib/nuthing/raster';

export function decodeRgbaBin(path: string): RgbaImage {
  const buf = readFileSync(path);
  if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'NUP1') {
    throw new Error(`Not a NUP1 rgba dump: ${path}`);
  }
  const width = buf.readUInt32LE(4);
  const height = buf.readUInt32LE(8);
  const data = new Uint8Array(buf.buffer, buf.byteOffset + 16, width * height * 4);
  return { width, height, data };
}

export function decodeImageFile(path: string): RgbaImage {
  const lower = path.toLowerCase();
  if (lower.endsWith('.rgba.bin')) return decodeRgbaBin(path);
  return decodeImageBytes(readFileSync(path), path);
}

/** Decode an immutable source-raster payload without writing a temporary file. */
export function decodeImageBytes(bytes: Uint8Array, fileName: string): RgbaImage {
  const lower = fileName.toLowerCase();
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (lower.endsWith('.png')) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    const decoded = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 2048 });
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  }
  throw new Error(`Unsupported raster type: ${fileName}`);
}
