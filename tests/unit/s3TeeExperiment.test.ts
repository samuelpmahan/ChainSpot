import { describe, expect, test } from 'vitest';
import type { ComponentStats } from '@chainspot/alg/detectors/threeFactor/components';
import type { TeeRing } from '@chainspot/alg/detectors/threeFactor/endpoints';
import { selectTeeFamily, type TeeFrameMeasure } from '@chainspot/alg/stages/S3/clean/Tee';
import { selectFillConsistentTeeFamily } from '@chainspot/alg/stages/S3/exp/fill-consistent/index';

function measure(id: number, fill: number): TeeFrameMeasure {
	const ring: TeeRing = {
		cx: id,
		cy: id,
		holeArea: 100,
		bboxX: id,
		bboxY: id,
		bboxW: 10,
		bboxH: 8,
		angle: 0,
		elongation: 1.6,
		ringFrac: 0.9,
		kind: 'tee-rect'
	};
	const frame: ComponentStats = {
		label: id,
		cx: id,
		cy: id,
		area: 160,
		bboxX: id,
		bboxY: id,
		bboxW: 20,
		bboxH: 16,
		major: 20,
		minor: 16,
		angle: 0,
		fill
	};
	return { ring, frame };
}

describe('S3 fill-consistent Tee-family experiment', () => {
	test('can reject a fill outlier that clean deliberately retains', () => {
		const measured = [measure(1, 0.5), measure(2, 0.51), measure(3, 0.3)];
		expect(selectTeeFamily(measured).members).toHaveLength(3);
		expect(selectFillConsistentTeeFamily(measured).members.map((member) => member.frame.label)).toEqual([
			1,
			2
		]);
	});
});
