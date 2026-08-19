// Two-Pass Execution Protocol (CULLED RUN vs FULL REPLAY) measured on the
// NuThing P1 tee candidate pool, across the full 15-image corpus.
//
// For each image: decode -> run P1 (timed as "P1 runtime") -> build the two
// passes over result.teePool with a real per-candidate downstream task
// ("evidence materialization": recompute the candidate's canonical mask,
// inner core, and package { label, bbox, score, rank, corePixelCount }).
//
// Truth coverage is computed for DashsTrack-full ONLY: for each hole's tee
// point, finds the best-ranked candidate whose (raster-space) bbox —
// expanded by a 3px margin — contains the point, and records which
// CandidatePool partition (PRIMARY / SECONDARY / CULLED / NONE) it fell in.
// DashsTrack-full is the sole annotated dev image whose annotation JSON's
// sourceImage.sha256 matches the corpus raster exactly — its tee/basket
// pixel coordinates are verified to be in the corpus raster's coordinate
// frame. The other four annotated dev images (AlexClark-full,
// HeritagePark-full, Lenard-full, TowneLake-full) are excluded from truth
// coverage: their annotations were made on different captures than the
// corpus rasters (dimension mismatch and/or sha256 mismatch, one lacking a
// checksum entirely with an empirically wrong coordinate frame on visual
// audit), so tee-coordinate matching against P1 candidates would be
// meaningless there — see the "Excluded from truth coverage" section of the
// generated report for the per-image reason.
//
// Usage: npx tsx scripts/nuthing/two-pass-tees.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  runNuThingP1,
  canonicalComponentMask,
  CANON_MAJOR_SPAN,
  OBSERVED_CORE_FRACTION,
  type TeeScoreRow,
} from '../../src/lib/nuthing/p1';
import { innerCore } from '../../src/lib/nuthing/chamfer';
import type { RankedCandidate } from '../../src/lib/nuthing/candidatePool';
import { TEE_THEORETICAL_FLOOR } from '../../src/lib/nuthing/candidatePool';
import { runTwoPass } from '../../src/lib/nuthing/twoPass';
import { decodeRgbaBin } from './decode';

const TRACES_DIR = '/workspace/nuthing-work/traces-py';
const CORPUS_ANNOTATED_DIR = '/workspace/chainspot-corpus/dev/Annotated';
const OUT_JSON_DIR = '/workspace/nuthing-work/two-pass';
const OUT_JSON_PATH = join(OUT_JSON_DIR, 'two-pass-tees.json');
const OUT_MD_PATH = join(
  '/home/user/ChainSpot/docs/nuthing-p2',
  'two-pass-tees.md',
);

// Course subdirectory name in the corpus differs from the image base name
// for HeritagePark ("Heritage" on disk).
const ANNOTATION_DIRS: Record<string, string> = {
  'AlexClark-full': 'AlexClark',
  'DashsTrack-full': 'DashsTrack',
  'HeritagePark-full': 'Heritage',
  'Lenard-full': 'Lenard',
  'TowneLake-full': 'TowneLake',
};

// Only DashsTrack-full's annotation JSON has a sourceImage.sha256 that
// matches the corpus raster exactly, i.e. a verified-correct coordinate
// frame. Truth coverage is computed for it alone; the rest are reported as
// excluded, with why, rather than matched against (meaningless) coordinates.
const TRUTH_VERIFIED_IMAGES = new Set(['DashsTrack-full']);

const TRUTH_EXCLUDED_REASONS: Record<string, string> = {
  'AlexClark-full':
    'older annotation schema with no sourceImage.sha256 to verify against; ' +
    'coordinate frame empirically wrong on visual audit',
  'HeritagePark-full':
    'annotation sourceImage is 1290x2115 but the corpus raster is 1290x2796 ' +
    '(different capture); similarity registration found only 5/18 tee inliers, ' +
    'so no reliable transform exists',
  'Lenard-full':
    'annotation sourceImage is 1290x2089 but the corpus raster is 1290x2796 ' +
    '(different capture); similarity registration found only 5/18 tee inliers, ' +
    'so no reliable transform exists',
  'TowneLake-full':
    'annotation sourceImage is 1290x2012 but the corpus raster is 1290x2796 ' +
    '(different capture); similarity registration found only 5/18 tee inliers, ' +
    'so no reliable transform exists',
};

