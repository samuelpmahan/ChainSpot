/**
 * ChainSpot demo step arming — loading a step's real inputs.
 *
 * The one place the demo touches product state, kept deliberately small and
 * deliberately boring. Arming never computes a result, never fabricates an
 * arrangement, and never writes into an editor: it only puts real files where a
 * real intake path will find them, then lets the route do its own work in front
 * of the visitor.
 *
 * Arming is idempotent-ish by design rather than by accident. Stitch Map's
 * inbox is a one-shot slot, so a second arm before navigation simply replaces
 * an unclaimed set of the same four files. The Map Round handoff refuses to
 * overwrite a pending handoff that is already waiting, because that handoff
 * is usually the visitor's own stitched export from step 1 — silently replacing
 * their work with a sample is the one thing this module must never do.
 *
 * Failures are returned, not thrown, matching `naip.ts`/`geocode.ts`, so the
 * guide rail can show one clear sentence instead of crashing a sales demo.
 */
import { getPendingHandoff, setPendingHandoff } from '../session';
import { fetchDemoFile, fetchDemoFiles, DemoAssetError } from './assets';
import type { FetchLike } from './assets';
import { DEMO_DATASET } from './catalog';
import type { DemoStep } from './catalog';
import { setPendingStitchCaptures } from '../session';
import { setVisionFlag } from '../autoAnnotation/visionFlags';

export type ArmResult =
	| { ok: true; message: string }
	| { ok: false; message: string };

/**
 * Loads whatever real inputs `step` needs and hands them to the route's own
 * intake path. Returns a sentence describing what happened, suitable for
 * display verbatim.
 */
export async function armDemoStep(step: DemoStep, fetchImpl: FetchLike = fetch): Promise<ArmResult> {
	try {
		switch (step.arming.kind) {
			case 'stitch-captures': {
				// The dataset knows its own capture calibration (The REC is shot at
				// 2x the detection corpus's zoom); arming the walkthrough arms the
				// matching detection lane so Annotate Course sees these captures
				// the way the pipeline was measured. Persisted flags, so a
				// mid-walkthrough reload keeps the calibration.
				if (DEMO_DATASET.vision) {
					setVisionFlag('nuthingPairing', DEMO_DATASET.vision.nuthingPairing);
					setVisionFlag('nuthingGeoScale', DEMO_DATASET.vision.nuthingGeoScale);
				}
				const files = await fetchDemoFiles(DEMO_DATASET.captures, fetchImpl);
				setPendingStitchCaptures(files);
				return {
					ok: true,
					message: `Loaded ${files.length} real UDisc captures of ${DEMO_DATASET.courseName}. Stitch Map infers their order and overlap itself.`
				};
			}
			case 'annotate-source': {
				// Any pending handoff blocks, not just one bound for this step's
				// own route. The handoff store holds a single slot shared by both
				// roles, so publishing a `source-overview` sample over a waiting
				// `target-basemap` export would destroy a stitch the visitor made
				// and is on their way to import — the precise thing this module
				// exists to never do. Which role is waiting does not change that.
				const existing = getPendingHandoff();
				if (existing) {
					return {
						ok: true,
						message: `Keeping the image already waiting to import ("${existing.fileName}") — the demo never overwrites your own stitched export.`
					};
				}
				const file = await fetchDemoFile(DEMO_DATASET.roundOverview, fetchImpl);
				setPendingHandoff({
					blob: file,
					fileName: file.name,
					targetRole: 'source-overview',
					destination: 'map-round'
				});
				return {
					ok: true,
					message: `Loaded the played-round capture of ${DEMO_DATASET.courseName}. Import it from the banner, then accept "Import saved holes" to pull in the course geometry from step 2.`
				};
			}
			case 'none':
				return {
					ok: true,
					message: 'This step runs on your own input — nothing to preload.'
				};
		}
	} catch (cause) {
		if (cause instanceof DemoAssetError) {
			return { ok: false, message: cause.message };
		}
		return {
			ok: false,
			message: `Could not load this step's sample inputs: ${
				cause instanceof Error ? cause.message : String(cause)
			}`
		};
	}
}

/** True when a step has sample inputs the guide can offer to load. */
export function stepHasArming(step: DemoStep): boolean {
	return step.arming.kind !== 'none';
}
