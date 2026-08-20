/**
 * Public annotation-vision facade.
 *
 * The historical worker implementation lives unchanged in
 * `basketDetectionLegacy.ts`. This facade adds only the dependency-driven
 * source-prior seam: exact Stitch Map evidence can satisfy badge/basket inputs
 * without awaiting annotation OpenCV; anything incomplete or incoherent falls
 * through to the existing worker unchanged.
 */
export * from './basketDetectionLegacy';

import {
  detectCourseCandidates as detectCourseCandidatesLegacy,
  prewarmBasketDetection as prewarmBasketDetectionLegacy,
  type CourseDetectionProgress,
  type CourseDetectionResult
} from './basketDetectionLegacy';
import { sourceLandmarkEvidenceForRaster } from './sourceLandmarkBridge';
import {
  canUseSourcePriorCoursePath,
  detectCourseFromSourcePriors
} from './sourcePriorCourseDetection';
import { getVisionFlagsSnapshot } from './visionFlags';

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Accurate name for the old basket-specific preload API. AnnotationWorkspace
 * invokes this speculatively (`void ...`) and never awaits it before the
 * source-prior path. Keep that warm-up behavior unchanged so an incomplete
 * handoff does not regress historical fallback latency; a complete source
 * handoff simply does not depend on the warm-up finishing.
 */
export function prewarmAnnotationVision(): Promise<void> {
  return prewarmBasketDetectionLegacy();
}

/** Backward-compatible name used by current AnnotationWorkspace. */
export function prewarmBasketDetection(): Promise<void> {
  return prewarmAnnotationVision();
}

export async function detectCourseCandidates(
  bytes: Uint8Array,
  mimeType: string,
  widthPx: number,
  heightPx: number,
  onProgress?: (progress: CourseDetectionProgress) => void
): Promise<CourseDetectionResult> {
  // Experimental NuThing render-identity lane (flag-gated; see visionFlags).
  // Tried first when armed so demo/e2e runs exercise it even when a complete
  // source-landmark handoff would otherwise claim the image; any failure
  // falls through to the existing paths unchanged.
  const flags = getVisionFlagsSnapshot();
  if (flags.nuthingPairing) {
    try {
      const { detectCourseWithNuThing } = await import('./nuthingCourseDetection');
      const startedAt = nowMs();
      onProgress?.({
        stage: 'numbers',
        message: 'NuThing render-identity pairing…',
        elapsedMs: 0
      });
      const result = await detectCourseWithNuThing(bytes, mimeType, widthPx, heightPx, {
        geoScale: flags.nuthingGeoScale,
        onEvidence: (events) => {
          if (events.length === 0) return;
          const latest = events[events.length - 1];
          onProgress?.({
            stage: 'evidence',
            message: latest.message,
            elapsedMs: nowMs() - startedAt,
            evidence: events
          });
        }
      });
      console.info('[ChainSpot Annotate NuThing lane]', {
        ...result.nuthing,
        stages: result.nuthing.stages
      });
      return result;
    } catch (error) {
      console.warn(
        '[ChainSpot Annotate] NuThing lane failed; preserving existing detection paths.',
        error
      );
    }
  }

  const lookupStartedAt = nowMs();
  const evidence = await sourceLandmarkEvidenceForRaster(bytes);
  const evidenceLookupMs = nowMs() - lookupStartedAt;
  if (canUseSourcePriorCoursePath(evidence)) {
    onProgress?.({
      stage: 'numbers',
      message: `${evidence.expectedHoleNumbers.length} source badges + baskets already resolved · assigning tees…`,
      elapsedMs: evidenceLookupMs
    });
    try {
      const result = await detectCourseFromSourcePriors(
        bytes,
        mimeType,
        widthPx,
        heightPx,
        evidence,
        getVisionFlagsSnapshot(),
        // Progressive Course Vision evidence rides the same onProgress channel
        // both execution paths share, so the UI never needs to know which path
        // ran. Display/trace only — never a domain mutation trigger.
        (events) => {
          if (events.length === 0) return;
          const latest = events[events.length - 1];
          onProgress?.({
            stage: 'evidence',
            message: latest.message,
            elapsedMs: latest.elapsedMs,
            evidence: events
          });
        }
      );
      console.info('[ChainSpot Annotate critical path]', {
        evidenceLookupMs,
        ...result.sourcePrior
      });
      console.table({ evidenceLookupMs, ...result.sourcePrior.stages });
      return result;
    } catch (error) {
      console.warn(
        '[ChainSpot Annotate] complete source-prior path failed; preserving historical worker fallback.',
        error
      );
    }
  }

  if (evidence) {
    console.info('[ChainSpot Annotate source-prior fallback]', {
      evidenceLookupMs,
      completeness: evidence.completeness,
      completenessBasis: evidence.completenessBasis,
      expectedHoleNumbers: evidence.expectedHoleNumbers,
      sourceBadges: evidence.fused.filter((landmark) => landmark.family === 'badge').length,
      sourceBaskets: evidence.fused.filter((landmark) => landmark.family === 'basket').length,
      wholeRasterFallback: true
    });
  }
  return detectCourseCandidatesLegacy(bytes, mimeType, widthPx, heightPx, onProgress);
}
