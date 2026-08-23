import type { RgbaImage } from './raster';

/**
 * Local ribbon follower used by the LAB G5 path gate.
 *
 * The state is not a point. It is an oriented corridor cross-section whose
 * width comes from the renderer family. Four equal-width lanes span 4W/3:
 *
 *   [ outer-L ][ inner-L ][ inner-R ][ outer-R ]
 *        ^                               ^
 *      L rail                          R rail
 *
 * Each lane is W/3 wide and the lane centers are [-W/2,-W/6,+W/6,+W/2].
 * The outer lane centers therefore ride the two rendered rails while the
 * inner lanes measure corridor-interior paint. A bend is never rewarded or
 * penalized by angle. The tracker changes heading only when a nearby rotated
 * cross-section gives stronger SUSTAINED renderer evidence than continuing
 * the current pose.
 *
 * Occlusion semantics intentionally mirror badgeOcclusion.ts:
 *   - two visible rails  -> paired evidence; both must agree (min score)
 *   - one visible rail   -> one-sided evidence from the visible rail
 *   - zero visible rails -> UNKNOWN, never a zero/miss
 * Hidden expected pixels are neutral. This is important around badges,
 * basket sprites, and other known higher render layers.
 */

export interface FourLanePoint {
  xPx: number;
  yPx: number;
}

export interface FourLaneOccluder {
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  kind?: string;
}

export interface FourLaneState extends FourLanePoint {
  /** Direction of travel, radians. */
  headingRad: number;
  /** Rail-to-rail renderer width in source pixels. */
  corridorWidthPx: number;
}

export type FourLaneRailMode = 'paired' | 'one-sided' | 'occluded';

export interface FourLaneObservation {
  /** Four equal lane centers in normal-offset source pixels. */
  laneOffsetsPx: readonly [number, number, number, number];
  laneWidthPx: number;
  /** Left/right outer lanes are rail riders. null = known-occluded/unknown. */
  leftRail: number | null;
  innerLeft: number | null;
  innerRight: number | null;
  rightRail: number | null;
  leftRailOccluded: boolean;
  innerLeftOccluded: boolean;
  innerRightOccluded: boolean;
  rightRailOccluded: boolean;
  railMode: FourLaneRailMode;
  /** Paired=min(L,R), one-sided=the visible rail, occluded=null. */
  railScore: number | null;
  /** min of visible inner lanes, null when both are hidden/unknown. */
  innerScore: number | null;
  /** Conservative cross-section score = min(available rail, available inner). */
  score: number | null;
}

export interface FourLaneTrackStep {
  distancePx: number;
  state: FourLaneState;
  observation: FourLaneObservation;
  /** Weakest visible cross-section over the lookahead horizon. */
  sustainedScore: number | null;
  headingDeltaDeg: number;
}

export type FourLaneStopReason = 'max-distance' | 'evidence-lost' | 'occluded-too-long';

export interface FourLaneTrackResult {
  points: FourLanePoint[];
  steps: FourLaneTrackStep[];
  stopReason: FourLaneStopReason;
}

export interface FourLaneOptions {
  /** Source-pixel step of the local tracker. */
  stepPx?: number;
  /** Candidate heading deltas tested at each step. */
  headingOffsetsDeg?: readonly number[];
  /** Number of forward steps that must sustain a candidate pose. */
  lookaheadSteps?: number;
  maxDistancePx?: number;
  /** Stop after this many consecutive visible low-evidence steps. */
  failureSteps?: number;
  minVisibleScore?: number;
  /** Fully hidden cross-sections are neutral, but cannot continue forever. */
  maxUnknownSteps?: number;
  /** Rail inside/outside sample offset. Mirrors badgeOcclusion DELTA. */
  edgeDeltaPx?: number;
  /** Gray lift that maps to full confidence. Mirrors badgeOcclusion LIFT_REF. */
  liftReference?: number;
  /** Half-length sampled along each lane/rail at one cross-section. */
  tangentHalfPx?: number;
  tangentSamples?: number;
}

