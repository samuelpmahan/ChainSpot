import { describe, expect, it } from 'vitest';
import {
	groundTruthMatchesImage,
	IMG_5641_GROUND_TRUTH,
	mergeCourseGroundTruth
} from '../../src/lib/autoAnnotation/courseGroundTruth';

describe('IMG_5641 course ground truth', () => {
	it('matches the shipped reference image, including a filename with incidental whitespace', () => {
		expect(
			groundTruthMatchesImage({ fileName: 'IMG_5641 .jpg', widthPx: 1290, heightPx: 2091 })
		).toBe(true);
		expect(
			groundTruthMatchesImage({ fileName: 'IMG_5641.jpg', widthPx: 1289, heightPx: 2091 })
		).toBe(false);
	});

	it('contains 18 pads, baskets, and badges', () => {
		expect(IMG_5641_GROUND_TRUTH.holes).toHaveLength(18);
		expect(IMG_5641_GROUND_TRUTH.badges).toHaveLength(18);
		expect(IMG_5641_GROUND_TRUTH.holes[0]).toMatchObject({ number: 1, tee: { xPx: 884.8377444109449 }, basket: { xPx: 520.909799907873 } });
	});

	it('changes only course endpoints when merging into existing annotation', () => {
		const current = [{
			id: 'existing-1',
			number: 1,
			tee: { xPx: 1, yPx: 2 },
			shots: [{ id: 'shot-1', landing: { xPx: 3, yPx: 4 } }],
			corridorBends: [{ xPx: 5, yPx: 6 }],
			corridorWidthPx: 77
		}];
		const merged = mergeCourseGroundTruth(current, IMG_5641_GROUND_TRUTH, () => 'new-id', 60);
		const holeOne = merged.find((hole) => hole.number === 1)!;
		expect(merged).toHaveLength(18);
		expect(holeOne.id).toBe('existing-1');
		expect(holeOne.tee).toEqual(IMG_5641_GROUND_TRUTH.holes[0].tee);
		expect(holeOne.basket).toEqual(IMG_5641_GROUND_TRUTH.holes[0].basket);
		expect(holeOne.shots).toEqual(current[0].shots);
		expect(holeOne.corridorBends).toEqual(current[0].corridorBends);
		expect(holeOne.corridorWidthPx).toBe(77);
	});
});
