// Learn the LOCAL ALPHA of the hole-path ribbon overlay from the strongest
// tee→badge segments.
//
// Render model (Linear doc "Working Model — How UDisc Seems to Draw a Course
// Map"): the corridor is a semi-transparent constant-color overlay
// alpha-composited over the satellite basemap:
//     p_inside = (1−α)·basemap + α·C
// The tee→badge segment of a confidently-assigned hole is guaranteed ribbon
// interior (validated invariants: tee→badge is straight, on-corridor, before
// any bend; ray error ≤1.4°). Sampling p_in on the segment and p_out at a
// perpendicular offset just outside the corridor (basemap is locally
// continuous across the edge) gives pairs obeying
//     p_in ≈ (1−α)·p_out + α·C
// so a robust per-channel linear fit of p_in against p_out yields slope
// (1−α) and intercept α·C — i.e. α and the overlay color C, measured, not
// guessed. Reported per hole (local), per course, and pooled; each fit
// ships with prediction RMS so a bad fit is visible.
//
// Usage: npx tsx scripts/nuthing/learn-local-alpha.ts CACHE_DIR

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';
import { decodeRgbaBin } from './decode';

const COURSES: Record<string, string> = {
  'DashsTrack-full': 'DashsTrack',
  'HeritagePark-full': 'Heritage',
  'Lenard-full': 'Lenard',
  'TowneLake-full': 'TowneLake',
};
const ANNOT_ROOT = '/workspace/chainspot-corpus/dev/Annotated';
const GLYPH_MARGIN = 16; // skip samples near tee/badge glyphs
const OUT_MARGIN = 12; // outside sample sits halfWidth + margin off-axis
const TOP_HOLES = 6;

interface Sample {
  pin: [number, number, number];
  pout: [number, number, number];
}

/** Robust per-channel linear fit p_in = s*p_out + t with residual trimming. */
function fitChannel(samples: Sample[], ch: number): { s: number; t: number; rms: number; n: number } {
  let keep = samples;
  let s = 0;
  let t = 0;
  for (let round = 0; round < 3; round++) {
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    const n = keep.length;
    for (const k of keep) {
      const x = k.pout[ch];
      const y = k.pin[ch];
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
    }
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-9) break;
    s = (n * sxy - sx * sy) / denom;
    t = (sy - s * sx) / n;
    if (round < 2) {
      // Trim the worst 30% (occlusions, trees, walking paths crossing).
      const resid = keep.map((k) => Math.abs(k.pin[ch] - (s * k.pout[ch] + t)));
      const cut = [...resid].sort((a, b) => a - b)[Math.floor(resid.length * 0.7)];
      keep = keep.filter((_, i) => resid[i] <= cut);
    }
  }
  let se = 0;
  for (const k of keep) {
    const e = k.pin[ch] - (s * k.pout[ch] + t);
    se += e * e;
  }
  return { s, t, rms: Math.sqrt(se / Math.max(1, keep.length)), n: keep.length };
}

