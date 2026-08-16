import { describe, expect, it } from 'vitest';
import { detectBasketCandidatesAtPose } from '../../src/lib/autoAnnotation/basketConstrainedPoseDetection';
import { detectAtConstrainedPoses } from '../../src/lib/autoAnnotation/constrainedPoseDetection';
import type { ConstrainedPose } from '../../src/lib/autoAnnotation/constrainedPoseDetection';
import { queryContributingSourcesForRegion } from '../../src/lib/autoAnnotation/sourcePose';
import type { BasketRaster } from '../../src/lib/autoAnnotation/basketTemplateDetection';
import { centeredSimilarityTransform, compositeProvenanceFixture, sourceCaptureFixture } from '../helpers/provenanceFixtures';
import { blankGlyphRaster, buildCanonicalGlyphTemplate, createBruteForceBasketCv, paintGlyph } from '../helpers/bruteForceBasketCv';

/**
 * End-to-end validation of the constrained-composite-space fallback path:
 * real provenance (two sources, two different poses, overlapping) drives
 * `queryContributingSourcesForRegion` to produce a finite pose list, which
 * then genuinely bounds `detectAtConstrainedPoses` -- proven both by an
 * evaluation-count assertion (never more than the two supplied poses) and by
 * a correctness assertion (a rotation the pose set does NOT contain is not
 * found, even though it exists in the raster).
 */
describe('constrained composite-space basket detection, driven by real provenance poses', () => {
	const cv = createBruteForceBasketCv();
	const template = buildCanonicalGlyphTemplate();

	function posesFromContributors(regionCenter: { xPx: number; yPx: number }, sources: ReturnType<typeof sourceCaptureFixture>[]) {
		const provenance = compositeProvenanceFixture(sources);
		const query = queryContributingSourcesForRegion(provenance, {
			xPx: regionCenter.xPx - 5,
			yPx: regionCenter.yPx - 5,
			widthPx: 10,
			heightPx: 10
		});
		if (query.kind !== 'contributors') throw new Error('expected contributors, got unconstrained');
		return query.contributors.map((contributor) => ({ rotationDeg: contributor.rotationDeg, scale: contributor.approxScale }));
	}

	function twoOverlappingSources(rotationADeg: number, rotationBDeg: number, shared: { xPx: number; yPx: number }) {
		const cropA = { xPx: 0, yPx: 0, widthPx: 200, heightPx: 160 };
		const cropB = { xPx: 0, yPx: 0, widthPx: 220, heightPx: 180 };
		return [
			sourceCaptureFixture({
				sourceId: 'source-a',
				widthPx: 300,
				heightPx: 300,
				crop: cropA,
				transform: centeredSimilarityTransform(rotationADeg, 1, cropA, shared),
				paintOrder: 0
			}),
			sourceCaptureFixture({
				sourceId: 'source-b',
				widthPx: 300,
				heightPx: 300,
				crop: cropB,
				transform: centeredSimilarityTransform(rotationBDeg, 1, cropB, shared),
				paintOrder: 1
			})
		];
	}

	it('evaluates only the poses the overlapping sources actually support -- exactly 2, never a blind sweep', () => {
		const shared = { xPx: 260, yPx: 260 };
		const poses = posesFromContributors(shared, twoOverlappingSources(10, 100, shared));
		expect(poses).toHaveLength(2);
		const rotations = poses.map((pose) => Math.round(pose.rotationDeg)).sort((a, b) => a - b);
		expect(rotations).toEqual([10, 100]);

		const evaluated: ConstrainedPose[] = [];
		const raster: BasketRaster = { gray: blankGlyphRaster(20, 20), widthPx: 20, heightPx: 20, sourceScale: 1 };
		detectAtConstrainedPoses(raster, poses, () => [], { onPoseEvaluated: (pose) => evaluated.push(pose) });

		// The crux of "constrained by real provenance, not swept": exactly the
		// two poses the sources support, nothing from a 2.5deg-step 0-180
		// blind sweep (which would be 72 evaluations, not 2).
		expect(evaluated).toHaveLength(2);
		expect(evaluated).toEqual(poses);
	});

	it('finds a basket at a pose the sources support, and does NOT find a basket at a pose outside that set even though it is really there', () => {
		const shared = { xPx: 100, yPx: 100 };
		const poses = posesFromContributors(shared, twoOverlappingSources(10, 100, shared));
		expect(poses.map((p) => Math.round(p.rotationDeg)).sort((a, b) => a - b)).toEqual([10, 100]);

		const width = 200;
		const height = 200;

		// Case 1: the glyph really is rotated at one of the two supported poses (10deg).
		const supportedGray = blankGlyphRaster(width, height);
		paintGlyph(supportedGray, width, height, 100, 100, 10, 1);
		const supportedRaster: BasketRaster = { gray: supportedGray, widthPx: width, heightPx: height, sourceScale: 1 };
		const supportedResults = detectAtConstrainedPoses(supportedRaster, poses, (raster, pose) =>
			detectBasketCandidatesAtPose(cv, raster, template, pose, { minScore: 0.5 })
		);
		expect(supportedResults.length).toBeGreaterThan(0);
		const best = supportedResults.reduce((a, b) => (a.candidate.score > b.candidate.score ? a : b));
		expect(Math.round(best.pose.rotationDeg)).toBe(10);
		// Two independent nearest-neighbor rotations compound here (painting the
		// glyph, then rotating the template to match it), so this falls short of
		// the near-1.0 score the axis-aligned/unrotated fixture in
		// sourceSpaceDetection.test.ts gets -- 0.75 is still a strong, clearly
		// "found it" match, well above the 0.5 minScore floor.
		expect(best.candidate.score).toBeGreaterThan(0.75);
		expect(best.candidate.xPx).toBeCloseTo(100, 0);

		// Case 2: the glyph is rotated at 45deg -- a real pose, but NOT one of
		// the two the overlapping sources support. The constrained search must
		// not find it: it is only ever allowed to try 10deg and 100deg.
		const unsupportedGray = blankGlyphRaster(width, height);
		paintGlyph(unsupportedGray, width, height, 100, 100, 45, 1);
		const unsupportedRaster: BasketRaster = { gray: unsupportedGray, widthPx: width, heightPx: height, sourceScale: 1 };
		const unsupportedResults = detectAtConstrainedPoses(unsupportedRaster, poses, (raster, pose) =>
			detectBasketCandidatesAtPose(cv, raster, template, pose, { minScore: 0.5 })
		);
		expect(unsupportedResults).toHaveLength(0);
	});
});
