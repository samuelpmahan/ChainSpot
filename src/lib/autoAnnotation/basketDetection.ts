/**
 * Public annotation-vision facade.
 *
 * The historical worker implementation lives unchanged in
 * `basketDetectionLegacy.ts`. This facade adds only the dependency-driven
 * source-prior seam: exact Stitch Map evidence can satisfy badge/basket inputs
 * without booting annotation OpenCV; anything incomplete or incoherent falls
 * through to the existing worker unchanged.
 */
export * from './basketDetectionLegacy';

import {
  detectCourseCandidates as detectCourseCandidatesLegacy,
  prewarmBasketDetection as prewarmBasketDetectionLegacy,
  type CourseDetectionProgress,
  type CourseDetectionResult
} from './basketDetectionLegacy';
import {
  hasRenderedSourceLandmarkEvidence,
  sourceLandmarkEvidenceForRaster
} from './sourceLandmarkBridge';
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

/** Accurate name for the old basket-specific preload API. */
export function prewarmAnnotationVision(): Promise<void> {
  // Do not eagerly put annotation CV back on the critical path while an exact
  // Stitch Map evidence handoff is pending. The exact-byte lookup below still
  // decides whether that evidence is usable; an incomplete handoff therefore
  // only defers speculative warm-up, never changes correctness.
  if (hasRenderedSourceLandmarkEvidence()) return Promise.resolve();
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
        getVisionFlagsSnapshot()
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
