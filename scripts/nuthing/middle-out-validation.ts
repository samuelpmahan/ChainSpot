// P1.5 pipeline over the validation corpus (earned by passing the dev gate).
//
// No positional truth exists for validation courses, so this reports what is
// checkable: per-image timing, badge counts, digit readings (scored against
// evaluation-only labels where they exist — Fountain Hills), endpoint-pool
// pairing stats, and visual overlay renders for qualitative audit.
//
// Usage: npx tsx scripts/nuthing/middle-out-validation.ts OUT_DIR [--report MD]

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PNG } from 'pngjs';
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
import { decodeImageFile } from './decode';

const VALIDATION_ROOT = '/workspace/chainspot-corpus/validation';

function evalLabels(): Map<string, string> {
  // Fountain Hills evaluation-only digit truth from the manifest.
  const manifest = JSON.parse(
    readFileSync('resources/nuthing-p2/badges/manifest.json', 'utf8'),
  ) as { badges: { id: string; image: string; bbox: number[]; evalLabel?: string | null }[] };
  const map = new Map<string, string>();
  for (const b of manifest.badges) {
    if (b.evalLabel) map.set(`${b.image}|${b.bbox.join(',')}`, b.evalLabel);
  }
  return map;
}

function main(): void {
  const args = process.argv.slice(2);
  const reportIdx = args.indexOf('--report');
  const reportPath = reportIdx >= 0 ? args.splice(reportIdx, 2)[1] : null;
  const [outDir] = args;
  if (!outDir) {
    console.error('Usage: tsx scripts/nuthing/middle-out-validation.ts OUT_DIR [--report MD]');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const model = JSON.parse(
    readFileSync('resources/nuthing-p2/digits/models/logistic.json', 'utf8'),
  ) as LogisticModel;
  const scorer: DigitScorer = { name: 'logistic', scores: (m) => predictProbs(model, m) };
  const truth = evalLabels();

  const files: string[] = [];
  for (const course of readdirSync(VALIDATION_ROOT)) {
    const dir = join(VALIDATION_ROOT, course, 'clean');
    try {
      for (const f of readdirSync(dir)) {
        if (/\.(png|jpe?g)$/i.test(f)) files.push(join(dir, f));
      }
    } catch {
      // no clean/ dir
    }
  }
  files.sort();

  const lines: string[] = [];
  lines.push('# P1.5 validation-course run');
  lines.push('');
  lines.push(
    'Pipeline: badge stage → logistic digit reading → ribbon support field → ' +
      'per-badge middle-out endpoint pools. Digit readings are scored only ' +
      'where evaluation-only truth exists (Fountain Hills); other courses ' +
      'report structural stats and overlay renders for qualitative audit.',
  );
  lines.push('');
  lines.push(
    '| image | size | badges | labels read | digit truth | total s | paired badges |',
  );
  lines.push('|---|---|---|---|---|---|---|');

  for (const file of files) {
    const name = basename(file).replace(/\.(png|jpe?g)$/i, '').replace(/\s+/g, '');
    const image = decodeImageFile(file);
    const t0 = performance.now();
    const stage = runBadgeStage(image);
    const readings = readCourseBadges(stage, scorer);
    const field = computeRibbonSupport(image, { widthsSrc: [16, 24, 36, 48] });
    const cost = supportCost(field, 30, 0.25);
    const badgeLabels = new Set(stage.badges.map((b) => b.label));
    const candidates = stage.brightComponents.filter((c) => !badgeLabels.has(c.label));
    const pools = readings.map((r) =>
      scoreEndpointComponents(field, cost, r.badge.cx, r.badge.cy, candidates, {}),
    );
    const totalS = (performance.now() - t0) / 1000;

    // Digit truth (bbox-keyed against the manifest, FountainHills only).
    let truthChecked = 0;
    let truthCorrect = 0;
    const mapName = name.replace('FountainHills-lazy', 'FountainHills-lazy');
    for (const r of readings) {
      const key = `${mapName}|${r.badge.bboxX},${r.badge.bboxY},${r.badge.bboxW},${r.badge.bboxH}`;
      const expect = truth.get(key);
      if (expect !== undefined) {
        truthChecked++;
        if (r.label === expect) truthCorrect++;
      }
    }
    const paired = pools.filter((p) => p.primary.length === 2).length;

    // Overlay render at field scale over the ORIGINAL imagery (box-averaged),
    // not the support field, so the annotations read against the map.
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
    const line = (x0s: number, y0s: number, x1s: number, y1s: number): void => {
      const steps = Math.ceil(Math.hypot(x1s - x0s, y1s - y0s) / field.scale);
      for (let t = 0; t <= steps; t++) {
        mark(x0s + ((x1s - x0s) * t) / steps, y0s + ((y1s - y0s) * t) / steps, 255, 90, 200, 0);
      }
    };
    pools.forEach((pool, i) => {
      const badge = readings[i].badge;
      for (const c of pool.primary) {
        line(badge.cx, badge.cy, c.value.x, c.value.y);
        mark(c.value.x, c.value.y, 255, 220, 0, 2);
      }
      mark(badge.cx, badge.cy, 255, 0, 0, 2);
    });
    writeFileSync(join(outDir, `${name}-overlay.png`), PNG.sync.write(png));

    const labelsRead = readings
      .map((r) => r.label || '·')
      .join(',');
    lines.push(
      `| ${name} | ${image.width}x${image.height} | ${stage.badgeCount} | ${labelsRead} | ` +
        `${truthChecked ? `${truthCorrect}/${truthChecked}` : '—'} | ${totalS.toFixed(2)} | ` +
        `${paired}/${readings.length} |`,
    );
    console.log(
      `${name}: badges=${stage.badgeCount} truth=${truthChecked ? `${truthCorrect}/${truthChecked}` : '-'} ` +
        `total=${totalS.toFixed(2)}s paired=${paired}/${readings.length}`,
    );
  }

  if (reportPath) {
    writeFileSync(reportPath, lines.join('\n'));
    console.log(`report -> ${reportPath}`);
  }
}

main();
