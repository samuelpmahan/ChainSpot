import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { runBadgeStage } from '../../src/lib/nuthing/badgeStage';
import { CandidatePool } from '../../src/lib/nuthing/candidatePool';
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
  assignCourseEndpoints,
  computeRibbonSupport,
  scoreEndpointComponents,
  supportCost,
  type SupportField,
} from '../../src/lib/nuthing/ribbon';
import type { RgbaImage } from '../../src/lib/nuthing/raster';
import { cropRows, detectMapViewport } from '../../src/lib/nuthing/viewport';
import { buildSupportCost, recoverMiddleOutPath, type Point } from '../../src/lib/autoAnnotation/middleOutRibbon';
import { detectCorridorBendsCapsule } from '../../src/lib/autoAnnotation/corridorBendDetectionCapsule';
import type { CorridorBendRaster } from '../../src/lib/autoAnnotation/corridorBendDetection';
import { decodeImageFile } from '../nuthing/decode';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_ARTIFACT_ROOT = process.env.CHAINSPOT_LAB_ARTIFACTS ?? '/mnt/d/ChainSpot-LAB/artifacts';
const DEFAULT_CORPUS_ROOT = process.env.CHAINSPOT_CORPUS_PATH ?? resolve(repoRoot, '..', 'chainspot-corpus');
const GATES = ['badges', 'baskets', 'tees', 'association', 'bends'] as const;
type GateName = (typeof GATES)[number];

interface Args {
  course: string;
  outDir?: string;
  from: number;
  through: number;
}

interface TeeMeasure {
  ring: TeeRing;
  frame: ComponentStats;
  grayCount: number;
  grayFraction: number;
}

interface AssociationRow {
  holeNumber: number;
  badge: Point;
  tee: TeeMeasure;
  basket: SpriteMatch;
  teeRank: number | null;
  basketRank: number | null;
}

function usage(): never {
  console.error([
    'Usage: ./lab sweep <course-or-image> [--gate G | --through G] [--from G] [--out DIR]',
    '',
    'Gates: badges -> baskets -> tees -> association -> bends',
    'Cardinality is always numBadges from Gate 1; no downstream gate assumes 18.',
    '',
    'Examples:',
    '  ./lab sweep Coleto',
    '  ./lab sweep Coleto --gate tees',
    '  ./lab sweep Coleto --through association',
    '  ./lab sweep Coleto --from tees',
  ].join('\n'));
  process.exit(2);
}

function gateIndex(value: string | undefined): number {
  if (!value) usage();
  const i = GATES.indexOf(value as GateName);
  if (i < 0) usage();
  return i;
}

function parseArgs(argv: readonly string[]): Args {
  const args = [...argv];
  const course = args.shift();
  if (!course) usage();
  let from = 0;
  let through = GATES.length - 1;
  let outDir: string | undefined;
  let exactGate: number | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--from') from = gateIndex(args[++i]);
    else if (a === '--through') through = gateIndex(args[++i]);
    else if (a === '--gate') exactGate = gateIndex(args[++i]);
    else if (a === '--out') {
      outDir = args[++i];
      if (!outDir) usage();
    } else usage();
  }
  if (exactGate !== null) {
    from = exactGate;
    through = exactGate;
  }
  if (from > through && exactGate === null) usage();
  return { course, outDir, from, through };
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

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
  const ranked = collectImages(DEFAULT_CORPUS_ROOT)
    .map((path) => {
      const normalized = normalizeToken(path);
      if (!normalized.includes(q)) return null;
      const base = normalizeToken(basename(path, extname(path)));
      let score = 0;
      if (base === q || base === `${q}full`) score += 200;
      if (base.startsWith(q)) score += 80;
      if (path.includes('validation')) score += 20;
      if (path.includes('clean')) score += 40;
      if (/full/i.test(basename(path))) score += 30;
      if (/lazy|tile|upper|lower|left|right/i.test(basename(path))) score -= 80;
      return { path, score };
    })
    .filter((x): x is { path: string; score: number } => x !== null)
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

