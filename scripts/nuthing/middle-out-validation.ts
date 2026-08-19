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

    // Overlay render at field scale.
    const png = new PNG({ width: field.width, height: field.height });
    for (let i = 0; i < field.support.length; i++) {
      const v = Math.round(field.support[i] * 255);
      png.data[i * 4] = v;
      png.data[i * 4 + 1] = v;
      png.data[i * 4 + 2] = v;
      png.data[i * 4 + 3] = 255;
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
    pools.forEach((pool, i) => {
      for (const c of pool.primary) mark(c.value.x, c.value.y, 255, 220, 0, 2);
      mark(readings[i].badge.cx, readings[i].badge.cy, 255, 0, 0, 2);
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
