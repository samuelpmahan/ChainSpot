import { describe, expect, test } from 'vitest';
import {
	badgeGlyphTemplateFeature,
	badgeGlyphTemplateUnit,
	classifyBadgeAgainstTemplates,
	BADGE_GLYPH_TEMPLATES
} from '../../packages/alg/src/detectors/threeFactor/features/g1.badgeGlyphTemplate';
import type { RgbaBitmap } from '../../packages/alg/src/detectors/threeFactor/digits/badgeGlyphTemplateMath';
import type { BadgeEvidence } from '../../packages/alg/src/detectors/threeFactor/types';

function makeBadge(overrides: Partial<BadgeEvidence>): BadgeEvidence {
	return {
		detId: 'badge-0',
		component: {} as BadgeEvidence['component'],
		cxPx: 50,
		cyPx: 50,
		bbox: [30, 40, 40, 20],
		source: 'bright-family',
		digits: [],
		rawLabel: '',
		digitCount: 0,
		label: null,
		bestLabel: null,
		labelCandidates: [],
		confidence: Infinity,
		abstentionReason: null,
		confidenceFloor: 0,
		conflictWith: [],
		notes: [],
		...overrides
	};
}

/** Renders one baked template's normalized mask back into a bright-on-dark
 * RGBA raster the classifier's own sampling pipeline can re-discover -- the
 * mask's foreground pixels become a centered bright blob at the exact
 * on-image badge bbox the classifier samples. This lets the feature-level
 * test exercise the SAME code path a real badge crop takes (raw pixels in,
 * sample+normalize+score), independent of the self-test in
 * badgeGlyphTemplateMath.test.ts which starts from the already-normalized
 * mask. */
function rasterFromTemplate(label: number): { image: RgbaBitmap; badge: { xPx: number; yPx: number; widthPx: number; heightPx: number } } {
	const template = BADGE_GLYPH_TEMPLATES.find((t) => t.label === label)!;
	const scale = 4;
	const widthPx = template.mask.widthPx * scale;
	const heightPx = template.mask.heightPx * scale;
	const data = new Uint8ClampedArray(widthPx * heightPx * 4);
	for (let i = 0; i < widthPx * heightPx; i++) data[i * 4 + 3] = 255; // opaque black background
	for (let y = 0; y < template.mask.heightPx; y++) {
		for (let x = 0; x < template.mask.widthPx; x++) {
			if (!template.mask.data[y * template.mask.widthPx + x]) continue;
			for (let dy = 0; dy < scale; dy++) {
				for (let dx = 0; dx < scale; dx++) {
					const px = x * scale + dx;
					const py = y * scale + dy;
					const offset = (py * widthPx + px) * 4;
					data[offset] = 255;
					data[offset + 1] = 255;
					data[offset + 2] = 255;
				}
			}
		}
	}
	return {
		image: { width: widthPx, height: heightPx, data },
		badge: { xPx: widthPx / 2, yPx: heightPx / 2, widthPx, heightPx }
	};
}

describe('badgeGlyphTemplate ABFeature registration', () => {
	test('is a default-OFF G1 frozen-safe deviation', () => {
		expect(badgeGlyphTemplateFeature).toMatchObject({
			id: 'badgeGlyphTemplate',
			gate: 'G1',
			kind: 'deviation',
			defaultEnabled: false,
			resolveOnlyWhenConfigured: true
		});
	});

	test('unit declares its slots and never mutates badges', () => {
		expect(badgeGlyphTemplateUnit.consumes).toEqual(['localImage', 'badges', 'viewport']);
		expect(badgeGlyphTemplateUnit.produces).toEqual(['badgeGlyphTemplate']);
	});
});

describe('classifyBadgeAgainstTemplates agreement verdicts', () => {
	test('agrees when both sides read the same hole', () => {
		const { image, badge } = rasterFromTemplate(7);
		const evidence = makeBadge({
			bbox: [
				badge.xPx - badge.widthPx / 2,
				badge.yPx - badge.heightPx / 2,
				badge.widthPx,
				badge.heightPx
			],
			label: '7'
		});
		const verdict = classifyBadgeAgainstTemplates(image, evidence);
		expect(verdict.templateLabel).toBe('7');
		expect(verdict.agreement).toBe('agree');
		expect(verdict.templateAbstention).toBeNull();
	});

	test('flags a loud disagreement when the reader and template differ', () => {
		const { image, badge } = rasterFromTemplate(7);
		const evidence = makeBadge({
			bbox: [
				badge.xPx - badge.widthPx / 2,
				badge.yPx - badge.heightPx / 2,
				badge.widthPx,
				badge.heightPx
			],
			label: '3' // current reader claims a different hole than the template sees
		});
		const verdict = classifyBadgeAgainstTemplates(image, evidence);
		expect(verdict.templateLabel).toBe('7');
		expect(verdict.currentLabel).toBe('3');
		expect(verdict.agreement).toBe('disagree');
	});

	test('names the reader as UNREAD when it abstained but the template reads confidently', () => {
		const { image, badge } = rasterFromTemplate(4);
		const evidence = makeBadge({
			bbox: [
				badge.xPx - badge.widthPx / 2,
				badge.yPx - badge.heightPx / 2,
				badge.widthPx,
				badge.heightPx
			],
			label: null
		});
		const verdict = classifyBadgeAgainstTemplates(image, evidence);
		expect(verdict.currentLabel).toBeNull();
		expect(verdict.templateLabel).toBe('4');
		expect(verdict.agreement).toBe('readerAbstained');
	});

	test('names the template as abstained (empty-glyph) on a blank badge crop, never guesses', () => {
		const widthPx = 40;
		const heightPx = 30;
		const image: RgbaBitmap = { width: widthPx, height: heightPx, data: new Uint8ClampedArray(widthPx * heightPx * 4) };
		const evidence = makeBadge({ bbox: [0, 0, widthPx, heightPx], label: '9' });
		const verdict = classifyBadgeAgainstTemplates(image, evidence);
		expect(verdict.templateLabel).toBeNull();
		expect(verdict.templateAbstention).toBe('empty-glyph');
		expect(verdict.agreement).toBe('templateAbstained');
	});
});
