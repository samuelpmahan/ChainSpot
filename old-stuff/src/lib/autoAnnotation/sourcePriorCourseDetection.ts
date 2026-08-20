/**
 * Dependency-driven Annotate Course fast path for a complete CHSPT-79 source
 * landmark handoff.
 *
 * OpenCV is intentionally absent. P1 still scans the composite once because
 * current tee localization lives there, but its incidental badge/basket
 * components are discarded and replaced with the source-space observations
 * Stitch Map already localized and transformed. P3/P4/P5/P6/grammar are the
 * existing ordinary TypeScript/raster stages. MiddleOut is diagnostic and is
 * not on this readiness path.
 */
import {
  CANONICAL_BADGE_HEIGHT_PX,
  CANONICAL_BADGE_WIDTH_PX,
  asNumberTemplateScale
} from './cvCalibration';
import type { CalibratedHoleNumberDetection } from './cvCalibratedDetectors';
import type { CourseDetectionResult } from './basketDetectionLegacy';
import { deriveP3Ownership } from './rawObjectOwnership';
import { deriveP4RibbonOwnership } from './p4RibbonOwnership';
import { deriveP5SparseAssignment } from './p5SparseAssignment';
import { deriveP6LowParBasketAssignment } from './p6LowParBasketAssignment';
import { buildPancakeDisplayGrammar, BASKET_SPRITE_TIP_OFFSET_PX } from './pancakeCourseDisplay';
import {
  detectRawObjectMask,
  RAW_MASK_HISTORICAL_DEFAULTS,
  type RawMaskBadge,
  type RawMaskBasket,
  type RawObjectMaskResult
} from './rawObjectMask';
import { DEFAULT_RIBBON_MASS_PARAMS, segmentRibbonMass } from './ribbonMass';
import type { VisionFlags } from './visionFlags';
import type {
  AnnotateSourceLandmarkEvidence,
  FusedBadgeIdentity
} from './sourceLandmarkBridge';
import type { FusedPhysicalLandmark } from './sourceLandmarkHandoff';
import type { HoleNumberDetection } from './holeNumberDetection';
import {
  COURSE_VISION_OPERATORS,
  type CourseVisionEvidenceListener,
  type CourseVisionEvidenceEvent
} from './courseVisionEvidence';

export interface SourcePriorCoursePerformance {
  readonly path: 'source-prior-pure-ts';
  readonly totalMs: number;
  readonly opencvOnAnnotateCriticalPath: false;
  readonly middleOutOnAnnotateCriticalPath: false;
  readonly sourceFusionMs: number;
  readonly badgeTemplateLoadMs: number;
  readonly badgePureTsMs: number;
  readonly badgeRoiOpenCvMs: number;
  readonly wholeRasterBadgeDiscoveryCount: number;
  readonly stages: Readonly<{
    decodeRasterMs: number;
    p1MaskMs: number;
    sourcePriorMaterializeMs: number;
    p3Ms: number;
    ribbonSegmentationMs: number;
    p4Ms: number;
    p5Ms: number;
    p6Ms: number;
    grammarMs: number;
  }>;
  readonly counts: Readonly<{
    expectedHoles: number;
    sourceBadges: number;
    sourceBaskets: number;
    p1Tees: number;
    discardedP1Badges: number;
    discardedP1Baskets: number;
  }>;
}

export type SourcePriorCourseDetectionResult = CourseDetectionResult & {
  readonly sourcePrior: SourcePriorCoursePerformance;
};

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

async function decodeRgba(
  bytes: Uint8Array,
  mimeType: string,
  widthPx: number,
  heightPx: number
): Promise<Uint8ClampedArray> {
  const bitmap = await createImageBitmap(new Blob([bytes as BufferSource], { type: mimeType }));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = widthPx;
    canvas.height = heightPx;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Source-prior detection could not create a 2D canvas.');
    context.drawImage(bitmap, 0, 0, widthPx, heightPx);
    return context.getImageData(0, 0, widthPx, heightPx).data;
  } finally {
    bitmap.close();
  }
}

