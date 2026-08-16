import { describe, expect, it } from 'vitest';
import { detectInSourceSpace } from '../../src/lib/autoAnnotation/sourceSpaceDetection';
import { detectBasketsInSourceSpace } from '../../src/lib/autoAnnotation/basketSourceSpaceDetection';
import { detectBasketTemplateCandidates } from '../../src/lib/autoAnnotation/basketTemplateDetection';
import type { BasketRaster } from '../../src/lib/autoAnnotation/basketTemplateDetection';
import { applySourceTransform } from '../../src/lib/domain/provenance';
import { similaritySourceTransform } from '../helpers/provenanceFixtures';
import {
	BASKET_BASE_Y_FRACTION,
	blankGlyphRaster,
	buildCanonicalGlyphTemplate,
	createBruteForceBasketCv,
	paintGlyph
} from '../helpers/bruteForceBasketCv';

describe('detectInSourceSpace (generic merge helper)', () => {
	it('is detector-agnostic: works with an arbitrary Candidate-producing detector, not just baskets', () => {
		// A deliberately non-basket-shaped detector (models a badge-like
		// detector returning a `label`), proving the merge helper hardcodes no
		// sprite kind -- it only ever looks at {xPx, yPx} plus whatever the
		// caller's own detector returns alongside them.
		interface FakeBadgeCandidate {
			readonly xPx: number;
			readonly yPx: number;
			readonly label: number;
		}
		const fakeBadgeDetector = (raster: { readonly seedLabel: number }): readonly FakeBadgeCandidate[] => [
			{ xPx: 5, yPx: 7, label: raster.seedLabel }
		];

		const transform = similaritySourceTransform(15, 1.2, 300, 400);
		const observations = detectInSourceSpace(
			[{ sourceId: 'badge-source', transform, raster: { seedLabel: 3, widthPx: 1, heightPx: 1, sourceScale: 1 } }],
			fakeBadgeDetector
		);

		expect(observations).toHaveLength(1);
		expect(observations[0].sourceId).toBe('badge-source');
		expect(observations[0].sourceCandidate.label).toBe(3);
		const expected = applySourceTransform({ xPx: 5, yPx: 7 }, transform);
		expect(observations[0].compositePoint.xPx).toBeCloseTo(expected.xPx, 6);
		expect(observations[0].compositePoint.yPx).toBeCloseTo(expected.yPx, 6);
	});

	it('keeps observations from multiple sources separate, each mapped through its own transform', () => {
		interface StubRaster {
			readonly seedXPx: number;
			readonly seedYPx: number;
			readonly widthPx: number;
			readonly heightPx: number;
			readonly sourceScale: number;
		}
		const detect = (raster: StubRaster) => [{ xPx: raster.seedXPx, yPx: raster.seedYPx }];
		const stubRaster: StubRaster = { seedXPx: 10, seedYPx: 10, widthPx: 1, heightPx: 1, sourceScale: 1 };
		const observations = detectInSourceSpace(
			[
				{ sourceId: 's1', transform: similaritySourceTransform(0, 1, 0, 0), raster: stubRaster },
				{ sourceId: 's2', transform: similaritySourceTransform(90, 1, 1000, 0), raster: stubRaster }
			],
			detect
		);
		expect(observations).toHaveLength(2);
		expect(observations.map((o) => o.sourceId)).toEqual(['s1', 's2']);
		// s1 is untransformed (identity); s2 is rotated 90deg then offset -- the two
		// composite points must differ, proving each source's own transform was used.
		expect(observations[0].compositePoint).toEqual({ xPx: 10, yPx: 10 });
		expect(observations[1].compositePoint.xPx).not.toBeCloseTo(observations[0].compositePoint.xPx, 0);
	});
});

