// Dumps per-course endpoint candidate pools (P1.5 middle-out) to JSON so
// scripts/nuthing/search-assignment.ts can grid/random-search the combined
// assignment cost WITHOUT re-running the expensive pipeline per trial.
//
// Runs the exact same stages as scripts/nuthing/middle-out-pair-eval.ts:
// auto-crop -> runBadgeStage -> readCourseBadges (logistic model) ->
// computeRibbonSupport(widthsSrc [16,24,36,48]) -> supportCost(field,30,0.25)
// -> scoreEndpointComponents per badge, then serializes the FULL candidate
// rows (nothing culled) plus truth shifted into cropped space, so the search
// script can reconstruct assignCourseEndpoints' inputs bit-for-bit.
//
// Usage: npx tsx scripts/nuthing/dump-endpoint-pools.ts [OUT_DIR]
// Default OUT_DIR: /workspace/nuthing-work/pools-cache

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { runBadgeStage } from '../../src/lib/nuthing/badgeStage';
import { readCourseBadges } from '../../src/lib/nuthing/digits/readBadges';
import { predictProbs } from '../../src/lib/nuthing/digits/logistic';
import type { LogisticModel } from '../../src/lib/nuthing/digits/logistic';
import { computeRibbonSupport, supportCost, scoreEndpointComponents } from '../../src/lib/nuthing/ribbon';
import type { EndpointComponentCandidate } from '../../src/lib/nuthing/ribbon';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';
import { decodeRgbaBin } from './decode';

const RIBBON_WIDTHS = [16, 24, 36, 48];
const COST_BOOST = 30;
const COST_LOW_SUPPORT = 0.25;

interface TruthHole {
  number: number;
  tee: [number, number];
  basket: [number, number];
}

function loadTruth(): Record<string, TruthHole[]> {
  const reg = JSON.parse(
    readFileSync('resources/nuthing-p2/registered-annotations.json', 'utf8'),
  ) as Record<string, { registeredHoles: { number: number; tee: number[]; basket: number[] }[] }>;
  const dashs = JSON.parse(
    readFileSync(
      '/workspace/chainspot-corpus/dev/DashsTrack/DashsTrack-full.annotation.json',
      'utf8',
    ),
  ) as { holes: { number: number; tee: { xPx: number; yPx: number }; basket: { xPx: number; yPx: number } }[] };
  const out: Record<string, TruthHole[]> = {
    'DashsTrack-full': dashs.holes.map((h) => ({
      number: h.number,
      tee: [h.tee.xPx, h.tee.yPx],
      basket: [h.basket.xPx, h.basket.yPx],
    })),
  };
  for (const nm of ['HeritagePark-full', 'Lenard-full', 'TowneLake-full']) {
    out[nm] = reg[nm].registeredHoles.map((h) => ({
      number: h.number,
      tee: [h.tee[0], h.tee[1]],
      basket: [h.basket[0], h.basket[1]],
    }));
  }
  return out;
}

interface DumpedComponent {
  label: number;
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  area: number;
  fill: number;
}

interface DumpedCandidate {
  component: DumpedComponent | null;
  x: number;
  y: number;
  geodesic: number;
  radius: number;
  efficiency: number;
  kind: EndpointComponentCandidate['kind'];
  firstIcon: boolean | null;
  gateX: number | null;
  gateY: number | null;
}

interface DumpedBadge {
  label: string;
  cx: number;
  cy: number;
  candidates: DumpedCandidate[];
}

interface DumpedTruthHole {
  number: number;
  /** [x, y] shifted into cropped space (y - viewport.top). */
  tee: [number, number];
  basket: [number, number];
}

interface DumpedCourse {
  name: string;
  viewportTop: number;
  viewportBottom: number;
  badges: DumpedBadge[];
  truth: DumpedTruthHole[];
}

function dumpCandidate(c: EndpointComponentCandidate): DumpedCandidate {
  return {
    component: c.component
      ? {
          label: c.component.label,
          bboxX: c.component.bboxX,
          bboxY: c.component.bboxY,
          bboxW: c.component.bboxW,
          bboxH: c.component.bboxH,
          area: c.component.area,
          fill: c.component.fill,
        }
      : null,
    x: c.x,
    y: c.y,
    geodesic: c.geodesic,
    radius: c.radius,
    efficiency: c.efficiency,
    kind: c.kind,
    firstIcon: c.firstIcon === undefined ? null : c.firstIcon,
    gateX: c.gateX === undefined ? null : c.gateX,
    gateY: c.gateY === undefined ? null : c.gateY,
  };
}

function main(): void {
  const [outDirArg] = process.argv.slice(2);
  const outDir = outDirArg ?? '/workspace/nuthing-work/pools-cache';
  mkdirSync(outDir, { recursive: true });
  const model = JSON.parse(
    readFileSync('resources/nuthing-p2/digits/models/logistic.json', 'utf8'),
  ) as LogisticModel;
  const truthAll = loadTruth();

  for (const nm of Object.keys(truthAll)) {
    const t0 = Date.now();
    const fullImage = decodeRgbaBin(`/workspace/nuthing-work/traces-py/${nm}.rgba.bin`);
    const viewport = detectMapViewport(fullImage);
    const image = cropRows(fullImage, viewport);
    const stage = runBadgeStage(image);
    const readings = readCourseBadges(stage, {
      name: 'logistic',
      scores: (m) => predictProbs(model, m),
    });
    const field = computeRibbonSupport(image, { widthsSrc: RIBBON_WIDTHS });
    const cost = supportCost(field, COST_BOOST, COST_LOW_SUPPORT);
    const badgeLabels = new Set(stage.badges.map((b) => b.label));
    const cands = stage.brightComponents.filter((c) => !badgeLabels.has(c.label));

    const badges: DumpedBadge[] = readings.map((r) => {
      const pool = scoreEndpointComponents(field, cost, r.badge.cx, r.badge.cy, cands, {});
      return {
        label: r.label,
        cx: r.badge.cx,
        cy: r.badge.cy,
        candidates: pool.unculled.map((rc) => dumpCandidate(rc.value)),
      };
    });

    const truth = truthAll[nm];
    const dumpedTruth: DumpedTruthHole[] = truth.map((h) => ({
      number: h.number,
      tee: [h.tee[0], h.tee[1] - viewport.top],
      basket: [h.basket[0], h.basket[1] - viewport.top],
    }));

    const course: DumpedCourse = {
      name: nm,
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom,
      badges,
      truth: dumpedTruth,
    };
    const outPath = `${outDir}/${nm}.json`;
    writeFileSync(outPath, JSON.stringify(course));
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `${nm}: badges=${badges.length} candTotal=${badges.reduce((s, b) => s + b.candidates.length, 0)} -> ${outPath} (${dt}s)`,
    );
  }
}

main();
