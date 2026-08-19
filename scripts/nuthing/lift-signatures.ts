// Uniform lift-signature measurement: for each family cell, background =
// median of p at +/-30px perpendicular; report lift at the cell (L0) and at
// +/-8px perpendicular (L8). Corridor: broad plateau -> L0 ~ L8 ~ +40.
// Walking path: narrow line -> L0 > 0, L8 ~ 0. Zone fill: weak greenish.
// Control: random ground cells -> ~0.
import { readFileSync, readdirSync } from 'node:fs';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';
import { decodeRgbaBin } from './decode';

const COURSES: Record<string, string> = {
  'DashsTrack-full': 'DashsTrack', 'HeritagePark-full': 'Heritage',
  'Lenard-full': 'Lenard', 'TowneLake-full': 'TowneLake',
};
const VIOL: Record<string, number[]> = {
  'DashsTrack-full': [6, 17], 'HeritagePark-full': [],
  'Lenard-full': [3, 10, 11, 13], 'TowneLake-full': [3, 10],
};
const med = (a: number[]): number => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
interface Rec { L0: number[]; L8: number[]; g0: number[] }
const fam: Record<string, Rec> = {
  ribbon: { L0: [], L8: [], g0: [] }, walkpath: { L0: [], L8: [], g0: [] },
  zonefill: { L0: [], L8: [], g0: [] }, control: { L0: [], L8: [], g0: [] },
};
let seed = 12345;
const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

for (const nm of Object.keys(COURSES)) {
  const cache = JSON.parse(readFileSync(`/workspace/nuthing-work/pair-matrix/${nm}.json`, 'utf8'));
  const asg = JSON.parse(readFileSync(`/workspace/nuthing-work/pair-matrix/${nm}-assignments.json`, 'utf8'));
  const annot = JSON.parse(readFileSync(`/workspace/chainspot-corpus/dev/Annotated/${COURSES[nm]}/` +
    readdirSync(`/workspace/chainspot-corpus/dev/Annotated/${COURSES[nm]}`).find((f: string) => f.endsWith('.annotation.json')), 'utf8'));
  const widthBy = new Map(annot.holes.map((h: any) => [h.number, h.corridorWidthPx ?? 44]));
  const fullImage = decodeRgbaBin(`/workspace/nuthing-work/traces-py/${nm}.rgba.bin`);
  const image = cropRows(fullImage, detectMapViewport(fullImage));
  const gray = (x: number, y: number): number | null => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || xi >= image.width || yi < 0 || yi >= image.height) return null;
    const p = (yi * image.width + xi) * 4;
    return (image.data[p] + image.data[p + 1] + image.data[p + 2]) / 3;
  };
  const green = (x: number, y: number): number | null => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || xi >= image.width || yi < 0 || yi >= image.height) return null;
    const p = (yi * image.width + xi) * 4;
    return image.data[p + 1] - (image.data[p] + image.data[p + 2]) / 2;
  };
  const addSample = (rec: Rec, x: number, y: number, nx: number, ny: number): void => {
    const c = gray(x, y);
    const a30 = gray(x + nx * 30, y + ny * 30), b30 = gray(x - nx * 30, y - ny * 30);
    const a8 = gray(x + nx * 8, y + ny * 8), b8 = gray(x - nx * 8, y - ny * 8);
    const gg = green(x, y), ga = green(x + nx * 30, y + ny * 30), gb = green(x - nx * 30, y - ny * 30);
    if (c === null || a30 === null || b30 === null || a8 === null || b8 === null) return;
    const bg = Math.min(a30, b30); // min of the two sides: the side more likely to be plain ground
    rec.L0.push(c - bg);
    rec.L8.push((a8 + b8) / 2 - bg);
    if (gg !== null && ga !== null && gb !== null) rec.g0.push(gg - (ga + gb) / 2);
  };
  // ribbon: centerline cells of strongest segments
  const strongest = asg.holes.filter((h: any) => h.devTruthVerdict === 'correct')
    .sort((a: any, b: any) => b.pairScore - a.pairScore).slice(0, 6);
  for (const h of strongest) {
    const tee = cache.endpoints.tees[Number(h.teeId.slice(1))];
    const badge = cache.badges.find((b: any) => Number(b.label) === h.hole);
    if (!tee || !badge) continue;
    const dx = badge.cx - tee.x, dy = badge.cy - tee.y, len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    for (let a = 16; a <= len - 16; a += 2)
      addSample(fam.ribbon, tee.x + ux * a, tee.y + uy * a, -uy, ux);
  }
  // walkpath: off-chord violation cells
  for (const holeNum of VIOL[nm]) {
    const j = cache.judgments.find((x: any) => x.hole === holeNum);
    const badge = cache.badges.find((b: any) => Number(b.label) === holeNum);
    if (!j || !badge) continue;
    const tee = cache.endpoints.tees[j.trueTee], bk = cache.endpoints.baskets[j.trueBasket];
    const vx = bk.x - tee.x, vy = bk.y - tee.y, len = Math.hypot(vx, vy);
    for (const leg of badge.legs.filter((l: any) => l.endpointId === `T${j.trueTee}` || l.endpointId === `B${j.trueBasket}`)) {
      for (let i = 0; i + 3 < leg.path.length; i += 2) {
        const x = leg.path[i] * 3 + 1.5, y = leg.path[i + 1] * 3 + 1.5;
        const t = ((x - tee.x) * vx + (y - tee.y) * vy) / (len * len);
        const qx = tee.x + t * vx, qy = tee.y + t * vy;
        if (Math.hypot(x - qx, y - qy) <= 22) continue;
        const dx2 = leg.path[i + 2] - leg.path[i], dy2 = leg.path[i + 3] - leg.path[i + 1];
        const l2 = Math.hypot(dx2, dy2) || 1;
        addSample(fam.walkpath, x, y, -dy2 / l2, dx2 / l2);
      }
    }
  }
  // zonefill: C2F annulus cells, radial normal
  for (const j of cache.judgments) {
    if (j.trueBasket < 0) continue;
    const bk = cache.endpoints.baskets[j.trueBasket];
    for (let deg = 0; deg < 360; deg += 7) {
      const th = (deg * Math.PI) / 180;
      addSample(fam.zonefill, bk.x + 62 * Math.cos(th), bk.y + 62 * Math.sin(th), Math.cos(th), Math.sin(th));
    }
  }
  // control: random cells away from all endpoints/badges
  for (let k = 0; k < 400; k++) {
    const x = 20 + rand() * (image.width - 40), y = 20 + rand() * (image.height - 40);
    const nearAny = cache.endpoints.baskets.some((b: any) => Math.hypot(x - b.x, y - b.y) < 110) ||
      cache.endpoints.tees.some((t: any) => Math.hypot(x - t.x, y - t.y) < 40) ||
      cache.badges.some((b: any) => Math.hypot(x - b.cx, y - b.cy) < 40);
    if (nearAny) continue;
    const th = rand() * Math.PI;
    addSample(fam.control, x, y, Math.cos(th), Math.sin(th));
  }
}
for (const k of Object.keys(fam)) {
  const r = fam[k];
  console.log(`${k.padEnd(9)}: n=${r.L0.length} L0(med)=${med(r.L0).toFixed(1)} L8(med)=${med(r.L8).toFixed(1)} ` +
    `plateauRatio(L8/L0)=${(med(r.L8) / Math.max(1e-6, med(r.L0))).toFixed(2)} greenness=${med(r.g0).toFixed(1)}`);
}
