import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { runBadgeStage } from '../../src/lib/nuthing/badgeStage';
import type { ComponentStats } from '../../src/lib/nuthing/components';
import { readCourseBadges } from '../../src/lib/nuthing/digits/readBadges';
import { predictProbs } from '../../src/lib/nuthing/digits/logistic';
import type { LogisticModel } from '../../src/lib/nuthing/digits/logistic';
import {
  detectTeeRings,
  matchBasketSprites,
  prepareSpriteTemplate,
  type SpriteMatch,
  type SpriteTemplate,
  type TeeRing,
} from '../../src/lib/nuthing/endpoints';
import {
  attributeBasketZones,
  computeRibbonSupport,
  scoreEndpointComponents,
  supportCost,
  suppressCircleCost,
  type SupportField,
} from '../../src/lib/nuthing/ribbon';
import type { RgbaImage } from '../../src/lib/nuthing/raster';
import { cropRows, detectMapViewport } from '../../src/lib/nuthing/viewport';
import {
  meanSupportAlongPath,
  pathLengthPx,
  recoverMiddleOutPath,
  sampleFieldAlongPath,
  type Point,
} from '../../src/lib/autoAnnotation/middleOutRibbon';
import { detectCorridorBendsCapsule } from '../../src/lib/autoAnnotation/corridorBendDetectionCapsule';
import type { CorridorBendRaster } from '../../src/lib/autoAnnotation/corridorBendDetection';
import { decodeImageFile } from '../nuthing/decode';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_ARTIFACT_ROOT = process.env.CHAINSPOT_LAB_ARTIFACTS ?? '/mnt/d/ChainSpot-LAB/artifacts';
const DEFAULT_CORPUS_ROOT = process.env.CHAINSPOT_CORPUS_PATH ?? resolve(repoRoot, '..', 'chainspot-corpus');
const GATES = ['badges', 'baskets', 'tees', 'tee-badge', 'path'] as const;
type GateName = (typeof GATES)[number];

interface Args { course: string; outDir?: string; from: number; through: number }
interface TeeMeasure { ring: TeeRing; frame: ComponentStats; grayCount: number; grayFraction: number }
interface TeeBadgeRow { holeNumber: number; badge: Point; tee: TeeMeasure; teeRank: number; cost: number }
interface PathHypothesis {
  basketIndex: number;
  basket: SpriteMatch;
  dense: readonly Point[];
  meanSupport: number;
  worstWindowMean: number;
  lengthRatio: number;
  cost: number;
}
interface PathRow extends PathHypothesis { holeNumber: number; basketRank: number; bends: readonly Point[] }

function usage(): never {
  console.error([
    'Usage: ./lab sweep <course-or-image> [--gate G | --through G] [--from G] [--out DIR]',
    '',
    'Gates: badges -> baskets -> tees -> tee-badge -> path',
    'Aliases: association=tee-badge, bends=path.',
    'Cardinality is always numBadges from Gate 1; no downstream gate assumes 18.',
  ].join('\n'));
  process.exit(2);
}

function gateIndex(value: string | undefined): number {
  if (!value) usage();
  const alias = value === 'association' ? 'tee-badge' : value === 'bends' || value === 'paths' ? 'path' : value;
  const i = GATES.indexOf(alias as GateName);
  if (i < 0) usage();
  return i;
}

