// Why did the component-tier tee family miss the visible REC pads?
// For each missed pad (native coords from visual inspection), find the
// half-scale bright component(s) near it and report which family gate
// rejects each: minDim>=8, maxDim<=42, area 80..350, fill 0.2..0.85.
import { runBadgeStage } from '../../src/lib/nuthing/badgeStage';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';
import { decodeRgbaBin } from './decode';

const half = decodeRgbaBin('/workspace/nuthing-work/traces-py/TheRec-full.rgba.bin');
const vp = detectMapViewport(half);
const image = cropRows(half, vp);
const stage = runBadgeStage(image);

const misses: Array<[string, number, number]> = [
  ['h4-pad', 1925 / 2, 1443 / 2],
  ['h5-pad', 1637 / 2, 1650 / 2],
  ['h8-pad', 1343 / 2, 820 / 2],
  ['h2-pad', 1357 / 2, 242 / 2],
];

for (const [tag, px, py] of misses) {
  console.log(`\n${tag} @ half (${px.toFixed(0)},${py.toFixed(0)}):`);
  const near = stage.brightComponents
    .map((c) => ({ c, d: Math.hypot(c.cx - px, c.cy - py) }))
    .filter(({ c, d }) => d < 40 ||
      (px >= c.bboxX - 2 && px <= c.bboxX + c.bboxW + 2 && py >= c.bboxY - 2 && py <= c.bboxY + c.bboxH + 2))
    .sort((a, b) => a.d - b.d)
    .slice(0, 4);
  if (near.length === 0) {
    console.log('  NO bright component within 40px — border below bright threshold?');
  }
  for (const { c, d } of near) {
    const minDim = Math.min(c.bboxW, c.bboxH);
    const maxDim = Math.max(c.bboxW, c.bboxH);
    const gates: string[] = [];
    if (minDim < 8) gates.push(`minDim ${minDim}<8`);
    if (maxDim > 42) gates.push(`maxDim ${maxDim}>42`);
    if (c.area < 80) gates.push(`area ${c.area}<80`);
    if (c.area > 350) gates.push(`area ${c.area}>350`);
    if (c.fill < 0.2) gates.push(`fill ${c.fill.toFixed(2)}<0.2`);
    if (c.fill > 0.85) gates.push(`fill ${c.fill.toFixed(2)}>0.85`);
    console.log(
      `  comp d=${d.toFixed(0)} cx,cy=(${c.cx.toFixed(0)},${c.cy.toFixed(0)}) ` +
      `bbox ${c.bboxW}x${c.bboxH} area ${c.area} fill ${c.fill.toFixed(2)} -> ` +
      (gates.length ? `REJECTED: ${gates.join(', ')}` : 'PASSES family'),
    );
  }
  // Raw bright-mask coverage in a 30x24 window around the pad center.
  let on = 0;
  let tot = 0;
  for (let y = Math.round(py) - 12; y <= Math.round(py) + 12; y++) {
    for (let x = Math.round(px) - 15; x <= Math.round(px) + 15; x++) {
      if (x < 0 || x >= image.width || y < 0 || y >= image.height) continue;
      tot++;
      if (stage.brightMask.data[y * image.width + x]) on++;
    }
  }
  console.log(`  brightMask coverage in 31x25 window: ${on}/${tot}`);
}
