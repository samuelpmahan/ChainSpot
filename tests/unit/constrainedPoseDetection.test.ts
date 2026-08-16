import { describe, expect, it } from 'vitest';
import { detectAtConstrainedPoses } from '../../src/lib/autoAnnotation/constrainedPoseDetection';
import type { ConstrainedPose } from '../../src/lib/autoAnnotation/constrainedPoseDetection';

describe('detectAtConstrainedPoses (generic bounded-search harness)', () => {
	it('evaluates exactly the supplied poses -- no more, no fewer, none outside the list', () => {
		const poses: readonly ConstrainedPose[] = [
			{ rotationDeg: 12, scale: 1 },
			{ rotationDeg: 97, scale: 1.4 }
		];
		const evaluated: ConstrainedPose[] = [];
		const raster = { marker: 'raster' };

		detectAtConstrainedPoses(raster, poses, () => [], { onPoseEvaluated: (pose) => evaluated.push(pose) });

		// This is the ticket's "countable/boundable search, not an
		// unconstrained sweep" requirement made concrete: exactly 2 poses
		// evaluated (not, say, 72 = a blind 0-180deg sweep at 2.5deg steps).
		expect(evaluated).toHaveLength(2);
		expect(evaluated).toEqual(poses);
	});

	it('never evaluates an empty poses list as "search everything"', () => {
		const evaluated: ConstrainedPose[] = [];
		const results = detectAtConstrainedPoses({}, [], () => [{ hit: true }], {
			onPoseEvaluated: (pose) => evaluated.push(pose)
		});
		expect(evaluated).toHaveLength(0);
		expect(results).toHaveLength(0);
	});

	it('passes the raster and the exact current pose to detectAtPose, and tags each returned candidate with the pose that found it', () => {
		const raster = { id: 'r1' };
		const poses: readonly ConstrainedPose[] = [
			{ rotationDeg: 0, scale: 1 },
			{ rotationDeg: 180, scale: 1 }
		];
		const results = detectAtConstrainedPoses(raster, poses, (r, pose) => {
			expect(r).toBe(raster);
			return pose.rotationDeg === 180 ? [{ xPx: 1, yPx: 2 }] : [];
		});
		expect(results).toHaveLength(1);
		expect(results[0].pose).toEqual({ rotationDeg: 180, scale: 1 });
		expect(results[0].candidate).toEqual({ xPx: 1, yPx: 2 });
	});
});