describe('detectBasketsInSourceSpace + rotated composite fixture (basket validation case)', () => {
	const cv = createBruteForceBasketCv();
	const template = buildCanonicalGlyphTemplate();

	it('recovers the glyph in SOURCE space (upright) and merges it to the correct composite location despite a rotated SourceTransform', () => {
		const sourceWidthPx = 90;
		const sourceHeightPx = 90;
		const paintedCenterXPx = 45;
		const paintedCenterYPx = 50;

		const sourceGray = blankGlyphRaster(sourceWidthPx, sourceHeightPx);
		paintGlyph(sourceGray, sourceWidthPx, sourceHeightPx, paintedCenterXPx, paintedCenterYPx, 0, 1);
		const sourceRaster: BasketRaster = { gray: sourceGray, widthPx: sourceWidthPx, heightPx: sourceHeightPx, sourceScale: 1 };

		const sourceCandidates = detectBasketTemplateCandidates(cv, sourceRaster, template, {
			uiScalePx: 1,
			templateScales: [1],
			minScore: 0.5
		});
		expect(sourceCandidates).toHaveLength(1);
		const sourceCandidate = sourceCandidates[0];
		expect(sourceCandidate.score).toBeGreaterThan(0.9);

		// Ground truth, computed independently of the detector: the matched
		// template's top-left must sit at (paintedCenter - templateExtent/2),
		// so the detector's own bottom-stem-base semantic point is derivable
		// directly from the paint parameters.
		const expectedTopLeftXPx = paintedCenterXPx - template.widthPx / 2;
		const expectedTopLeftYPx = paintedCenterYPx - template.heightPx / 2;
		const expectedSourcePoint = {
			xPx: expectedTopLeftXPx + template.widthPx / 2,
			yPx: expectedTopLeftYPx + template.heightPx * BASKET_BASE_Y_FRACTION
		};
		expect(sourceCandidate.xPx).toBeCloseTo(expectedSourcePoint.xPx, 0);
		expect(sourceCandidate.yPx).toBeCloseTo(expectedSourcePoint.yPx, 0);

		// A real rotation + non-unit scale, exactly the `SourceTransform` shape
		// Agent B's generalized stitch produces for a rotated capture.
		const transform = similaritySourceTransform(37, 1.15, 220, 160);

		const observations = detectBasketsInSourceSpace(
			cv,
			[{ sourceId: 'rotated-source', transform, raster: sourceRaster }],
			template,
			{ uiScalePx: 1, templateScales: [1], minScore: 0.5 }
		);
		expect(observations).toHaveLength(1);
		expect(observations[0].sourceId).toBe('rotated-source');

		const expectedCompositePoint = applySourceTransform(expectedSourcePoint, transform);
		expect(observations[0].compositePoint.xPx).toBeCloseTo(expectedCompositePoint.xPx, 0);
		expect(observations[0].compositePoint.yPx).toBeCloseTo(expectedCompositePoint.yPx, 0);

		// --- The point of this fixture: prove source-space detection beats
		// naive upright-only detection run directly on what the composite
		// would actually look like. ---
		//
		// Simulate the composite raster a renderer would produce: the SAME
		// glyph, but painted directly at the transform's rotation/scale/offset
		// (i.e. what stitching a rotated capture actually puts on screen).
		const compositeWidthPx = 500;
		const compositeHeightPx = 500;
		const paintedCenterComposite = applySourceTransform(
			{ xPx: paintedCenterXPx, yPx: paintedCenterYPx },
			transform
		);
		const compositeGray = blankGlyphRaster(compositeWidthPx, compositeHeightPx);
		paintGlyph(
			compositeGray,
			compositeWidthPx,
			compositeHeightPx,
			paintedCenterComposite.xPx,
			paintedCenterComposite.yPx,
			37,
			1.15
		);
		const compositeRaster: BasketRaster = {
			gray: compositeGray,
			widthPx: compositeWidthPx,
			heightPx: compositeHeightPx,
			sourceScale: 1
		};

		// Today's existing detector has no rotation parameter at all -- the
		// best it can do directly on the composite is match the UPRIGHT
		// template at the transform's own scale (1.15), which is exactly
		// `basketTemplateDetection.ts`'s real "always render upright and
		// unrotated" assumption in action.
		// minScore matches the production default: a flat background scores
		// exactly 0 under NCC (zero patch energy), and a 500x500 composite
		// raster full of 0-valued "local maxima" would otherwise blow up the
		// local-maxima collector below any real threshold.
		const directComposite = detectBasketTemplateCandidates(cv, compositeRaster, template, {
			uiScalePx: 1,
			templateScales: [1.15],
			minScore: 0.05
		});
		const directBestScore = directComposite.length > 0 ? Math.max(...directComposite.map((c) => c.score)) : 0;

		// Empirically: sourceCandidate.score is a near-perfect 1.0 (exact pixel
		// match, no rotation to fight), while directBestScore lands around 0.4
		// -- below `detectBasketTemplateCandidates`'s own 0.5 production
		// default. Today's upright-only composite-space matching would simply
		// miss this basket; source-space detection does not.
		expect(directBestScore).toBeLessThan(sourceCandidate.score - 0.2);
	});
});