function parseArgs(argv: readonly string[]): Args {
  const xs = [...argv];
  const course = xs.shift();
  if (!course) usage();
  let from = 0;
  let through = GATES.length - 1;
  let outDir: string | undefined;
  let exact: number | null = null;
  for (let i = 0; i < xs.length; i++) {
    const a = xs[i];
    if (a === '--from') from = gateIndex(xs[++i]);
    else if (a === '--through') through = gateIndex(xs[++i]);
    else if (a === '--gate') exact = gateIndex(xs[++i]);
    else if (a === '--out') { outDir = xs[++i]; if (!outDir) usage(); }
    else usage();
  }
  if (exact !== null) { from = exact; through = exact; }
  if (from > through && exact === null) usage();
  return { course, outDir, from, through };
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
  const ranked = collectImages(DEFAULT_CORPUS_ROOT).map((path) => {
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
  if (!ranked.length) throw new Error(`Could not resolve '${value}' under ${DEFAULT_CORPUS_ROOT}`);
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
function gateHeader(index: number, title: string): void { console.log(`\nG${index + 1} ${title.toUpperCase()}`); }
function gateResult(actual: number, expected: number, noun: string): boolean {
  const ok = actual === expected;
  console.log(`${noun}: ${actual} / expected ${expected} -> ${ok ? 'PASS' : 'FAIL'}`);
  return ok;
}
function hardStop(name: GateName, detail: string): never {
  console.error(`\nSWEEP STOP @ ${name}: ${detail}`);
  process.exit(1);
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
function rect(png: PNG, x: number, y: number, w: number, h: number, rgb: readonly [number, number, number]): void {
  for (let xx = Math.round(x); xx <= Math.round(x + w); xx++) { setPixel(png, xx, Math.round(y), rgb); setPixel(png, xx, Math.round(y + h), rgb); }
  for (let yy = Math.round(y); yy <= Math.round(y + h); yy++) { setPixel(png, Math.round(x), yy, rgb); setPixel(png, Math.round(x + w), yy, rgb); }
}
function line(png: PNG, a: Point, b: Point, rgb: readonly [number, number, number]): void {
  const n = Math.max(1, Math.ceil(Math.hypot(b.xPx - a.xPx, b.yPx - a.yPx)));
  for (let i = 0; i <= n; i++) { const t = i / n; setPixel(png, Math.round(a.xPx + (b.xPx - a.xPx) * t), Math.round(a.yPx + (b.yPx - a.yPx) * t), rgb); }
}
function writeOverlay(outDir: string, name: string, image: RgbaImage, draw: (png: PNG) => void): string {
  const png = new PNG({ width: image.width, height: image.height });
  Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).copy(png.data);
  draw(png);
  const path = join(outDir, name);
  writeFileSync(path, PNG.sync.write(png));
  console.log(`overlay -> ${path}`);
  return path;
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
      return Math.abs(Math.log(Math.max(f.major, 1) / Math.max(s.major, 1))) <= Math.log(1.25) && Math.abs(Math.log(Math.max(f.minor, 1) / Math.max(s.minor, 1))) <= Math.log(1.25) && Math.abs(Math.log(Math.max(f.area, 1) / Math.max(s.area, 1))) <= Math.log(1.5);
    });
    const spread = family.reduce((sum, m) => sum + Math.abs(Math.log(Math.max(m.frame.major, 1) / Math.max(s.major, 1))) + Math.abs(Math.log(Math.max(m.frame.minor, 1) / Math.max(s.minor, 1))) + Math.abs(Math.log(Math.max(m.frame.area, 1) / Math.max(s.area, 1))), 0);
    if (family.length > best.length || (family.length === best.length && spread < bestSpread)) { best = family; bestSpread = spread; }
  }
  return best.slice().sort((a, b) => a.ring.cy - b.ring.cy || a.ring.cx - b.ring.cx);
}
function teeComponent(m: TeeMeasure, index: number): ComponentStats {
  return { label: 1_000_000 + index, cx: m.ring.cx, cy: m.ring.cy, area: 160, bboxX: m.ring.cx - 12, bboxY: m.ring.cy - 9, bboxW: 24, bboxH: 18, major: 24, minor: 18, angle: m.ring.angle, fill: 0.45 };
}
function basketSpriteComponent(m: SpriteMatch, index: number): ComponentStats {
  return { label: 2_000_000 + index, cx: m.cx, cy: m.cy, area: 1700, bboxX: m.x, bboxY: m.y, bboxW: 42, bboxH: 66, major: 66, minor: 42, angle: Math.PI / 2, fill: 0.61 };
}

/** O(n^3) minimum-cost one-to-one assignment. Rows are semantic owners; columns are candidates. */
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