function transformedGeometry(landmark: FusedPhysicalLandmark): {
  widthPx: number;
  heightPx: number;
  areaPx: number;
  fill: number;
} {
  let width = 0;
  let height = 0;
  let fill = 0;
  for (const observation of landmark.observations) {
    const [a, b, c, d] = observation.sourceTransform.coefficients;
    width += observation.sourceGeometry.widthPx * Math.hypot(a, b);
    height += observation.sourceGeometry.heightPx * Math.hypot(c, d);
    fill += observation.sourceGeometry.fill;
  }
  const count = Math.max(1, landmark.observations.length);
  const widthPx = width / count;
  const heightPx = height / count;
  const averageFill = fill / count;
  return {
    widthPx,
    heightPx,
    areaPx: widthPx * heightPx * averageFill,
    fill: averageFill
  };
}

function sourceRawBadge(landmark: FusedPhysicalLandmark): RawMaskBadge {
  const geometry = transformedGeometry(landmark);
  return {
    xPx: landmark.compositePoint.xPx,
    yPx: landmark.compositePoint.yPx,
    ...geometry
  };
}

function sourceRawBasket(landmark: FusedPhysicalLandmark): RawMaskBasket {
  const geometry = transformedGeometry(landmark);
  return {
    // P3-P6 expect the bright-sprite bottom point, not the final +4px display tip.
    xPx: landmark.compositeSemanticPoint.xPx,
    yPx: landmark.compositeSemanticPoint.yPx,
    centerXPx: landmark.compositePoint.xPx,
    centerYPx: landmark.compositePoint.yPx,
    ...geometry
  };
}

function badgeScale(badge: RawMaskBadge): number {
  return (badge.widthPx / CANONICAL_BADGE_WIDTH_PX + badge.heightPx / CANONICAL_BADGE_HEIGHT_PX) / 2;
}

function identityByCluster(
  evidence: AnnotateSourceLandmarkEvidence
): ReadonlyMap<string, FusedBadgeIdentity> {
  return new Map(evidence.badgeIdentities.map((identity) => [identity.clusterId, identity]));
}

function sourceNumberDetection(
  evidence: AnnotateSourceLandmarkEvidence,
  badges: readonly RawMaskBadge[],
  fusedBadges: readonly FusedPhysicalLandmark[]
): { calibrated: CalibratedHoleNumberDetection; p2: HoleNumberDetection } {
  const identities = identityByCluster(evidence);
  const candidates = fusedBadges.map((fused, index) => {
    const identity = identities.get(fused.clusterId);
    if (!identity || identity.label === undefined) {
      throw new Error(`Source-prior badge ${fused.clusterId} is not identity-complete.`);
    }
    const badge = badges[index];
    const scale = badgeScale(badge);
    return {
      xPx: badge.xPx,
      yPx: badge.yPx,
      widthPx: badge.widthPx,
      heightPx: badge.heightPx,
      scale,
      score: identity.score,
      badgeScore: 1,
      label: identity.label,
      glyphScore: identity.score,
      diagnosticId: index,
      topGlyphMatches: [
        { label: identity.label, score: identity.score }
      ]
    };
  });
  const anchorCandidate = [...candidates].sort((a, b) => b.glyphScore - a.glyphScore)[0];
  const p2: HoleNumberDetection = {
    candidates,
    anchor: anchorCandidate
      ? {
          label: anchorCandidate.label,
          score: anchorCandidate.glyphScore,
          scale: anchorCandidate.scale,
          xPx: anchorCandidate.xPx,
          yPx: anchorCandidate.yPx,
          widthPx: anchorCandidate.widthPx,
          heightPx: anchorCandidate.heightPx
        }
      : null,
    labeling: 'assigned',
    note: 'Badge bodies and identities propagated from Stitch Map source observations.'
  };
  const calibrated: CalibratedHoleNumberDetection = {
    ...p2,
    anchor: p2.anchor
      ? { ...p2.anchor, scale: asNumberTemplateScale(p2.anchor.scale, 'Source-prior badge scale') }
      : null,
    candidates: p2.candidates.map((candidate) => ({
      ...candidate,
      scale: asNumberTemplateScale(candidate.scale, 'Source-prior badge scale')
    }))
  };
  return { calibrated, p2 };
}