function gateHeader(index: number, title: string): void {
  console.log(`\nG${index + 1} ${title.toUpperCase()}`);
}

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
  png.data[i] = rgb[0];
  png.data[i + 1] = rgb[1];
  png.data[i + 2] = rgb[2];
  png.data[i + 3] = 255;
}

function circle(png: PNG, cx: number, cy: number, radius: number, rgb: readonly [number, number, number]): void {
  for (let a = 0; a < 360; a += 2) {
    const t = a * Math.PI / 180;
    for (let w = 0; w < 3; w++) setPixel(png, Math.round(cx + (radius + w) * Math.cos(t)), Math.round(cy + (radius + w) * Math.sin(t)), rgb);
  }
}

function rect(png: PNG, x: number, y: number, w: number, h: number, rgb: readonly [number, number, number]): void {
  for (let xx = Math.round(x); xx <= Math.round(x + w); xx++) {
    setPixel(png, xx, Math.round(y), rgb);
    setPixel(png, xx, Math.round(y + h), rgb);
  }
  for (let yy = Math.round(y); yy <= Math.round(y + h); yy++) {
    setPixel(png, Math.round(x), yy, rgb);
    setPixel(png, Math.round(x + w), yy, rgb);
  }
}

function line(png: PNG, a: Point, b: Point, rgb: readonly [number, number, number]): void {
  const n = Math.max(1, Math.ceil(Math.hypot(b.xPx - a.xPx, b.yPx - a.yPx)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    setPixel(png, Math.round(a.xPx + (b.xPx - a.xPx) * t), Math.round(a.yPx + (b.yPx - a.yPx) * t), rgb);
  }
}

function basePng(image: RgbaImage): PNG {
  const png = new PNG({ width: image.width, height: image.height });
  Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).copy(png.data);
  return png;
}

function writeOverlay(outDir: string, name: string, image: RgbaImage, draw: (png: PNG) => void): string {
  const png = basePng(image);
  draw(png);
  const path = join(outDir, name);
  writeFileSync(path, PNG.sync.write(png));
  console.log(`overlay -> ${path}`);
  return path;
}

function grayStats(image: RgbaImage, ring: TeeRing): { count: number; fraction: number } {
  const x0 = Math.max(0, Math.floor(ring.bboxX));
  const y0 = Math.max(0, Math.floor(ring.bboxY));
  const x1 = Math.min(image.width, Math.ceil(ring.bboxX + ring.bboxW));
  const y1 = Math.min(image.height, Math.ceil(ring.bboxY + ring.bboxH));
  let count = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * image.width + x) * 4;
      const v = Math.max(image.data[p], image.data[p + 1], image.data[p + 2]);
      if (v >= 145 && v <= 175) count++;
      total++;
    }
  }
  return { count, fraction: total ? count / total : 0 };
}

function frameForRing(ring: TeeRing, components: readonly ComponentStats[]): ComponentStats | null {
  const candidates = components.filter((c) =>
    c.area >= 10 && c.area <= 500 && c.bboxW <= 50 && c.bboxH <= 50 &&
    ring.cx >= c.bboxX && ring.cx <= c.bboxX + c.bboxW &&
    ring.cy >= c.bboxY && ring.cy <= c.bboxY + c.bboxH
  );
  if (!candidates.length) return null;
  return candidates.slice().sort((a, b) => a.bboxW * a.bboxH - b.bboxW * b.bboxH || b.area - a.area)[0];
}

function measureTee(image: RgbaImage, ring: TeeRing, components: readonly ComponentStats[]): TeeMeasure | null {
  const frame = frameForRing(ring, components);
  if (!frame) return null;
  const gray = grayStats(image, ring);
  return { ring, frame, grayCount: gray.count, grayFraction: gray.fraction };
}