const DEFAULT_OPTIONS: Required<FourLaneOptions> = {
  stepPx: 6,
  headingOffsetsDeg: [-18, -12, -6, 0, 6, 12, 18],
  lookaheadSteps: 3,
  maxDistancePx: 600,
  failureSteps: 6,
  minVisibleScore: 0.07,
  maxUnknownSteps: 16,
  edgeDeltaPx: 2.5,
  liftReference: 45,
  tangentHalfPx: 4,
  tangentSamples: 5,
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function inOccluder(x: number, y: number, occluders: readonly FourLaneOccluder[]): boolean {
  return occluders.some(
    (o) => x >= o.bboxX && x <= o.bboxX + o.bboxW && y >= o.bboxY && y <= o.bboxY + o.bboxH,
  );
}

function grayAt(image: RgbaImage, x: number, y: number): number | null {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || xi >= image.width || yi < 0 || yi >= image.height) return null;
  const p = (yi * image.width + xi) * 4;
  return (image.data[p] + image.data[p + 1] + image.data[p + 2]) / 3;
}

interface BandSample {
  mean: number | null;
  occluded: boolean;
}

function sampleBand(
  image: RgbaImage,
  center: FourLanePoint,
  headingRad: number,
  normalOffsetPx: number,
  occluders: readonly FourLaneOccluder[],
  options: Required<FourLaneOptions>,
): BandSample {
  const tx = Math.cos(headingRad);
  const ty = Math.sin(headingRad);
  const nx = -ty;
  const ny = tx;
  const n = Math.max(1, options.tangentSamples);
  let total = 0;
  let visible = 0;
  let blocked = 0;
  for (let i = 0; i < n; i++) {
    const along = n === 1 ? 0 : -options.tangentHalfPx + (2 * options.tangentHalfPx * i) / (n - 1);
    const x = center.xPx + nx * normalOffsetPx + tx * along;
    const y = center.yPx + ny * normalOffsetPx + ty * along;
    if (inOccluder(x, y, occluders)) {
      blocked++;
      continue;
    }
    const g = grayAt(image, x, y);
    if (g === null) continue;
    total += g;
    visible++;
  }
  return {
    mean: visible ? total / visible : null,
    // Majority-hidden means this band cannot honestly provide appearance evidence.
    occluded: blocked * 2 >= n || visible === 0,
  };
}

function normalizedLift(inside: number, outside: number, liftReference: number): number {
  return clamp01((inside - outside) / Math.max(liftReference, 1e-6));
}

