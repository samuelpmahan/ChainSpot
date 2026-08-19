// Test the rendered-UI corridor model: the corridor is a gray-paint capsule
// (rectangle + semicircular end caps of radius W/2 centered on the
// endpoints). Prediction: behind the tee (opposite the hole direction) the
// corridor paint persists to EXACTLY r = W/2 and then stops.
// Measure: radial gray profile behind truth tees on straight correct holes,
// normalized per hole by its annotated half-width.
import { readFileSync, readdirSync } from 'node:fs';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';
import { decodeRgbaBin } from './decode';

const COURSES: Record<string, string> = {
  'DashsTrack-full': 'DashsTrack', 'HeritagePark-full': 'Heritage',
  'Lenard-full': 'Lenard', 'TowneLake-full': 'TowneLake',
};
// bins of r/(W/2) from 0 to 2 in steps of 0.1; collect gray values
const bins: number[][] = Array.from({ length: 20 }, () => []);
for (const nm of Object.keys(COURSES)) {
  const cache = JSON.parse(readFileSync(`/workspace/nuthing-work/pair-matrix/${nm}.json`, 'utf8'));
  const asg = JSON.parse(readFileSync(`/workspace/nuthing-work/pair-matrix/${nm}-assignments.json`, 'utf8'));
  const annot = JSON.parse(readFileSync(`/workspace/chainspot-corpus/dev/Annotated/${COURSES[nm]}/` +
    readdirSync(`/workspace/chainspot-corpus/dev/Annotated/${COURSES[nm]}`).find((f: string) => f.endsWith('.annotation.json')), 'utf8'));
  const widthBy = new Map(annot.holes.map((h: any) => [h.number, h.corridorWidthPx ?? 44]));
  const straight = new Set(annot.holes.filter((h: any) => !(h.corridorBends?.length)).map((h: any) => h.number));
  const fullImage = decodeRgbaBin(`/workspace/nuthing-work/traces-py/${nm}.rgba.bin`);
  const image = cropRows(fullImage, detectMapViewport(fullImage));
  const gray = (x: number, y: number): number | null => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || xi >= image.width || yi < 0 || yi >= image.height) return null;
    const p = (yi * image.width + xi) * 4;
    return (image.data[p] + image.data[p + 1] + image.data[p + 2]) / 3;
  };
  for (const h of asg.holes.filter((x: any) => x.devTruthVerdict === 'correct' && straight.has(x.hole))) {
    const tee = cache.endpoints.tees[Number(h.teeId.slice(1))];
    const bk = cache.endpoints.baskets[Number(h.basketId.slice(1))];
    const half = (widthBy.get(h.hole) as number) / 2;
    // hole direction: tee -> basket; sample the BACKWARD half-plane fan
    const dir = Math.atan2(bk.y - tee.y, bk.x - tee.x);
    for (let a = -80; a <= 80; a += 10) {
      const th = dir + Math.PI + (a * Math.PI) / 180; // backward fan
      for (let rr = 0.05; rr < 2.0; rr += 0.1) {
        const g = gray(tee.x + Math.cos(th) * rr * half, tee.y + Math.sin(th) * rr * half);
        if (g === null) continue;
        // normalize per hole: subtract far background along same ray (r=2.5..3)
        const bg = gray(tee.x + Math.cos(th) * 2.7 * half, tee.y + Math.sin(th) * 2.7 * half);
        if (bg === null) continue;
        bins[Math.min(19, Math.floor(rr / 0.1))].push(g - bg);
      }
    }
  }
}
console.log('r/(W/2) | median lift behind tee (all courses, straight correct holes)');
for (let i = 0; i < 20; i++) {
  const s = [...bins[i]].sort((a, b) => a - b);
  const m = s[Math.floor(s.length / 2)] ?? 0;
  console.log(`${(0.05 + i * 0.1).toFixed(2).padStart(6)}  | ${m.toFixed(1).padStart(6)} ${'#'.repeat(Math.max(0, Math.round(m / 2)))}`);
}
