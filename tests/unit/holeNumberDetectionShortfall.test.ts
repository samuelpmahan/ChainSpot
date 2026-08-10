import { describe, expect, it } from 'vitest';
import { detectHoleNumberBadges } from '../../src/lib/autoAnnotation/holeNumberDetection';
import type {
	HoleNumberCvModule,
	HoleNumberRaster,
	HoleNumberTemplate
} from '../../src/lib/autoAnnotation/holeNumberDetection';

/**
 * Reproduces (with a synthetic, photo-free raster) the exact collapse
 * measured live against the shipped demo dataset
 * (`static/resources/demo/dashs-track/`, see `docs/cv-demo-zero-ready.md`):
 * `assignedCandidates` in `holeNumberDetection.ts` requires the number of
 * physical badge-body clusters found on the source image to *exactly* equal
 * the number of supplied templates (18) before it will label anything. When
 * the real image only yields 16 physical candidates (two badges did not
 * survive the same-size clustering step -- see the doc for the real
 * measurement), the labeler does not label the 16 it *did* find; it aborts
 * for all 18 and returns `labeling: 'candidate-only'` with every candidate's
 * `label` left `undefined`.
 *
 * This never needs OpenCV.js: the equality gate that causes the collapse
 * runs before any `cv.matchTemplate` call, so a fake `cv` that is never
 * invoked is sufficient to isolate it.
 */

function unusedCv(): HoleNumberCvModule {
	return {
		Mat: class {
			delete(): void {}
		} as unknown as HoleNumberCvModule['Mat'],
		CV_8UC1: 0,
		TM_CCOEFF_NORMED: 0,
		matchTemplate(): void {
			throw new Error('matchTemplate should not be reached when the physical-candidate count is short.');
		}
	};
}

/** A solid dark rectangle on a light background -- exactly what `darkComponents` + `plausibleBadgeBody` are built to accept as one badge body. */
function solidRasterWithBoxes(
	widthPx: number,
	heightPx: number,
	boxes: readonly { x: number; y: number; w: number; h: number }[]
): HoleNumberRaster {
	const data = new Uint8Array(widthPx * heightPx).fill(255);
	for (const box of boxes) {
		for (let y = box.y; y < box.y + box.h; y += 1) {
			for (let x = box.x; x < box.x + box.w; x += 1) {
				data[y * widthPx + x] = 0;
			}
		}
	}
	return { format: 'gray', widthPx, heightPx, data };
}

function templatePack(count: number): HoleNumberTemplate[] {
	// 47x35 matches the canonical badge-body size measured directly against
	// the real bundled hole-01.png..hole-18.png pack.
	const templates: HoleNumberTemplate[] = [];
	for (let label = 1; label <= count; label += 1) {
		templates.push({
			label,
			raster: solidRasterWithBoxes(60, 45, [{ x: 6, y: 5, w: 47, h: 35 }])
		});
	}
	return templates;
}

describe('detectHoleNumberBadges: physical-candidate shortfall', () => {
	it('demonstrates the current bug: 16 well-formed badges found against 18 templates labels zero of them', () => {
		// 16 consistently-sized, well-separated badge-shaped boxes -- the exact
		// count measured on the real stitched demo course map.
		const boxes = Array.from({ length: 16 }, (_, index) => ({
			x: 20 + (index % 4) * 90,
			y: 20 + Math.floor(index / 4) * 90,
			w: 37,
			h: 27
		}));
		const source = solidRasterWithBoxes(400, 400, boxes);
		const result = detectHoleNumberBadges(unusedCv(), source, templatePack(18));

		// What actually happens today: total collapse.
		expect(result.labeling).toBe('candidate-only');
		expect(result.candidates.filter((candidate) => candidate.label !== undefined)).toHaveLength(0);
		// The 16 real, well-formed physical candidates were still *found* --
		// they are sitting right there in the result, just unlabeled.
		expect(result.candidates).toHaveLength(16);
	});

	it.skip('desired behavior: the 16 badges that were found should still get labels (currently fails -- see docs/cv-demo-zero-ready.md)', () => {
		const boxes = Array.from({ length: 16 }, (_, index) => ({
			x: 20 + (index % 4) * 90,
			y: 20 + Math.floor(index / 4) * 90,
			w: 37,
			h: 27
		}));
		const source = solidRasterWithBoxes(400, 400, boxes);
		const result = detectHoleNumberBadges(unusedCv(), source, templatePack(18));

		// This is what a partial/at-most-N assignment (mirroring courseGrammar's
		// own `withDummyColumns` Hungarian pattern) would produce instead of the
		// current all-or-nothing collapse: most candidates labeled, at most two
		// left unlabeled for lack of a matching physical candidate.
		const labeledCount = result.candidates.filter((candidate) => candidate.label !== undefined).length;
		expect(labeledCount).toBeGreaterThanOrEqual(14);
	});
});