/** I20/I21 family selection: cluster on the actual repeated WHITE renderer component, not hole geometry alone. */
function selectTeeFamily(measures: readonly TeeMeasure[]): TeeMeasure[] {
  if (!measures.length) return [];
  let best: TeeMeasure[] = [];
  let bestSpread = Infinity;
  for (const seed of measures) {
    const s = seed.frame;
    const family = measures.filter((m) => {
      const f = m.frame;
      return Math.abs(Math.log(Math.max(f.major, 1) / Math.max(s.major, 1))) <= Math.log(1.25) &&
        Math.abs(Math.log(Math.max(f.minor, 1) / Math.max(s.minor, 1))) <= Math.log(1.25) &&
        Math.abs(Math.log(Math.max(f.area, 1) / Math.max(s.area, 1))) <= Math.log(1.5);
    });
    const lmj = family.map((m) => Math.log(Math.max(m.frame.major, 1)));
    const lmn = family.map((m) => Math.log(Math.max(m.frame.minor, 1)));
    const la = family.map((m) => Math.log(Math.max(m.frame.area, 1)));
    const spread = family.reduce((sum, m) =>
      sum + Math.abs(Math.log(Math.max(m.frame.major, 1)) - median(lmj)) +
      Math.abs(Math.log(Math.max(m.frame.minor, 1)) - median(lmn)) +
      Math.abs(Math.log(Math.max(m.frame.area, 1)) - median(la)), 0);
    if (family.length > best.length || (family.length === best.length && spread < bestSpread)) {
      best = family;
      bestSpread = spread;
    }
  }
  return best.slice().sort((a, b) => a.ring.cy - b.ring.cy || a.ring.cx - b.ring.cx);
}

function teeComponent(m: TeeMeasure, index: number): ComponentStats {
  return {
    label: 1_000_000 + index,
    cx: m.ring.cx,
    cy: m.ring.cy,
    area: 160,
    bboxX: m.ring.cx - 12,
    bboxY: m.ring.cy - 9,
    bboxW: 24,
    bboxH: 18,
    major: 24,
    minor: 18,
    angle: m.ring.angle,
    fill: 0.45,
  };
}

function basketComponent(m: SpriteMatch, index: number): ComponentStats {
  return {
    label: 2_000_000 + index,
    cx: m.tipX,
    cy: m.tipY,
    area: 1700,
    bboxX: m.tipX - 21,
    bboxY: m.tipY - 33,
    bboxW: 42,
    bboxH: 66,
    major: 66,
    minor: 42,
    angle: Math.PI / 2,
    fill: 0.61,
  };
}

