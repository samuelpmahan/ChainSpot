// Register cross-frame dev annotations into the corpus raster frame.
//
// HeritagePark/Lenard/TowneLake annotations were drawn on vertically-cropped
// variants of the corpus screenshots (sha mismatch; ~420-530px of app chrome
// removed). Their coordinates become usable by fitting a similarity
// transform (uniform scale + translation, no rotation) from labeled
// correspondences: each hole's corridor path midpoint (annotation frame)
// must coincide with the badge whose digits read that hole number (raster
// frame; manual-visual labels). The badge-at-path-midpoint model was
// validated on the sha-matched DashsTrack annotation (14/14) and AlexClark's
// bent holes.
//
// Outputs:
// - resources/nuthing-p2/registered-annotations.json — per course: fitted
//   transform, per-hole residuals, and every tee/basket remapped into raster
//   coordinates (with inlier/outlier status), for future truth work.
// - docs/nuthing-p2/annotation-registration.md — fit quality, leave-one-out
//   label corroboration (the LOO refit removes the target hole from the fit,
//   so associating its midpoint to a badge is NOT circular for that hole),
//   and tee truth-coverage (pool partition per hole) on the newly usable
//   courses.
//
// Usage: npx tsx scripts/nuthing/register-annotations.ts RGBA_DIR

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runNuThingP1 } from '../../src/lib/nuthing/p1';
import { decodeRgbaBin } from './decode';

const CORPUS_ROOT = '/workspace/chainspot-corpus';

interface Hole {
  id?: string;
  number: number;
  tee: { xPx: number; yPx: number };
  basket: { xPx: number; yPx: number };
  corridorBends?: { xPx: number; yPx: number }[];
}

const CASES: { name: string; annotation: string }[] = [
  { name: 'HeritagePark-full', annotation: 'dev/Heritage/HeritagePark-full.annotation.json' },
  { name: 'Lenard-full', annotation: 'dev/Lenard/Lenard-full.annotation.json' },
  { name: 'TowneLake-full', annotation: 'dev/TowneLake/TowneLake-full.annotation.json' },
];

type Pt = [number, number];

function pathMidpoint(h: Hole): Pt {
  const pts: Pt[] = [
    [h.tee.xPx, h.tee.yPx],
    ...(h.corridorBends ?? []).map((p): Pt => [p.xPx, p.yPx]),
    [h.basket.xPx, h.basket.yPx],
  ];
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    seg.push(L);
    total += L;
  }
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    if (acc + seg[i] >= total / 2 && seg[i] > 0) {
      const f = (total / 2 - acc) / seg[i];
      return [
        pts[i][0] + f * (pts[i + 1][0] - pts[i][0]),
        pts[i][1] + f * (pts[i + 1][1] - pts[i][1]),
      ];
    }
    acc += seg[i];
  }
  return pts[pts.length - 1];
}

interface Fit {
  s: number;
  tx: number;
  ty: number;
}

function fitSimilarity(A: Pt[], B: Pt[]): Fit {
  const n = A.length;
  let amx = 0;
  let amy = 0;
  let bmx = 0;
  let bmy = 0;
  for (let i = 0; i < n; i++) {
    amx += A[i][0];
    amy += A[i][1];
    bmx += B[i][0];
    bmy += B[i][1];
  }
  amx /= n;
  amy /= n;
  bmx /= n;
  bmy /= n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const ax = A[i][0] - amx;
    const ay = A[i][1] - amy;
    num += ax * (B[i][0] - bmx) + ay * (B[i][1] - bmy);
    den += ax * ax + ay * ay;
  }
  const s = num / den;
  return { s, tx: bmx - s * amx, ty: bmy - s * amy };
}

function apply(f: Fit, p: Pt): Pt {
  return [f.s * p[0] + f.tx, f.s * p[1] + f.ty];
}