function main(): void {
  const [cacheDir] = process.argv.slice(2);
  if (!cacheDir) {
    console.error('Usage: tsx scripts/nuthing/learn-local-alpha.ts CACHE_DIR');
    process.exit(1);
  }

  const pooled: Sample[] = [];
  const courseAlphas: number[] = [];
  for (const nm of Object.keys(COURSES)) {
    const cache = JSON.parse(readFileSync(`${cacheDir}/${nm}.json`, 'utf8')) as {
      endpoints: { tees: { x: number; y: number }[]; baskets: { x: number; y: number }[] };
      badges: { label: string; cx: number; cy: number }[];
    };
    const assignments = JSON.parse(
      readFileSync(`${cacheDir}/${nm}-assignments.json`, 'utf8'),
    ) as {
      holes: {
        hole: number;
        teeId: string;
        pairScore: number;
        devTruthVerdict: string;
      }[];
    };
    const annot = JSON.parse(
      readFileSync(
        `${ANNOT_ROOT}/${COURSES[nm]}/` +
          readdirSync(`${ANNOT_ROOT}/${COURSES[nm]}`).find((f) => f.endsWith('.annotation.json')),
        'utf8',
      ),
    ) as { holes: { number: number; corridorWidthPx?: number }[] };
    const widthByHole = new Map(annot.holes.map((h) => [h.number, h.corridorWidthPx ?? 44]));

    const fullImage = decodeRgbaBin(`/workspace/nuthing-work/traces-py/${nm}.rgba.bin`);
    const image = cropRows(fullImage, detectMapViewport(fullImage));
    const px = (x: number, y: number): [number, number, number] | null => {
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || xi >= image.width || yi < 0 || yi >= image.height) return null;
      const p = (yi * image.width + xi) * 4;
      return [image.data[p], image.data[p + 1], image.data[p + 2]];
    };

    // Strongest tee→badge segments: correctly-assigned holes by pair score.
    const strongest = assignments.holes
      .filter((h) => h.devTruthVerdict === 'correct')
      .sort((a, b) => b.pairScore - a.pairScore)
      .slice(0, TOP_HOLES);

    const courseSamples: Sample[] = [];
    const perHole: string[] = [];
    for (const h of strongest) {
      const tee = cache.endpoints.tees[Number(h.teeId.slice(1))];
      const badge = cache.badges.find((b) => Number(b.label) === h.hole);
      if (!tee || !badge) continue;
      const dx = badge.cx - tee.x;
      const dy = badge.cy - tee.y;
      const len = Math.hypot(dx, dy);
      if (len < 2 * GLYPH_MARGIN + 20) continue;
      const ux = dx / len;
      const uy = dy / len;
      const nx = -uy;
      const ny = ux;
      const half = (widthByHole.get(h.hole) ?? 44) / 2;
      const holeSamples: Sample[] = [];
      for (let a = GLYPH_MARGIN; a <= len - GLYPH_MARGIN; a += 1) {
        const cx = tee.x + ux * a;
        const cy = tee.y + uy * a;
        // Edge-straddling pairs on the SAME side: basemap is only reliably
        // continuous ACROSS the corridor edge, not from centerline to 30px
        // out (corridors follow mown fairways — the ground itself changes).
        // Inside sits half−6 (clear of the ~2-3px edge stroke), outside
        // half+8.
        for (const side of [1, -1]) {
          const pin = px(cx + nx * side * (half - 6), cy + ny * side * (half - 6));
          const pout = px(cx + nx * side * (half + 8), cy + ny * side * (half + 8));
          if (!pin || !pout) continue;
          holeSamples.push({ pin, pout });
        }
      }
      courseSamples.push(...holeSamples);
      const fits = [0, 1, 2].map((ch) => fitChannel(holeSamples, ch));
      const alphas = fits.map((f) => 1 - f.s);
      const alpha = alphas.reduce((a, b) => a + b, 0) / 3;
      const color = fits.map((f) => f.t / Math.max(1e-6, 1 - f.s));
      perHole.push(
        `  h${h.hole}: n=${holeSamples.length} α=[${alphas.map((a) => a.toFixed(3)).join(',')}] ` +
          `C=[${color.map((c) => c.toFixed(0)).join(',')}] rms=[${fits.map((f) => f.rms.toFixed(1)).join(',')}]`,
      );
    }
    pooled.push(...courseSamples);
    const fits = [0, 1, 2].map((ch) => fitChannel(courseSamples, ch));
    const alphas = fits.map((f) => 1 - f.s);
    const alpha = alphas.reduce((a, b) => a + b, 0) / 3;
    courseAlphas.push(alpha);
    const color = fits.map((f) => f.t / Math.max(1e-6, 1 - f.s));
    console.log(
      `${nm}: ${strongest.length} strongest tee→badge segments, n=${courseSamples.length} paired samples\n` +
        perHole.join('\n') +
        `\n  COURSE: α=${alpha.toFixed(3)} per-channel=[${alphas.map((a) => a.toFixed(3)).join(',')}] ` +
        `C=[${color.map((c) => c.toFixed(0)).join(',')}] rms=[${fits.map((f) => f.rms.toFixed(1)).join(',')}]`,
    );

    // Visual verification strip: for the single strongest hole, render
    // [observed inside | predicted (1−α)·outside+α·C | outside] rows.
    const h0 = strongest[0];
    const tee = cache.endpoints.tees[Number(h0.teeId.slice(1))];
    const badge = cache.badges.find((b) => Number(b.label) === h0.hole)!;
    const dx = badge.cx - tee.x;
    const dy = badge.cy - tee.y;
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    const nx = -ux * 0 - uy;
    const ny = ux;
    const half = (widthByHole.get(h0.hole) ?? 44) / 2;
    const W = Math.floor(len - 2 * GLYPH_MARGIN);
    const strip = new PNG({ width: W, height: 36 });
    for (let a = 0; a < W; a++) {
      const cx = tee.x + ux * (a + GLYPH_MARGIN);
      const cy = tee.y + uy * (a + GLYPH_MARGIN);
      const pin = px(cx, cy) ?? [0, 0, 0];
      const pout = px(cx + nx * (half + OUT_MARGIN), cy + ny * (half + OUT_MARGIN)) ?? [0, 0, 0];
      const pred = [0, 1, 2].map((ch) => (1 - alphas[ch]) * pout[ch] + alphas[ch] * color[ch]);
      for (let row = 0; row < 36; row++) {
        const src = row < 12 ? pin : row < 24 ? pred : pout;
        const q = (row * W + a) * 4;
        strip.data[q] = src[0];
        strip.data[q + 1] = src[1];
        strip.data[q + 2] = src[2];
        strip.data[q + 3] = 255;
      }
    }
    writeFileSync(`${cacheDir}/${nm}-alpha-strip.png`, PNG.sync.write(strip));
  }

  const fits = [0, 1, 2].map((ch) => fitChannel(pooled, ch));
  const alphas = fits.map((f) => 1 - f.s);
  const color = fits.map((f) => f.t / Math.max(1e-6, 1 - f.s));
  console.log(
    `\nPOOLED (n=${pooled.length}): α=${(alphas.reduce((a, b) => a + b, 0) / 3).toFixed(3)} ` +
      `per-channel=[${alphas.map((a) => a.toFixed(3)).join(',')}] ` +
      `C=[${color.map((c) => c.toFixed(0)).join(',')}] rms=[${fits.map((f) => f.rms.toFixed(1)).join(',')}] ` +
      `| per-course α: [${courseAlphas.map((a) => a.toFixed(3)).join(', ')}]`,
  );
}

main();