type Partition = 'PRIMARY' | 'SECONDARY' | 'CULLED' | 'NONE';

interface EvidenceRow {
  label: number;
  bbox: [number, number, number, number];
  score: number;
  rank: number;
  corePixelCount: number;
  partition: Exclude<Partition, 'NONE'>;
}

interface TruthMatch {
  hole: number;
  rank: number | null;
  score: number | null;
  partition: Partition;
}

interface AnnotationHole {
  number: number;
  tee: { xPx: number; yPx: number };
}

interface Annotation {
  holes: AnnotationHole[];
}

function partitionOf(rank: number, score: number, primaryCount: number): Exclude<Partition, 'NONE'> {
  if (rank <= primaryCount) return 'PRIMARY';
  return score >= TEE_THEORETICAL_FLOOR ? 'SECONDARY' : 'CULLED';
}

/** Real downstream per-candidate task: evidence materialization. */
function makeEvidenceTask(
  brightLabels: Int32Array,
  width: number,
  canonScale: number,
  primaryCount: number,
): (c: RankedCandidate<TeeScoreRow>) => EvidenceRow {
  return (c) => {
    const comp = c.value.component;
    const proj = canonicalComponentMask(brightLabels, width, comp, canonScale);
    const core = innerCore(proj.mask, OBSERVED_CORE_FRACTION);
    let corePixelCount = 0;
    for (let i = 0; i < core.length; i++) if (core[i]) corePixelCount++;
    return {
      label: comp.label,
      bbox: [comp.bboxX, comp.bboxY, comp.bboxW, comp.bboxH],
      score: c.value.score,
      rank: c.rank,
      corePixelCount,
      partition: partitionOf(c.rank, c.value.score, primaryCount),
    };
  };
}

function matchTruth(
  evidence: EvidenceRow[],
  teeX: number,
  teeY: number,
  margin: number,
): EvidenceRow | null {
  let best: EvidenceRow | null = null;
  for (const e of evidence) {
    const [x, y, w, h] = e.bbox;
    if (
      teeX >= x - margin &&
      teeX <= x + w + margin &&
      teeY >= y - margin &&
      teeY <= y + h + margin
    ) {
      if (best === null || e.rank < best.rank) best = e;
    }
  }
  return best;
}

function loadAnnotation(name: string): Annotation | null {
  const dir = ANNOTATION_DIRS[name];
  if (!dir) return null;
  const path = join(CORPUS_ANNOTATED_DIR, dir, `${name}.annotation.json`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Annotation;
  } catch {
    return null;
  }
}

interface ImageOutcome {
  name: string;
  width: number;
  height: number;
  p1Seconds: number;
  badgeCount: number;
  primaryCount: number;
  theoreticalFloor: number;
  teeModalMajor: number;
  teeModalMinor: number;
  culledRun: { candidateCount: number; seconds: number };
  fullReplay: { candidateCount: number; seconds: number };
  evidence: EvidenceRow[];
  truth: { totalTees: number; matches: TruthMatch[] } | null;
}

/**
 * The modal tee family (median major/minor extent that seeds the border
 * template) is normally close to a real tee-icon's size (tens of px). On
 * several corpus images the anchored-family search instead locks onto a
 * degenerate ~2px "family" of noise-sized components; every real tee-sized
 * candidate's canonical projection then scales off the 96x96 canonical
 * square and scores null (dropped from teeRanked entirely). This is a
 * pre-existing property of the P1 port (present in the Python baseline too
 * — see tee_modal_major in the parity traces), not introduced by the
 * two-pass measurement. Flag it so the truth-coverage numbers are read in
 * context rather than mistaken for a matching bug.
 */
const DEGENERATE_MODAL_MAJOR_PX = 10;

