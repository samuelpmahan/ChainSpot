import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { runBadgeStage } from '../../src/lib/nuthing/badgeStage';
import type { ComponentStats } from '../../src/lib/nuthing/components';
import { readCourseBadges } from '../../src/lib/nuthing/digits/readBadges';
import { predictProbs } from '../../src/lib/nuthing/digits/logistic';
import type { LogisticModel } from '../../src/lib/nuthing/digits/logistic';
import { detectTeeRings, type SpriteMatch, type SpriteTemplate, type TeeRing } from '../../src/lib/nuthing/endpoints';
import { computeRibbonSupport, scoreEndpointComponents, supportCost } from '../../src/lib/nuthing/ribbon';
import { matchBasketSpritesSmart } from '../../src/lib/nuthing/smartBasket';
import { collectMeasuredTeeCandidates } from '../../src/lib/nuthing/teeCandidates';
import type { RgbaImage } from '../../src/lib/nuthing/raster';
import { cropRows, detectMapViewport } from '../../src/lib/nuthing/viewport';
import { decodeImageFile } from '../nuthing/decode';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const corpusRoot = process.env.CHAINSPOT_CORPUS_PATH ?? resolve(repoRoot, '..', 'chainspot-corpus');
const artifactRoot = process.env.CHAINSPOT_LAB_ARTIFACTS ?? '/mnt/d/ChainSpot-LAB/artifacts';

type TeeTier = 'intact-family' | 'shard-or-component' | 'phantom-predecessor-basket';
interface TeeMeasure { ring: TeeRing; frame: ComponentStats; grayCount: number; grayFraction: number }
interface TeeCandidate {
  x: number;
  y: number;
  angle: number | null;
  tier: TeeTier;
  source: string;
  ownerHint: number | null;
}
interface BasketObservation extends SpriteMatch {
  tier: 'clean-family' | 'occlusion-recovery';
  effectiveVisibility: number;
  source: string;
}

