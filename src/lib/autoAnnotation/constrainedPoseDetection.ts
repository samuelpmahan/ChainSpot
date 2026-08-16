/**
 * Generic constrained-composite-space detection harness (CHSPT-55/51, "Agent
 * D — generic sprite pose").
 *
 * For the fallback case where source-space detection (`sourceSpaceDetection.ts`)
 * isn't practical -- no access to individual source rasters at detection
 * time, only the flattened composite -- this restricts a composite-space
 * search to the FINITE set of poses the contributing source(s) at a given
 * region actually support (from `sourcePose.ts`'s pose-query API), instead of
 * an arbitrary full-angle/full-scale sweep.
 *
 * `teePadOrientation.ts`'s `sweepPadOrientation` is prior art for "how do you
 * sweep candidate angles and score with NCC" (`SWEEP_ANGLE_STEP_DEG = 2.5`,
 * a blind 0-180 degree sweep) but it fits a per-OBJECT orientation search,
 * not a per-CAPTURE pose constraint, and it is not reused here directly. This
 * module deliberately does NOT sweep: it evaluates exactly the caller-supplied
 * `poses` list and nothing outside it, which is what makes the search
 * "constrained by real provenance" rather than "blind, just with fewer
 * steps." Detector-agnostic by construction -- `detectAtPose` is a
 * caller-supplied dependency, the same pattern `sourceSpaceDetection.ts` uses
 * -- so this is equally usable for baskets, badges, tees, or a sprite type
 * that doesn't exist yet.
 */

/** One pose a constrained search is allowed to try. */
export interface ConstrainedPose {
	readonly rotationDeg: number;
	readonly scale: number;
}

/** A candidate found while evaluating one specific pose, with that pose attached. */
export interface ConstrainedPoseCandidate<TCandidate> {
	readonly pose: ConstrainedPose;
	readonly candidate: TCandidate;
}

export interface DetectAtConstrainedPosesOptions {
	/** Diagnostic hook, invoked once per pose actually evaluated, in `poses` order -- the mechanism tests use to prove the search space is bounded to exactly `poses`, not swept. */
	readonly onPoseEvaluated?: (pose: ConstrainedPose) => void;
}

/**
 * Evaluates `detectAtPose` at exactly the poses in `poses` -- no more, no
 * fewer, and never any pose outside that list -- and returns every resulting
 * candidate tagged with the pose that found it. Does not deduplicate/merge
 * candidates found by more than one pose (each pose's own `detectAtPose` is
 * expected to do its own within-pose non-max suppression, matching e.g.
 * `basketTemplateDetection.ts`'s own local-maxima handling); a caller
 * merging across poses owns that policy, since "the same sprite" and an
 * acceptable cross-pose NMS radius are detector-specific.
 */
export function detectAtConstrainedPoses<TRaster, TCandidate>(
	raster: TRaster,
	poses: readonly ConstrainedPose[],
	detectAtPose: (raster: TRaster, pose: ConstrainedPose) => readonly TCandidate[],
	options: DetectAtConstrainedPosesOptions = {}
): readonly ConstrainedPoseCandidate<TCandidate>[] {
	const results: ConstrainedPoseCandidate<TCandidate>[] = [];
	for (const pose of poses) {
		options.onPoseEvaluated?.(pose);
		for (const candidate of detectAtPose(raster, pose)) {
			results.push({ pose, candidate });
		}
	}
	return results;
}
