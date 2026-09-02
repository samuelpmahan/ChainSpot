import { describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { composePcr } from '@chainspot/alg/exec';
import { executeNodeCanonicalInputTick } from '@chainspot/alg/exec/node-intake';

describe('S0 Node canonical input Tick', () => {
	test('decodes once into shared PxC and freezes exact RGBA Materialization', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'chainspot-s0-'));
		const path = join(directory, 'one-pixel.png');
		const png = new PNG({ width: 1, height: 1 });
		png.data.set([10, 20, 30, 255]);
		writeFileSync(path, PNG.sync.write(png));

		const result = await executeNodeCanonicalInputTick(path);
		expect(result.pxc.get('px.source.decodedPixels')).toBe(result.input);
		expect(result.pxc.get('px.course.canonicalPixels')).toBe(result.input);
		expect([...result.input.rgba]).toEqual([10, 20, 30, 255]);
		expect(result.testimony.actualConsumes).toEqual(['px.source.selectedFiles']);
		expect(result.testimony.writes).toEqual([
			{ address: 'px.source.decodedPixels', kind: 'new-address' },
			{ address: 'px.course.canonicalPixels', kind: 'new-address' }
		]);
		expect(result.testimony.frozenCalculations[0]).toMatchObject({
			address: 'fn.decodeNodeFile',
			implementationHash: expect.stringMatching(/^[0-9a-f]{64}$/)
		});
		expect(result.testimony.artifacts).toMatchObject([
			{ kind: 'rgba', dims: { width: 1, height: 1 }, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }
		]);
		const pcr = composePcr(
			{ id: 'intake-pcr', title: 'Canonical Intake PCR', tickIds: [result.testimony.opId] },
			result.plan,
			[result.testimony]
		);
		expect(pcr.runResultId).toMatch(/^[0-9a-f]{64}$/);
	});
});