function normalizeToken(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function collectImages(root: string, depth = 0): string[] {
  if (depth > 5 || !existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (stat.isDirectory()) out.push(...collectImages(path, depth + 1));
    else if (/\.(png|jpe?g)$/i.test(name)) out.push(path);
  }
  return out;
}
function resolveCourseInput(value: string): string {
  const literal = resolve(value);
  if (existsSync(literal)) return literal;
  const q = normalizeToken(value);
  const ranked = collectImages(corpusRoot).map((path) => {
    const n = normalizeToken(path);
    if (!n.includes(q)) return null;
    const b = normalizeToken(basename(path, extname(path)));
    let score = 0;
    if (b === q || b === `${q}full`) score += 200;
    if (b.startsWith(q)) score += 80;
    if (path.includes('validation')) score += 20;
    if (path.includes('clean')) score += 40;
    if (/full/i.test(basename(path))) score += 30;
    if (/lazy|tile|upper|lower|left|right/i.test(basename(path))) score -= 80;
    return { path, score };
  }).filter((x): x is { path: string; score: number } => x !== null)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (!ranked.length) throw new Error(`Could not resolve '${value}' under ${corpusRoot}`);
  return ranked[0].path;
}
function median(values: readonly number[]): number {
  if (!values.length) return NaN;
  const x = [...values].sort((a, b) => a - b);
  const m = x.length >> 1;
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
}
function summarize(values: readonly number[]): string {
  if (!values.length) return 'n/a';
  return `min=${Math.min(...values).toFixed(1)} p50=${median(values).toFixed(1)} max=${Math.max(...values).toFixed(1)}`;
}
function grayStats(image: RgbaImage, ring: TeeRing): { count: number; fraction: number } {
  const x0 = Math.max(0, Math.floor(ring.bboxX)); const y0 = Math.max(0, Math.floor(ring.bboxY));
  const x1 = Math.min(image.width, Math.ceil(ring.bboxX + ring.bboxW)); const y1 = Math.min(image.height, Math.ceil(ring.bboxY + ring.bboxH));
  let count = 0; let total = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = (y * image.width + x) * 4;
    const v = Math.max(image.data[p], image.data[p + 1], image.data[p + 2]);
    if (v >= 145 && v <= 175) count++;
    total++;
  }
  return { count, fraction: total ? count / total : 0 };
}
function frameForRing(ring: TeeRing, components: readonly ComponentStats[]): ComponentStats | null {
  const candidates = components.filter((c) => c.area >= 10 && c.area <= 500 && c.bboxW <= 50 && c.bboxH <= 50 && ring.cx >= c.bboxX && ring.cx <= c.bboxX + c.bboxW && ring.cy >= c.bboxY && ring.cy <= c.bboxY + c.bboxH);
  if (!candidates.length) return null;
  return candidates.slice().sort((a, b) => a.bboxW * a.bboxH - b.bboxW * b.bboxH || b.area - a.area)[0];
}
function measureTee(image: RgbaImage, ring: TeeRing, components: readonly ComponentStats[]): TeeMeasure | null {
  const frame = frameForRing(ring, components);
  if (!frame) return null;
  const gray = grayStats(image, ring);
  return { ring, frame, grayCount: gray.count, grayFraction: gray.fraction };
}
function selectTeeFamily(measures: readonly TeeMeasure[]): TeeMeasure[] {
  let best: TeeMeasure[] = []; let bestSpread = Infinity;
  for (const seed of measures) {
    const s = seed.frame;
    const family = measures.filter((m) => {
      const f = m.frame;
      return Math.abs(Math.log(Math.max(f.major, 1) / Math.max(s.major, 1))) <= Math.log(1.25) &&
        Math.abs(Math.log(Math.max(f.minor, 1) / Math.max(s.minor, 1))) <= Math.log(1.25) &&
        Math.abs(Math.log(Math.max(f.area, 1) / Math.max(s.area, 1))) <= Math.log(1.5);
    });
    const spread = family.reduce((sum, m) => sum +
      Math.abs(Math.log(Math.max(m.frame.major, 1) / Math.max(s.major, 1))) +
      Math.abs(Math.log(Math.max(m.frame.minor, 1) / Math.max(s.minor, 1))) +
      Math.abs(Math.log(Math.max(m.frame.area, 1) / Math.max(s.area, 1))), 0);
    if (family.length > best.length || (family.length === best.length && spread < bestSpread)) { best = family; bestSpread = spread; }
  }
  return best.slice().sort((a, b) => a.ring.cy - b.ring.cy || a.ring.cx - b.ring.cx);
}

