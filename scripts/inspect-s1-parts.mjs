import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createExecBoard } from '../packages/alg/dist/exec/board.js';
import { createStage } from '../packages/alg/dist/stages/S1/exp/badge-assembly/stage.js';
import { partsViewBox, pixelLayers, renderPartsSvg } from '../packages/alg/dist/exec/render.js';

// Run against the exact S0 raster emitted by build:staging.
const out = resolve(process.argv[2] ?? 'experiments/parts-inspector');
mkdirSync(out, { recursive: true });
const snapshot = JSON.parse(readFileSync('build/labui-s0/snapshot.json', 'utf8'));
const raster = snapshot.panels.find(p => p.address === 'px.course.canonicalPixels');
const pxc = createExecBoard();
pxc.set(raster.address, { imageId: raster.imageId, widthPx: raster.widthPx, heightPx: raster.heightPx,
  rgba: new Uint8ClampedArray(readFileSync('build/labui-s0/CroppedImage.rgba')) });
const yaml = readFileSync('packages/alg/src/stages/S1/exp/badge-assembly/PrincipleComponentRender.yaml', 'utf8');
const results = createStage(yaml).run({ pxc });
const result = results.find(r => r.kind === 'default');
if (!result?.run || result.status !== 'completed') throw new Error(result?.error ?? 'No Default run');
const calculations = result.run.Ticks.flatMap(t => t.Calculations.map(c => ({ tick: t.name, ...c })));
const assembly = calculations.at(-1).output;
const candidate = assembly.candidates.find(c => c.digitLoops.some(row => row.matches.length)) ?? assembly.candidates[0];
if (!candidate) throw new Error('No candidate to inspect');
const layers = pixelLayers(candidate);
const frame = partsViewBox(layers, raster.widthPx, raster.heightPx);
writeFileSync(join(out, 'candidate.svg'), renderPartsSvg(layers, raster.widthPx, raster.heightPx, '', frame));
const receipt = {
  sourceCommit: snapshot.sourceSha,
  sourceImage: snapshot.sourcePath,
  raster: { width: raster.widthPx, height: raster.heightPx },
  ticks: result.run.Ticks.length,
  calculations: calculations.map(c => ({ tick: c.tick, call: c.actualCall, args: c.args, into: c.into,
    collections: Object.fromEntries(Object.entries(c.output).filter(([k,v]) => k !== 'pixels' && Array.isArray(v)).map(([k,v]) => [k,v.length])) })),
  candidates: assembly.candidates.length,
  incomplete: assembly.incomplete.length,
  selectedCandidate: candidate.id,
  parts: layers.map(l => ({ role: l.name, pixelCount: l.pixels.length, color: l.color })),
  frame,
  browserInteractionVerified: false
};
writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
