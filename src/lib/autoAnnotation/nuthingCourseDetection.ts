/**
 * NuThing render-identity Course Vision producer (experimental lane).
 *
 * Runs the NuThing P2 pipeline — screen-space badge/sprite staging, ribbon
 * support field, per-badge Dijkstra pair evidence (src/lib/nuthing/
 * coursePairing.ts), the frozen dev72 strip-coherence scoring stack, and the
 * 1:1 exchange assignment (src/lib/nuthing/pairScoring.ts) — as an
 * alternative producer behind the `nuthingPairing` vision flag. The exact
 * same modules back scripts/nuthing/pair-matrix*.ts, where the stack
 * measures 72/72 exact assignments on the dev corpus and 9/9 on The Rec.
 *
 * Dual-scale captures (CX-058): badges and basket sprites are screen-space
 * furniture, corridors/zones/tee pads are geographic. `geoScale` (geometry
 * px per capture px; 0.5 = capture at 2x the dev render zoom) is supplied by
 * the caller — a user-facing calibration in the `UiScaleInput` tradition,
 * carried by the `nuthingGeoScale` vision flag until the render-identity
 * zoom estimator (CX open item) is measured in.
 *
 * Output contract matches `detectCourseFromSourcePriors`: an authoritative
 * `CourseDetectionResult` (numberDetection + grammar drive the workspace
 * draft; rawMaskObjects carries the candidate pools), plus display-only
 * progressive evidence events.
 */
import spriteTemplateJson from '../../../resources/nuthing-p2/endpoints/basket-sprite.json';
import logisticModelJson from '../../../resources/nuthing-p2/digits/models/logistic.json';
import { asNumberTemplateScale } from './cvCalibration';
import type { CalibratedHoleNumberDetection } from './cvCalibratedDetectors';
import type { CourseDetectionResult } from './basketDetectionLegacy';
import type { CourseGrammarResult, CourseHoleProposal } from './courseGrammar';
import type { HoleNumberDetection } from './holeNumberDetection';
import type { RawObjectMaskResult } from './rawObjectMask';
import {
  COURSE_VISION_OPERATORS,
  type CourseVisionEvidenceEvent,
  type CourseVisionEvidenceListener,
  type CourseVisionOperatorRef
} from './courseVisionEvidence';
import { measureCoursePairs } from '../nuthing/coursePairing';
import type { BadgeMatrix } from '../nuthing/coursePairing';
import { rescoreCourse, assignPairs, DEV72_SCORING } from '../nuthing/pairScoring';
import type { ScoringCourse } from '../nuthing/pairScoring';
import { prepareSpriteTemplate } from '../nuthing/endpoints';
import type { SpriteTemplate } from '../nuthing/endpoints';
import { predictProbs } from '../nuthing/digits/logistic';
import type { LogisticModel } from '../nuthing/digits/logistic';
import { detectMapViewport, cropRows } from '../nuthing/viewport';
import { resampleToGeometryFrame } from '../nuthing/renderScale';
import { DEFAULT_CORRIDOR_WIDTH } from '../nuthing/badgeOcclusion';
import type { RgbaImage } from '../nuthing/raster';

/** NuThing-era operators (descriptive names only — no Pancake shorthand). */
const NUTHING_MEASUREMENT: CourseVisionOperatorRef = Object.freeze({
  name: 'NuThing Render-Identity Measurement'
});
const NUTHING_ASSIGNMENT: CourseVisionOperatorRef = Object.freeze({
  name: 'NuThing Strip-Coherence Assignment'
});

export interface NuThingDetectionOptions {
  /** Geometry px per capture px. 1 = dev render zoom, 0.5 = 2x zoom. */
  readonly geoScale?: number;
  readonly corridorWidthPx?: number;
  readonly onEvidence?: CourseVisionEvidenceListener;
  /** Test seam: pre-decoded RGBA (browser decode needs a DOM). */
  readonly rgba?: Uint8ClampedArray;
}

export interface NuThingCoursePerformance {
  readonly path: 'nuthing-render-identity';
  readonly totalMs: number;
  readonly geoScale: number;
  readonly stages: Readonly<{
    decodeRasterMs: number;
    resampleMs: number;
    measureMs: number;
    rescoreMs: number;
    assignMs: number;
  }>;
  readonly counts: Readonly<{
    badges: number;
    tees: number;
    baskets: number;
    assignedHoles: number;
  }>;
}

export type NuThingCourseDetectionResult = CourseDetectionResult & {
  readonly nuthing: NuThingCoursePerformance;
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
    if (!context) throw new Error('NuThing detection could not create a 2D canvas.');
    context.drawImage(bitmap, 0, 0, widthPx, heightPx);
    return context.getImageData(0, 0, widthPx, heightPx).data;
  } finally {
    bitmap.close();
  }
}

