// Basket backward-walk: recover the corridor's APPROACH direction (and, while
// evidence supports, a short centerline polyline) starting at each basket's
// precise endpoint and walking backward into the corridor.
//
// Why: the pairing pipeline's one remaining systematic error is
// over-preferring baskets — wrong (tee,basket) assignments are wrong on the
// basket side almost every time (see docs/nuthing-p2/distractor-attribution.md).
// If each basket can independently testify "my corridor leaves me heading
// THIS way", a pair whose badge/tee do not lie along that bearing can be
// down-weighted without ever re-routing anything. This script only MEASURES
// that bearing and validates it against truth; it does not touch pairing.
//
// The basket zone is the worst-measured part of the whole corridor (opaque
// sprite, C1S solid ring ~44px, C2D dashed ring ~84px, translucent fills
// between them, all stacked on top of the corridor's own semicircular cap).
// So evidence is aggregated over a wide angular scan and a W-wide rectangle
// footprint, not chased at any single pixel:
//
//   1. DIRECTION SCAN: for every candidate bearing theta (2 deg steps, full
//      360 deg — the corridor is a one-sided capsule from the basket's point
//      of view, so only the true approach direction has paint beyond the
//      zone), score theta by FLANKED-RECTANGLE CONTRAST: mean gray in a
//      W-wide center band from r0 (just outside the sprite) to r1 (beyond
//      the C2D ring) minus the mean gray of two parallel flank bands offset
//      +-W (one full corridor width away — this cancels the zone fill's
//      near-basket brightness lift, which raises center and flank alike).
//      Every sample is checked against KNOWN occluders first and dropped
//      (not counted for OR against the hypothesis) if it falls inside: any
//      basket's sprite bbox, any basket's ring bands (44+-8, 84+-12 — this
//      applies uniformly to the basket's OWN rings too, so a true bearing
//      that legitimately crosses its own rings is neither rewarded nor
//      punished for it), any badge's bbox, or any tee's box (badges and
//      tees are approximated as fixed half-extent boxes around their cached
//      centers — the pair-matrix cache carries no real bboxes for either;
//      measured directly off the rendered badges in all four courses, see
//      below; tee exclusion is not in the task's example occluder list but
//      measured as one of the two biggest single wins, see below). The scan
//      window (r0..r1) also runs much further out than "beyond the C2D
//      ring" suggests — see the R1 note by its constant.
//   2. FIELD CONFIRMATION: beyond r=90px the cached support/theta planes are
//      trustworthy (distractor-attribution.md), so a second, independent
//      signal — support weighted by how well the field's own local best
//      orientation aligns with theta (mod pi, since bestTheta is undirected)
//      — is added to the color-contrast score. This is the same
//      strip-coherence idea validated in pair-matrix-replay.ts, reused here
//      for a ray instead of a route.
//   3. WALK: starting just outside the sprite along the winning bearing, a
//      short local re-scan (+-20 deg window, capped turn rate) at each 4px
//      step lets the centerline bend gently with the paint instead of
//      committing to one straight ray; the walk stops when local evidence
//      drops for two consecutive steps or the target distance is reached.
//      The walk is a confirmation/visualization aid — the reported bearing
//      comes from the direction scan, not from the walk's final heading.
//
// Usage: npx tsx scripts/nuthing/basket-backwalk.ts CACHE_DIR

import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';
import { decodeRgbaBin } from './decode';
import { COURSE_CORRIDOR_WIDTH, DEFAULT_CORRIDOR_WIDTH } from '../../src/lib/nuthing/badgeOcclusion';

const COURSES = ['DashsTrack-full', 'HeritagePark-full', 'Lenard-full', 'TowneLake-full'];

// ---- Render-stack constants (measured; see doc appendix) ------------------
const SPRITE_W = 42;
const SPRITE_H = 66;
const SPRITE_MARGIN = 2;
const RING1 = 44;
const RING1_TOL = 8;
const RING2 = 84;
const RING2_TOL = 12;
// Badge bbox is NOT in the pair-matrix cache (only cx,cy). Measured directly
// off the rendered badges in all four courses (white pill rim around the
// digit glyph): half-width ~24-26px, half-height ~20-21px, consistent
// course to course. Used with a small margin as a conservative exclusion box.
const BADGE_HALF_W = 28;
const BADGE_HALF_H = 24;
// Tees are also known, rendered occluders (small rect/pin glyphs; the P1
// endpoint doc notes real tees render 11-35px per axis) and are NOT in the
// task's example occluder list, but measurement (below) showed excluding a
// generous box around each tee is one of the two biggest single wins here:
// median own-badge error 14.0deg -> 7.5deg, discrimination 46.0% -> 49.2%
// (DashsTrack-full alone, holding everything else fixed). Kept as a fixed
// half-extent for the same reason as the badge box (no per-tee bbox cached).
const TEE_HALF = 20;

// ---- Direction-scan geometry ------------------------------------------
const R0 = 35; // just outside the sprite's own bbox radius (in most directions)
// R1 (both the color band and the field-confirmation ray) was swept from 110
// to 360px against the 63-hole truth join, holding every other parameter
// fixed: discrimination rises from 41% at 110px to a plateau of 60-62% across
// 200-230px, then falls back below 45% by 320px as the window starts pulling
// in unrelated holes' evidence. 200px was picked from the middle of that
// plateau. This is well past "beyond the C2D ring" (84+12=96) — short holes
// routinely put the badge itself, and sometimes a neighboring hole's tee,
// inside a 130px window, so a narrower window starves the TRUE bearing of
// evidence (its own badge eats the outer arc) while doing nothing to stop a
// false bearing from riding a short, clean, nearby distractor. See the
// DashsTrack h4 case study in the doc appendix.
const R1 = 200;
const DR = 2;
const OFFSET_FRACS = [-0.35, -0.15, 0, 0.15, 0.35]; // of corridor width W
const THETA_STEP_DEG = 2;
const MIN_CENTER_SAMPLES = 30;
const MIN_FLANK_SAMPLES = 40;