export function canUseSourcePriorCoursePath(
  evidence: AnnotateSourceLandmarkEvidence | undefined
): evidence is AnnotateSourceLandmarkEvidence & { readonly expectedHoleNumbers: readonly number[] } {
  return Boolean(
    evidence &&
    evidence.completeness.badge === 'complete' &&
    evidence.completeness.basket === 'complete' &&
    evidence.expectedHoleNumbers &&
    evidence.expectedHoleNumbers.length > 0 &&
    evidence.badgeIdentities.length === evidence.expectedHoleNumbers.length &&
    evidence.badgeIdentities.every((identity) => identity.status === 'resolved' && identity.label !== undefined)
  );
}

export async function detectCourseFromSourcePriors(
  bytes: Uint8Array,
  mimeType: string,
  widthPx: number,
  heightPx: number,
  evidence: AnnotateSourceLandmarkEvidence & { readonly expectedHoleNumbers: readonly number[] },
  visionFlags: VisionFlags,
  onEvidence?: CourseVisionEvidenceListener
): Promise<SourcePriorCourseDetectionResult> {
  const startedAt = nowMs();
  const emit = (events: readonly CourseVisionEvidenceEvent[]): void => {
    try {
      onEvidence?.(events);
    } catch {
      // display-only; never break detection
    }
  };
  const decodeStartedAt = nowMs();
  const rgba = await decodeRgba(bytes, mimeType, widthPx, heightPx);
  const decodeRasterMs = nowMs() - decodeStartedAt;

  const p1StartedAt = nowMs();
  const p1 = detectRawObjectMask(
    { rgba, widthPx, heightPx },
    undefined,
    visionFlags.p1Profile === 'historical' ? RAW_MASK_HISTORICAL_DEFAULTS : undefined
  );
  const p1MaskMs = nowMs() - p1StartedAt;

  const materializeStartedAt = nowMs();
  const fusedBadges = evidence.fused.filter((landmark) => landmark.family === 'badge');
  const fusedBaskets = evidence.fused.filter((landmark) => landmark.family === 'basket');
  const sourceBadges = fusedBadges.map(sourceRawBadge);
  const sourceBaskets = fusedBaskets.map(sourceRawBasket);
  const rawMaskObjects: RawObjectMaskResult = {
    tees: p1.tees,
    badges: sourceBadges,
    baskets: sourceBaskets,
    diagnostics: p1.diagnostics
  };
  const { calibrated: numberDetection, p2: p2BadgeDetection } = sourceNumberDetection(
    evidence,
    sourceBadges,
    fusedBadges
  );
  const p2LabeledBadges = p2BadgeDetection.candidates.map((candidate) => ({
    holeNumber: candidate.label!,
    glyphScore: candidate.glyphScore!,
    xPx: candidate.xPx,
    yPx: candidate.yPx,
    widthPx: candidate.widthPx,
    heightPx: candidate.heightPx
  }));
  const sourcePriorMaterializeMs = nowMs() - materializeStartedAt;

  // Emission Point 1: After source badges/baskets/identities materialized (before P3)
  const emissionPoint1Events: CourseVisionEvidenceEvent[] = [];
  const elapsedMs1 = nowMs() - startedAt;

  // Candidate event with landmarks batch
  emissionPoint1Events.push({
    state: 'candidate',
    channel: 'fast-lane',
    producer: COURSE_VISION_OPERATORS.sourceLandmarkFusion,
    landmarks: {
      tees: rawMaskObjects.tees.map((tee) => ({
        xPx: tee.xPx,
        yPx: tee.yPx,
        widthPx: tee.widthPx,
        heightPx: tee.heightPx
      })),
      badges: sourceBadges.map((badge) => ({
        xPx: badge.xPx,
        yPx: badge.yPx,
        widthPx: badge.widthPx,
        heightPx: badge.heightPx
      })),
      baskets: sourceBaskets.map((basket) => ({
        xPx: basket.xPx,
        yPx: basket.yPx + BASKET_SPRITE_TIP_OFFSET_PX,
        widthPx: basket.widthPx,
        heightPx: basket.heightPx
      }))
    },
    message: `Source Landmark Fusion supplied ${sourceBadges.length} badges + ${sourceBaskets.length} baskets; Raw UI Landmark Localization found ${rawMaskObjects.tees.length} tee candidates`,
    elapsedMs: elapsedMs1
  });

  // Identified events: one per labeled badge
  for (const badge of p2LabeledBadges) {
    emissionPoint1Events.push({
      state: 'identified',
      channel: 'fast-lane',
      producer: COURSE_VISION_OPERATORS.sourceLandmarkFusion,
      holeNumber: badge.holeNumber,
      geometry: {
        badge: {
          xPx: badge.xPx,
          yPx: badge.yPx,
          widthPx: badge.widthPx,
          heightPx: badge.heightPx
        }
      },
      message: `Source Landmark Fusion resolved H${badge.holeNumber} from propagated Stitch Map evidence`,
      elapsedMs: elapsedMs1
    });
  }

  emit(emissionPoint1Events);

  const p3StartedAt = nowMs();
  const p3Ownership = deriveP3Ownership(
    rawMaskObjects.tees,
    p2LabeledBadges,
    rawMaskObjects.baskets,
    visionFlags
  );
  const p3Ms = nowMs() - p3StartedAt;

  // Emission Point 2: After P3 ownership derivation
  const emissionPoint2Events: CourseVisionEvidenceEvent[] = [];
  const elapsedMs2 = nowMs() - startedAt;

  // Build a map of holeNumber to badge for quick lookup
  const badgesByHoleNumber = new Map(
    p2LabeledBadges.map((badge) => [badge.holeNumber, badge])
  );

  // Owned events: one per teeBadgeHit
  for (const hit of p3Ownership.teeBadgeHits) {
    const tee = rawMaskObjects.tees[hit.teeIndex];
    const badge = badgesByHoleNumber.get(hit.holeNumber);
    if (tee && badge) {
      emissionPoint2Events.push({
        state: 'owned',
        channel: 'fast-lane',
        producer: COURSE_VISION_OPERATORS.geometricOwnership,
        holeNumber: hit.holeNumber,
        geometry: {
          tee: {
            xPx: tee.xPx,
            yPx: tee.yPx,
            widthPx: tee.widthPx,
            heightPx: tee.heightPx
          },
          badge: {
            xPx: badge.xPx,
            yPx: badge.yPx,
            widthPx: badge.widthPx,
            heightPx: badge.heightPx
          }
        },
        message: `Geometric Tee/Badge/Basket Ownership associated H${hit.holeNumber} tee and badge`,
        elapsedMs: elapsedMs2
      });
    }
  }

  // Provisional events: one per straightBasketHit
  for (const hit of p3Ownership.straightBasketHits) {
    const tee = rawMaskObjects.tees[hit.teeIndex];
    const badge = badgesByHoleNumber.get(hit.holeNumber);
    const basket = rawMaskObjects.baskets[hit.basketIndex];
    if (tee && badge && basket) {
      emissionPoint2Events.push({
        state: 'provisional',
        channel: 'fast-lane',
        producer: COURSE_VISION_OPERATORS.geometricOwnership,
        holeNumber: hit.holeNumber,
        geometry: {
          tee: {
            xPx: tee.xPx,
            yPx: tee.yPx,
            widthPx: tee.widthPx,
            heightPx: tee.heightPx
          },
          badge: {
            xPx: badge.xPx,
            yPx: badge.yPx,
            widthPx: badge.widthPx,
            heightPx: badge.heightPx
          },
          basket: {
            xPx: basket.xPx,
            yPx: basket.yPx,
            widthPx: basket.widthPx,
            heightPx: basket.heightPx
          }
        },
        message: `Geometric Tee/Badge/Basket Ownership found provisional straight evidence for H${hit.holeNumber}`,
        elapsedMs: elapsedMs2
      });
    }
  }

  emit(emissionPoint2Events);

  const ribbonStartedAt = nowMs();
  const ribbonSegmentation = segmentRibbonMass(
    { data: rgba, widthPx, heightPx, channels: 4 },
    p2LabeledBadges.map((badge) => ({ xPx: badge.xPx, yPx: badge.yPx })),
    DEFAULT_RIBBON_MASS_PARAMS
  );
  const ribbonSegmentationMs = nowMs() - ribbonStartedAt;

  const p4StartedAt = nowMs();
  const p4RibbonOwnership = deriveP4RibbonOwnership(
    ribbonSegmentation,
    rawMaskObjects.tees,
    p2LabeledBadges,
    rawMaskObjects.baskets,
    p3Ownership
  );
  const p4Ms = nowMs() - p4StartedAt;

  const p5StartedAt = nowMs();
  const p5SparseAssignment = deriveP5SparseAssignment(
    rawMaskObjects.tees,
    p2LabeledBadges,
    p3Ownership,
    p4RibbonOwnership
  );
  const p5Ms = nowMs() - p5StartedAt;

  const p6StartedAt = nowMs();
  const p6LowParBasketAssignment = deriveP6LowParBasketAssignment(
    {
      data: rgba,
      widthPx,
      heightPx,
      originXPx: 0,
      originYPx: 0,
      scale: 1,
      channels: 4
    },
    rawMaskObjects.tees,
    rawMaskObjects.baskets,
    p2LabeledBadges,
    p5SparseAssignment,
    p4RibbonOwnership,
    ribbonSegmentation,
    visionFlags
  );
  const p6Ms = nowMs() - p6StartedAt;

  const grammarStartedAt = nowMs();
  const grammar = buildPancakeDisplayGrammar(
    rawMaskObjects,
    p2BadgeDetection,
    p5SparseAssignment,
    p6LowParBasketAssignment,
    evidence.expectedHoleNumbers
  );
  const grammarMs = nowMs() - grammarStartedAt;

  // Emission Point 3: After display grammar construction
  const emissionPoint3Events: CourseVisionEvidenceEvent[] = [];
  const elapsedMs3 = nowMs() - startedAt;

  for (const hole of grammar.holes) {
    const geometry = {
      ...(hole.tee ? { tee: { xPx: hole.tee.xPx, yPx: hole.tee.yPx } } : {}),
      ...(hole.basket ? { basket: { xPx: hole.basket.xPx, yPx: hole.basket.yPx } } : {})
    };

    emissionPoint3Events.push({
      state: 'final',
      channel: 'authoritative',
      producer: COURSE_VISION_OPERATORS.finalCourseGrammarMaterialization,
      holeNumber: hole.number,
      ...(hole.tee || hole.basket ? { geometry } : {}),
      message: `Basket Assignment and Reconciliation finalized H${hole.number}`,
      elapsedMs: elapsedMs3
    });
  }

  emit(emissionPoint3Events);

  const sourcePrior: SourcePriorCoursePerformance = {
    path: 'source-prior-pure-ts',
    totalMs: nowMs() - startedAt,
    opencvOnAnnotateCriticalPath: false,
    middleOutOnAnnotateCriticalPath: false,
    sourceFusionMs: evidence.fusionMs,
    badgeTemplateLoadMs: evidence.badgeLabeling?.templateLoadMs ?? 0,
    badgePureTsMs: evidence.badgeLabeling?.pureTsMs ?? 0,
    badgeRoiOpenCvMs: evidence.badgeLabeling?.roiOpenCvMs ?? 0,
    wholeRasterBadgeDiscoveryCount: evidence.badgeLabeling?.wholeRasterDiscoveryCount ?? 0,
    stages: {
      decodeRasterMs,
      p1MaskMs,
      sourcePriorMaterializeMs,
      p3Ms,
      ribbonSegmentationMs,
      p4Ms,
      p5Ms,
      p6Ms,
      grammarMs
    },
    counts: {
      expectedHoles: evidence.expectedHoleNumbers.length,
      sourceBadges: sourceBadges.length,
      sourceBaskets: sourceBaskets.length,
      p1Tees: p1.tees.length,
      discardedP1Badges: p1.badges.length,
      discardedP1Baskets: p1.baskets.length
    }
  };

  return {
    numberDetection,
    tees: [],
    baskets: [],
    grammar,
    rawMaskObjects,
    p2BadgeDetection,
    p3Ownership,
    p4RibbonOwnership,
    p5SparseAssignment,
    p6LowParBasketAssignment,
    visionFlags,
    sourcePrior
  };
}
