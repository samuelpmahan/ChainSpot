// Straight-hole badge-ray invariant test + distractor attribution.
// See docs/nuthing-p2/distractor-attribution.md (documented BEFORE this was
// run). Pure replay: reads only the cached pair matrix (JSON + planes) and
// corpus bend truth; nothing is re-detected or re-routed. Imagery is decoded
// only to draw overlays.
//
// Usage: npx tsx scripts/nuthing/straight-hole-test.ts CACHE_DIR

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
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

interface CacheLeg {
  endpointId: string;
  path: number[];
  reachable: boolean;
}
interface CacheBadge {
  label: string;
  cx: number;
  cy: number;
  legs: CacheLeg[];
}
interface CacheCourse {
  course: string;
  viewport: { top: number };
  field: { width: number; height: number; scale: number };
  endpoints: {
    tees: { id: string; x: number; y: number; tier: string }[];
    baskets: { id: string; x: number; y: number; score?: number }[];
  };
  badges: CacheBadge[];
  judgments: { hole: number; trueTee: number; trueBasket: number; rankPrimary: number }[];
}

type Attribution = 'basket-zone' | 'tee-glyph' | 'badge' | 'unknown/walking-path';

function main(): void {
  const [cacheDir] = process.argv.slice(2);
  if (!cacheDir) {
    console.error('Usage: tsx scripts/nuthing/straight-hole-test.ts CACHE_DIR');
    process.exit(1);
  }

  const histogram: Record<Attribution, number> = {
    'basket-zone': 0,
    'tee-glyph': 0,
    badge: 0,
    'unknown/walking-path': 0,
  };
  const rayAngles: number[] = [];

  for (const nm of Object.keys(COURSES)) {
    const cache = JSON.parse(readFileSync(`${cacheDir}/${nm}.json`, 'utf8')) as CacheCourse;
    const { scale } = cache.field;
    const annot = JSON.parse(
      readFileSync(
        `${ANNOT_ROOT}/${COURSES[nm]}/` +
          readdirSync(`${ANNOT_ROOT}/${COURSES[nm]}`).find((f) => f.endsWith('.annotation.json')),
        'utf8',
      ),
    ) as { holes: { number: number; corridorBends: unknown[]; corridorWidthPx?: number }[] };
    const bendByHole = new Map(annot.holes.map((h) => [h.number, h.corridorBends?.length ?? 0]));
    const widthByHole = new Map(annot.holes.map((h) => [h.number, h.corridorWidthPx ?? 44]));

    // Attribution of a source-px point against cached geometry. `ownBasket`,
    // `ownTee`, `ownBadge` are the hole's own elements (never distractors).
    const classify = (
      x: number,
      y: number,
      ownBasketId: string,
      ownTeeId: string,
      ownLabel: string,
    ): Attribution => {
      for (const b of cache.endpoints.baskets) {
        if (b.id === ownBasketId) continue;
        const d = Math.hypot(x - b.x, y - b.y);
        if (d <= 35 || Math.abs(d - 44) <= 8 || Math.abs(d - 84) <= 12) return 'basket-zone';
      }
      for (const t of cache.endpoints.tees) {
        if (t.id === ownTeeId) continue;
        if (Math.hypot(x - t.x, y - t.y) <= 15) return 'tee-glyph';
      }
      for (const bd of cache.badges) {
        if (bd.label === ownLabel) continue;
        if (Math.hypot(x - bd.cx, y - bd.cy) <= 20) return 'badge';
      }
      return 'unknown/walking-path';
    };

    interface Row {
      hole: number;
      rayDeg: number;
      maxDevPx: number;
      peakFrac: number;
      offChordPx: number;
      attribution: Attribution | '-';
      pathSrc: [number, number][];
      tee: [number, number];
      basket: [number, number];
    }
    const rows: Row[] = [];
    for (const j of cache.judgments) {
      if (j.rankPrimary < 1) continue;
      if ((bendByHole.get(j.hole) ?? 1) !== 0) continue; // straight holes only
      const badge = cache.badges.find((b) => Number(b.label) === j.hole);
      const tee = cache.endpoints.tees[j.trueTee];
      const basket = cache.endpoints.baskets[j.trueBasket];
      if (!badge || !tee || !basket) continue;

      const ang = (ax: number, ay: number, bx: number, by: number): number =>
        Math.atan2(by - ay, bx - ax);
      let rayDeg =
        Math.abs(ang(tee.x, tee.y, badge.cx, badge.cy) - ang(tee.x, tee.y, basket.x, basket.y)) *
        (180 / Math.PI);
      if (rayDeg > 180) rayDeg = 360 - rayDeg;

      // True-pair route: reverse(badge→tee) + badge→basket[1:], in src px.
      const tl = badge.legs.find((l) => l.endpointId === tee.id);
      const bl = badge.legs.find((l) => l.endpointId === basket.id);
      if (!tl?.reachable || !bl?.reachable) continue;
      const pathSrc: [number, number][] = [];
      for (let i = tl.path.length - 2; i >= 0; i -= 2)
        pathSrc.push([tl.path[i] * scale + scale / 2, tl.path[i + 1] * scale + scale / 2]);
      for (let i = 2; i < bl.path.length; i += 2)
        pathSrc.push([bl.path[i] * scale + scale / 2, bl.path[i + 1] * scale + scale / 2]);

      // Perpendicular deviation from the tee→basket chord.
      const vx = basket.x - tee.x;
      const vy = basket.y - tee.y;
      const len = Math.hypot(vx, vy);
      const halfWidth = (widthByHole.get(j.hole) ?? 44) / 2;
      let maxDev = 0;
      let peakIdx = 0;
      let offChord = 0;
      let prev: [number, number] | null = null;
      for (let i = 0; i < pathSrc.length; i++) {
        const [px, py] = pathSrc[i];
        const t = ((px - tee.x) * vx + (py - tee.y) * vy) / (len * len);
        const qx = tee.x + t * vx;
        const qy = tee.y + t * vy;
        const dev = Math.hypot(px - qx, py - qy);
        if (dev > maxDev) {
          maxDev = dev;
          peakIdx = i;
        }
        if (prev && dev > halfWidth) offChord += Math.hypot(px - prev[0], py - prev[1]);
        prev = [px, py];
      }
      const attribution =
        maxDev > halfWidth
          ? classify(pathSrc[peakIdx][0], pathSrc[peakIdx][1], basket.id, tee.id, badge.label)
          : ('-' as const);
      if (attribution !== '-') histogram[attribution]++;
      rayAngles.push(rayDeg);
      rows.push({
        hole: j.hole,
        rayDeg,
        maxDevPx: maxDev,
        peakFrac: peakIdx / Math.max(1, pathSrc.length - 1),
        offChordPx: offChord,
        attribution,
        pathSrc,
        tee: [tee.x, tee.y],
        basket: [basket.x, basket.y],
      });
    }

    rows.sort((a, b) => a.hole - b.hole);
    const bad = rows.filter((r) => r.attribution !== '-');
    console.log(
      `${nm}: ${rows.length} straight holes | ray angle max=${Math.max(0, ...rows.map((r) => r.rayDeg)).toFixed(1)}° ` +
        `| chord-clean ${rows.length - bad.length}/${rows.length}` +
        (bad.length
          ? ` | violations: ${bad
              .map(
                (r) =>
                  `h${r.hole}(dev=${r.maxDevPx.toFixed(0)}px@${r.peakFrac.toFixed(2)} ${r.attribution})`,
              )
              .join(' ')}`
          : ''),
    );
    for (const r of rows) {
      console.log(
        `  h${r.hole}: ray=${r.rayDeg.toFixed(1)}° maxDev=${r.maxDevPx.toFixed(0)}px ` +
          `peak@${r.peakFrac.toFixed(2)} offChord=${r.offChordPx.toFixed(0)}px ${r.attribution}`,
      );
    }

    // Overlay: chord (blue) + actual route (green when chord-clean, orange
    // when off-chord) for every straight hole.
    const fullImage = decodeRgbaBin(`/workspace/nuthing-work/traces-py/${nm}.rgba.bin`);
    const image = cropRows(fullImage, detectMapViewport(fullImage));
    const w = cache.field.width;
    const h = cache.field.height;
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
    for (const r of rows) {
      const steps = Math.ceil(Math.hypot(r.basket[0] - r.tee[0], r.basket[1] - r.tee[1]) / scale);
      for (let t = 0; t <= steps; t++)
        put(
          r.tee[0] + ((r.basket[0] - r.tee[0]) * t) / steps,
          r.tee[1] + ((r.basket[1] - r.tee[1]) * t) / steps,
          60,
          120,
          255,
        );
      const clean = r.attribution === '-';
      for (const [px, py] of r.pathSrc) put(px, py, clean ? 0 : 255, clean ? 220 : 150, 0);
    }
    writeFileSync(`${cacheDir}/${nm}-straight-test.png`, PNG.sync.write(png));

    // ---- Phase 2: classify the current wrong assignments ------------------
    // Reads the emitted assignments product; for each hole whose verdict is
    // 'wrong', attributes BOTH routes with the same classifier: what the
    // chosen (wrong) route rides, and what the true route rides. Renders a
    // full-course overlay of just those holes (true green, chosen red).
    let assignments: {
      holes: { hole: number; teeId: string; basketId: string; devTruthVerdict: string }[];
    } | null = null;
    try {
      assignments = JSON.parse(readFileSync(`${cacheDir}/${nm}-assignments.json`, 'utf8'));
    } catch {
      // product not emitted yet
    }
    const wrongs = assignments?.holes.filter((h) => h.devTruthVerdict === 'wrong') ?? [];
    if (wrongs.length) {
      const png2 = new PNG({ width: w, height: h });
      png.data.copy(png2.data); // reuse the straight-test canvas as base
      for (const wr of wrongs) {
        const j = cache.judgments.find((jj) => jj.hole === wr.hole);
        const badge = cache.badges.find((b) => Number(b.label) === wr.hole);
        if (!j || !badge) continue;
        const routeCells = (teeId: string, basketId: string): [number, number][] => {
          const tl = badge.legs.find((l) => l.endpointId === teeId);
          const bl = badge.legs.find((l) => l.endpointId === basketId);
          const out: [number, number][] = [];
          if (tl) {
            for (let i = tl.path.length - 2; i >= 0; i -= 2)
              out.push([tl.path[i] * scale + scale / 2, tl.path[i + 1] * scale + scale / 2]);
          }
          if (bl) {
            for (let i = 2; i < bl.path.length; i += 2)
              out.push([bl.path[i] * scale + scale / 2, bl.path[i + 1] * scale + scale / 2]);
          }
          return out;
        };
        const composition = (cells: [number, number][], ownB: string, ownT: string): string => {
          // Only OFF-CORRIDOR cells are evidence of distractor riding: a cell
          // within a corridor half-width of the route's own tee→basket chord
          // is on-hole regardless of what else is nearby.
          const tp = cache.endpoints.tees[Number(ownT.slice(1))];
          const bp = cache.endpoints.baskets[Number(ownB.slice(1))];
          if (!tp || !bp) return 'n/a';
          const vx2 = bp.x - tp.x;
          const vy2 = bp.y - tp.y;
          const len2 = Math.hypot(vx2, vy2);
          const counts: Record<Attribution, number> = {
            'basket-zone': 0,
            'tee-glyph': 0,
            badge: 0,
            'unknown/walking-path': 0,
          };
          let off = 0;
          for (const [x, y] of cells) {
            const t = ((x - tp.x) * vx2 + (y - tp.y) * vy2) / (len2 * len2);
            const qx = tp.x + t * vx2;
            const qy = tp.y + t * vy2;
            if (Math.hypot(x - qx, y - qy) <= 22 && t >= -0.05 && t <= 1.05) continue;
            off++;
            counts[classify(x, y, ownB, ownT, badge.label)]++;
          }
          if (off === 0) return 'on-corridor (0 off-chord cells)';
          const parts = (Object.keys(counts) as Attribution[])
            .filter((k) => counts[k] / off >= 0.05)
            .map((k) => `${k}=${((100 * counts[k]) / off).toFixed(0)}%`);
          return `offChordCells=${off} → ${parts.join(' ')}`;
        };
        const chosenCells = routeCells(wr.teeId, wr.basketId);
        const trueCells = routeCells(`T${j.trueTee}`, `B${j.trueBasket}`);
        const teeOwn = cache.endpoints.tees[Number(wr.teeId.slice(1))];
        const bOwn = cache.endpoints.baskets[Number(wr.basketId.slice(1))];
        console.log(
          `  WRONG h${wr.hole}: chose ${wr.teeId}/${wr.basketId}` +
            ` (teeTier=${teeOwn?.tier ?? '?'}, basketScore=${bOwn?.score?.toFixed(2) ?? '?'})` +
            ` wrongSide=${wr.teeId !== `T${j.trueTee}` ? 'tee' : ''}${wr.basketId !== `B${j.trueBasket}` ? 'basket' : ''}`,
        );
        console.log(`    chosen route: ${composition(chosenCells, wr.basketId, wr.teeId)}`);
        console.log(`    true route:   ${composition(trueCells, `B${j.trueBasket}`, `T${j.trueTee}`)}`);
        for (const [x, y] of chosenCells) put2(png2, x, y, 255, 40, 40);
        for (const [x, y] of trueCells) put2(png2, x, y, 0, 220, 0);
      }
      writeFileSync(`${cacheDir}/${nm}-wrongs.png`, PNG.sync.write(png2));
    }

    function put2(p2: PNG, sx: number, sy: number, r: number, g: number, b: number): void {
      const fx = Math.round(sx / scale);
      const fy = Math.round(sy / scale);
      if (fx < 0 || fx >= w || fy < 0 || fy >= h) return;
      const p = (fy * w + fx) * 4;
      p2.data[p] = r;
      p2.data[p + 1] = g;
      p2.data[p + 2] = b;
    }
  }

  const sorted = [...rayAngles].sort((a, b) => a - b);
  const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
  console.log(
    `\nRAY (n=${sorted.length}): med=${q(0.5).toFixed(1)}° p90=${q(0.9).toFixed(1)}° max=${q(1).toFixed(1)}°`,
  );
  console.log(`ATTRIBUTION of chord violations: ${JSON.stringify(histogram)}`);
}

main();
