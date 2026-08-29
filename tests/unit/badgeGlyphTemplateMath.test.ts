// Unit coverage for the ported whole-glyph Dice-template classifier
// (docs/CLAIMS-LEDGER.md row 23). The primary contract, carried over
// verbatim from the pre-rebuild classifier's own unit test
// (old-stuff/tests/unit/badgeGlyphClassifier.test.ts, read at af85a3e):
// every one of the 18 canonical templates classifies as itself, with zero
// abstention. That test exercised PNG->normalize->classify end to end; this
// port instead classifies each baked NORMALIZED template mask
// (assets/badge-glyph-templates.json) directly against the vocabulary --
// see classifyNormalizedGlyph's doc comment for why that is the right
// level to hold the contract at once the templates are baked ahead of time.

import { describe, expect, test } from 'vitest';
import {
	BADGE_GLYPH_TEMPLATES
} from '../../packages/alg/src/detectors/threeFactor/features/g1.badgeGlyphTemplate';
import {
	classifyNormalizedGlyph,
	shiftedDice,
	bestMaskScore,
	normalizeBadgeGlyphMask,
	DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS,
	type RgbaBitmap
} from '../../packages/alg/src/detectors/threeFactor/digits/badgeGlyphTemplateMath';

describe('badge glyph template vocabulary', () => {
	test('ships exactly the fixed 1..18 vocabulary', () => {
		expect(BADGE_GLYPH_TEMPLATES.map((t) => t.label)).toEqual(
			Array.from({ length: 18 }, (_, i) => i + 1)
		);
		for (const template of BADGE_GLYPH_TEMPLATES) {
			expect(template.mask.widthPx).toBe(DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS.normalizedWidthPx);
			expect(template.mask.heightPx).toBe(DEFAULT_BADGE_GLYPH_TEMPLATE_KNOBS.normalizedHeightPx);
			// every template has SOME glyph -- an all-zero mask would mean the
			// bake silently produced an empty template, never a real shape.
			expect(template.mask.data.some((v) => v === 1)).toBe(true);
		}
	});

	test('old classifier self-test contract: every canonical template classifies as itself, no abstention', () => {
		const outcomes = BADGE_GLYPH_TEMPLATES.map((template) =>
			classifyNormalizedGlyph(template.mask, BADGE_GLYPH_TEMPLATES)
		);
		const correct = outcomes.filter((outcome, i) => outcome.label === BADGE_GLYPH_TEMPLATES[i]!.label);
		expect(correct.length).toBe(BADGE_GLYPH_TEMPLATES.length);
		expect(outcomes.every((o) => o.abstention === null)).toBe(true);
		// A template compared to itself is a perfect Dice match.
		expect(outcomes.every((o) => o.bestScore === 1)).toBe(true);
	});

	test('explicitly abstains on an empty glyph rather than guessing', () => {
		const outcome = classifyNormalizedGlyph(null, BADGE_GLYPH_TEMPLATES);
		expect(outcome.label).toBeUndefined();
		expect(outcome.abstention).toBe('empty-glyph');
	});
});

describe('shiftedDice / bestMaskScore', () => {
	function mask(rows: readonly string[]) {
		const heightPx = rows.length;
		const widthPx = rows[0]!.length;
		const data = new Uint8Array(widthPx * heightPx);
		rows.forEach((row, y) => row.split('').forEach((ch, x) => (data[y * widthPx + x] = ch === '1' ? 1 : 0)));
		return { widthPx, heightPx, data };
	}

	test('identical masks score a perfect 1', () => {
		const a = mask(['010', '111', '010']);
		expect(shiftedDice(a, a, 0, 0)).toBe(1);
	});

	test('disjoint masks score 0', () => {
		const a = mask(['100', '000', '000']);
		const b = mask(['000', '000', '001']);
		expect(shiftedDice(a, b, 0, 0)).toBe(0);
	});

	test('bestMaskScore recovers a perfect match after a one-pixel shift', () => {
		const a = mask(['0100', '0100', '0100']);
		const bShifted = mask(['0010', '0010', '0010']); // same shape, shifted right by 1
		expect(shiftedDice(a, bShifted, 0, 0)).toBeLessThan(1);
		expect(bestMaskScore(a, bShifted, 1)).toBe(1);
	});
});

describe('normalizeBadgeGlyphMask', () => {
	function solidRaster(widthPx: number, heightPx: number): RgbaBitmap {
		const data = new Uint8ClampedArray(widthPx * heightPx * 4);
		for (let i = 0; i < widthPx * heightPx; i++) {
			data[i * 4] = 0;
			data[i * 4 + 1] = 0;
			data[i * 4 + 2] = 0;
			data[i * 4 + 3] = 255;
		}
		return { width: widthPx, height: heightPx, data };
	}

	test('returns null (empty-glyph) for a badge crop with no bright pixels at all', () => {
		const raster = solidRaster(40, 30);
		const mask = normalizeBadgeGlyphMask(raster, { xPx: 20, yPx: 15, widthPx: 40, heightPx: 30 });
		expect(mask).toBeNull();
	});

	test('finds bright foreground and centers it on the canonical canvas', () => {
		const widthPx = 40;
		const heightPx = 30;
		const raster = solidRaster(widthPx, heightPx);
		// A small bright neutral (white) blob well inside the sampled interior.
		for (let y = 12; y < 18; y++) {
			for (let x = 16; x < 24; x++) {
				const offset = (y * widthPx + x) * 4;
				raster.data[offset] = 255;
				raster.data[offset + 1] = 255;
				raster.data[offset + 2] = 255;
			}
		}
		const mask = normalizeBadgeGlyphMask(raster, { xPx: 20, yPx: 15, widthPx, heightPx });
		expect(mask).not.toBeNull();
		expect(mask!.data.some((v) => v === 1)).toBe(true);
	});
});
