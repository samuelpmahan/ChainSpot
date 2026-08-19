// Primary-pair evaluation for P1.5 middle-out endpoint discovery, with
// mandatory annotated overlays: every numbers run renders, per course, the
// original imagery with badges (red), chosen primary pairs (yellow + pink
// legs), truth tees (green) and truth baskets (blue) so the numbers can be
// verified by eye.
//
// Auto-crop (production stitch autoCrop) runs FIRST; all stages operate on
// the map viewport and coordinates are reported in full-frame space.
//
// Usage: npx tsx scripts/nuthing/middle-out-pair-eval.ts OUT_DIR

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PNG } from 'pngjs';
import { runBadgeStage } from '../../src/lib/nuthing/badgeStage';
import { readCourseBadges } from '../../src/lib/nuthing/digits/readBadges';
import { predictProbs } from '../../src/lib/nuthing/digits/logistic';
import type { LogisticModel } from '../../src/lib/nuthing/digits/logistic';
import {
  computeRibbonSupport,
  supportCost,
  scoreEndpointComponents,
  assignCourseEndpoints,
} from '../../src/lib/nuthing/ribbon';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';
import { decodeRgbaBin } from './decode';

const RIBBON_WIDTHS = [16, 24, 36, 48];
const COST_BOOST = 30;
const COST_LOW_SUPPORT = 0.25;
const TOL = 10;

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

function main(): void {
  const [outDir] = process.argv.slice(2);
  if (!outDir) {
    console.error('Usage: tsx scripts/nuthing/middle-out-pair-eval.ts OUT_DIR');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const model = JSON.parse(
    readFileSync('resources/nuthing-p2/digits/models/logistic.json', 'utf8'),
  ) as LogisticModel;
  const truthAll = loadTruth();

  let pairBoth = 0;
  let total = 0;
  for (const nm of Object.keys(truthAll)) {
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
    const truth = truthAll[nm];

    // Overlay base: cropped imagery at field scale.
    const png = new PNG({ width: field.width, height: field.height });
    for (let fy = 0; fy < field.height; fy++) {
      for (let fx = 0; fx < field.width; fx++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = 0; dy < field.scale; dy++) {
          const sy = fy * field.scale + dy;
          if (sy >= image.height) continue;
          for (let dx = 0; dx < field.scale; dx++) {
            const sx = fx * field.scale + dx;
            if (sx >= image.width) continue;
            const p = (sy * image.width + sx) * 4;
            r += image.data[p];
            g += image.data[p + 1];
            b += image.data[p + 2];
            n++;
          }
        }
        const o = (fy * field.width + fx) * 4;
        png.data[o] = n ? r / n : 0;
        png.data[o + 1] = n ? g / n : 0;
        png.data[o + 2] = n ? b / n : 0;
        png.data[o + 3] = 255;
      }
    }
    const mark = (x: number, y: number, r: number, g: number, b: number, rad = 2): void => {
      const fx = Math.round(x / field.scale);
      const fy = Math.round(y / field.scale);
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const xx = fx + dx;
          const yy = fy + dy;
          if (xx < 0 || xx >= field.width || yy < 0 || yy >= field.height) continue;
          const p = (yy * field.width + xx) * 4;
          png.data[p] = r;
          png.data[p + 1] = g;
          png.data[p + 2] = b;
        }
      }
    };
    const line = (x0: number, y0: number, x1: number, y1: number): void => {
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / field.scale);
      for (let t = 0; t <= steps; t++) {
        mark(x0 + ((x1 - x0) * t) / steps, y0 + ((y1 - y0) * t) / steps, 255, 90, 200, 0);
      }
    };

    let cb = 0;
    let n = 0;
    const fails: string[] = [];
    const pools = readings.map((r) =>
      scoreEndpointComponents(field, cost, r.badge.cx, r.badge.cy, cands, {}),
    );
    const assignment = assignCourseEndpoints(pools);
    readings.forEach((r, i) => {
      const chosen = [assignment.tee[i], assignment.basket[i]].filter(
        (c): c is NonNullable<typeof c> => c !== null,
      );
      for (const c of chosen) {
        line(r.badge.cx, r.badge.cy, c.x, c.y);
        mark(c.x, c.y, 255, 220, 0, 2);
      }
      mark(r.badge.cx, r.badge.cy, 255, 0, 0, 2);
      if (!r.label) return;
      const t = truth.find((h) => h.number === Number(r.label));
      if (!t) return;
      n++;
      total++;
      const tee: [number, number] = [t.tee[0], t.tee[1] - viewport.top];
      const basket: [number, number] = [t.basket[0], t.basket[1] - viewport.top];
      const hit = (p: [number, number]): boolean =>
        chosen.some((c) => {
          const comp = c.component;
          return comp
            ? p[0] >= comp.bboxX - TOL &&
                p[0] <= comp.bboxX + comp.bboxW + TOL &&
                p[1] >= comp.bboxY - TOL &&
                p[1] <= comp.bboxY + comp.bboxH + TOL
            : Math.hypot(c.x - p[0], c.y - p[1]) <= 30;
        });
      const th = hit(tee);
      const bh = hit(basket);
      if (th && bh) {
        cb++;
        pairBoth++;
      } else {
        fails.push(`h${r.label}(${th ? '' : 'T'}${bh ? '' : 'B'})`);
      }
    });
    for (const t of truth) {
      mark(t.tee[0], t.tee[1] - viewport.top, 0, 230, 0, 1);
      mark(t.basket[0], t.basket[1] - viewport.top, 60, 120, 255, 1);
    }
    writeFileSync(`${outDir}/${nm}-pairs.png`, PNG.sync.write(png));
    console.log(
      `${nm}: viewport[${viewport.top},${viewport.bottom}) primary both=${cb}/${n}` +
        (fails.length ? ` fails: ${fails.join(' ')}` : ''),
    );
  }
  console.log(`TOTAL primary both=${pairBoth}/${total}`);
}

main();