export function observeFourLaneCrossSection(
  image: RgbaImage,
  state: FourLaneState,
  occluders: readonly FourLaneOccluder[] = [],
  inputOptions: FourLaneOptions = {},
): FourLaneObservation {
  const options = { ...DEFAULT_OPTIONS, ...inputOptions };
  const width = Math.max(1, state.corridorWidthPx);
  const laneWidth = width / 3;
  const laneOffsets: [number, number, number, number] = [-width / 2, -width / 6, width / 6, width / 2];

  // Guards just outside the 4W/3 bundle estimate local ground. One visible
  // guard is enough; two are averaged. Both hidden => interior evidence unknown.
  const guardLeft = sampleBand(image, state, state.headingRad, (-2 * width) / 3, occluders, options);
  const guardRight = sampleBand(image, state, state.headingRad, (2 * width) / 3, occluders, options);
  const guards = [guardLeft, guardRight]
    .filter((s) => !s.occluded && s.mean !== null)
    .map((s) => s.mean as number);
  const ground = guards.length ? guards.reduce((a, b) => a + b, 0) / guards.length : null;

  const sampleInnerLane = (offset: number): { score: number | null; occluded: boolean } => {
    const samples = [-laneWidth / 3, 0, laneWidth / 3].map((sub) =>
      sampleBand(image, state, state.headingRad, offset + sub, occluders, options),
    );
    const visible = samples.filter((s) => !s.occluded && s.mean !== null).map((s) => s.mean as number);
    const occluded = samples.filter((s) => s.occluded).length >= 2;
    if (occluded || visible.length === 0 || ground === null) return { score: null, occluded: true };
    const mean = visible.reduce((a, b) => a + b, 0) / visible.length;
    return { score: normalizedLift(mean, ground, options.liftReference), occluded: false };
  };

  const sampleRail = (railOffset: number, insideSign: -1 | 1): { score: number | null; occluded: boolean } => {
    const inside = sampleBand(
      image,
      state,
      state.headingRad,
      railOffset + insideSign * options.edgeDeltaPx,
      occluders,
      options,
    );
    const outside = sampleBand(
      image,
      state,
      state.headingRad,
      railOffset - insideSign * options.edgeDeltaPx,
      occluders,
      options,
    );
    if (inside.occluded || outside.occluded || inside.mean === null || outside.mean === null) {
      return { score: null, occluded: true };
    }
    return {
      score: normalizedLift(inside.mean, outside.mean, options.liftReference),
      occluded: false,
    };
  };

  // Normal points left of heading. For left rail, inward is +normal (toward
  // center); for right rail, inward is -normal.
  const leftRail = sampleRail(laneOffsets[0], 1);
  const innerLeft = sampleInnerLane(laneOffsets[1]);
  const innerRight = sampleInnerLane(laneOffsets[2]);
  const rightRail = sampleRail(laneOffsets[3], -1);

  const visibleRails = [leftRail, rightRail].filter((r) => !r.occluded && r.score !== null);
  let railMode: FourLaneRailMode;
  let railScore: number | null;
  if (visibleRails.length === 2) {
    railMode = 'paired';
    railScore = Math.min(visibleRails[0].score as number, visibleRails[1].score as number);
  } else if (visibleRails.length === 1) {
    railMode = 'one-sided';
    railScore = visibleRails[0].score as number;
  } else {
    railMode = 'occluded';
    railScore = null;
  }

  const visibleInner = [innerLeft, innerRight]
    .filter((r) => !r.occluded && r.score !== null)
    .map((r) => r.score as number);
  const innerScore = visibleInner.length ? Math.min(...visibleInner) : null;
  const observed = [railScore, innerScore].filter((v): v is number => v !== null);
  const score = observed.length ? Math.min(...observed) : null;

  return {
    laneOffsetsPx: laneOffsets,
    laneWidthPx: laneWidth,
    leftRail: leftRail.score,
    innerLeft: innerLeft.score,
    innerRight: innerRight.score,
    rightRail: rightRail.score,
    leftRailOccluded: leftRail.occluded,
    innerLeftOccluded: innerLeft.occluded,
    innerRightOccluded: innerRight.occluded,
    rightRailOccluded: rightRail.occluded,
    railMode,
    railScore,
    innerScore,
    score,
  };
}

export function seedFourLaneState(
  tee: FourLanePoint,
  badge: FourLanePoint,
  corridorWidthPx: number,
): FourLaneState {
  return {
    xPx: badge.xPx,
    yPx: badge.yPx,
    headingRad: Math.atan2(badge.yPx - tee.yPx, badge.xPx - tee.xPx),
    corridorWidthPx,
  };
}

interface CandidatePose {
  state: FourLaneState;
  observation: FourLaneObservation;
  sustainedScore: number | null;
  deltaDeg: number;
}

function evaluateCandidate(
  image: RgbaImage,
  current: FourLaneState,
  deltaDeg: number,
  occluders: readonly FourLaneOccluder[],
  options: Required<FourLaneOptions>,
): CandidatePose {
  const heading = current.headingRad + (deltaDeg * Math.PI) / 180;
  let firstObservation: FourLaneObservation | null = null;
  const visibleScores: number[] = [];
  for (let k = 1; k <= options.lookaheadSteps; k++) {
    const state: FourLaneState = {
      xPx: current.xPx + Math.cos(heading) * options.stepPx * k,
      yPx: current.yPx + Math.sin(heading) * options.stepPx * k,
      headingRad: heading,
      corridorWidthPx: current.corridorWidthPx,
    };
    const observation = observeFourLaneCrossSection(image, state, occluders, options);
    if (k === 1) firstObservation = observation;
    if (observation.score !== null) visibleScores.push(observation.score);
  }
  const next: FourLaneState = {
    xPx: current.xPx + Math.cos(heading) * options.stepPx,
    yPx: current.yPx + Math.sin(heading) * options.stepPx,
    headingRad: heading,
    corridorWidthPx: current.corridorWidthPx,
  };
  return {
    state: next,
    observation: firstObservation as FourLaneObservation,
    sustainedScore: visibleScores.length ? Math.min(...visibleScores) : null,
    deltaDeg,
  };
}

