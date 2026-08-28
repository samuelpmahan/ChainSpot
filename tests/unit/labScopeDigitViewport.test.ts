import { describe, expect, test } from 'vitest';
import {
	DEFAULT_DERIVED_BOX_SIZE,
	deriveHoleSourceBox,
	type DigitViewportReading
} from '../../scripts/chainspot-lab/scope/digitViewport';

const DIMS = { width: 1290, height: 2091 };
const NO_OFFSET = { xPx: 0, yPx: 0 };

function reading(overrides: Partial<DigitViewportReading> & { detId: string }): DigitViewportReading {
	return {
		label: '1',
		confidence: 0.99,
		cxPx: 645,
		cyPx: 1000,
		...overrides
	};
}

describe('digit-derived hole viewports (truth-free scope fallback)', () => {
	test('centers a manifest-shaped box on the matching badge, shifted to the original frame', () => {
		const derived = deriveHoleSourceBox(
			[reading({ detId: 'badge-7', label: '14', cxPx: 700, cyPx: 967 })],
			14,
			DIMS,
			{ xPx: 0, yPx: -431 }
		);
		// original = canonical - offset -> y = 967 + 431 = 1398
		expect(derived.sourceBox).toEqual([
			700 - DEFAULT_DERIVED_BOX_SIZE / 2,
			1398 - DEFAULT_DERIVED_BOX_SIZE / 2,
			DEFAULT_DERIVED_BOX_SIZE,
			DEFAULT_DERIVED_BOX_SIZE
		]);
		expect(derived.warnings).toEqual([]);
	});

	test('clamps the box inside the original raster near edges', () => {
		const derived = deriveHoleSourceBox(
			[reading({ detId: 'badge-0', label: '1', cxPx: 10, cyPx: 12 })],
			1,
			DIMS,
			NO_OFFSET
		);
		expect(derived.sourceBox[0]).toBe(0);
		expect(derived.sourceBox[1]).toBe(0);
	});

	test('duplicate labels pick the highest confidence and say so', () => {
		const derived = deriveHoleSourceBox(
			[
				reading({ detId: 'badge-3', label: '9', confidence: 0.41 }),
				reading({ detId: 'badge-5', label: '9', confidence: 0.93, cxPx: 200, cyPx: 300 })
			],
			9,
			DIMS,
			NO_OFFSET
		);
		expect(derived.reading.detId).toBe('badge-5');
		expect(derived.warnings.join(' ')).toContain('read on 2 badges');
	});

	test('an ambiguous digit read is warned, never silently trusted', () => {
		const derived = deriveHoleSourceBox(
			[
				reading({
					detId: 'badge-12',
					label: '17',
					confidence: 0.198,
					runnerUp: { label: 12, confidence: 0.193 }
				})
			],
			17,
			DIMS,
			NO_OFFSET
		);
		expect(derived.warnings.join(' ')).toContain('ambiguous');
	});

	test('a hole nobody read fails loudly with the full read-label inventory', () => {
		expect(() =>
			deriveHoleSourceBox(
				[
					reading({ detId: 'badge-0', label: '3' }),
					reading({ detId: 'badge-1', label: null, confidence: 0.002 })
				],
				7,
				DIMS,
				NO_OFFSET
			)
		).toThrow(/no badge read as hole 7 .*badge-0=3@0\.990, badge-1=UNREAD@0\.002/);
	});
});
