import { describe, expect, it } from 'vitest';
import { DEFAULT_GRAPHIC_STYLE, GRAPHIC_STYLE_PRESETS, findGraphicStyle } from '../../src/lib/graphics/style';

describe('graphic style presets', () => {
	it('has unique, non-empty ids and names', () => {
		const ids = GRAPHIC_STYLE_PRESETS.map((style) => style.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const style of GRAPHIC_STYLE_PRESETS) {
			expect(style.id.trim()).not.toBe('');
			expect(style.name.trim()).not.toBe('');
		}
	});

	it('resolves a known id and falls back to the default for an unknown one', () => {
		const second = GRAPHIC_STYLE_PRESETS[1];
		expect(findGraphicStyle(second.id)).toBe(second);
		expect(findGraphicStyle('not-a-real-style')).toBe(DEFAULT_GRAPHIC_STYLE);
	});
});
