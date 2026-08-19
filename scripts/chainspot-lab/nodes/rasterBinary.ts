import type { RgbaImage } from '../../../src/lib/nuthing/raster';

const RGBA_MAGIC = Buffer.from('CSRGBA02', 'ascii');
const RGBA_HEADER_BYTES = 40;
const MASK_MAGIC = Buffer.from('CSMASK02', 'ascii');
const MASK_HEADER_BYTES = 32;

function checkedDimensions(width: number, height: number): number {
	if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
		throw new TypeError(`Invalid raster dimensions: ${width}x${height}`);
	}
	const pixels = width * height;
	if (!Number.isSafeInteger(pixels)) throw new TypeError('Raster dimensions overflow');
	return pixels;
}

export interface RasterCoordinateFrame {
	readonly sourceWidth: number;
	readonly sourceHeight: number;
	readonly originX: number;
	readonly originY: number;
	readonly detectedTop: number;
	readonly detectedBottom: number;
}

export interface StoredRgbaRaster extends RgbaImage {
	readonly frame: RasterCoordinateFrame;
}

export function encodeRgbaRaster(
	image: RgbaImage,
	frame: RasterCoordinateFrame = {
		sourceWidth: image.width,
		sourceHeight: image.height,
		originX: 0,
		originY: 0,
		detectedTop: 0,
		detectedBottom: image.height
	}
): Buffer {
	const pixels = checkedDimensions(image.width, image.height);
	checkedDimensions(frame.sourceWidth, frame.sourceHeight);
	for (const [name, value] of Object.entries(frame)) {
		if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
			throw new TypeError(`Invalid coordinate-frame ${name}: ${value}`);
		}
	}
	if (image.data.byteLength !== pixels * 4) throw new Error('RGBA payload length is invalid');
	const output = Buffer.allocUnsafe(RGBA_HEADER_BYTES + image.data.byteLength);
	RGBA_MAGIC.copy(output, 0);
	output.writeUInt32LE(image.width, 8);
	output.writeUInt32LE(image.height, 12);
	output.writeUInt32LE(frame.sourceWidth, 16);
	output.writeUInt32LE(frame.sourceHeight, 20);
	output.writeUInt32LE(frame.originX, 24);
	output.writeUInt32LE(frame.originY, 28);
	output.writeUInt32LE(frame.detectedTop, 32);
	output.writeUInt32LE(frame.detectedBottom, 36);
	Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).copy(
		output,
		RGBA_HEADER_BYTES
	);
	return output;
}

export function decodeRgbaRaster(bytes: Uint8Array): StoredRgbaRaster {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (buffer.byteLength < RGBA_HEADER_BYTES || !buffer.subarray(0, 8).equals(RGBA_MAGIC)) {
		throw new Error('Invalid ChainSpot RGBA object header');
	}
	const width = buffer.readUInt32LE(8);
	const height = buffer.readUInt32LE(12);
	const pixels = checkedDimensions(width, height);
	if (buffer.byteLength !== RGBA_HEADER_BYTES + pixels * 4) {
		throw new Error('ChainSpot RGBA object length mismatch');
	}
	return {
		width,
		height,
		data: new Uint8Array(buffer.subarray(RGBA_HEADER_BYTES)),
		frame: {
			sourceWidth: buffer.readUInt32LE(16),
			sourceHeight: buffer.readUInt32LE(20),
			originX: buffer.readUInt32LE(24),
			originY: buffer.readUInt32LE(28),
			detectedTop: buffer.readUInt32LE(32),
			detectedBottom: buffer.readUInt32LE(36)
		}
	};
}

export interface BrightDarkMaskPayload {
	readonly width: number;
	readonly height: number;
	readonly bright: Uint8Array;
	readonly dark: Uint8Array;
	readonly frame?: Pick<RasterCoordinateFrame, 'sourceWidth' | 'sourceHeight' | 'originX' | 'originY'>;
}

export function encodeBrightDarkMasks(payload: BrightDarkMaskPayload): Buffer {
	const pixels = checkedDimensions(payload.width, payload.height);
	if (payload.bright.byteLength !== pixels || payload.dark.byteLength !== pixels) {
		throw new Error('Mask payload length is invalid');
	}
	const output = Buffer.allocUnsafe(MASK_HEADER_BYTES + pixels * 2);
	MASK_MAGIC.copy(output, 0);
	output.writeUInt32LE(payload.width, 8);
	output.writeUInt32LE(payload.height, 12);
	output.writeUInt32LE(payload.frame?.sourceWidth ?? payload.width, 16);
	output.writeUInt32LE(payload.frame?.sourceHeight ?? payload.height, 20);
	output.writeUInt32LE(payload.frame?.originX ?? 0, 24);
	output.writeUInt32LE(payload.frame?.originY ?? 0, 28);
	Buffer.from(payload.bright).copy(output, MASK_HEADER_BYTES);
	Buffer.from(payload.dark).copy(output, MASK_HEADER_BYTES + pixels);
	return output;
}

export function decodeBrightDarkMasks(bytes: Uint8Array): BrightDarkMaskPayload {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (buffer.byteLength < MASK_HEADER_BYTES || !buffer.subarray(0, 8).equals(MASK_MAGIC)) {
		throw new Error('Invalid ChainSpot mask object header');
	}
	const width = buffer.readUInt32LE(8);
	const height = buffer.readUInt32LE(12);
	const pixels = checkedDimensions(width, height);
	if (buffer.byteLength !== MASK_HEADER_BYTES + pixels * 2) {
		throw new Error('ChainSpot mask object length mismatch');
	}
	return {
		width,
		height,
		bright: new Uint8Array(buffer.subarray(MASK_HEADER_BYTES, MASK_HEADER_BYTES + pixels)),
		dark: new Uint8Array(buffer.subarray(MASK_HEADER_BYTES + pixels)),
		frame: {
			sourceWidth: buffer.readUInt32LE(16),
			sourceHeight: buffer.readUInt32LE(20),
			originX: buffer.readUInt32LE(24),
			originY: buffer.readUInt32LE(28)
		}
	};
}