/** O(n^3) Hungarian; rows <= columns. */
function hungarian(cost: readonly (readonly number[])[]): number[] {
  const n = cost.length; const m = cost[0]?.length ?? 0;
  if (!n || n > m) throw new Error(`Hungarian requires 0 < rows <= cols; got ${n}x${m}`);
  const u = new Array(n + 1).fill(0); const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0); const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity); const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = Infinity; let j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }
  const assignment = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) assignment[p[j] - 1] = j - 1;
  return assignment;
}
function rankOf(row: readonly number[], selected: number): number {
  return row.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value || a.index - b.index).findIndex((x) => x.index === selected) + 1;
}
function acuteAxisErrorRad(axis: number, ray: number): number {
  let d = Math.abs((axis - ray) % Math.PI); if (d > Math.PI / 2) d = Math.PI - d; return d;
}
function topHalfCenter(b: Pick<BasketObservation, 'x' | 'y'>): { x: number; y: number } {
  return { x: b.x + 21, y: b.y + 16.5 };
}
function asSprite(b: ReturnType<typeof matchBasketSpritesSmart>[number]): BasketObservation {
  return {
    x: b.x, y: b.y, cx: b.cx, cy: b.cy, tipX: b.tipX, tipY: b.tipY,
    onFrac: b.whiteCoverage,
    offFrac: Math.max(0, b.whiteCoverage - b.identity),
    score: b.identity,
    tier: b.tier,
    effectiveVisibility: b.effectiveVisibility,
    source: b.source,
  };
}
function componentForTee(t: TeeCandidate, index: number): ComponentStats {
  return { label: 1_000_000 + index, cx: t.x, cy: t.y, area: 160, bboxX: t.x - 12, bboxY: t.y - 9, bboxW: 24, bboxH: 18, major: 24, minor: 18, angle: t.angle ?? 0, fill: 0.45 };
}
function setPixel(png: PNG, x: number, y: number, rgb: readonly [number, number, number]): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (y * png.width + x) * 4;
  png.data[i] = rgb[0]; png.data[i + 1] = rgb[1]; png.data[i + 2] = rgb[2]; png.data[i + 3] = 255;
}
function circle(png: PNG, cx: number, cy: number, radius: number, rgb: readonly [number, number, number]): void {
  for (let a = 0; a < 360; a += 2) {
    const t = a * Math.PI / 180;
    for (let w = 0; w < 3; w++) setPixel(png, Math.round(cx + (radius + w) * Math.cos(t)), Math.round(cy + (radius + w) * Math.sin(t)), rgb);
  }
}
function line(png: PNG, ax: number, ay: number, bx: number, by: number, rgb: readonly [number, number, number]): void {
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
  for (let i = 0; i <= n; i++) { const t = i / n; setPixel(png, Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t), rgb); }
}
function writeOverlay(outDir: string, image: RgbaImage, rows: readonly { hole: number; tee: TeeCandidate; bx: number; by: number }[]): string {
  const png = new PNG({ width: image.width, height: image.height });
  Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).copy(png.data);
  for (const r of rows) {
    line(png, r.tee.x, r.tee.y, r.bx, r.by, [255, 80, 210]);
    const color: readonly [number, number, number] = r.tee.tier === 'phantom-predecessor-basket' ? [255, 70, 70] : r.tee.tier === 'shard-or-component' ? [255, 180, 40] : [50, 235, 255];
    circle(png, r.tee.x, r.tee.y, r.tee.tier === 'phantom-predecessor-basket' ? 9 : 7, color);
  }
  const path = join(outDir, 'g4-phantom-tee-badge.png');
  writeFileSync(path, PNG.sync.write(png));
  return path;
}