// ---- Little-clue features (semicircle cap, one-sidedness, teepad-on-ray) --
// The corridor is a round-capped polyline that TERMINATES at the basket: a
// perfect semicircular cap of radius W/2 whose center sits ~4-5px inside the
// endpoint along the approach direction. Three render-model consequences,
// each measured as its own weak feature (combined downstream, not argmaxed
// individually):
//   capEdge  — just inside the cap arc is corridor paint, just outside is
//              background. Sampled on the BACK half of the cap (the sprite
//              occludes most of the front); occluded samples dropped.
//   oppLift  — a terminating corridor is one-sided: full-width band evidence
//              along theta+180 beyond the cap radius means theta is either a
//              passing corridor or the back-side BTD trap, not the approach.
//   teeOnRay — the BTD walking path leaves the basket toward the NEXT hole's
//              tee; a teepad sitting close along the ray is evidence AGAINST
//              theta being the approach.
//   fracPos/runLen — corridor paint is solid; BTD dashes and incidental
//              clutter are intermittent. Per-radius lift persistence.
const CAP_INSET = 4.5;
const CAP_ARC_HALF_DEG = 110; // back arc: theta+180 +- this (sides of the cap included)
const CAP_ARC_STEP_DEG = 6;
const CAP_R_IN = 5; // sample this far inside the cap arc radius (W/2)
const CAP_R_OUT = 6; // and this far outside
const CAP_MIN_PAIRS = 4;
// First cut used a 90px flanked-contrast window for the opposite side and it
// was starved exactly where it matters: in cluttered zones the badge box /
// rings occlude most of the near window, and the flanks of the opposite band
// sit on unrelated renders. Persistence over occlusion-SKIPPED bins out to
// 160px is the robust version (a trap direction has a real corridor behind
// it for 100+px; a terminating one has nothing past the cap).
const OPP_R1 = 160;
const TEE_RAY_MAX_DIST = 200;
const TEE_RAY_HALF_ANGLE_DEG = 25;
const RUN_WEAK_LIFT = 4; // per-radius lift below this counts as a gap
const RUN_WEAK_STOP = 3; // consecutive weak radius bins that end the run
// BTD dashes lift ~+17 vs the corridor ribbon's ~+33 (lift-signatures
// measurement): a persistence pass thresholded between them sees only
// SOLID corridor, so the dashed walking path behind a true approach no
// longer pollutes the one-sidedness clue.
const SOLID_LIFT = 24;
// Centerline paint boundary: walking BACKWARD from the anchor along
// theta+180, the paint of a corridor that terminates here must stop within
// ~W/2 (the cap arc); a passing corridor / back-side trap keeps paint going.
// Uses a slimmer occluder set (tight ring bands) because neighbors' generous
// ring-band exclusions were starving the probe in exactly the clustered
// cases that need it.
const BOUNDARY_MAX_PX = 70;
const BOUNDARY_STEP_PX = 2;
const BOUNDARY_PAINT_LIFT = 10;
const BOUNDARY_GAP_SAMPLES = 6; // consecutive unpainted valid samples = boundary
const RING_TOL_LOCAL = 3;
const ROT_FLANK_DEG = 50; // clears the corridor's angular width for r >= ~18
const ROT_ON_ARC_DEG = 6; // on-axis arc half-width for the center sample
const PEAK_MIN_SEP_DEG = 20;
const MAX_PEAKS = 8;
const FIELD_R0 = 90; // support/theta trustworthy beyond here
const FIELD_R1 = R1;
const FIELD_WEIGHT = 40; // gray-equivalent weight on the [0,1] field term; swept 0-90, flat optimum 30-50
const SECOND_PEAK_MIN_SEP_DEG = 20;
const COLOR_LIFT_REF = 33; // measured badge->basket pre-zone lift (gray)
const MARGIN_REF = 25;

// ---- Walk geometry ------------------------------------------------------
const WALK_STEP_PX = 4;
const WALK_MAX_DIST_FROM_ANCHOR = 180;
const WALK_ANGLE_WINDOW_DEG = 20;
const WALK_ANGLE_STEP_DEG = 2;
const WALK_MIN_LIFT = 8; // gray; below this the local evidence is "weak"
const WALK_WEAK_STOP = 2; // consecutive weak steps before stopping
const WALK_LOCAL_R0 = 6;
const WALK_LOCAL_R1 = 26;
const WALK_LOCAL_DR = 2;

interface CacheBasket {
  id: string;
  x: number;
  y: number;
  spriteCx: number;
  spriteCy: number;
  score?: number;
}
interface CacheTee {
  id: string;
  x: number;
  y: number;
  tier: string;
}
interface CacheBadge {
  label: string;
  cx: number;
  cy: number;
}
interface CacheJudgment {
  hole: number;
  trueTee: number;
  trueBasket: number;
  rankPrimary: number;
}
interface CacheCourse {
  course: string;
  field: { width: number; height: number; scale: number };
  endpoints: { tees: CacheTee[]; baskets: CacheBasket[] };
  badges: CacheBadge[];
  judgments: CacheJudgment[];
}

interface ThetaScore {
  thetaDeg: number;
  colorLift: number;
  fieldConf: number;
  combined: number;
  nCenter: number;
}

interface ScanResult {
  approachBearingDeg: number;
  confidence: number;
  colorLift: number;
  fieldConf: number;
  combined: number;
  margin: number;
  validCandidates: number;
}

