// Fit ONE corridor width per course. The corridor is a rectangle (exact
// vector UI), so its rendered width is a per-course render constant, not a
// per-hole free parameter. Measured as the full-width-at-half-maximum of
// the paint lift, sampled perpendicular to guaranteed-ribbon segments
// (strongest tee→badge legs + badge→basket on verified-straight holes,
// stopping 95px short of the basket).
//
// Usage: npx tsx scripts/nuthing/corridor-width.ts CACHE_DIR

import { readFileSync, readdirSync } from 'node:fs';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';
import { decodeRgbaBin } from './decode';

const COURSES: Record<string, string> = {
  'DashsTrack-full': 'DashsTrack', 'HeritagePark-full': 'Heritage',
  'Lenard-full': 'Lenard', 'TowneLake-full': 'TowneLake',
};
const ANNOT_ROOT = '/workspace/chainspot-corpus/dev/Annotated';

function main(): void {
  const [cacheDir] = process.argv.slice(2);
  for (const nm of Object.keys(COURSES)) {
    const cache = JSON.parse(readFileSync(`${cacheDir}/${nm}.json`, 'utf8'));
    const asg = JSON.parse(readFileSync(`${cacheDir}/${nm}-assignments.json`, 'utf8'));
    const annot = JSON.parse(readFileSync(`${ANNOT_ROOT}/${COURSES[nm]}/` +
      readdirSync(`${ANNOT_ROOT}/${COURSES[nm]}`).find((f) => f.endsWith('.annotation.json')), 'utf8'));
    const straight = new Set(
      annot.holes.filter((h: { corridorBends?: unknown[] }) => !(h.corridorBends?.length)).map((h: { number: number }) => h.number),
    );
    const annWidths = annot.holes.map((h: { corridorWidthPx?: number }) => h.corridorWidthPx ?? 0).filter((w: number) => w > 0);
    const fullImage = decodeRgbaBin(`/workspace/nuthing-work/traces-py/${nm}.rgba.bin`);
    const image = cropRows(fullImage, detectMapViewport(fullImage));
    const gray = (x: number, y: number): number | null => {
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || xi >= image.width || yi < 0 || yi >= image.height) return null;
      const p = (yi * image.width + xi) * 4;
      return (image.data[p] + image.data[p + 1] + image.data[p + 2]) / 3;
    };

    // Guaranteed-ribbon segments.
    const segs: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const strongest = asg.holes.filter((h: { devTruthVerdict: string }) => h.devTruthVerdict === 'correct')
      .sort((a: { pairScore: number }, b: { pairScore: number }) => b.pairScore - a.pairScore).slice(0, 8);
    for (const h of strongest) {
      const tee = cache.endpoints.tees[Number(h.teeId.slice(1))];
      const badge = cache.badges.find((b: { label: string }) => Number(b.label) === h.hole);
      if (tee && badge) segs.push({ x0: tee.x, y0: tee.y, x1: badge.cx, y1: badge.cy });
      if (straight.has(h.hole)) {
        const bk = cache.endpoints.baskets[Number(h.basketId.slice(1))];
        if (badge && bk) {
          const len = Math.hypot(bk.x - badge.cx, bk.y - badge.cy);
          if (len > 130) {
            const f = (len - 95) / len;
            segs.push({ x0: badge.cx, y0: badge.cy, x1: badge.cx + (bk.x - badge.cx) * f, y1: badge.cy + (bk.y - badge.cy) * f });
          }
        }
      }
    }

    const widths: number[] = [];
    for (const s of segs) {
      const dx = s.x1 - s.x0, dy = s.y1 - s.y0, len = Math.hypot(dx, dy);
      if (len < 50) continue;
      const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
      for (let a = 16; a <= len - 16; a += 3) {
        const cx = s.x0 + ux * a, cy = s.y0 + uy * a;
        // profile: lift(offset) = gray(offset) − background (median of ±(38..48))
        const bgs: number[] = [];
        for (const off of [-46, -42, -38, 38, 42, 46]) {
          const g = gray(cx + nx * off, cy + ny * off);
          if (g !== null) bgs.push(g);
        }
        if (bgs.length < 4) continue;
        const bg = bgs.sort((p, q) => p - q)[Math.floor(bgs.length / 2)];
        const center = gray(cx, cy);
        if (center === null) continue;
        const peak = center - bg;
        if (peak < 20) continue; // occluded / weak spot — skip
        // FWHM: walk outward each side until lift < peak/2
        const halfAt = (dir: number): number | null => {
          for (let off = 1; off <= 36; off++) {
            const g = gray(cx + nx * dir * off, cy + ny * dir * off);
            if (g === null) return null;
            if (g - bg < peak / 2) return off - 0.5;
          }
          return null;
        };
        const hp = halfAt(1), hm = halfAt(-1);
        if (hp === null || hm === null) continue;
        const w = hp + hm;
        if (w >= 10 && w <= 60) widths.push(w);
      }
    }
    widths.sort((a, b) => a - b);
    const q = (p: number): number => widths[Math.floor(p * (widths.length - 1))] ?? 0;
    const annSorted = [...annWidths].sort((a: number, b: number) => a - b);
    console.log(
      `${nm}: n=${widths.length} W(FWHM) p25=${q(0.25).toFixed(1)} median=${q(0.5).toFixed(1)} p75=${q(0.75).toFixed(1)} ` +
        `IQR=${(q(0.75) - q(0.25)).toFixed(1)} | annotated corridorWidthPx median=${annSorted[Math.floor(annSorted.length / 2)]} ` +
        `range=[${annSorted[0]},${annSorted[annSorted.length - 1]}]`,
    );
  }
}

main();
