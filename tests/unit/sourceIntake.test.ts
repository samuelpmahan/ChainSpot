import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { captureSelectedSources, formatSourceCaptureReceipt } from '$lib/sourceIntake';

function file(name: string, bytes: Uint8Array, fails = false): File {
	return {
		name,
		type: 'image/png',
		lastModified: 1,
		size: bytes.byteLength,
		arrayBuffer: async () => {
			if (fails) throw new Error('read failed');
			return bytes.slice().buffer;
		}
	} as File;
}

describe('captureSelectedSources', () => {
	test('preserves selection order and hashes the compressed bytes', async () => {
		const firstBytes = new Uint8Array([1, 2, 3]);
		const secondBytes = new Uint8Array([4, 5]);
		const receipt = await captureSelectedSources([
			file('first.png', firstBytes),
			file('second.png', secondBytes)
		]);

		expect(receipt.entries).toHaveLength(2);
		const first = receipt.entries[0];
		const second = receipt.entries[1];
		expect(first.ok && first.source.selectionIndex).toBe(0);
		expect(second.ok && second.source.selectionIndex).toBe(1);
		expect(first.ok && first.source.sourceByteLength).toBe(3);
		expect(first.ok && first.source.imageId).toBe(
			createHash('sha256').update(firstBytes).digest('hex')
		);
	});

	test('keeps failed reads in the receipt with a reason', async () => {
		const receipt = await captureSelectedSources([file('broken.png', new Uint8Array(), true)]);

		expect(receipt.entries[0]).toMatchObject({
			ok: false,
			selectionIndex: 0,
			reason: 'source-read-or-hash-failed'
		});
		expect(formatSourceCaptureReceipt(receipt)).toContain(
			'REJECT broken.png reason=source-read-or-hash-failed'
		);
	});
});