function main(): void {
  mkdirSync(OUT_JSON_DIR, { recursive: true });

  const files = readdirSync(TRACES_DIR)
    .filter((f) => f.endsWith('.rgba.bin'))
    .sort();

  const outcomes: ImageOutcome[] = [];

  for (const file of files) {
    const name = file.replace(/\.rgba\.bin$/, '');
    const path = join(TRACES_DIR, file);
    const image = decodeRgbaBin(path);

    const t0 = performance.now();
    const result = runNuThingP1(image);
    const p1Seconds = (performance.now() - t0) / 1000;

    const canonScale = CANON_MAJOR_SPAN / result.teeModalMajor;
    const primaryCount = result.teePool.primaryCount;
    const task = makeEvidenceTask(result.brightLabels, result.width, canonScale, primaryCount);

    const twoPass = runTwoPass(result.teePool, task);

    let truth: ImageOutcome['truth'] = null;
    if (TRUTH_VERIFIED_IMAGES.has(name)) {
      const annotation = loadAnnotation(name);
      if (annotation) {
        const matches: TruthMatch[] = annotation.holes.map((hole) => {
          const best = matchTruth(twoPass.fullReplay.results, hole.tee.xPx, hole.tee.yPx, 3);
          return best
            ? { hole: hole.number, rank: best.rank, score: best.score, partition: best.partition }
            : { hole: hole.number, rank: null, score: null, partition: 'NONE' };
        });
        truth = { totalTees: annotation.holes.length, matches };
      }
    }

    outcomes.push({
      name,
      width: result.width,
      height: result.height,
      p1Seconds,
      badgeCount: result.badgeCount,
      primaryCount,
      theoreticalFloor: result.teePool.theoreticalFloor,
      teeModalMajor: result.teeModalMajor,
      teeModalMinor: result.teeModalMinor,
      culledRun: {
        candidateCount: twoPass.culledRun.candidateCount,
        seconds: twoPass.culledRun.seconds,
      },
      fullReplay: {
        candidateCount: twoPass.fullReplay.candidateCount,
        seconds: twoPass.fullReplay.seconds,
      },
      evidence: twoPass.fullReplay.results,
      truth,
    });

    console.log(
      `${name}: p1=${p1Seconds.toFixed(3)}s culled=${twoPass.culledRun.candidateCount}` +
        `/${twoPass.culledRun.seconds.toFixed(3)}s full=${twoPass.fullReplay.candidateCount}` +
        `/${twoPass.fullReplay.seconds.toFixed(3)}s` +
        (truth ? ` truth=${truth.totalTees}` : ''),
    );
  }

  writeFileSync(OUT_JSON_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), images: outcomes }, null, 2));
  console.log(`wrote ${OUT_JSON_PATH}`);

  writeFileSync(OUT_MD_PATH, renderReport(outcomes));
  console.log(`wrote ${OUT_MD_PATH}`);
}

function fmt(n: number, digits = 3): string {
  return n.toFixed(digits);
}

