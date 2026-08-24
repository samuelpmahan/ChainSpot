// Round pre-read orchestration — extracted behavior-identical from the
// page's runRoundPreRead() (src/routes/+page.svelte, ~lines 383-410): run
// both thrown-round detectors over an already-decoded image and collect
// their positions.
//
// The policy worth naming explicitly: an empty pre-read ({walk: [],
// droplets: []}) is a VALID result, not a failure signal — confirm may
// proceed with no trace; Map Round simply gets nothing to show. This
// function therefore never throws. The page's own seq/selectionSeq
// staleness guard (does this async result still belong to the current
// selection?) stays page-side — that's session state about WHEN to accept
// a result, not part of what the result should contain.
//
// OperationKind: 'decide' (walkTraceDetector/landingDropletDetector
// themselves remain 'measure').

import type { RgbaRaster } from '../detect';
import { walkTraceDetector } from '../detectors/walkTrace';
import { landingDropletDetector } from '../detectors/landingDroplet';

export interface RoundPreReadPoint {
	readonly xPx: number;
	readonly yPx: number;
}

export interface RoundPreRead {
	readonly walk: readonly RoundPreReadPoint[];
	readonly droplets: readonly RoundPreReadPoint[];
}

export async function preReadRound(image: RgbaRaster): Promise<RoundPreRead> {
	try {
		const walk: RoundPreReadPoint[] = [];
		const droplets: RoundPreReadPoint[] = [];
		await walkTraceDetector(image, (e) => {
			if (e.kind === 'object' && e.objType === 'walk-vertex') walk.push({ xPx: e.xPx, yPx: e.yPx });
		});
		await landingDropletDetector(image, (e) => {
			if (e.kind === 'object' && e.objType === 'landing-droplet') droplets.push({ xPx: e.xPx, yPx: e.yPx });
		});
		return { walk, droplets };
	} catch {
		// An empty pre-read is a valid pre-read — never block the pipeline on CV failure.
		return { walk: [], droplets: [] };
	}
}
