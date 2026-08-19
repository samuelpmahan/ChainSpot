// Render-identity endpoint detector evaluation against all dev truth.
//
// Baskets: fixed-sprite matched filter (occlusion-tolerant). Tees:
// enclosed-hole (hollow rect ring) detection with diamond separation.
// Reports per-course recall vs truth, candidate/false-positive counts and
// timing, and writes annotated overlays (standing rule: every numbers
// report ships with an image): red box = sprite match, green dot = tee-rect,
// cyan dot = diamond marker, magenta cross = truth, orange ring = missed
// truth.
//
// Usage: npx tsx scripts/nuthing/endpoint-eval.ts OUT_DIR

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { PNG } from 'pngjs';
import { runBadgeStage } from '../../src/lib/nuthing/badgeStage';
import {
  prepareSpriteTemplate,
  matchBasketSprites,
  detectTeeRings,
  collectTeePoints,
} from '../../src/lib/nuthing/endpoints';
import type { SpriteTemplate } from '../../src/lib/nuthing/endpoints';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';
import { decodeRgbaBin } from './decode';

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
    console.error('Usage: tsx scripts/nuthing/endpoint-eval.ts OUT_DIR');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const template = prepareSpriteTemplate(
    JSON.parse(
      readFileSync('resources/nuthing-p2/endpoints/basket-sprite.json', 'utf8'),
    ) as SpriteTemplate,
  );
  const truthAll = loadTruth();

  let teeHitAll = 0;
  let teeTotAll = 0;
  let bkHitAll = 0;
  let bkTotAll = 0;
  for (const nm of Object.keys(truthAll)) {
    const fullImage = decodeRgbaBin(`/workspace/nuthing-work/traces-py/${nm}.rgba.bin`);
    const viewport = detectMapViewport(fullImage);
    const image = cropRows(fullImage, viewport);
    const stage = runBadgeStage(image);
    const t0 = performance.now();
    const sprites = matchBasketSprites(stage.brightMask, template);
    const t1 = performance.now();
    const rings = detectTeeRings(stage.brightMask);
    const t2 = performance.now();
    // Exclude rings inside badge boxes (digit counters 0/4/6/8/9 have holes).
    const insideBadge = (x: number, y: number): boolean =>
      stage.badges.some(
        (b) =>
          x >= b.bboxX - 3 && x <= b.bboxX + b.bboxW + 3 &&
          y >= b.bboxY - 3 && y <= b.bboxY + b.bboxH + 3,
      );
    const badgeLabels = new Set(stage.badges.map((b) => b.label));
    const teeComponents = stage.brightComponents.filter(
      (c) => !badgeLabels.has(c.label) && !insideBadge(c.cx, c.cy),
    );
    const tees = collectTeePoints(
      rings.filter((r) => !insideBadge(r.cx, r.cy)),
      teeComponents,
      sprites,
    );
    const diamonds = rings.filter((r) => r.kind === 'diamond' && !insideBadge(r.cx, r.cy));

    const truth = truthAll[nm];
    const teeMisses: string[] = [];
    const bkMisses: string[] = [];
    let teeHit = 0;
    let bkHit = 0;
    for (const h of truth) {
      const tx = h.tee[0];
      const ty = h.tee[1] - viewport.top;
      const tOk = tees.some((r) => Math.hypot(r.cx - tx, r.cy - ty) <= 18);
      if (tOk) teeHit++;
      else {
        const near = rings
          .map((r) => ({ r, d: Math.hypot(r.cx - tx, r.cy - ty) }))
          .sort((a, b) => a.d - b.d)[0];
        teeMisses.push(
          `h${h.number}` +
            (near && near.d <= 20 ? `(near ${near.r.kind} e=${near.r.elongation.toFixed(2)} d=${near.d.toFixed(0)})` : ''),
        );
      }
      const bx = h.basket[0];
      const by = h.basket[1] - viewport.top;
      // Truth point is the pole tip.
      const bOk = sprites.some((s) => Math.hypot(s.tipX - bx, s.tipY - by) <= 16);
      if (bOk) bkHit++;
      else bkMisses.push(`h${h.number}`);
    }
    teeHitAll += teeHit;
    teeTotAll += truth.length;
    bkHitAll += bkHit;
    bkTotAll += truth.length;

    console.log(
      `${nm}: baskets ${bkHit}/${truth.length} (${sprites.length} matches, ${(t1 - t0).toFixed(0)}ms)` +
        (bkMisses.length ? ` miss: ${bkMisses.join(' ')}` : '') +
        ` | tees ${teeHit}/${truth.length} (${tees.length} cands: ${tees.filter((t) => t.tier === 'ring').length} ring + ${tees.filter((t) => t.tier === 'component').length} comp, ${diamonds.length} diamonds, ${(t2 - t1).toFixed(0)}ms)` +
        (teeMisses.length ? ` miss: ${teeMisses.join(' ')}` : ''),
    );

    // Overlay at half resolution.
    const S = 2;
    const ow = Math.floor(image.width / S);
    const oh = Math.floor(image.height / S);
    const png = new PNG({ width: ow, height: oh });
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        const p = (y * S * image.width + x * S) * 4;
        const q = (y * ow + x) * 4;
        png.data[q] = image.data[p];
        png.data[q + 1] = image.data[p + 1];
        png.data[q + 2] = image.data[p + 2];
        png.data[q + 3] = 255;
      }
    }
    const dot = (x: number, y: number, r: number, g: number, b: number, rad = 2): void => {
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const xx = Math.round(x / S) + dx;
          const yy = Math.round(y / S) + dy;
          if (xx < 0 || xx >= ow || yy < 0 || yy >= oh) continue;
          const q = (yy * ow + xx) * 4;
          png.data[q] = r;
          png.data[q + 1] = g;
          png.data[q + 2] = b;
        }
      }
    };
    const box = (x0: number, y0: number, w: number, h: number, r: number, g: number, b: number): void => {
      for (let x = x0; x <= x0 + w; x++) {
        dot(x, y0, r, g, b, 0);
        dot(x, y0 + h, r, g, b, 0);
      }
      for (let y = y0; y <= y0 + h; y++) {
        dot(x0, y, r, g, b, 0);
        dot(x0 + w, y, r, g, b, 0);
      }
    };
    for (const s of sprites) box(s.x, s.y, 42, 66, 255, 40, 40);
    for (const t of tees) dot(t.cx, t.cy, 0, 230, 0, 2);
    for (const d of diamonds) dot(d.cx, d.cy, 0, 210, 230, 2);
    for (const h of truth) {
      dot(h.tee[0], h.tee[1] - viewport.top, 255, 0, 255, 1);
      dot(h.basket[0], h.basket[1] - viewport.top, 255, 0, 255, 1);
    }
    writeFileSync(`${outDir}/${nm}-endpoints.png`, PNG.sync.write(png));
  }
  console.log(`TOTAL baskets ${bkHitAll}/${bkTotAll} tees ${teeHitAll}/${teeTotAll}`);
}

main();