function main(): void {
  const [rgbaDir] = process.argv.slice(2);
  if (!rgbaDir) {
    console.error('Usage: tsx scripts/nuthing/register-annotations.ts RGBA_DIR');
    process.exit(1);
  }
  const manual = (
    JSON.parse(readFileSync('resources/nuthing-p2/manual-badge-labels.json', 'utf8')) as {
      labels: Record<string, string>;
    }
  ).labels;

  const out: Record<string, unknown> = {};
  const md: string[] = [];
  md.push('# Annotation registration into the corpus raster frame');
  md.push('');
  md.push(
    'Heritage/Lenard/TowneLake annotations were drawn on vertically-cropped ' +
      'variants of the corpus screenshots. Similarity transforms (uniform ' +
      'scale + translation) fitted from labeled correspondences — hole path ' +
      'midpoint (annotation frame) ↔ badge center whose digits read that ' +
      'hole number (raster frame) — with iterative outlier trimming. ' +
      'Label corroboration uses leave-one-out refits so the target hole ' +
      'never influences the transform that tests it.',
  );

  for (const spec of CASES) {
    const ann = JSON.parse(readFileSync(join(CORPUS_ROOT, spec.annotation), 'utf8')) as {
      holes: Hole[];
    };
    const image = decodeRgbaBin(join(rgbaDir, `${spec.name}.rgba.bin`));
    const result = runNuThingP1(image);
    const badgeByNumber = new Map<number, { cx: number; cy: number; label: number }>();
    const badgeCenters: { cx: number; cy: number; read: string; label: number }[] = [];
    for (const b of result.badges) {
      const read = manual[`${spec.name}#badge${b.label}`];
      if (read && !read.startsWith('NON_DIGIT')) {
        badgeByNumber.set(Number(read), { cx: b.cx, cy: b.cy, label: b.label });
        badgeCenters.push({ cx: b.cx, cy: b.cy, read, label: b.label });
      }
    }
    const holes = new Map(ann.holes.map((h) => [h.number, h]));
    const common = [...badgeByNumber.keys()].filter((n) => holes.has(n)).sort((a, b) => a - b);
    const A = common.map((n) => pathMidpoint(holes.get(n) as Hole));
    const B = common.map((n) => {
      const b = badgeByNumber.get(n) as { cx: number; cy: number };
      return [b.cx, b.cy] as Pt;
    });

    // Iteratively trimmed fit.
    let keep = common.map(() => true);
    let fit = fitSimilarity(A, B);
    for (let iter = 0; iter < 3; iter++) {
      const idx = common.map((_, i) => i).filter((i) => keep[i]);
      fit = fitSimilarity(
        idx.map((i) => A[i]),
        idx.map((i) => B[i]),
      );
      const res = A.map((a, i) => {
        const p = apply(fit, a);
        return Math.hypot(p[0] - B[i][0], p[1] - B[i][1]);
      });
      const inRes = res.filter((_, i) => keep[i]).sort((a, b) => a - b);
      const med = inRes[inRes.length >> 1];
      keep = res.map((r) => r <= Math.max(3 * med, 25));
    }
    const residuals = A.map((a, i) => {
      const p = apply(fit, a);
      return Math.hypot(p[0] - B[i][0], p[1] - B[i][1]);
    });

    // Leave-one-out label corroboration.
    const corroboration: {
      hole: number;
      badgeLabel: number;
      manualRead: string;
      looDistance: number;
      looMargin: number;
      corroborated: boolean;
    }[] = [];
    for (let j = 0; j < common.length; j++) {
      if (!keep[j]) continue;
      const idx = common.map((_, i) => i).filter((i) => keep[i] && i !== j);
      if (idx.length < 3) continue;
      const looFit = fitSimilarity(
        idx.map((i) => A[i]),
        idx.map((i) => B[i]),
      );
      const p = apply(looFit, A[j]);
      const ds = badgeCenters
        .map((b) => ({ b, d: Math.hypot(b.cx - p[0], b.cy - p[1]) }))
        .sort((x, y) => x.d - y.d);
      const nearest = ds[0];
      const margin = ds.length > 1 ? ds[1].d - nearest.d : Infinity;
      corroboration.push({
        hole: common[j],
        badgeLabel: nearest.b.label,
        manualRead: nearest.b.read,
        looDistance: nearest.d,
        looMargin: margin,
        corroborated: Number(nearest.b.read) === common[j] && nearest.d <= 40 && margin >= 40,
      });
    }

    // Tee truth coverage against the pool using the fitted transform.
    const ranked = result.teeRanked;
    const coverage: { hole: number; partition: string; rank?: number; score?: number }[] = [];
    for (const h of ann.holes) {
      const tee = apply(fit, [h.tee.xPx, h.tee.yPx]);
      let best: { rank: number; score: number } | null = null;
      for (let i = 0; i < ranked.length; i++) {
        const c = ranked[i].component;
        if (
          tee[0] >= c.bboxX - 3 &&
          tee[0] <= c.bboxX + c.bboxW + 3 &&
          tee[1] >= c.bboxY - 3 &&
          tee[1] <= c.bboxY + c.bboxH + 3
        ) {
          best = { rank: i + 1, score: ranked[i].score };
          break; // ranked order: first hit is best-ranked
        }
      }
      if (!best) {
        coverage.push({ hole: h.number, partition: 'ABSENT' });
      } else {
        const partition =
          best.rank <= result.badgeCount
            ? 'PRIMARY'
            : best.score >= 0.4
              ? 'SECONDARY'
              : 'CULLED';
        coverage.push({ hole: h.number, partition, rank: best.rank, score: best.score });
      }
    }

    out[spec.name] = {
      annotation: spec.annotation,
      transform: fit,
      correspondences: common.map((n, i) => ({
        hole: n,
        residualPx: residuals[i],
        inlier: keep[i],
      })),
      corroboration,
      registeredHoles: ann.holes.map((h) => ({
        number: h.number,
        tee: apply(fit, [h.tee.xPx, h.tee.yPx]),
        basket: apply(fit, [h.basket.xPx, h.basket.yPx]),
        corridorBends: (h.corridorBends ?? []).map((p) => apply(fit, [p.xPx, p.yPx])),
      })),
      teeCoverage: coverage,
    };

    const inl = keep.filter(Boolean).length;
    const inRes = residuals.filter((_, i) => keep[i]);
    md.push('');
    md.push(`## ${spec.name}`);
    md.push('');
    md.push(
      `Transform: scale ${fit.s.toFixed(4)}, t=(${fit.tx.toFixed(1)}, ${fit.ty.toFixed(1)}); ` +
        `${inl}/${common.length} inlier correspondences, residual median ` +
        `${inRes.sort((a, b) => a - b)[inRes.length >> 1].toFixed(1)}px, max ` +
        `${Math.max(...inRes).toFixed(1)}px. Outlier holes: ` +
        `${common.filter((_, i) => !keep[i]).join(', ') || 'none'}.`,
    );
    const good = corroboration.filter((c) => c.corroborated);
    md.push('');
    md.push(
      `Leave-one-out label corroboration: ${good.length}/${corroboration.length} holes ` +
        `associate (d<=40px, margin>=40px) to the badge whose manual read equals the ` +
        `hole number. ${corroboration
          .filter((c) => !c.corroborated)
          .map((c) => `h${c.hole}: d=${c.looDistance.toFixed(0)} m=${c.looMargin.toFixed(0)}`)
          .join('; ') || ''}`,
    );
    md.push('');
    md.push('Tee truth coverage (registered coordinates vs candidate pool):');
    const counts: Record<string, number> = {};
    for (const c of coverage) counts[c.partition] = (counts[c.partition] ?? 0) + 1;
    md.push(
      `- ${Object.entries(counts)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ')} of ${coverage.length} holes`,
    );
    for (const c of coverage) {
      if (c.partition !== 'PRIMARY') {
        md.push(
          `- hole ${c.hole}: ${c.partition}` +
            (c.rank !== undefined ? ` (rank ${c.rank}, score ${c.score?.toFixed(3)})` : ''),
        );
      }
    }
    console.log(
      `${spec.name}: s=${fit.s.toFixed(4)} dy=${fit.ty.toFixed(0)} inliers=${inl}/${common.length} ` +
        `corroborated=${good.length}/${corroboration.length} coverage=${JSON.stringify(counts)}`,
    );
  }

  writeFileSync(
    'resources/nuthing-p2/registered-annotations.json',
    JSON.stringify(out, null, 1),
  );
  writeFileSync('docs/nuthing-p2/annotation-registration.md', md.join('\n'));
  console.log('wrote resources/nuthing-p2/registered-annotations.json + docs/nuthing-p2/annotation-registration.md');
}

main();