// One angular peak of the base score landscape, with its little-clue
// feature vector. The downstream combiner (hand-weighted or learned)
// re-ranks these peaks; this script does not pick a winner from them.
interface PeakFeatures {
  thetaDeg: number;
  colorLift: number;
  fieldConf: number;
  combinedBase: number; // colorLift + FIELD_WEIGHT * fieldConf (the old score)
  oppLift: number; // band lift along theta+180 (cap radius .. OPP_R1); null->0
  oppValid: boolean;
  oppFracPos: number; // occlusion-tolerant persistence along theta+180
  oppRunLenPx: number;
  oppSolidFrac: number; // same, but only SOLID-corridor-level lift counts
  boundaryBehindPx: number; // where centerline paint stops behind the anchor
  boundaryValid: boolean;
  capEdge: number; // inside-arc minus outside-arc gray at the cap boundary
  capPairs: number; // non-occluded arc sample pairs the edge is based on
  teeOnRay: number; // 1 - d/TEE_RAY_MAX_DIST for nearest tee inside the ray cone, else 0
  fracPos: number; // fraction of radius bins with lift > RUN_WEAK_LIFT
  runLenPx: number; // distance before RUN_WEAK_STOP consecutive weak bins
  walkEndDistPx: number;
  walkStoppedReason: WalkResult['stoppedReason'];
  // Raw replay-node payload: per-radius centerline lift samples along theta
  // (fwd) and theta+180 (bwd), occlusion-valid bins only, as [r, lift]
  // rounded to 0.1. Every threshold/persistence/boundary parameter and any
  // combiner can be re-derived from these downstream WITHOUT re-touching the
  // images — the expensive boundary is the sampling, cached here.
  fwdProfile: [number, number][];
  bwdProfile: [number, number][];
  // Rotated-flank (radially fair) variants: contrast at radius r is the
  // small on-axis arc mean minus the mean at the SAME radius rotated
  // +-ROT_FLANK_DEG around the anchor. The basket zone's fills are radially
  // symmetric around the anchor, so they cancel exactly under rotation —
  // perpendicular flanks do not cancel them, which washed out the boundary
  // clue (good-peak paint "extended" ~48px behind every anchor).
  fwdRadial: [number, number][];
  bwdRadial: [number, number][];
}

interface WalkResult {
  points: [number, number][];
  endDistFromAnchorPx: number;
  stoppedReason: 'evidence-lost' | 'max-distance' | 'no-evidence';
}

interface BasketOut {
  id: string;
  x: number;
  y: number;
  scan: ScanResult | null;
  walk: WalkResult | null;
  peaks: PeakFeatures[];
}

function circMeanDiffDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