/**
 * Maps an assignment pair score to a display confidence. Measured score
 * bands: healthy assigned pairs 0.28–0.79 on The Rec and the dev corpus;
 * starved/false pairs 0.03–0.07. 0.15 is the ready/review boundary; the
 * confidence mapping puts healthy pairs above the workspace's default 0.6
 * auto-apply floor and starved ones far below it.
 */
function pairConfidence(score: number): number {
  return Math.max(0, Math.min(1, score / 0.4));
}

export async function detectCourseWithNuThing(
  bytes: Uint8Array,
  mimeType: string,
  widthPx: number,
  heightPx: number,
  options: NuThingDetectionOptions = {}
): Promise<NuThingCourseDetectionResult> {
  const startedAt = nowMs();
  const geoScale = options.geoScale ?? 1;
  const corridorWidthPx = options.corridorWidthPx ?? DEFAULT_CORRIDOR_WIDTH;
  const emit = (events: readonly CourseVisionEvidenceEvent[]): void => {
    try {
      if (events.length > 0) options.onEvidence?.(events);
    } catch {
      // display-only; never break detection
    }
  };

  const decodeStartedAt = nowMs();
  const rgba = options.rgba ?? (await decodeRgba(bytes, mimeType, widthPx, heightPx));
  const decodeRasterMs = nowMs() - decodeStartedAt;
  const nativeFull: RgbaImage = {
    width: widthPx,
    height: heightPx,
    data: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)
  };

  const resampleStartedAt = nowMs();
  const geometryFull = resampleToGeometryFrame(nativeFull, geoScale);
  const resampleMs = nowMs() - resampleStartedAt;
  const dualScale = geometryFull !== nativeFull;
  // resampleToGeometryFrame treats |geoScale-1| < 2% as identity; every
  // frame mapping below must use the scale that was ACTUALLY applied, or a
  // geoScale of e.g. 0.99 shifts all emitted coordinates by ~1% (audit
  // finding: nuthingGeoScale accepts any value in [0.2, 2]).
  const appliedGeoScale = dualScale ? geoScale : 1;

  const geometryVp = detectMapViewport(geometryFull);
  const geometryImage = cropRows(geometryFull, geometryVp);
  const nativeVp = dualScale ? detectMapViewport(nativeFull) : geometryVp;
  const nativeImage = dualScale ? cropRows(nativeFull, nativeVp) : geometryImage;

  const measureStartedAt = nowMs();
  const measured = measureCoursePairs({
    courseName: 'live',
    image: geometryImage,
    viewportTop: geometryVp.top,
    ...(dualScale ? { native: { image: nativeImage, viewportTop: nativeVp.top }, geoScale } : {}),
    corridorWidthPx,
    patchBadges: true,
    spriteTemplate: prepareSpriteTemplate(spriteTemplateJson as SpriteTemplate),
    digitScorer: {
      name: 'logistic',
      scores: (m) => predictProbs(logisticModelJson as LogisticModel, m)
    }
  });
  const measureMs = nowMs() - measureStartedAt;

  // Geometry frame -> full capture frame (the raster the workspace displays).
  const toNativeX = (x: number): number => x / appliedGeoScale;
  const toNativeY = (y: number): number => (y + geometryVp.top) / appliedGeoScale;

  const labeledBadges = measured.readings.filter((r) => r.label);
  emit([
    {
      state: 'candidate',
      channel: 'fast-lane',
      producer: NUTHING_MEASUREMENT,
      landmarks: {
        tees: measured.teePoints.map((t) => ({ xPx: toNativeX(t.x), yPx: toNativeY(t.y) })),
        badges: measured.badges.map((b) => ({
          xPx: toNativeX(b.cx),
          yPx: toNativeY(b.cy),
          widthPx: b.bboxW / appliedGeoScale,
          heightPx: b.bboxH / appliedGeoScale
        })),
        baskets: measured.basketPoints.map((b) => ({ xPx: toNativeX(b.x), yPx: toNativeY(b.y) }))
      },
      message: `NuThing Render-Identity Measurement localized ${measured.badges.length} badges, ${measured.teePoints.length} tee candidates, ${measured.basketPoints.length} basket candidates`,
      elapsedMs: nowMs() - startedAt
    },
    ...labeledBadges.map(
      (r): CourseVisionEvidenceEvent => ({
        state: 'identified',
        channel: 'fast-lane',
        producer: NUTHING_MEASUREMENT,
        holeNumber: Number(r.label),
        geometry: {
          badge: {
            xPx: toNativeX(r.badge.cx),
            yPx: toNativeY(r.badge.cy),
            widthPx: r.badge.bboxW / appliedGeoScale,
            heightPx: r.badge.bboxH / appliedGeoScale
          }
        },
        message: `NuThing Render-Identity Measurement resolved H${r.label}`,
        elapsedMs: nowMs() - startedAt
      })
    )
  ]);

  const rescoreStartedAt = nowMs();
  const scoringCourse: ScoringCourse = {
    field: {
      width: measured.field.width,
      height: measured.field.height,
      scale: measured.field.scale
    },
    endpoints: {
      tees: measured.teePoints.map((t, i) => ({
        id: `T${i}`,
        x: t.x,
        y: t.y,
        onRing: t.onRing,
        angle: t.angle,
        tier: t.tier
      })),
      baskets: measured.basketPoints.map((b, i) => ({
        id: `B${i}`,
        x: b.x,
        y: b.y,
        score: b.score
      }))
    },
    // ScoringCourse badges carry top-level cx/cy (the cache-JSON shape the
    // replay script emits); BadgeMatrix nests them under `.badge`.
    badges: measured.matrices.map((m) => ({
      label: m.label,
      cx: m.badge.cx,
      cy: m.badge.cy,
      legs: m.legs,
      pairs: m.pairs
    }))
  };
  const rescored = rescoreCourse(scoringCourse, measured.field.support, measured.field.bestTheta, {
    ...DEV72_SCORING,
    corridorWidthPx
  });
  const rescoreMs = nowMs() - rescoreStartedAt;

  const assignStartedAt = nowMs();
  const chosen = assignPairs(rescored);
  const assignMs = nowMs() - assignStartedAt;

  // --- Authoritative result -------------------------------------------------
  const badgeByLabel = new Map(labeledBadges.map((r) => [r.label, r]));
  const matrixByLabel = new Map<string, BadgeMatrix>(measured.matrices.map((m) => [m.label, m]));

  const candidates = labeledBadges.map((r, index) => ({
    xPx: toNativeX(r.badge.cx),
    yPx: toNativeY(r.badge.cy),
    widthPx: r.badge.bboxW / appliedGeoScale,
    heightPx: r.badge.bboxH / appliedGeoScale,
    scale: 1,
    score: 1,
    badgeScore: 1,
    label: Number(r.label),
    glyphScore: 1,
    diagnosticId: index,
    topGlyphMatches: [{ label: Number(r.label), score: 1 }]
  }));
  const anchorCandidate = candidates[0];
  const p2BadgeDetection: HoleNumberDetection = {
    candidates,
    anchor: anchorCandidate
      ? {
          label: anchorCandidate.label,
          score: 1,
          scale: 1,
          xPx: anchorCandidate.xPx,
          yPx: anchorCandidate.yPx,
          widthPx: anchorCandidate.widthPx,
          heightPx: anchorCandidate.heightPx
        }
      : null,
    labeling: 'assigned',
    note: 'Badges localized and read by the NuThing render-identity stage.'
  };
  const numberDetection: CalibratedHoleNumberDetection = {
    ...p2BadgeDetection,
    anchor: p2BadgeDetection.anchor
      ? {
          ...p2BadgeDetection.anchor,
          scale: asNumberTemplateScale(1, 'NuThing badge scale')
        }
      : null,
    candidates: p2BadgeDetection.candidates.map((candidate) => ({
      ...candidate,
      scale: asNumberTemplateScale(1, 'NuThing badge scale')
    }))
  };

  const rawMaskObjects: RawObjectMaskResult = {
    tees: measured.teePoints.map((t) => ({
      xPx: toNativeX(t.x),
      yPx: toNativeY(t.y),
      orientationDeg: t.angle === null ? 0 : (t.angle * 180) / Math.PI,
      widthPx: 28 / appliedGeoScale,
      heightPx: 20 / appliedGeoScale,
      areaPx: (28 * 20) / (appliedGeoScale * appliedGeoScale),
      fill: 0.5
    })),
    badges: measured.badges.map((b) => ({
      xPx: toNativeX(b.cx),
      yPx: toNativeY(b.cy),
      widthPx: b.bboxW / appliedGeoScale,
      heightPx: b.bboxH / appliedGeoScale,
      areaPx: b.area / (appliedGeoScale * appliedGeoScale),
      fill: b.fill
    })),
    baskets: measured.basketPoints.map((b) => ({
      xPx: toNativeX(b.x),
      yPx: toNativeY(b.y),
      centerXPx: toNativeX(b.cx),
      centerYPx: toNativeY(b.cy),
      widthPx: 42,
      heightPx: 66,
      areaPx: 1746,
      fill: 0.63
    })),
    diagnostics: {
      brightComponentCount: measured.teePoints.length,
      darkComponentCount: measured.badges.length,
      basketShapePoolCount: measured.basketPoints.length,
      badgeShapePoolCount: measured.badges.length,
      thresholds: { brightValueMin: 210, brightSaturationMax: 45, darkValueMax: 45 }
    }
  };

  const teeIndexOf = (teeId: string): number => Number(teeId.slice(1));
  const basketIndexOf = (basketId: string): number => Number(basketId.slice(1));
  const holes: CourseHoleProposal[] = [...chosen.entries()]
    .filter(([label]) => badgeByLabel.has(label))
    .map(([label, pick]) => {
      const number = Number(label);
      const badge = badgeByLabel.get(label)!;
      const matrix = matrixByLabel.get(label);
      const numberBadge = {
        candidateIndex: candidates.findIndex((c) => c.label === number),
        xPx: toNativeX(badge.badge.cx),
        yPx: toNativeY(badge.badge.cy),
        confidence: 1,
        cost: 0
      };
      if (!pick) {
        return {
          number,
          numberBadge,
          confidence: 0,
          status: 'incomplete' as const,
          failures: []
        };
      }
      const tee = measured.teePoints[teeIndexOf(pick.teeId)];
      const basket = measured.basketPoints[basketIndexOf(pick.basketId)];
      const confidence = pairConfidence(pick.score);
      const teeNativeX = toNativeX(tee.x);
      const teeNativeY = toNativeY(tee.y);
      const basketNativeX = toNativeX(basket.x);
      const basketNativeY = toNativeY(basket.y);
      const status: CourseHoleProposal['status'] = pick.score >= 0.15 ? 'ready' : 'review';
      return {
        number,
        numberBadge,
        tee: {
          candidateIndex: teeIndexOf(pick.teeId),
          xPx: teeNativeX,
          yPx: teeNativeY,
          detectorConfidence: confidence,
          confidence,
          distancePx: Math.hypot(teeNativeX - numberBadge.xPx, teeNativeY - numberBadge.yPx)
        },
        basket: {
          candidateIndex: basketIndexOf(pick.basketId),
          xPx: basketNativeX,
          yPx: basketNativeY,
          detectorConfidence: basket.score,
          confidence,
          distancePx: Math.hypot(basketNativeX - numberBadge.xPx, basketNativeY - numberBadge.yPx),
          cost: 1 - confidence
        },
        confidence,
        status,
        failures: []
      };
    })
    .sort((a, b) => a.number - b.number);

  const assignedTees = new Set(
    holes.filter((h) => h.tee).map((h) => h.tee!.candidateIndex)
  );
  const assignedBaskets = new Set(
    holes.filter((h) => h.basket).map((h) => h.basket!.candidateIndex)
  );
  const grammar: CourseGrammarResult = {
    holes,
    failures: [],
    unassigned: {
      numberBadgeCandidateIndexes: [],
      teeCandidateIndexes: measured.teePoints
        .map((_, i) => i)
        .filter((i) => !assignedTees.has(i)),
      basketCandidateIndexes: measured.basketPoints
        .map((_, i) => i)
        .filter((i) => !assignedBaskets.has(i))
    }
  };

  emit(
    holes
      .filter((h) => h.tee && h.basket)
      .map(
        (h): CourseVisionEvidenceEvent => ({
          state: 'final',
          channel: 'authoritative',
          producer: NUTHING_ASSIGNMENT,
          holeNumber: h.number,
          geometry: {
            tee: { xPx: h.tee!.xPx, yPx: h.tee!.yPx },
            basket: { xPx: h.basket!.xPx, yPx: h.basket!.yPx }
          },
          message: `NuThing Strip-Coherence Assignment finalized H${h.number} (pair score ${h.confidence.toFixed(2)})`,
          elapsedMs: nowMs() - startedAt
        })
      )
  );

  const nuthing: NuThingCoursePerformance = {
    path: 'nuthing-render-identity',
    totalMs: nowMs() - startedAt,
    geoScale,
    stages: { decodeRasterMs, resampleMs, measureMs, rescoreMs, assignMs },
    counts: {
      badges: measured.badges.length,
      tees: measured.teePoints.length,
      baskets: measured.basketPoints.length,
      assignedHoles: holes.filter((h) => h.tee && h.basket).length
    }
  };

  return {
    numberDetection,
    tees: [],
    baskets: [],
    grammar,
    rawMaskObjects,
    p2BadgeDetection,
    nuthing
  };
}

/** Re-export for the facade's operator registry checks. */
export const NUTHING_OPERATORS = Object.freeze({
  measurement: NUTHING_MEASUREMENT,
  assignment: NUTHING_ASSIGNMENT
});
void COURSE_VISION_OPERATORS;