export function trackFourLaneRibbon(
  image: RgbaImage,
  start: FourLaneState,
  occluders: readonly FourLaneOccluder[] = [],
  inputOptions: FourLaneOptions = {},
): FourLaneTrackResult {
  const options = { ...DEFAULT_OPTIONS, ...inputOptions };
  const points: FourLanePoint[] = [{ xPx: start.xPx, yPx: start.yPx }];
  const steps: FourLaneTrackStep[] = [];
  let current = { ...start };
  let distance = 0;
  let consecutiveUnknown = 0;
  const recentVisible: number[] = [];

  while (distance < options.maxDistancePx) {
    const candidates = options.headingOffsetsDeg.map((deltaDeg) =>
      evaluateCandidate(image, current, deltaDeg, occluders, options),
    );
    candidates.sort((a, b) => {
      // Unknown evidence is neutral ONLY for holding the current pose. It must
      // never manufacture a bend through an occluder.
      const qa = a.sustainedScore ?? (Math.abs(a.deltaDeg) < 1e-9 ? 0 : -1);
      const qb = b.sustainedScore ?? (Math.abs(b.deltaDeg) < 1e-9 ? 0 : -1);
      return qb - qa || Math.abs(a.deltaDeg) - Math.abs(b.deltaDeg);
    });
    const chosen = candidates[0];
    current = chosen.state;
    distance += options.stepPx;
    points.push({ xPx: current.xPx, yPx: current.yPx });
    steps.push({
      distancePx: distance,
      state: { ...current },
      observation: chosen.observation,
      sustainedScore: chosen.sustainedScore,
      headingDeltaDeg: chosen.deltaDeg,
    });

    if (chosen.observation.score === null) {
      consecutiveUnknown++;
    } else {
      consecutiveUnknown = 0;
      recentVisible.push(chosen.observation.score);
      if (recentVisible.length > options.failureSteps) recentVisible.shift();
      if (
        recentVisible.length === options.failureSteps &&
        recentVisible.every((score) => score < options.minVisibleScore)
      ) {
        return { points, steps, stopReason: 'evidence-lost' };
      }
    }
    if (consecutiveUnknown > options.maxUnknownSteps) {
      return { points, steps, stopReason: 'occluded-too-long' };
    }
  }
  return { points, steps, stopReason: 'max-distance' };
}

export interface TeeBadgeSegment {
  tee: FourLanePoint;
  badge: FourLanePoint;
}

export interface FourLaneWidthEstimate {
  widthPx: number;
  scores: { widthPx: number; meanScore: number; visibleSamples: number }[];
}

/**
 * Course-local width calibration from already-frozen Tee->Badge halves.
 * This is deliberately renderer-only: no basket/path truth participates.
 */
export function estimateFourLaneCorridorWidth(
  image: RgbaImage,
  segments: readonly TeeBadgeSegment[],
  occluders: readonly FourLaneOccluder[] = [],
  candidateWidthsPx: readonly number[] = [24, 30, 32, 36, 40, 48, 56, 64],
  inputOptions: FourLaneOptions = {},
): FourLaneWidthEstimate {
  const fractions = [0.2, 0.35, 0.5, 0.65, 0.78];
  const rows = candidateWidthsPx.map((widthPx) => {
    const scores: number[] = [];
    for (const segment of segments) {
      const headingRad = Math.atan2(
        segment.badge.yPx - segment.tee.yPx,
        segment.badge.xPx - segment.tee.xPx,
      );
      for (const f of fractions) {
        const state: FourLaneState = {
          xPx: segment.tee.xPx + (segment.badge.xPx - segment.tee.xPx) * f,
          yPx: segment.tee.yPx + (segment.badge.yPx - segment.tee.yPx) * f,
          headingRad,
          corridorWidthPx: widthPx,
        };
        const observation = observeFourLaneCrossSection(image, state, occluders, inputOptions);
        if (observation.score !== null) scores.push(observation.score);
      }
    }
    return {
      widthPx,
      meanScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : -Infinity,
      visibleSamples: scores.length,
    };
  });
  const best = rows
    .slice()
    .sort((a, b) => b.meanScore - a.meanScore || b.visibleSamples - a.visibleSamples || a.widthPx - b.widthPx)[0];
  return { widthPx: best?.widthPx ?? candidateWidthsPx[0] ?? 40, scores: rows };
}