function main(): void {
  const inputArg = process.argv[2];
  if (!inputArg || process.argv.length > 4) throw new Error('Usage: npx tsx scripts/chainspot-lab/g4PhantomExperiment.ts <course-or-image> [outDir]');
  const input = resolveCourseInput(inputArg);
  const outDir = resolve(process.argv[3] ?? join(artifactRoot, 'phantom-g4', normalizeToken(basename(input, extname(input)))));
  mkdirSync(outDir, { recursive: true });
  const full = decodeImageFile(input); const viewport = detectMapViewport(full); const image = cropRows(full, viewport);

  const model = JSON.parse(readFileSync(join(repoRoot, 'resources/nuthing-p2/digits/models/logistic.json'), 'utf8')) as LogisticModel;
  const basketTemplate = JSON.parse(readFileSync(join(repoRoot, 'resources/nuthing-p2/endpoints/basket-sprite.json'), 'utf8')) as SpriteTemplate;

  // G1
  const badgeStage = runBadgeStage(image);
  const readings = readCourseBadges(badgeStage, { name: 'logistic', scores: (m) => predictProbs(model, m) })
    .filter((r) => /^\d+$/.test(r.label) && Number(r.label) > 0)
    .sort((a, b) => Number(a.label) - Number(b.label));
  const numBadges = badgeStage.badgeCount;
  if (readings.length !== numBadges || new Set(readings.map((r) => r.label)).size !== numBadges) throw new Error(`G1 failed: plates=${numBadges} numeric=${readings.length}`);
  console.log(`G1 PASS: badges=${numBadges}`);

  // G2: renderer-family baskets, including attributable overlap recovery.
  const baskets = matchBasketSpritesSmart(badgeStage.brightMask, badgeStage.darkMask, badgeStage.badges, basketTemplate).map(asSprite);
  if (baskets.length !== numBadges) throw new Error(`G2 failed: baskets=${baskets.length}/${numBadges}`);
  console.log(`G2 PASS: baskets=${baskets.length}; clean=${baskets.filter((b) => b.tier === 'clean-family').length}; recovered=${baskets.filter((b) => b.tier === 'occlusion-recovery').length}`);

  // G3 intact family + visible component/shard recovery.
  const ringsRaw = detectTeeRings(badgeStage.brightMask);
  const insideBadgeInterior = (x: number, y: number): boolean => badgeStage.badges.some((b) => Math.abs(x - b.cx) <= b.bboxW / 2 - 7 && Math.abs(y - b.cy) <= b.bboxH / 2 - 7);
  const rings = ringsRaw.filter((r) => !insideBadgeInterior(r.cx, r.cy));
  const ringMeasures = rings.filter((r) => r.kind === 'tee-rect').map((r) => measureTee(image, r, badgeStage.brightComponents)).filter((x): x is TeeMeasure => x !== null);
  const family = selectTeeFamily(ringMeasures);
  const familyRingSet = new Set(family.map((m) => m.ring));

  const insideBadgePoint = (x: number, y: number): boolean => badgeStage.badges.some((b) => x >= b.bboxX - 3 && x <= b.bboxX + b.bboxW + 3 && y >= b.bboxY - 3 && y <= b.bboxY + b.bboxH + 3);
  const components = badgeStage.brightComponents.filter((c) => !insideBadgePoint(c.cx, c.cy)).map((c) => ({ label: c.label, cx: c.cx, cy: c.cy, bboxX: c.bboxX, bboxY: c.bboxY, bboxW: c.bboxW, bboxH: c.bboxH, area: c.area, fill: c.fill }));
  const measured = collectMeasuredTeeCandidates(rings, components, baskets, badgeStage.brightMask, badgeStage.darkMask, badgeStage.brightLabels);

  const visible: TeeCandidate[] = family.map((m) => ({ x: m.ring.cx, y: m.ring.cy, angle: m.ring.angle, tier: 'intact-family', source: 'ring-family', ownerHint: null }));
  for (const p of measured.points) {
    if (p.tier !== 'component' || p.componentLabel === undefined) continue;
    const c = badgeStage.brightComponents.find((x) => x.label === p.componentLabel);
    if (!c) continue;
    if (visible.some((t) => Math.hypot(t.x - p.cx, t.y - p.cy) < 12)) continue;
    visible.push({ x: p.cx, y: p.cy, angle: c.angle, tier: 'shard-or-component', source: `bright-component:${p.componentLabel}`, ownerHint: null });
  }
  if (visible.length > numBadges) throw new Error(`G3 overcomplete visible tee inventory ${visible.length}/${numBadges}; do not hide it with phantom logic`);

  // Coverage-only neighborhood assignment: when there are fewer visible tees
  // than badges, assign each visible tee to one badge by pure Euclidean distance.
  // Unused badges are the missing Tn identities. This is intentionally simpler
  // than G4 and carries no ribbon/axis evidence.
  const teeToBadge = visible.map((t) => readings.map((r) => Math.hypot(t.x - r.badge.cx, t.y - r.badge.cy)));
  const visibleBadgeAssignment = visible.length ? hungarian(teeToBadge) : [];
  const usedBadges = new Set(visibleBadgeAssignment);
  const missing = readings.map((r, i) => ({ number: Number(r.label), index: i })).filter((x) => !usedBadges.has(x.index));
  for (let i = 0; i < visible.length; i++) visible[i].ownerHint = Number(readings[visibleBadgeAssignment[i]].label);

  // Provisional Bn identity for the fallback: globally match each badge to one
  // basket using ONLY basket top-half-center distance. This is not path
  // attribution and is deliberately allowed to break later.
  const basketProximity = readings.map((r) => baskets.map((b) => {
    const p = topHalfCenter(b);
    return Math.hypot(p.x - r.badge.cx, p.y - r.badge.cy);
  }));
  const basketAssignment = hungarian(basketProximity);
  const basketByHole = new Map<number, BasketObservation>();
  for (let i = 0; i < readings.length; i++) basketByHole.set(Number(readings[i].label), baskets[basketAssignment[i]]);

  const phantoms: TeeCandidate[] = [];
  for (const miss of missing) {
    if (miss.number <= 1) throw new Error('G3 cannot synthesize T1 from a predecessor basket');
    const predecessor = basketByHole.get(miss.number - 1);
    if (!predecessor) throw new Error(`G3 missing predecessor basket B${miss.number - 1} for T${miss.number}`);
    const p = topHalfCenter(predecessor);
    phantoms.push({ x: p.x, y: p.y, angle: null, tier: 'phantom-predecessor-basket', source: `provisional-B${miss.number - 1}:${predecessor.source}`, ownerHint: miss.number });
  }
  const tees = [...visible, ...phantoms];
  if (tees.length !== numBadges) throw new Error(`G3 failed: visible=${visible.length} phantom=${phantoms.length} total=${tees.length}/${numBadges}`);
  console.log(`G3 PASS: intact=${family.length}; visible-recovery=${visible.length - family.length}; phantom=${phantoms.length}; total=${tees.length}`);
  for (const p of phantoms) console.log(`  T${p.ownerHint}: (${p.x.toFixed(1)},${p.y.toFixed(1)}) <- ${p.source}`);
  console.log(`  intact holeArea ${summarize(family.map((m) => m.ring.holeArea))}; grayCount ${summarize(family.map((m) => m.grayCount))}`);

  // G4 current tee->badge scorer. Phantom orientation is UNKNOWN: do not
  // manufacture an axis from the badge and then reward ourselves for it.
  const field = computeRibbonSupport(image, { scale: 3, orientations: 12, widthsSrc: [24, 32, 40, 48, 56, 64] });
  const teeComponents = tees.map(componentForTee);
  const teeCost: number[][] = [];
  for (const reading of readings) {
    const pool = scoreEndpointComponents(field, supportCost(field, 30, 0.25), reading.badge.cx, reading.badge.cy, teeComponents, { primaryCount: teeComponents.length, maxCandidates: teeComponents.length, maxGeodesic: 1600, maxEfficiency: 5, minRadiusSrc: 0 });
    const byLabel = new Map(pool.unculled.filter((x) => x.value.component).map((x) => [x.value.component!.label, x.value]));
    teeCost.push(teeComponents.map((c, j) => {
      const hit = byLabel.get(c.label); if (!hit) return 1e6;
      let anglePenalty = 0;
      if (tees[j].angle !== null) {
        const ray = Math.atan2(reading.badge.cy - tees[j].y, reading.badge.cx - tees[j].x);
        const angleDeg = acuteAxisErrorRad(tees[j].angle as number, ray) * 180 / Math.PI;
        anglePenalty = 0.25 * (angleDeg / 5) ** 2;
      }
      return hit.efficiency + anglePenalty + (hit.firstIcon === false ? 0.5 : 0);
    }));
  }
  const teeAssignment = hungarian(teeCost);
  const rows = teeAssignment.map((teeIndex, i) => ({
    hole: Number(readings[i].label), tee: tees[teeIndex], bx: readings[i].badge.cx, by: readings[i].badge.cy,
    rank: rankOf(teeCost[i], teeIndex), cost: teeCost[i][teeIndex],
  }));
  const pass = new Set(teeAssignment).size === numBadges && rows.every((r) => Number.isFinite(r.cost) && r.cost < 1e5);
  console.log(`G4 ${pass ? 'PASS' : 'FAIL'}: unique tee ownership=${new Set(teeAssignment).size}/${numBadges}`);
  for (const r of rows) console.log(`  H${r.hole}: ${r.tee.tier} rank=${r.rank} cost=${r.cost.toFixed(3)} tee=(${r.tee.x.toFixed(1)},${r.tee.y.toFixed(1)})`);
  const overlay = writeOverlay(outDir, image, rows);
  console.log(`overlay -> ${overlay}`);
  const report = { input, numBadges, g2: baskets.map((b) => ({ x: b.x, y: b.y, tier: b.tier, visibility: b.effectiveVisibility, source: b.source })), g3: { family: family.length, visible: visible.length, missing: missing.map((x) => x.number), phantoms }, g4: rows.map((r) => ({ hole: r.hole, tier: r.tee.tier, x: r.tee.x, y: r.tee.y, rank: r.rank, cost: r.cost })) };
  writeFileSync(join(outDir, 'g4-phantom-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (!pass) process.exitCode = 1;
}

main();