function renderReport(outcomes: ImageOutcome[]): string {
  const lines: string[] = [];
  lines.push('# NuThing P2 — Two-Pass Execution Protocol on the tee pool');
  lines.push('');
  lines.push(
    'CULLED RUN = per-candidate "evidence materialization" task (canonical mask, inner ' +
      'core, bbox/score/rank packaging) run over `pool.forwarded` (primary + candidates ' +
      'scoring >= the 0.40 theoretical floor). FULL REPLAY = the same task re-run from the ' +
      'same boundary over `pool.unculled` (the complete ranked population). Both are ' +
      'independently timed with `performance.now()`; FULL REPLAY genuinely re-executes the ' +
      'task rather than inspecting CULLED RUN leftovers, so it is the falsification check for ' +
      'the 0.40 floor. All 15 corpus images are included in timing. Truth coverage is computed ' +
      'for DashsTrack-full only — see "Truth coverage" below for why the other 4 annotated dev ' +
      'images are excluded.',
  );
  lines.push('');

  lines.push('## Per-image timing');
  lines.push('');
  lines.push(
    '| Image | P1 seconds | CULLED RUN candidates | CULLED RUN seconds | FULL REPLAY candidates | FULL REPLAY seconds |',
  );
  lines.push('|---|---:|---:|---:|---:|---:|');
  let sumP1 = 0;
  let sumCulledCount = 0;
  let sumCulledSec = 0;
  let sumFullCount = 0;
  let sumFullSec = 0;
  for (const o of outcomes) {
    lines.push(
      `| ${o.name} | ${fmt(o.p1Seconds)} | ${o.culledRun.candidateCount} | ${fmt(o.culledRun.seconds)} | ` +
        `${o.fullReplay.candidateCount} | ${fmt(o.fullReplay.seconds)} |`,
    );
    sumP1 += o.p1Seconds;
    sumCulledCount += o.culledRun.candidateCount;
    sumCulledSec += o.culledRun.seconds;
    sumFullCount += o.fullReplay.candidateCount;
    sumFullSec += o.fullReplay.seconds;
  }
  lines.push(
    `| **Total (15 images)** | ${fmt(sumP1)} | ${sumCulledCount} | ${fmt(sumCulledSec)} | ${sumFullCount} | ${fmt(sumFullSec)} |`,
  );
  lines.push('');

  const degenerateModal = outcomes.filter((o) => o.teeModalMajor < DEGENERATE_MODAL_MAJOR_PX);
  if (degenerateModal.length > 0) {
    lines.push(
      `Note: ${degenerateModal.length} image(s) — ` +
        `${degenerateModal.map((o) => `${o.name} (modal major ${fmt(o.teeModalMajor, 1)}px)`).join(', ')} ` +
        '— have the anchored-family search locking onto a degenerate noise-sized "modal tee ' +
        'family" instead of a real tee-icon-sized one (a pre-existing property of the P1 port, ' +
        'also present in the Python baseline). Real tee-sized candidates then scale off the ' +
        '96x96 canonical square and score null, so `teeRanked` (and therefore both pool sizes ' +
        'above) is far sparser for these images than for a normally-seeded image like ' +
        'DashsTrack-full.',
    );
    lines.push('');
  }

  lines.push('## Truth coverage (DashsTrack-full only)');
  lines.push('');
  lines.push(
    'Of the 5 annotated dev images, only DashsTrack-full has an annotation JSON whose ' +
      '`sourceImage.sha256` matches the corpus raster exactly — a verified-correct coordinate ' +
      'frame. Truth coverage below is computed for DashsTrack-full alone; matching the other 4 ' +
      "annotated images' tee coordinates against P1 candidates would be meaningless since their " +
      'coordinate frames are not confirmed to be the corpus raster frame (see "Excluded from ' +
      'truth coverage" below for the per-image reason).',
  );
  lines.push('');

  const annotated = outcomes.filter((o) => o.truth !== null);
  let totalTees = 0;
  let totalPrimary = 0;
  let totalSecondaryOnly = 0;
  let totalCulledOnly = 0;
  let totalUnmatched = 0;
  const falsificationCases: { image: string; hole: number; rank: number; score: number }[] = [];
  const unmatchedCases: { image: string; hole: number }[] = [];

  for (const o of annotated) {
    const truth = o.truth!;
    const primary = truth.matches.filter((m) => m.partition === 'PRIMARY');
    const secondaryOnly = truth.matches.filter((m) => m.partition === 'SECONDARY');
    const culledOnly = truth.matches.filter((m) => m.partition === 'CULLED');
    const unmatched = truth.matches.filter((m) => m.partition === 'NONE');

    totalTees += truth.totalTees;
    totalPrimary += primary.length;
    totalSecondaryOnly += secondaryOnly.length;
    totalCulledOnly += culledOnly.length;
    totalUnmatched += unmatched.length;

    for (const m of culledOnly) {
      falsificationCases.push({ image: o.name, hole: m.hole, rank: m.rank!, score: m.score! });
    }
    for (const m of unmatched) {
      unmatchedCases.push({ image: o.name, hole: m.hole });
    }

    lines.push(`### ${o.name}`);
    lines.push('');
    lines.push(
      `Total annotated tees: ${truth.totalTees}. Found in PRIMARY: ${primary.length}. ` +
        `Found only in SECONDARY (score >= 0.40): ${secondaryOnly.length}. ` +
        `Found only among CULLED (score < 0.40): ${culledOnly.length}. ` +
        `Unmatched (no candidate at all): ${unmatched.length}.`,
    );
    lines.push('');

    if (secondaryOnly.length > 0) {
      lines.push('SECONDARY-only matches:');
      for (const m of secondaryOnly) {
        lines.push(`- hole ${m.hole}: rank ${m.rank}, score ${fmt(m.score!, 4)}`);
      }
      lines.push('');
    }

    if (culledOnly.length > 0) {
      lines.push('**Floor falsification cases (matched only among CULLED, score < 0.40):**');
      for (const m of culledOnly) {
        lines.push(`- hole ${m.hole}: rank ${m.rank}, score ${fmt(m.score!, 4)}`);
      }
      lines.push('');
    }

    if (unmatched.length > 0) {
      lines.push('**Unmatched tees (no candidate bbox contains the tee point):**');
      for (const m of unmatched) {
        lines.push(`- hole ${m.hole}`);
      }
      lines.push('');
    }
  }

  lines.push('### Aggregate truth coverage');
  lines.push('');
  lines.push('| Total annotated tees | Found in PRIMARY | Found only in SECONDARY | Found only among CULLED | Unmatched |');
  lines.push('|---:|---:|---:|---:|---:|');
  lines.push(
    `| ${totalTees} | ${totalPrimary} | ${totalSecondaryOnly} | ${totalCulledOnly} | ${totalUnmatched} |`,
  );
  lines.push('');

  lines.push('## Excluded from truth coverage');
  lines.push('');
  lines.push(
    'The following annotated dev images are excluded from truth coverage because their ' +
      'annotation coordinate frame is not verified to match the corpus raster:',
  );
  lines.push('');
  for (const [name, reason] of Object.entries(TRUTH_EXCLUDED_REASONS)) {
    lines.push(`- **${name}**: ${reason}.`);
  }
  lines.push('');

  lines.push('## Conclusions');
  lines.push('');
  const savedCount = sumFullCount - sumCulledCount;
  const savedSec = sumFullSec - sumCulledSec;
  lines.push(
    `The 0.40 theoretical floor withholds ${savedCount} of ${sumFullCount} ranked candidates ` +
      `(${((savedCount / Math.max(sumFullCount, 1)) * 100).toFixed(1)}%) from the evidence-` +
      `materialization task across the 15-image corpus, saving ${fmt(savedSec)}s of the ` +
      `${fmt(sumFullSec)}s FULL REPLAY would cost (CULLED RUN: ${fmt(sumCulledSec)}s).`,
  );
  lines.push('');
  if (falsificationCases.length === 0) {
    lines.push(
      'FULL REPLAY did not surface any truth tee candidate that the 0.40 floor would have ' +
        'withheld: every matched annotated tee that had any matching candidate at all was ' +
        'found at or above the floor (PRIMARY or SECONDARY). No floor-falsification cases in ' +
        'this corpus.',
    );
  } else {
    lines.push(
      `FULL REPLAY surfaced ${falsificationCases.length} truth tee(s) whose only matching ` +
        'candidate scored below the 0.40 floor — these are floor-falsification cases (listed ' +
        'above, per image) and are reported as-is.',
    );
  }
  lines.push('');
  if (unmatchedCases.length === 0) {
    lines.push('Every annotated tee had at least one candidate (of any partition) matching its bbox.');
  } else {
    lines.push(
      `${unmatchedCases.length} annotated tee(s) had no matching candidate in the entire ` +
        'ranked population (listed above, per image) — these are gaps in the underlying tee ' +
        'candidate discovery, not floor-culling artifacts.',
    );
  }
  lines.push('');

  return lines.join('\n');
}

main();
