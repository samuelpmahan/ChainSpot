// P1.5 middle-out endpoint discovery — dev truth gate.
//
// Full experimental pipeline per image: fast badge stage (no tee-template
// scoring) -> digit reading (logistic) -> ribbon support field -> per-badge
// geodesic endpoint discovery. Each truth hole whose badge exists (badge
// digits == hole number) must have BOTH its tee and its basket matched by an
// endpoint candidate. Timing target: < 2 s per image total, warm.
//
// Truth: DashsTrack and AlexClark full corpus annotations (sha-verified
// identity frames); Heritage/Lenard/TowneLake via
// resources/nuthing-p2/registered-annotations.json.
//
// Usage: npx tsx scripts/nuthing/middle-out-dev.ts RGBA_DIR [--report MD] [--tol PX]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runBadgeStage } from '../../src/lib/nuthing/badgeStage';
import { readCourseBadges } from '../../src/lib/nuthing/digits/readBadges';
import type { DigitScorer } from '../../src/lib/nuthing/digits/readBadges';
import { predictProbs } from '../../src/lib/nuthing/digits/logistic';
import type { LogisticModel } from '../../src/lib/nuthing/digits/logistic';
import {
  computeRibbonSupport,
  supportCost,
  scoreEndpointComponents,
} from '../../src/lib/nuthing/ribbon';
import type { RibbonOptions, EndpointComponentOptions } from '../../src/lib/nuthing/ribbon';
import { decodeRgbaBin } from './decode';

const CORPUS = '/workspace/chainspot-corpus';

interface TruthHole {
  number: number;
  tee: [number, number];
  basket: [number, number];
  note?: string;
}

function dashsTrackTruth(): TruthHole[] {
  const ann = JSON.parse(
    readFileSync(join(CORPUS, 'dev/DashsTrack/DashsTrack-full.annotation.json'), 'utf8'),
  ) as { holes: { number: number; tee: { xPx: number; yPx: number }; basket: { xPx: number; yPx: number } }[] };
  return ann.holes.map((h) => ({
    number: h.number,
    tee: [h.tee.xPx, h.tee.yPx],
    basket: [h.basket.xPx, h.basket.yPx],
  }));
}

function registeredTruth(name: string): TruthHole[] {
  const reg = JSON.parse(
    readFileSync('resources/nuthing-p2/registered-annotations.json', 'utf8'),
  ) as Record<string, { registeredHoles: { number: number; tee: number[]; basket: number[] }[] }>;
  return reg[name].registeredHoles.map((h) => ({
    number: h.number,
    tee: [h.tee[0], h.tee[1]],
    basket: [h.basket[0], h.basket[1]],
  }));
}

function alexClarkTruth(): TruthHole[] {
  const ann = JSON.parse(
    readFileSync(join(CORPUS, 'dev/AlexClark/AlexClark-full.annotation.json'), 'utf8'),
  ) as {
    holes: {
      number: number;
      tee: { xPx: number; yPx: number };
      basket: { xPx: number; yPx: number };
    }[];
  };
  return ann.holes.map((h) => ({
    number: h.number,
    tee: [h.tee.xPx, h.tee.yPx],
    basket: [h.basket.xPx, h.basket.yPx],
  }));
}

const TRUTH: Record<string, () => TruthHole[]> = {
  'DashsTrack-full': dashsTrackTruth,
  'HeritagePark-full': () => registeredTruth('HeritagePark-full'),
  'Lenard-full': () => registeredTruth('Lenard-full'),
  'TowneLake-full': () => registeredTruth('TowneLake-full'),
  'AlexClark-full': alexClarkTruth,
};

