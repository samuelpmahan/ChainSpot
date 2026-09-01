import { describe, expect, test } from 'vitest';
import { computeBrightDarkMasks } from '../../packages/alg/src/detectors/threeFactor/raster';
import { extractComponents } from '../../packages/alg/src/detectors/threeFactor/components';
import { groupBrightDarkComponentFields } from '../../packages/alg/src/detectors/threeFactor/componentField';

describe('bright/dark ComponentField parity', () => {
	test('groups the existing masks/components without changing outputs', () => {
		const width = 7;
		const height = 5;
		const rgba = new Uint8Array(width * height * 4);
		for (let i = 0; i < width * height; i++) {
			const p = i * 4;
			const x = i % width;
			const y = Math.floor(i / width);
			const v = (x === 1 || x === 2) && (y === 1 || y === 2) ? 245 : x >= 4 && y >= 2 ? 20 : 120;
			rgba[p] = v;
			rgba[p + 1] = v;
			rgba[p + 2] = v;
			rgba[p + 3] = 255;
		}

		const masks = computeBrightDarkMasks({ width, height, data: rgba });
		const legacyBright = extractComponents(masks.bright);
		const legacyDark = extractComponents(masks.dark);
		const fields = groupBrightDarkComponentFields(masks);

		expect(fields.bright.config.polarity).toBe('bright');
		expect(fields.dark.config.polarity).toBe('dark');
		expect(fields.bright.mask).toBe(masks.bright);
		expect(fields.dark.mask).toBe(masks.dark);
		expect(fields.bright.labels).toEqual(legacyBright.labels);
		expect(fields.dark.labels).toEqual(legacyDark.labels);
		expect(fields.bright.components).toEqual(legacyBright.components);
		expect(fields.dark.components).toEqual(legacyDark.components);
	});
});