function main(): void {
  const [cacheDir] = process.argv.slice(2);
  if (!cacheDir) {
    console.error('Usage: tsx scripts/nuthing/basket-backwalk.ts CACHE_DIR');
    process.exit(1);
  }

  const t0 = Date.now();
  const poolOwn: number[] = [];
  const poolOther: number[] = [];
  let poolDiscriminates = 0;
  let poolN = 0;

  for (const nm of COURSES) {
    const courseT0 = Date.now();
    const cache = JSON.parse(readFileSync(`${cacheDir}/${nm}.json`, 'utf8')) as CacheCourse;
    const { width: fw, height: fh, scale } = cache.field;
    const support = new Float32Array(readFileSync(`${cacheDir}/${nm}-field.bin`).buffer.slice(0));
    const theta = new Float32Array(readFileSync(`${cacheDir}/${nm}-theta.bin`).buffer.slice(0));
    const W = COURSE_CORRIDOR_WIDTH[nm] ?? DEFAULT_CORRIDOR_WIDTH;

    const fullImage = decodeRgbaBin(`/workspace/nuthing-work/traces-py/${nm}.rgba.bin`);
    const image = cropRows(fullImage, detectMapViewport(fullImage));
    const gray = (x: number, y: number): number | null => {
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || xi >= image.width || yi < 0 || yi >= image.height) return null;
      const p = (yi * image.width + xi) * 4;
      return (image.data[p] + image.data[p + 1] + image.data[p + 2]) / 3;
    };

    const baskets = cache.endpoints.baskets;
    const badges = cache.badges;

    const inSpriteBBox = (x: number, y: number): boolean => {
      for (const b of baskets) {
        if (
          x >= b.spriteCx - SPRITE_W / 2 - SPRITE_MARGIN &&
          x <= b.spriteCx + SPRITE_W / 2 + SPRITE_MARGIN &&
          y >= b.spriteCy - SPRITE_H / 2 - SPRITE_MARGIN &&
          y <= b.spriteCy + SPRITE_H / 2 + SPRITE_MARGIN
        )
          return true;
      }
      return false;
    };
    const inRingBand = (x: number, y: number): boolean => {
      for (const b of baskets) {
        const dx = x - b.x;
        const dy = y - b.y;
        // cheap pre-filter before sqrt
        if (Math.abs(dx) > RING2 + RING2_TOL || Math.abs(dy) > RING2 + RING2_TOL) continue;
        const d = Math.hypot(dx, dy);
        if (Math.abs(d - RING1) <= RING1_TOL || Math.abs(d - RING2) <= RING2_TOL) return true;
      }
      return false;
    };
    const inBadgeBox = (x: number, y: number): boolean => {
      for (const bd of badges) {
        if (
          x >= bd.cx - BADGE_HALF_W &&
          x <= bd.cx + BADGE_HALF_W &&
          y >= bd.cy - BADGE_HALF_H &&
          y <= bd.cy + BADGE_HALF_H
        )
          return true;
      }
      return false;
    };
    const inTeeBox = (x: number, y: number): boolean => {
      for (const t of cache.endpoints.tees) {
        if (Math.abs(x - t.x) <= TEE_HALF && Math.abs(y - t.y) <= TEE_HALF) return true;
      }
      return false;
    };
    const occluded = (x: number, y: number): boolean =>
      inSpriteBBox(x, y) || inRingBand(x, y) || inBadgeBox(x, y) || inTeeBox(x, y);

    // Slim variant for the near-anchor probes (cap edge, paint boundary):
    // the generous ring-band tolerances exist to keep ring paint out of the
    // long band statistics, but in basket clusters they blanket the whole
    // cap neighborhood; the actual ring strokes are only a few px wide.
    const inRingBandTight = (x: number, y: number): boolean => {
      for (const b of baskets) {
        const dx = x - b.x;
        const dy = y - b.y;
        if (Math.abs(dx) > RING2 + RING_TOL_LOCAL || Math.abs(dy) > RING2 + RING_TOL_LOCAL) continue;
        const d = Math.hypot(dx, dy);
        if (Math.abs(d - RING1) <= RING_TOL_LOCAL || Math.abs(d - RING2) <= RING_TOL_LOCAL) return true;
      }
      return false;
    };
    const occludedLocal = (x: number, y: number): boolean =>
      inSpriteBBox(x, y) || inRingBandTight(x, y) || inBadgeBox(x, y) || inTeeBox(x, y);

    const fieldAt = (x: number, y: number): { s: number; t: number } | null => {
      const fx = Math.floor(x / scale);
      const fy = Math.floor(y / scale);
      if (fx < 0 || fx >= fw || fy < 0 || fy >= fh) return null;
      const i = fy * fw + fx;
      return { s: support[i], t: theta[i] };
    };

    function bandContrast(
      anchorX: number,
      anchorY: number,
      thetaRad: number,
      r0: number,
      r1: number,
      dr: number,
    ): { colorLift: number; nCenter: number; nFlank: number } | null {
      const ux = Math.cos(thetaRad);
      const uy = Math.sin(thetaRad);
      const nx = -uy;
      const ny = ux;
      let centerSum = 0;
      let centerN = 0;
      let flankSum = 0;
      let flankN = 0;
      for (let r = r0; r <= r1; r += dr) {
        const cxr = anchorX + ux * r;
        const cyr = anchorY + uy * r;
        for (const f of OFFSET_FRACS) {
          const off = f * W;
          const px = cxr + nx * off;
          const py = cyr + ny * off;
          if (!occluded(px, py)) {
            const g = gray(px, py);
            if (g !== null) {
              centerSum += g;
              centerN++;
            }
          }
          for (const side of [1, -1]) {
            const fx2 = cxr + nx * (off + side * W);
            const fy2 = cyr + ny * (off + side * W);
            if (!occluded(fx2, fy2)) {
              const g = gray(fx2, fy2);
              if (g !== null) {
                flankSum += g;
                flankN++;
              }
            }
          }
        }
      }
      if (centerN < 1 || flankN < 1) return null;
      return { colorLift: centerSum / centerN - flankSum / flankN, nCenter: centerN, nFlank: flankN };
    }

    function fieldConfirm(anchorX: number, anchorY: number, thetaRad: number): number {
      const ux = Math.cos(thetaRad);
      const uy = Math.sin(thetaRad);
      let sum = 0;
      let n = 0;
      for (let r = FIELD_R0; r <= FIELD_R1; r += scale) {
        const px = anchorX + ux * r;
        const py = anchorY + uy * r;
        const f = fieldAt(px, py);
        if (!f) continue;
        let dth = (thetaRad - f.t) % Math.PI;
        if (dth < 0) dth += Math.PI;
        if (dth > Math.PI / 2) dth = Math.PI - dth;
        const align = Math.cos(dth) ** 2;
        sum += f.s * align;
        n++;
      }
      return n > 0 ? sum / n : 0;
    }

    // Per-radius lift profile along theta: same samples as bandContrast, but
    // binned by radius so persistence (solid corridor vs dashed/incidental
    // paint) is measurable. Bins with no valid center or flank samples are
    // skipped rather than counted as gaps — occlusion is not absence.
    function bandProfile(
      anchorX: number,
      anchorY: number,
      thetaRad: number,
      r0: number,
      r1: number,
      liftThresh: number = RUN_WEAK_LIFT,
    ): { fracPos: number; runLenPx: number; nBins: number } {
      const ux = Math.cos(thetaRad);
      const uy = Math.sin(thetaRad);
      const nx = -uy;
      const ny = ux;
      let pos = 0;
      let nBins = 0;
      let weak = 0;
      let runLenPx = r1 - r0;
      let runEnded = false;
      for (let r = r0; r <= r1; r += DR * 2) {
        const cxr = anchorX + ux * r;
        const cyr = anchorY + uy * r;
        let cSum = 0;
        let cN = 0;
        let fSum = 0;
        let fN = 0;
        for (const f of OFFSET_FRACS) {
          const off = f * W;
          const px = cxr + nx * off;
          const py = cyr + ny * off;
          if (!occluded(px, py)) {
            const g = gray(px, py);
            if (g !== null) {
              cSum += g;
              cN++;
            }
          }
          for (const side of [1, -1]) {
            const fx2 = cxr + nx * (off + side * W);
            const fy2 = cyr + ny * (off + side * W);
            if (!occluded(fx2, fy2)) {
              const g = gray(fx2, fy2);
              if (g !== null) {
                fSum += g;
                fN++;
              }
            }
          }
        }
        if (cN < 2 || fN < 2) continue;
        nBins++;
        const lift = cSum / cN - fSum / fN;
        if (lift > liftThresh) {
          pos++;
          if (!runEnded) weak = 0;
        } else if (!runEnded) {
          weak++;
          if (weak >= RUN_WEAK_STOP) {
            runLenPx = Math.max(0, r - r0 - (RUN_WEAK_STOP - 1) * DR * 2);
            runEnded = true;
          }
        }
      }
      return { fracPos: nBins > 0 ? pos / nBins : 0, runLenPx, nBins };
    }

    // Semicircle cap edge: paint just inside the cap arc, background just
    // outside. Cap center sits CAP_INSET px inside the endpoint along theta;
    // sampled on the back half-arc only (the sprite owns the front).
    function capEdgeAt(
      anchorX: number,
      anchorY: number,
      thetaRad: number,
    ): { capEdge: number; capPairs: number } {
      const capR = W / 2;
      const cx = anchorX + Math.cos(thetaRad) * CAP_INSET;
      const cy = anchorY + Math.sin(thetaRad) * CAP_INSET;
      let sum = 0;
      let pairs = 0;
      for (let a = -CAP_ARC_HALF_DEG; a <= CAP_ARC_HALF_DEG; a += CAP_ARC_STEP_DEG) {
        const phi = thetaRad + Math.PI + (a * Math.PI) / 180;
        const dx = Math.cos(phi);
        const dy = Math.sin(phi);
        const ix = cx + dx * (capR - CAP_R_IN);
        const iy = cy + dy * (capR - CAP_R_IN);
        const ox = cx + dx * (capR + CAP_R_OUT);
        const oy = cy + dy * (capR + CAP_R_OUT);
        if (occludedLocal(ix, iy) || occludedLocal(ox, oy)) continue;
        const gi = gray(ix, iy);
        const go = gray(ox, oy);
        if (gi === null || go === null) continue;
        sum += gi - go;
        pairs++;
      }
      return { capEdge: pairs >= CAP_MIN_PAIRS ? sum / pairs : 0, capPairs: pairs };
    }

    // Raw centerline lift profile: for each radius bin along dir, the
    // W-wide center band mean minus the +-W flank means, occlusion-skipped
    // (occludedLocal). This is the replay-node payload — persistence,
    // solidity, and boundary features for ANY threshold derive from it.
    function centerProfile(
      anchorX: number,
      anchorY: number,
      dirRad: number,
      r0: number,
      r1: number,
    ): [number, number][] {
      const ux = Math.cos(dirRad);
      const uy = Math.sin(dirRad);
      const nx = -uy;
      const ny = ux;
      const out: [number, number][] = [];
      for (let r = r0; r <= r1; r += DR * 2) {
        const cxr = anchorX + ux * r;
        const cyr = anchorY + uy * r;
        let cSum = 0;
        let cN = 0;
        let fSum = 0;
        let fN = 0;
        for (const f of OFFSET_FRACS) {
          const off = f * W;
          const px = cxr + nx * off;
          const py = cyr + ny * off;
          if (!occludedLocal(px, py)) {
            const g = gray(px, py);
            if (g !== null) {
              cSum += g;
              cN++;
            }
          }
          for (const side of [1, -1]) {
            const fx2 = cxr + nx * (off + side * W);
            const fy2 = cyr + ny * (off + side * W);
            if (!occludedLocal(fx2, fy2)) {
              const g = gray(fx2, fy2);
              if (g !== null) {
                fSum += g;
                fN++;
              }
            }
          }
        }
        if (cN < 2 || fN < 2) continue;
        out.push([r, Math.round((cSum / cN - fSum / fN) * 10) / 10]);
      }
      return out;
    }

    // Radially fair lift profile: for each radius r along dir, the mean of a
    // small on-axis arc minus the mean at the same radius rotated
    // +-ROT_FLANK_DEG around the ANCHOR. Radial fields (zone fills) cancel;
    // a corridor strip through the anchor survives.
    function radialProfile(
      anchorX: number,
      anchorY: number,
      dirRad: number,
      r0: number,
      r1: number,
    ): [number, number][] {
      const out: [number, number][] = [];
      const arcOffsets = [-ROT_ON_ARC_DEG, 0, ROT_ON_ARC_DEG].map((d) => (d * Math.PI) / 180);
      const flankOffsets = [-ROT_FLANK_DEG, ROT_FLANK_DEG].map((d) => (d * Math.PI) / 180);
      for (let r = r0; r <= r1; r += DR * 2) {
        let cSum = 0;
        let cN = 0;
        let fSum = 0;
        let fN = 0;
        for (const a of arcOffsets) {
          const px = anchorX + Math.cos(dirRad + a) * r;
          const py = anchorY + Math.sin(dirRad + a) * r;
          if (occludedLocal(px, py)) continue;
          const g = gray(px, py);
          if (g !== null) {
            cSum += g;
            cN++;
          }
        }
        for (const a of flankOffsets) {
          for (const da of arcOffsets) {
            const px = anchorX + Math.cos(dirRad + a + da) * r;
            const py = anchorY + Math.sin(dirRad + a + da) * r;
            if (occludedLocal(px, py)) continue;
            const g = gray(px, py);
            if (g !== null) {
              fSum += g;
              fN++;
            }
          }
        }
        if (cN < 1 || fN < 2) continue;
        out.push([r, Math.round((cSum / cN - fSum / fN) * 10) / 10]);
      }
      return out;
    }

    // Where does centerline paint STOP behind the anchor? Walk r backward
    // along theta+180; each valid sample is painted if the centerline gray
    // beats the +-W flank mean by BOUNDARY_PAINT_LIFT. The boundary is the
    // start of the first run of BOUNDARY_GAP_SAMPLES consecutive unpainted
    // valid samples (12px — wider than a BTD dash gap). Occluded samples are
    // skipped and count toward neither run nor gap.
    function boundaryBehind(
      anchorX: number,
      anchorY: number,
      thetaRad: number,
    ): { boundaryBehindPx: number; boundaryValid: boolean } {
      const bx = Math.cos(thetaRad + Math.PI);
      const by = Math.sin(thetaRad + Math.PI);
      const nx = -by;
      const ny = bx;
      let gap = 0;
      let nValid = 0;
      for (let r = 4; r <= BOUNDARY_MAX_PX; r += BOUNDARY_STEP_PX) {
        const px = anchorX + bx * r;
        const py = anchorY + by * r;
        if (occludedLocal(px, py)) continue;
        const gc = gray(px, py);
        if (gc === null) continue;
        let fSum = 0;
        let fN = 0;
        for (const side of [1, -1]) {
          const fx2 = px + nx * side * W;
          const fy2 = py + ny * side * W;
          if (occludedLocal(fx2, fy2)) continue;
          const g = gray(fx2, fy2);
          if (g !== null) {
            fSum += g;
            fN++;
          }
        }
        if (fN === 0) continue;
        nValid++;
        const painted = gc - fSum / fN > BOUNDARY_PAINT_LIFT;
        if (painted) {
          gap = 0;
        } else {
          gap++;
          if (gap >= BOUNDARY_GAP_SAMPLES)
            return {
              boundaryBehindPx: r - (BOUNDARY_GAP_SAMPLES - 1) * BOUNDARY_STEP_PX,
              boundaryValid: nValid >= BOUNDARY_GAP_SAMPLES * 2,
            };
        }
      }
      return { boundaryBehindPx: BOUNDARY_MAX_PX, boundaryValid: nValid >= BOUNDARY_GAP_SAMPLES * 2 };
    }

    function teeOnRayAt(anchorX: number, anchorY: number, thetaDeg: number): number {
      let best = 0;
      for (const t of cache.endpoints.tees) {
        const d = Math.hypot(t.x - anchorX, t.y - anchorY);
        if (d < 10 || d > TEE_RAY_MAX_DIST) continue;
        const brg = (Math.atan2(t.y - anchorY, t.x - anchorX) * 180) / Math.PI;
        if (circMeanDiffDeg(brg, thetaDeg) > TEE_RAY_HALF_ANGLE_DEG) continue;
        best = Math.max(best, 1 - d / TEE_RAY_MAX_DIST);
      }
      return best;
    }

    function scanBearing(
      anchorX: number,
      anchorY: number,
    ): { scan: ScanResult; scores: ThetaScore[] } | null {
      const scores: ThetaScore[] = [];
      for (let td = 0; td < 360; td += THETA_STEP_DEG) {
        const th = (td * Math.PI) / 180;
        const bc = bandContrast(anchorX, anchorY, th, R0, R1, DR);
        if (!bc || bc.nCenter < MIN_CENTER_SAMPLES || bc.nFlank < MIN_FLANK_SAMPLES) continue;
        const fc = fieldConfirm(anchorX, anchorY, th);
        const combined = bc.colorLift + FIELD_WEIGHT * fc;
        scores.push({ thetaDeg: td, colorLift: bc.colorLift, fieldConf: fc, combined, nCenter: bc.nCenter });
      }
      if (scores.length === 0) return null;
      scores.sort((a, b) => b.combined - a.combined);
      const best = scores[0];
      let second: ThetaScore | undefined;
      for (const s of scores) {
        if (circMeanDiffDeg(s.thetaDeg, best.thetaDeg) >= SECOND_PEAK_MIN_SEP_DEG) {
          second = s;
          break;
        }
      }
      const margin = second ? best.combined - second.combined : best.combined;
      const confidence = Math.max(
        0,
        Math.min(1, 0.5 * Math.min(1, best.colorLift / COLOR_LIFT_REF) + 0.5 * Math.min(1, margin / MARGIN_REF)),
      );
      return {
        scan: {
          approachBearingDeg: best.thetaDeg,
          confidence,
          colorLift: best.colorLift,
          fieldConf: best.fieldConf,
          combined: best.combined,
          margin,
          validCandidates: scores.length,
        },
        scores,
      };
    }

    // Angular local maxima of the base landscape (greedy, min separation),
    // each dressed with the little-clue features and a walk.
    function extractPeaks(anchorX: number, anchorY: number, scores: ThetaScore[]): PeakFeatures[] {
      const peaks: ThetaScore[] = [];
      for (const s of scores) {
        // scores arrive sorted desc by combined
        if (peaks.every((p) => circMeanDiffDeg(p.thetaDeg, s.thetaDeg) >= PEAK_MIN_SEP_DEG))
          peaks.push(s);
        if (peaks.length >= MAX_PEAKS) break;
      }
      const out: PeakFeatures[] = [];
      for (const p of peaks) {
        const th = (p.thetaDeg * Math.PI) / 180;
        const opp = bandContrast(anchorX, anchorY, th + Math.PI, W / 2 + 6, OPP_R1, DR);
        const oppProf = bandProfile(anchorX, anchorY, th + Math.PI, W / 2 + 6, OPP_R1);
        const oppSolid = bandProfile(anchorX, anchorY, th + Math.PI, W / 2 + 6, OPP_R1, SOLID_LIFT);
        const cap = capEdgeAt(anchorX, anchorY, th);
        const prof = bandProfile(anchorX, anchorY, th, R0, R1);
        const walk = walkFrom(anchorX, anchorY, p.thetaDeg);
        out.push({
          thetaDeg: p.thetaDeg,
          colorLift: p.colorLift,
          fieldConf: p.fieldConf,
          combinedBase: p.combined,
          oppLift: opp ? opp.colorLift : 0,
          oppValid: !!opp && opp.nCenter >= 10,
          oppFracPos: oppProf.nBins >= 8 ? oppProf.fracPos : 0,
          oppRunLenPx: oppProf.nBins >= 8 ? oppProf.runLenPx : 0,
          oppSolidFrac:
            oppSolid.nBins >= 8 ? oppSolid.fracPos : 0,
          ...boundaryBehind(anchorX, anchorY, th),
          capEdge: cap.capEdge,
          capPairs: cap.capPairs,
          teeOnRay: teeOnRayAt(anchorX, anchorY, p.thetaDeg),
          fracPos: prof.fracPos,
          runLenPx: prof.runLenPx,
          walkEndDistPx: walk.endDistFromAnchorPx,
          walkStoppedReason: walk.stoppedReason,
          fwdProfile: centerProfile(anchorX, anchorY, th, 4, R1),
          bwdProfile: centerProfile(anchorX, anchorY, th + Math.PI, 4, 80),
          fwdRadial: radialProfile(anchorX, anchorY, th, 8, 120),
          bwdRadial: radialProfile(anchorX, anchorY, th + Math.PI, 8, 120),
        });
      }
      return out;
    }

    function walkFrom(anchorX: number, anchorY: number, startThetaDeg: number): WalkResult {
      let dir = (startThetaDeg * Math.PI) / 180;
      let x = anchorX + Math.cos(dir) * R0;
      let y = anchorY + Math.sin(dir) * R0;
      const points: [number, number][] = [[x, y]];
      let weak = 0;
      let stoppedReason: WalkResult['stoppedReason'] = 'max-distance';
      const maxSteps = Math.round((WALK_MAX_DIST_FROM_ANCHOR - R0) / WALK_STEP_PX);
      for (let i = 0; i < maxSteps; i++) {
        let bestDir = dir;
        let bestScore = -Infinity;
        let anyValid = false;
        for (let dd = -WALK_ANGLE_WINDOW_DEG; dd <= WALK_ANGLE_WINDOW_DEG; dd += WALK_ANGLE_STEP_DEG) {
          const cand = dir + (dd * Math.PI) / 180;
          const bc = bandContrast(x, y, cand, WALK_LOCAL_R0, WALK_LOCAL_R1, WALK_LOCAL_DR);
          if (!bc || bc.nCenter < 6 || bc.nFlank < 6) continue;
          anyValid = true;
          if (bc.colorLift > bestScore) {
            bestScore = bc.colorLift;
            bestDir = cand;
          }
        }
        if (!anyValid) {
          stoppedReason = 'no-evidence';
          break;
        }
        if (bestScore < WALK_MIN_LIFT) {
          weak++;
        } else {
          weak = 0;
        }
        if (weak >= WALK_WEAK_STOP) {
          stoppedReason = 'evidence-lost';
          break;
        }
        dir = bestDir;
        x += Math.cos(dir) * WALK_STEP_PX;
        y += Math.sin(dir) * WALK_STEP_PX;
        points.push([x, y]);
      }
      const last = points[points.length - 1];
      const endDist = Math.hypot(last[0] - anchorX, last[1] - anchorY);
      return { points, endDistFromAnchorPx: endDist, stoppedReason };
    }

    const basketsOut: BasketOut[] = [];
    for (const b of baskets) {
      const res = scanBearing(b.x, b.y);
      const scan = res?.scan ?? null;
      const walk = scan ? walkFrom(b.x, b.y, scan.approachBearingDeg) : null;
      const peaks = res ? extractPeaks(b.x, b.y, res.scores) : [];
      basketsOut.push({ id: b.id, x: b.x, y: b.y, scan, walk, peaks });
    }

    // ---- Validation against the 63-hole dev truth join ------------------
    const basketById = new Map(basketsOut.map((b) => [b.id, b]));
    const ownErrors: number[] = [];
    const otherMinErrors: number[] = [];
    let discriminates = 0;
    interface PerHole {
      hole: number;
      basketId: string;
      trueBearingDeg: number;
      estBearingDeg: number | null;
      ownErrorDeg: number | null;
      otherMinErrorDeg: number | null;
      otherMinBadgeLabel: string | null;
      discriminates: boolean;
    }
    const perHole: PerHole[] = [];
    for (const j of cache.judgments) {
      if (j.rankPrimary < 1) continue;
      const basket = baskets[j.trueBasket];
      const ownBadge = badges.find((bd) => Number(bd.label) === j.hole);
      if (!basket || !ownBadge) continue;
      const trueBearingDeg =
        (Math.atan2(ownBadge.cy - basket.y, ownBadge.cx - basket.x) * 180) / Math.PI;
      const bOut = basketById.get(basket.id);
      const estBearingDeg = bOut?.scan?.approachBearingDeg ?? null;
      let ownErrorDeg: number | null = null;
      let otherMinErrorDeg: number | null = null;
      let otherMinBadgeLabel: string | null = null;
      let disc = false;
      if (estBearingDeg !== null) {
        ownErrorDeg = circMeanDiffDeg(estBearingDeg, trueBearingDeg);
        for (const bd of badges) {
          if (bd === ownBadge) continue;
          const brg = (Math.atan2(bd.cy - basket.y, bd.cx - basket.x) * 180) / Math.PI;
          const err = circMeanDiffDeg(estBearingDeg, brg);
          if (otherMinErrorDeg === null || err < otherMinErrorDeg) {
            otherMinErrorDeg = err;
            otherMinBadgeLabel = bd.label;
          }
        }
        disc = otherMinErrorDeg === null || ownErrorDeg < otherMinErrorDeg;
        ownErrors.push(ownErrorDeg);
        poolOwn.push(ownErrorDeg);
        if (otherMinErrorDeg !== null) {
          otherMinErrors.push(otherMinErrorDeg);
          poolOther.push(otherMinErrorDeg);
        }
        if (disc) {
          discriminates++;
          poolDiscriminates++;
        }
        poolN++;
      }
      perHole.push({
        hole: j.hole,
        basketId: basket.id,
        trueBearingDeg,
        estBearingDeg,
        ownErrorDeg,
        otherMinErrorDeg,
        otherMinBadgeLabel,
        discriminates: disc,
      });
    }
    perHole.sort((a, b) => a.hole - b.hole);
    const ownSorted = [...ownErrors].sort((a, b) => a - b);
    const otherSorted = [...otherMinErrors].sort((a, b) => a - b);
    const validation = {
      n: ownErrors.length,
      ownErrorMedianDeg: quantile(ownSorted, 0.5),
      ownErrorP90Deg: quantile(ownSorted, 0.9),
      ownErrorMaxDeg: quantile(ownSorted, 1.0),
      otherErrorMedianDeg: quantile(otherSorted, 0.5),
      otherErrorP90Deg: quantile(otherSorted, 0.9),
      discriminationRate: ownErrors.length ? discriminates / ownErrors.length : NaN,
      perHole,
    };

    const scanned = basketsOut.filter((b) => b.scan).length;
    console.log(
      `${nm}: ${baskets.length} baskets, ${scanned} with a valid bearing (${(Date.now() - courseT0) / 1000}s) | ` +
        `truth n=${validation.n} own-err med=${validation.ownErrorMedianDeg.toFixed(1)}deg ` +
        `p90=${validation.ownErrorP90Deg.toFixed(1)}deg max=${validation.ownErrorMaxDeg.toFixed(1)}deg | ` +
        `other-min-err med=${validation.otherErrorMedianDeg.toFixed(1)}deg | ` +
        `discrimination=${(validation.discriminationRate * 100).toFixed(0)}% (${discriminates}/${validation.n})`,
    );
    const misses = perHole.filter((h) => h.ownErrorDeg === null || !h.discriminates);
    if (misses.length) {
      console.log(
        `  non-discriminating/failed holes: ` +
          misses
            .map(
              (h) =>
                `h${h.hole}(own=${h.ownErrorDeg?.toFixed(1) ?? 'NO-BEARING'}deg vs other-min=${h.otherMinErrorDeg?.toFixed(1) ?? '-'}deg@${h.otherMinBadgeLabel ?? '-'})`,
            )
            .join(' '),
      );
    }

    const out = {
      course: nm,
      params: {
        R0,
        R1,
        DR,
        thetaStepDeg: THETA_STEP_DEG,
        offsetFracsOfWidth: OFFSET_FRACS,
        corridorWidthPx: W,
        spriteW: SPRITE_W,
        spriteH: SPRITE_H,
        ring1: RING1,
        ring1Tol: RING1_TOL,
        ring2: RING2,
        ring2Tol: RING2_TOL,
        badgeHalfW: BADGE_HALF_W,
        badgeHalfH: BADGE_HALF_H,
        fieldR0: FIELD_R0,
        fieldWeight: FIELD_WEIGHT,
        colorLiftRef: COLOR_LIFT_REF,
        marginRef: MARGIN_REF,
        walk: {
          stepPx: WALK_STEP_PX,
          maxDistFromAnchorPx: WALK_MAX_DIST_FROM_ANCHOR,
          angleWindowDeg: WALK_ANGLE_WINDOW_DEG,
          angleStepDeg: WALK_ANGLE_STEP_DEG,
          minLift: WALK_MIN_LIFT,
        },
      },
      baskets: basketsOut.map((b) => ({
        id: b.id,
        x: b.x,
        y: b.y,
        approachBearingDeg: b.scan?.approachBearingDeg ?? null,
        confidence: b.scan?.confidence ?? null,
        colorLift: b.scan?.colorLift ?? null,
        fieldConf: b.scan?.fieldConf ?? null,
        combined: b.scan?.combined ?? null,
        margin: b.scan?.margin ?? null,
        validCandidates: b.scan?.validCandidates ?? 0,
        walkPoints: b.walk?.points ?? null,
        walkEndDistFromAnchorPx: b.walk?.endDistFromAnchorPx ?? null,
        walkStoppedReason: b.walk?.stoppedReason ?? null,
        peaks: b.peaks,
      })),
      validation,
    };
    writeFileSync(`${cacheDir}/${nm}-backwalk.json`, JSON.stringify(out));

    // ---- Overlay: box-averaged imagery + one ray per basket --------------
    const w = fw;
    const h = fh;
    const png = new PNG({ width: w, height: h });
    for (let fy = 0; fy < h; fy++) {
      for (let fx = 0; fx < w; fx++) {
        let rr = 0;
        let gg = 0;
        let bb = 0;
        let cnt = 0;
        for (let dy = 0; dy < scale; dy++) {
          const sy = fy * scale + dy;
          if (sy >= image.height) continue;
          for (let dx = 0; dx < scale; dx++) {
            const sx = fx * scale + dx;
            if (sx >= image.width) continue;
            const p = (sy * image.width + sx) * 4;
            rr += image.data[p];
            gg += image.data[p + 1];
            bb += image.data[p + 2];
            cnt++;
          }
        }
        const o = (fy * w + fx) * 4;
        png.data[o] = cnt ? rr / cnt : 0;
        png.data[o + 1] = cnt ? gg / cnt : 0;
        png.data[o + 2] = cnt ? bb / cnt : 0;
        png.data[o + 3] = 255;
      }
    }
    const put = (sx: number, sy: number, r: number, g: number, b: number): void => {
      const fx = Math.round(sx / scale);
      const fy = Math.round(sy / scale);
      if (fx < 0 || fx >= w || fy < 0 || fy >= h) return;
      const p = (fy * w + fx) * 4;
      png.data[p] = r;
      png.data[p + 1] = g;
      png.data[p + 2] = b;
    };
    const ownErrorByBasketId = new Map(perHole.map((ph) => [ph.basketId, ph.ownErrorDeg]));
    for (const b of basketsOut) {
      put(b.x, b.y, 255, 255, 0); // yellow anchor dot
      if (!b.scan) continue;
      const err = ownErrorByBasketId.get(b.id);
      const color: [number, number, number] =
        err === undefined ? [140, 140, 140] : err !== null && err <= 10 ? [0, 220, 0] : [255, 40, 40];
      const th = (b.scan.approachBearingDeg * Math.PI) / 180;
      const rayLen = b.walk?.endDistFromAnchorPx ?? R1;
      const steps = Math.ceil(rayLen / 1.5);
      for (let s = 0; s <= steps; s++) {
        const r = (rayLen * s) / steps;
        put(b.x + Math.cos(th) * r, b.y + Math.sin(th) * r, ...color);
      }
      if (b.walk) {
        for (const [px, py] of b.walk.points) put(px, py, 0, 200, 255); // cyan walked centerline
      }
    }
    writeFileSync(`${cacheDir}/${nm}-backwalk.png`, PNG.sync.write(png));
  }

  const ownSorted = [...poolOwn].sort((a, b) => a - b);
  const otherSorted = [...poolOther].sort((a, b) => a - b);
  console.log(
    `\nPOOLED (n=${poolN} truth baskets): own-badge error med=${quantile(ownSorted, 0.5).toFixed(1)}deg ` +
      `p90=${quantile(ownSorted, 0.9).toFixed(1)}deg max=${quantile(ownSorted, 1.0).toFixed(1)}deg | ` +
      `other-badge min-error med=${quantile(otherSorted, 0.5).toFixed(1)}deg p90=${quantile(otherSorted, 0.9).toFixed(1)}deg | ` +
      `discrimination=${((poolDiscriminates / poolN) * 100).toFixed(1)}% (${poolDiscriminates}/${poolN}) | ` +
      `total ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}

main();
