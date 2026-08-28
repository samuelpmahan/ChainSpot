import { loadScopeInput } from './scripts/chainspot-lab/scope/operation.ts';
import { computeBrightDarkMasks } from './packages/alg/dist/detectors/threeFactor/raster.js';
import { extractComponents } from './packages/alg/dist/detectors/threeFactor/components.js';

async function main() {
  const imagePath = process.argv[2];
  const cx = parseFloat(process.argv[3]);
  const cy = parseFloat(process.argv[4]);
  const radius = parseFloat(process.argv[5] || '150');
  const loaded = await loadScopeInput(imagePath);
  const image = loaded.decoded.image;
  const masks = computeBrightDarkMasks(image);
  const { components } = extractComponents(masks.bright);
  const near = components.filter((c: any) => Math.hypot(c.cx - cx, c.cy - cy) <= radius && c.area >= 15);
  near.sort((a: any, b: any) => Math.hypot(a.cx - cx, a.cy - cy) - Math.hypot(b.cx - cx, b.cy - cy));
  for (const c of near.slice(0, 15)) {
    console.log(JSON.stringify({ label: c.label, cx: c.cx, cy: c.cy, area: c.area, bboxX: c.bboxX, bboxY: c.bboxY, bboxW: c.bboxW, bboxH: c.bboxH, major: c.major, minor: c.minor, dist: Math.hypot(c.cx - cx, c.cy - cy) }));
  }
}
main();
