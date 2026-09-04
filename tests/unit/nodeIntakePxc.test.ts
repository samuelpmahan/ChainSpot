import { describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { composePcr } from '@chainspot/alg/exec';
import { executeNodeCanonicalInputTick } from '@chainspot/alg/exec/node-intake';

describe('S0 Node canonical input Tick', () => {
	test('sanitizes decoded intake before its first pixel write to PxC', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'chainspot-s0-'));
		const path = join(directory, 'one-pixel.png');
		const png = new PNG({ width: 1, height: 1 });
		png.data.set([10, 20, 30, 255]);
		writeFileSync(path, PNG.sync.write(png));

		let cachedAfterCrop = false;
		const result = await executeNodeCanonicalInputTick(path, {
			write() {
				cachedAfterCrop = true;
			}
		});
		expect(result.pxc.has('px.source.fullImage')).toBe(true);
		expect(result.pxc.get('px.course.canonicalPixels')).toBe(result.input);
		expect([...result.input.rgba]).toEqual([10, 20, 30, 255]);
		expect(result.cropReceipt).toMatchObject({
			cropMethod: 'none',
			upperRowsRemoved: 0,
			lowerRowsRemoved: 0,
			croppedPx: { width: 1, height: 1 }
		});
		expect(result.testimony.actualConsumes).toEqual(['px.source.fullImage']);
		expect(result.testimony.writes).toEqual([
			{ address: 'px.course.canonicalPixels', kind: 'new-address' }
		]);
		expect(result.testimony.frozenCalculations.map((calculation) => calculation.address)).toEqual([
			'fn.stripChromeProposal',
			'fn.materializeComposite'
		]);
		expect(result.testimony.artifacts).toMatchObject([
			{
				kind: 'rgba',
				dims: { width: 1, height: 1 },
				sha256: expect.stringMatching(/^[0-9a-f]{64}$/)
			}
		]);
		expect(result.cacheTestimony.actualConsumes).toEqual(['px.source.fullImage']);
		expect(cachedAfterCrop).toBe(true);
		const pcr = composePcr(
			{ id: 'intake-pcr', title: 'Canonical Intake PCR', tickIds: [result.testimony.opId] },
			result.plan,
			[result.testimony]
		);
		expect(pcr.runResultId).toMatch(/^[0-9a-f]{64}$/);
	});
});