function cropForBends(image: RgbaImage, tee: Point, basket: Point): CorridorBendRaster {
  const d = Math.hypot(basket.xPx - tee.xPx, basket.yPx - tee.yPx);
  const margin = Math.min(260, Math.max(40, d * 0.4));
  const x0 = Math.max(0, Math.floor(Math.min(tee.xPx, basket.xPx) - margin)); const y0 = Math.max(0, Math.floor(Math.min(tee.yPx, basket.yPx) - margin));
  const x1 = Math.min(image.width, Math.ceil(Math.max(tee.xPx, basket.xPx) + margin)); const y1 = Math.min(image.height, Math.ceil(Math.max(tee.yPx, basket.yPx) + margin));
  const cropW = Math.max(1, x1 - x0); const cropH = Math.max(1, y1 - y0); const scale = Math.max(1, Math.max(cropW, cropH) / 480);
  const widthPx = Math.max(1, Math.round(cropW / scale)); const heightPx = Math.max(1, Math.round(cropH / scale)); const data = new Uint8Array(widthPx * heightPx * 4);
  for (let y = 0; y < heightPx; y++) { const sy = Math.min(image.height - 1, y0 + Math.round(y * scale)); for (let x = 0; x < widthPx; x++) {
    const sx = Math.min(image.width - 1, x0 + Math.round(x * scale)); const src = (sy * image.width + sx) * 4; const dst = (y * widthPx + x) * 4;
    data[dst] = image.data[src]; data[dst + 1] = image.data[src + 1]; data[dst + 2] = image.data[src + 2]; data[dst + 3] = image.data[src + 3];
  }}
  return { widthPx, heightPx, originXPx: x0, originYPx: y0, scale, data, channels: 4 };
}
function suppressOtherBasketSprites(cost: Float32Array, field: SupportField, baskets: readonly SpriteMatch[], keep: number): void {
  const radius = 32 / field.scale; const r2 = radius * radius;
  for (let i = 0; i < baskets.length; i++) if (i !== keep) {
    const cx = baskets[i].cx / field.scale; const cy = baskets[i].cy / field.scale;
    for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(field.height - 1, Math.ceil(cy + radius)); y++) for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(field.width - 1, Math.ceil(cx + radius)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) cost[y * field.width + x] = Math.max(cost[y * field.width + x], 12);
    }
  }
}
function pathHypothesis(field: SupportField, baseCost: Float32Array, tee: Point, badge: Point, basket: SpriteMatch, basketIndex: number, allBaskets: readonly SpriteMatch[]): PathHypothesis | null {
  const cost = new Float32Array(baseCost);
  suppressOtherBasketSprites(cost, field, allBaskets, basketIndex);
  const basketPoint: Point = { xPx: basket.tipX, yPx: basket.tipY };
  const path = recoverMiddleOutPath(cost, field.width, field.height, field.scale, tee, badge, basketPoint, { badgeWaive: { radiusPx: 6, maxCost: 1.4 }, teeWaive: { radiusPx: 6, maxCost: 1.4 }, basketWaive: { radiusPx: 8, maxCost: 1.4 } });
  if (!path) return null;
  const meanSupport = meanSupportAlongPath(path.dense, field.support, field.width, field.height, field.scale);
  const samples = sampleFieldAlongPath(path.dense, field.support, field.width, field.height, field.scale);
  const window = Math.max(3, Math.round(45 / field.scale));
  let worstWindowMean = 1;
  if (samples.length) {
    if (samples.length <= window) worstWindowMean = samples.reduce((a, b) => a + b, 0) / samples.length;
    else for (let i = 0; i + window <= samples.length; i++) { let sum = 0; for (let j = i; j < i + window; j++) sum += samples[j]; worstWindowMean = Math.min(worstWindowMean, sum / window); }
  }
  const length = pathLengthPx(path.dense);
  const straight = Math.max(1, Math.hypot(basketPoint.xPx - tee.xPx, basketPoint.yPx - tee.yPx));
  const lengthRatio = length / straight;
  // Existing pair-matrix lesson: weakest sustained span leads; mean support and extreme detour are secondary diagnostics.
  const pathCost = (1 - worstWindowMean) + 0.25 * (1 - meanSupport) + 0.10 * Math.max(0, lengthRatio - 1.4);
  return { basketIndex, basket, dense: path.dense, meanSupport, worstWindowMean, lengthRatio, cost: pathCost };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const input = resolveCourseInput(args.course); const slug = normalizeToken(basename(input, extname(input))) || 'course';
  const outDir = resolve(args.outDir ?? join(DEFAULT_ARTIFACT_ROOT, 'sweep', slug)); mkdirSync(outDir, { recursive: true });
  console.log(`SWEEP INPUT: ${input}`); console.log(`SWEEP OUT:   ${outDir}`); console.log(`FOCUS:       ${GATES[args.from]} -> ${GATES[args.through]}`);
  const full = decodeImageFile(input); const viewport = detectMapViewport(full); const image = cropRows(full, viewport);
  console.log(`canonical: ${full.width}x${full.height} -> ${image.width}x${image.height}; rows [${viewport.top},${viewport.bottom})`);
  const model = JSON.parse(readFileSync(join(repoRoot, 'resources/nuthing-p2/digits/models/logistic.json'), 'utf8')) as LogisticModel;
  const spriteTemplate = prepareSpriteTemplate(JSON.parse(readFileSync(join(repoRoot, 'resources/nuthing-p2/endpoints/basket-sprite.json'), 'utf8')) as SpriteTemplate);

  gateHeader(0, 'badges');
  const badgeStage = runBadgeStage(image); const readingsRaw = readCourseBadges(badgeStage, { name: 'logistic', scores: (m) => predictProbs(model, m) }); const numBadges = badgeStage.badgeCount;
  const readings = readingsRaw.filter((r) => /^\d+$/.test(r.label) && Number(r.label) > 0).sort((a, b) => Number(a.label) - Number(b.label)); const labels = readings.map((r) => Number(r.label)); const uniqueLabels = new Set(labels);
  console.log(`dark-plate badges -> numBadges: ${badgeStage.badgeCount} -> ${numBadges} (delta 0)`); console.log(`decoded numeric badges=${readings.length}; unique=${uniqueLabels.size}; labels=${labels.join(',')}`);
  const badgePass = numBadges > 0 && readings.length === numBadges && uniqueLabels.size === numBadges; console.log(`badges: ${badgePass ? 'PASS' : 'FAIL'}; cardinality N=${numBadges}`);
  writeOverlay(outDir, 'g1-badges.png', image, (png) => { for (const b of badgeStage.badges) rect(png, b.bboxX, b.bboxY, b.bboxW, b.bboxH, [255, 70, 70]); });
  if (!badgePass) hardStop('badges', `numBadges=${numBadges}, numeric=${readings.length}, unique=${uniqueLabels.size}`); if (args.through === 0) return;

  gateHeader(1, 'baskets');
  const basketsAll = matchBasketSprites(badgeStage.brightMask, spriteTemplate); const baskets = basketsAll.filter((b) => b.score >= 0.8).sort((a, b) => b.score - a.score);
  console.log(`sprite candidates -> intact family(score>=0.8): ${basketsAll.length} -> ${baskets.length} (delta ${baskets.length - basketsAll.length})`); console.log(`intact scores: ${summarize(baskets.map((b) => b.score))}`);
  const basketPass = gateResult(baskets.length, numBadges, 'baskets'); writeOverlay(outDir, 'g2-baskets.png', image, (png) => { for (const b of basketsAll) rect(png, b.x, b.y, 42, 66, b.score >= 0.8 ? [60, 255, 120] : [255, 180, 60]); });
  if (!basketPass) hardStop('baskets', `intact basket family=${baskets.length}, numBadges=${numBadges}; recover deficit before path attribution`); if (args.through === 1) return;

  gateHeader(2, 'tees');
  const ringsRaw = detectTeeRings(badgeStage.brightMask); const insideBadgeInterior = (x: number, y: number): boolean => badgeStage.badges.some((b) => Math.abs(x - b.cx) <= b.bboxW / 2 - 7 && Math.abs(y - b.cy) <= b.bboxH / 2 - 7);
  const teeRings = ringsRaw.filter((r) => r.kind === 'tee-rect' && !insideBadgeInterior(r.cx, r.cy)); const teeMeasures = teeRings.map((r) => measureTee(image, r, badgeStage.brightComponents)).filter((x): x is TeeMeasure => x !== null); const teeFamily = selectTeeFamily(teeMeasures);
  console.log(`ring candidates -> tee-rect/badge-clean -> frame-measured -> intact family: ${ringsRaw.length} -> ${teeRings.length} -> ${teeMeasures.length} -> ${teeFamily.length}`); console.log(`family white area: ${summarize(teeFamily.map((t) => t.frame.area))}`); console.log(`family holeArea: ${summarize(teeFamily.map((t) => t.ring.holeArea))}`); console.log(`family grayCount: ${summarize(teeFamily.map((t) => t.grayCount))}`);
  const teePass = gateResult(teeFamily.length, numBadges, 'tees'); const teeFamilySet = new Set(teeFamily.map((t) => t.ring)); writeOverlay(outDir, 'g3-tees.png', image, (png) => { for (const t of teeMeasures) circle(png, t.ring.cx, t.ring.cy, 10, teeFamilySet.has(t.ring) ? [50, 235, 255] : [255, 120, 70]); });
  if (!teePass) hardStop('tees', `intact tee family=${teeFamily.length}, numBadges=${numBadges}; recover ${Math.max(0, numBadges - teeFamily.length)} exception(s)`); if (args.through === 2) return;

  const field = computeRibbonSupport(image, { scale: 3, orientations: 12, widthsSrc: [24, 32, 40, 48, 56, 64] });

  gateHeader(3, 'tee -> badge');
  const teeComponents = teeFamily.map(teeComponent); const teeCost: number[][] = [];
  for (const reading of readings) {
    const pool = scoreEndpointComponents(field, supportCost(field, 30, 0.25), reading.badge.cx, reading.badge.cy, teeComponents, { primaryCount: teeComponents.length, maxCandidates: teeComponents.length, maxGeodesic: 1600, maxEfficiency: 5, minRadiusSrc: 0 });
    const byLabel = new Map(pool.unculled.filter((x) => x.value.component).map((x) => [x.value.component!.label, x.value]));
    teeCost.push(teeComponents.map((c, j) => {
      const hit = byLabel.get(c.label); if (!hit) return 1e6;
      const ray = Math.atan2(reading.badge.cy - teeFamily[j].ring.cy, reading.badge.cx - teeFamily[j].ring.cx); const angleDeg = acuteAxisErrorRad(teeFamily[j].ring.angle, ray) * 180 / Math.PI;
      return hit.efficiency + 0.25 * (angleDeg / 5) ** 2 + (hit.firstIcon === false ? 0.5 : 0);
    }));
  }
  const teeAssignment = hungarian(teeCost); const teeBadgeRows: TeeBadgeRow[] = teeAssignment.map((teeIndex, i) => ({ holeNumber: Number(readings[i].label), badge: { xPx: readings[i].badge.cx, yPx: readings[i].badge.cy }, tee: teeFamily[teeIndex], teeRank: rankOf(teeCost[i], teeIndex), cost: teeCost[i][teeIndex] }));
  console.log(`badge rows -> unique tee ownership: ${numBadges} -> ${new Set(teeAssignment).size}`); for (const r of teeBadgeRows) console.log(`H${r.holeNumber}: teeRank=${r.teeRank} cost=${r.cost.toFixed(3)}`);
  const teeBadgePass = teeBadgeRows.length === numBadges && new Set(teeAssignment).size === numBadges && teeBadgeRows.every((r) => Number.isFinite(r.cost) && r.cost < 1e5); console.log(`tee-badge: ${teeBadgePass ? 'PASS' : 'FAIL'}`);
  writeOverlay(outDir, 'g4-tee-badge.png', image, (png) => { for (const r of teeBadgeRows) { const tee = { xPx: r.tee.ring.cx, yPx: r.tee.ring.cy }; line(png, tee, r.badge, [255, 80, 210]); circle(png, tee.xPx, tee.yPx, 7, [50, 235, 255]); } });
  if (!teeBadgePass) hardStop('tee-badge', `owned tees=${new Set(teeAssignment).size}/${numBadges}`); if (args.through === 3) return;

  gateHeader(4, 'badge -> basket path + bends');
  const routeBaseCost = supportCost(field, 30, 0.25); const basketComponents = baskets.map(basketSpriteComponent); const zones = attributeBasketZones(badgeStage.brightComponents, basketComponents); suppressCircleCost(routeBaseCost, field, zones);
  const hypotheses: Array<Array<PathHypothesis | null>> = []; const basketCost: number[][] = [];
  for (const owner of teeBadgeRows) {
    const tee: Point = { xPx: owner.tee.ring.cx, yPx: owner.tee.ring.cy }; const row: Array<PathHypothesis | null> = []; const costs: number[] = [];
    for (let j = 0; j < baskets.length; j++) { const h = pathHypothesis(field, routeBaseCost, tee, owner.badge, baskets[j], j, baskets); row.push(h); costs.push(h?.cost ?? 1e6); }
    hypotheses.push(row); basketCost.push(costs);
  }
  const basketAssignment = hungarian(basketCost); const pathRows: PathRow[] = [];
  for (let i = 0; i < teeBadgeRows.length; i++) {
    const selected = hypotheses[i][basketAssignment[i]]; if (!selected) continue;
    const owner = teeBadgeRows[i]; const tee: Point = { xPx: owner.tee.ring.cx, yPx: owner.tee.ring.cy }; const basketPoint: Point = { xPx: selected.basket.tipX, yPx: selected.basket.tipY };
    const bends = detectCorridorBendsCapsule(cropForBends(image, tee, basketPoint), tee, basketPoint, owner.badge);
    pathRows.push({ ...selected, holeNumber: owner.holeNumber, basketRank: rankOf(basketCost[i], basketAssignment[i]), bends });
  }
  console.log(`tee-badge rows -> path+basket assignments: ${teeBadgeRows.length} -> ${pathRows.length}`); for (const r of pathRows) console.log(`H${r.holeNumber}: basketRank=${r.basketRank} mean=${r.meanSupport.toFixed(3)} worst45=${r.worstWindowMean.toFixed(3)} lenRatio=${r.lengthRatio.toFixed(2)} bends=${r.bends.length}`);
  const pathPass = pathRows.length === numBadges && new Set(basketAssignment).size === numBadges; console.log(`path: ${pathPass ? 'STRUCTURAL PASS' : 'FAIL'}; basket attribution + route + bends are one gate`);
  writeOverlay(outDir, 'g5-path.png', image, (png) => { for (const r of pathRows) { for (let i = 1; i < r.dense.length; i++) line(png, r.dense[i - 1], r.dense[i], [255, 210, 40]); for (const b of r.bends) circle(png, b.xPx, b.yPx, 9, [255, 70, 220]); } });
  if (!pathPass) hardStop('path', `complete path ownership=${pathRows.length}/${numBadges}`);

  const report = { input, canonical: { width: image.width, height: image.height, top: viewport.top, bottom: viewport.bottom }, numBadges, counts: { badges: readings.length, basketCandidates: basketsAll.length, baskets: baskets.length, teeRings: teeRings.length, teeFrameMeasured: teeMeasures.length, teeFamily: teeFamily.length, teeBadge: teeBadgeRows.length, paths: pathRows.length }, teeBadge: teeBadgeRows.map((r) => ({ holeNumber: r.holeNumber, badge: r.badge, tee: { xPx: r.tee.ring.cx, yPx: r.tee.ring.cy, rawRank: r.teeRank } })), paths: pathRows.map((r) => ({ holeNumber: r.holeNumber, basket: { xPx: r.basket.tipX, yPx: r.basket.tipY, rawRank: r.basketRank }, meanSupport: r.meanSupport, worstWindowMean: r.worstWindowMean, lengthRatio: r.lengthRatio, bends: r.bends })) };
  const reportPath = join(outDir, 'sweep.json'); writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); console.log(`report -> ${reportPath}`); console.log(`\nSWEEP STRUCTURAL PASS: N=${numBadges}; badges -> baskets -> tees -> tee-badge -> path`);
}

main();