function cropForBends(image: RgbaImage, tee: Point, basket: Point): CorridorBendRaster {
  const d = Math.hypot(basket.xPx - tee.xPx, basket.yPx - tee.yPx);
  const margin = Math.min(260, Math.max(40, d * 0.4));
  const x0 = Math.max(0, Math.floor(Math.min(tee.xPx, basket.xPx) - margin));
  const y0 = Math.max(0, Math.floor(Math.min(tee.yPx, basket.yPx) - margin));
  const x1 = Math.min(image.width, Math.ceil(Math.max(tee.xPx, basket.xPx) + margin));
  const y1 = Math.min(image.height, Math.ceil(Math.max(tee.yPx, basket.yPx) + margin));
  const cropW = Math.max(1, x1 - x0);
  const cropH = Math.max(1, y1 - y0);
  const scale = Math.max(1, Math.max(cropW, cropH) / 480);
  const widthPx = Math.max(1, Math.round(cropW / scale));
  const heightPx = Math.max(1, Math.round(cropH / scale));
  const data = new Uint8Array(widthPx * heightPx * 4);
  for (let y = 0; y < heightPx; y++) {
    const sy = Math.min(image.height - 1, y0 + Math.round(y * scale));
    for (let x = 0; x < widthPx; x++) {
      const sx = Math.min(image.width - 1, x0 + Math.round(x * scale));
      const src = (sy * image.width + sx) * 4;
      const dst = (y * widthPx + x) * 4;
      data[dst] = image.data[src];
      data[dst + 1] = image.data[src + 1];
      data[dst + 2] = image.data[src + 2];
      data[dst + 3] = image.data[src + 3];
    }
  }
  return { widthPx, heightPx, originXPx: x0, originYPx: y0, scale, data, channels: 4 };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const input = resolveCourseInput(args.course);
  const slug = normalizeToken(basename(input, extname(input))) || 'course';
  const outDir = resolve(args.outDir ?? join(DEFAULT_ARTIFACT_ROOT, 'sweep', slug));
  mkdirSync(outDir, { recursive: true });
  console.log(`SWEEP INPUT: ${input}`);
  console.log(`SWEEP OUT:   ${outDir}`);
  console.log(`FOCUS:       ${GATES[args.from]} -> ${GATES[args.through]}`);

  const full = decodeImageFile(input);
  const viewport = detectMapViewport(full);
  const image = cropRows(full, viewport);
  console.log(`canonical: ${full.width}x${full.height} -> ${image.width}x${image.height}; rows [${viewport.top},${viewport.bottom})`);

  const model = JSON.parse(readFileSync(join(repoRoot, 'resources/nuthing-p2/digits/models/logistic.json'), 'utf8')) as LogisticModel;
  const spriteTemplate = prepareSpriteTemplate(JSON.parse(readFileSync(join(repoRoot, 'resources/nuthing-p2/endpoints/basket-sprite.json'), 'utf8')) as SpriteTemplate);

  gateHeader(0, 'badges');
  const badgeStage = runBadgeStage(image);
  const readingsRaw = readCourseBadges(badgeStage, { name: 'logistic', scores: (m) => predictProbs(model, m) });
  const numBadges = badgeStage.badgeCount;
  const readings = readingsRaw.filter((r) => /^\d+$/.test(r.label) && Number(r.label) > 0).sort((a, b) => Number(a.label) - Number(b.label));
  const labels = readings.map((r) => Number(r.label));
  const uniqueLabels = new Set(labels);
  console.log(`dark-plate badges -> numBadges: ${badgeStage.badgeCount} -> ${numBadges} (delta 0)`);
  console.log(`decoded numeric badges=${readings.length}; unique=${uniqueLabels.size}; labels=${labels.join(',')}`);
  const badgePass = numBadges > 0 && readings.length === numBadges && uniqueLabels.size === numBadges;
  console.log(`badges: ${badgePass ? 'PASS' : 'FAIL'}; cardinality N=${numBadges}`);
  writeOverlay(outDir, 'g1-badges.png', image, (png) => {
    for (const b of badgeStage.badges) rect(png, b.bboxX, b.bboxY, b.bboxW, b.bboxH, [255, 70, 70]);
  });
  if (!badgePass) hardStop('badges', `numBadges=${numBadges}, numeric=${readings.length}, unique=${uniqueLabels.size}`);
  if (args.through === 0) return;

  gateHeader(1, 'baskets');
  const basketsAll = matchBasketSprites(badgeStage.brightMask, spriteTemplate);
  const baskets = basketsAll.filter((b) => b.score >= 0.8).sort((a, b) => b.score - a.score);
  console.log(`sprite candidates -> intact family(score>=0.8): ${basketsAll.length} -> ${baskets.length} (delta ${baskets.length - basketsAll.length})`);
  console.log(`intact scores: ${summarize(baskets.map((b) => b.score))}`);
  const basketPass = gateResult(baskets.length, numBadges, 'baskets');
  writeOverlay(outDir, 'g2-baskets.png', image, (png) => {
    for (const b of basketsAll) rect(png, b.x, b.y, 42, 66, b.score >= 0.8 ? [60, 255, 120] : [255, 180, 60]);
  });
  if (!basketPass) hardStop('baskets', `intact basket family=${baskets.length}, numBadges=${numBadges}; recover the deficit before association`);
  if (args.through === 1) return;

  gateHeader(2, 'tees');
  const ringsRaw = detectTeeRings(badgeStage.brightMask);
  const insideBadgeInterior = (x: number, y: number): boolean => badgeStage.badges.some((b) => Math.abs(x - b.cx) <= b.bboxW / 2 - 7 && Math.abs(y - b.cy) <= b.bboxH / 2 - 7);
  const teeRings = ringsRaw.filter((r) => r.kind === 'tee-rect' && !insideBadgeInterior(r.cx, r.cy));
  const teeMeasures = teeRings.map((r) => measureTee(image, r, badgeStage.brightComponents)).filter((x): x is TeeMeasure => x !== null);
  const teeFamily = selectTeeFamily(teeMeasures);
  console.log(`ring candidates -> tee-rect/badge-clean -> frame-measured -> intact family: ${ringsRaw.length} -> ${teeRings.length} -> ${teeMeasures.length} -> ${teeFamily.length}`);
  console.log(`family white area: ${summarize(teeFamily.map((t) => t.frame.area))}`);
  console.log(`family holeArea: ${summarize(teeFamily.map((t) => t.ring.holeArea))}`);
  console.log(`family grayCount: ${summarize(teeFamily.map((t) => t.grayCount))}`);
  console.log(`family grayFraction: ${summarize(teeFamily.map((t) => t.grayFraction))}`);
  const teePass = gateResult(teeFamily.length, numBadges, 'tees');
  const teeFamilySet = new Set(teeFamily.map((t) => t.ring));
  writeOverlay(outDir, 'g3-tees.png', image, (png) => {
    for (const t of teeMeasures) circle(png, t.ring.cx, t.ring.cy, 10, teeFamilySet.has(t.ring) ? [50, 235, 255] : [255, 120, 70]);
  });
  if (!teePass) hardStop('tees', `intact tee family=${teeFamily.length}, numBadges=${numBadges}; do not widen the family—recover ${Math.max(0, numBadges - teeFamily.length)} exceptional tee(s)`);
  if (args.through === 2) return;

  const field: SupportField = computeRibbonSupport(image, { scale: 3, orientations: 12, widthsSrc: [24, 32, 40, 48, 56, 64] });
  const associationCost = supportCost(field, 30, 0.25);
  const routeCost = buildSupportCost(field.support);

  gateHeader(3, 'association');
  const teeComponents = teeFamily.map(teeComponent);
  const basketComponents = baskets.map(basketComponent);
  const identityComponents = [...teeComponents, ...basketComponents];
  const knownLabels = new Set(identityComponents.map((c) => c.label));
  const pools = readings.map((r) => {
    const raw = scoreEndpointComponents(field, associationCost, r.badge.cx, r.badge.cy, identityComponents, {
      primaryCount: 2,
      maxCandidates: identityComponents.length,
      maxGeodesic: 1600,
      maxEfficiency: 5,
    });
    const entries = raw.unculled.filter((x) => x.value.component !== null && knownLabels.has(x.value.component.label)).map((x) => ({ value: x.value, score: x.score }));
    return new CandidatePool(entries, { primaryCount: 2, theoreticalFloor: -Infinity, preRanked: true });
  });
  const assignment = assignCourseEndpoints(pools, readings.map((r) => ({ x: r.badge.cx, y: r.badge.cy })));
  const teeByLabel = new Map(teeComponents.map((c, i) => [c.label, teeFamily[i]]));
  const basketByLabel = new Map(basketComponents.map((c, i) => [c.label, baskets[i]]));
  const associations: AssociationRow[] = [];
  for (let i = 0; i < readings.length; i++) {
    const t = assignment.tee[i];
    const b = assignment.basket[i];
    const tl = t?.component?.label;
    const bl = b?.component?.label;
    const tee = tl === undefined ? undefined : teeByLabel.get(tl);
    const basket = bl === undefined ? undefined : basketByLabel.get(bl);
    if (!tee || !basket) continue;
    associations.push({
      holeNumber: Number(readings[i].label),
      badge: { xPx: readings[i].badge.cx, yPx: readings[i].badge.cy },
      tee,
      basket,
      teeRank: pools[i].all.find((x) => x.value.component?.label === tl)?.rank ?? null,
      basketRank: pools[i].all.find((x) => x.value.component?.label === bl)?.rank ?? null,
    });
  }
  const uniqueTees = new Set(associations.map((a) => `${a.tee.ring.cx.toFixed(2)},${a.tee.ring.cy.toFixed(2)}`));
  const uniqueBaskets = new Set(associations.map((a) => `${a.basket.tipX.toFixed(2)},${a.basket.tipY.toFixed(2)}`));
  console.log(`badge rows -> complete assignments: ${numBadges} -> ${associations.length} (delta ${associations.length - numBadges})`);
  console.log(`unique tees=${uniqueTees.size}; unique baskets=${uniqueBaskets.size}`);
  for (const a of associations) console.log(`H${a.holeNumber}: teeRank=${a.teeRank ?? '-'} basketRank=${a.basketRank ?? '-'}`);
  const associationPass = associations.length === numBadges && uniqueTees.size === numBadges && uniqueBaskets.size === numBadges;
  console.log(`association: ${associationPass ? 'PASS' : 'FAIL'}`);
  writeOverlay(outDir, 'g4-association.png', image, (png) => {
    for (const a of associations) {
      const tee: Point = { xPx: a.tee.ring.cx, yPx: a.tee.ring.cy };
      const basket: Point = { xPx: a.basket.tipX, yPx: a.basket.tipY };
      line(png, tee, a.badge, [255, 80, 210]);
      line(png, a.badge, basket, [255, 80, 210]);
      circle(png, tee.xPx, tee.yPx, 7, [50, 235, 255]);
      circle(png, basket.xPx, basket.yPx, 7, [60, 255, 120]);
    }
  });
  if (!associationPass) hardStop('association', `complete=${associations.length}/${numBadges}, unique tees=${uniqueTees.size}, unique baskets=${uniqueBaskets.size}`);
  if (args.through === 3) return;

  gateHeader(4, 'bends');
  const routes: Array<{ holeNumber: number; dense: Point[]; bends: Point[] }> = [];
  for (const a of associations) {
    const tee: Point = { xPx: a.tee.ring.cx, yPx: a.tee.ring.cy };
    const basket: Point = { xPx: a.basket.tipX, yPx: a.basket.tipY };
    const path = recoverMiddleOutPath(routeCost, field.width, field.height, field.scale, tee, a.badge, basket, {
      badgeWaive: { radiusPx: 6, maxCost: 1.4 },
      teeWaive: { radiusPx: 6, maxCost: 1.4 },
      basketWaive: { radiusPx: 6, maxCost: 1.4 },
    });
    if (!path) continue;
    const crop = cropForBends(image, tee, basket);
    const bends = detectCorridorBendsCapsule(crop, tee, basket, a.badge);
    routes.push({ holeNumber: a.holeNumber, dense: [...path.dense], bends: bends.map((p) => ({ xPx: p.xPx, yPx: p.yPx })) });
    console.log(`H${a.holeNumber}: routePts=${path.dense.length} bends=${bends.length}`);
  }
  const bendsPass = gateResult(routes.length, numBadges, 'routed holes');
  writeOverlay(outDir, 'g5-bends.png', image, (png) => {
    for (const r of routes) {
      for (let i = 1; i < r.dense.length; i++) line(png, r.dense[i - 1], r.dense[i], [255, 80, 210]);
      for (const b of r.bends) circle(png, b.xPx, b.yPx, 9, [255, 230, 50]);
    }
  });
  if (!bendsPass) hardStop('bends', `MiddleOut recovered ${routes.length}/${numBadges} assigned holes`);

  const report = {
    input,
    canonical: { width: image.width, height: image.height, top: viewport.top, bottom: viewport.bottom },
    numBadges,
    counts: {
      badges: readings.length,
      basketCandidates: basketsAll.length,
      baskets: baskets.length,
      teeRings: teeRings.length,
      teeFrameMeasured: teeMeasures.length,
      teeFamily: teeFamily.length,
      associations: associations.length,
      routes: routes.length,
    },
    associations: associations.map((a) => ({
      holeNumber: a.holeNumber,
      badge: a.badge,
      tee: { xPx: a.tee.ring.cx, yPx: a.tee.ring.cy, rawRank: a.teeRank },
      basket: { xPx: a.basket.tipX, yPx: a.basket.tipY, rawRank: a.basketRank },
    })),
    bends: routes.map((r) => ({ holeNumber: r.holeNumber, bends: r.bends })),
  };
  const reportPath = join(outDir, 'sweep.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report -> ${reportPath}`);
  console.log(`\nSWEEP PASS: ${numBadges}/${numBadges} badges -> baskets -> tees -> association -> bends`);
}

main();