function main(): void {
  const args = process.argv.slice(2);
  const reportIdx = args.indexOf('--report');
  const reportPath = reportIdx >= 0 ? args.splice(reportIdx, 2)[1] : null;
  const tolIdx = args.indexOf('--tol');
  const tol = tolIdx >= 0 ? Number(args.splice(tolIdx, 2)[1]) : 36;
  const [rgbaDir] = args;
  if (!rgbaDir) {
    console.error('Usage: tsx scripts/nuthing/middle-out-dev.ts RGBA_DIR [--report MD] [--tol PX]');
    process.exit(1);
  }
  const model = JSON.parse(
    readFileSync('resources/nuthing-p2/digits/models/logistic.json', 'utf8'),
  ) as LogisticModel;
  const scorer: DigitScorer = {
    name: 'logistic',
    scores: (mask) => predictProbs(model, mask),
  };
  const ribbonOptions: RibbonOptions = { widthsSrc: [16, 24, 36, 48] };
  const endpointOptions: EndpointComponentOptions = {};

  const lines: string[] = [];
  lines.push('# Middle-out endpoint discovery — dev truth gate');
  lines.push('');
  lines.push(
    `Pipeline per image: badge stage (P1 semantics, tee scoring skipped) → logistic digit ` +
      `reading → paired-edge ribbon support field → per-badge geodesic endpoint discovery. ` +
      `A truth hole passes when its badge exists (digits == hole number) and BOTH tee and ` +
      `basket have an endpoint candidate within ${tol}px. Endpoint pools follow the ` +
      `CandidatePool semantics (primaryCount=2, floor on mean ribbon support).`,
  );
  lines.push('');
  lines.push(
    '| image | badges | stage ms | read ms | field ms | endpoints ms | total s | holes w/ badge | tee+basket pass | tee-only | basket-only | neither |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');

  let allPass = true;
  const failures: string[] = [];
  for (const name of Object.keys(TRUTH)) {
    const image = decodeRgbaBin(join(rgbaDir, `${name}.rgba.bin`));
    // Warm-up pass then timed pass for stable numbers.
    for (let warm = 0; warm < 1; warm++) runBadgeStage(image);
    const t0 = performance.now();
    const stage = runBadgeStage(image);
    const t1 = performance.now();
    const readings = readCourseBadges(stage, scorer);
    const t2 = performance.now();
    const field = computeRibbonSupport(image, ribbonOptions);
    const cost = supportCost(field, 30, 0.25);
    const t3 = performance.now();
    const badgeByNumber = new Map<number, (typeof readings)[number]>();
    for (const r of readings) if (r.label) badgeByNumber.set(Number(r.label), r);
    const badgeLabels = new Set(stage.badges.map((b) => b.label));
    const candidates = stage.brightComponents.filter((c) => !badgeLabels.has(c.label));
    const pools = new Map<number, ReturnType<typeof scoreEndpointComponents>>();
    for (const [num, r] of badgeByNumber) {
      pools.set(
        num,
        scoreEndpointComponents(field, cost, r.badge.cx, r.badge.cy, candidates, endpointOptions),
      );
    }
    const t4 = performance.now();

    const truth = TRUTH[name]();
    let both = 0;
    let teeOnly = 0;
    let basketOnly = 0;
    let neither = 0;
    let withBadge = 0;
    for (const hole of truth) {
      const pool = pools.get(hole.number);
      if (!pool) continue;
      withBadge++;
      const all = pool.unculled;
      const near = (p: [number, number]) => {
        // Match = truth point inside candidate component bbox (+tol margin),
        // distance reported to the component centroid.
        let best = Infinity;
        let bestRank = -1;
        for (const c of all) {
          const comp = c.value.component;
          const inside = comp
            ? p[0] >= comp.bboxX - tol &&
              p[0] <= comp.bboxX + comp.bboxW + tol &&
              p[1] >= comp.bboxY - tol &&
              p[1] <= comp.bboxY + comp.bboxH + tol
            : Math.hypot(c.value.x - p[0], c.value.y - p[1]) <= 30;
          if (!inside) continue;
          const d = Math.hypot(c.value.x - p[0], c.value.y - p[1]);
          if (d < best) {
            best = d;
            bestRank = c.rank;
          }
        }
        return { d: best, rank: bestRank };
      };
      const teeHit = near(hole.tee);
      const basketHit = near(hole.basket);
      const teeOk = teeHit.rank >= 0;
      const basketOk = basketHit.rank >= 0;
      if (teeOk && basketOk) both++;
      else if (teeOk) teeOnly++;
      else if (basketOk) basketOnly++;
      else neither++;
      if (!teeOk || !basketOk) {
        failures.push(
          `${name} hole ${hole.number}${hole.note ? ` (${hole.note})` : ''}: ` +
            `tee d=${teeHit.d.toFixed(0)}px (rank ${teeHit.rank}), ` +
            `basket d=${basketHit.d.toFixed(0)}px (rank ${basketHit.rank})`,
        );
      }
    }
    const totalS = (t4 - t0) / 1000;
    if (both !== withBadge || totalS >= 2) allPass = false;
    const row =
      `| ${name} | ${stage.badgeCount} | ${(t1 - t0).toFixed(0)} | ${(t2 - t1).toFixed(0)} | ` +
      `${(t3 - t2).toFixed(0)} | ${(t4 - t3).toFixed(0)} | ${totalS.toFixed(2)} | ${withBadge} | ` +
      `${both} | ${teeOnly} | ${basketOnly} | ${neither} |`;
    lines.push(row);
    console.log(row.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim());
  }
  lines.push('');
  lines.push(`**Gate: ${allPass ? 'PASS' : 'FAIL'}** (every badge-backed truth hole tee+basket matched, and total < 2 s/image).`);
  if (failures.length) {
    lines.push('');
    lines.push('Failures:');
    for (const f of failures) lines.push(`- ${f}`);
    for (const f of failures) console.log('FAIL', f);
  }
  console.log(`gate: ${allPass ? 'PASS' : 'FAIL'}`);
  if (reportPath) {
    writeFileSync(reportPath, lines.join('\n'));
    console.log(`report -> ${reportPath}`);
  }
}

main();
