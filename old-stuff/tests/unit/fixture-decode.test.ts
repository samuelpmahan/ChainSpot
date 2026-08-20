import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FIXTURES = [
	{ name: 'tiny.png', mimeType: 'image/png', width: 2, height: 3 },
	{ name: 'tiny.jpg', mimeType: 'image/jpeg', width: 5, height: 4 }
];

function fixtureBytes(name: string): Buffer {
	return readFileSync(join(process.cwd(), 'tests', 'fixtures', name));
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function jpegDimensions(bytes: Buffer): { width: number; height: number } {
	let offset = 2;
	while (offset < bytes.length - 1) {
		if (bytes[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		const marker = bytes[offset + 1];
		if (marker === 0x00 || marker === 0xff || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		if (marker === 0xd9) break;
		const length = bytes.readUInt16BE(offset + 2);
		const isSof =
			marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof) {
			return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
		}
		offset += 2 + length;
	}
	throw new Error('no SOF marker found in JPEG');
}

describe('synthetic fixture decoding', () => {
	it('documents the fixture MIME types and intrinsic dimensions', () => {
		for (const fixture of FIXTURES) {
			const bytes = fixtureBytes(fixture.name);
			expect(bytes.length, `${fixture.name} should be tiny`).toBeLessThan(4096);
			expect(fixture.mimeType).toMatch(/^image\/(png|jpeg)$/);
		}
	});

	it('tiny.png is a well-formed PNG with its documented dimensions', () => {
		const bytes = fixtureBytes('tiny.png');

		expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
		expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
		expect(bytes.readUInt32BE(16)).toBe(2);
		expect(bytes.readUInt32BE(20)).toBe(3);

		const idat = bytes.indexOf(Buffer.from('IDAT', 'ascii'));
		const iend = bytes.indexOf(Buffer.from('IEND', 'ascii'));
		expect(idat).toBeGreaterThan(0);
		expect(iend).toBeGreaterThan(idat);
	});

	it('tiny.jpg is a baseline JPEG with its documented dimensions', () => {
		const bytes = fixtureBytes('tiny.jpg');

		expect(bytes[0]).toBe(0xff);
		expect(bytes[1]).toBe(0xd8);
		expect(bytes[bytes.length - 2]).toBe(0xff);
		expect(bytes[bytes.length - 1]).toBe(0xd9);

		expect(jpegDimensions(bytes)).toEqual({ width: 5, height: 4 });
	});
});
