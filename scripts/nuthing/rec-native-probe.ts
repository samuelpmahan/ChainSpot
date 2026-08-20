// Probe: run the frozen badge + sprite stages on the NATIVE-scale REC
// composite (badges and basket sprites are screen-space furniture, so they
// render at canonical size regardless of map zoom). Measurement before
// wiring the dual-scale pair-matrix run.
import { readFileSync } from 'node:fs';
import { runBadgeStage } from '../../src/lib/nuthing/badgeStage';
import { readCourseBadges } from '../../src/lib/nuthing/digits/readBadges';
import { predictProbs } from '../../src/lib/nuthing/digits/logistic';
import type { LogisticModel } from '../../src/lib/nuthing/digits/logistic';
import {
  prepareSpriteTemplate,
  matchBasketSprites,
  detectTeeRings,
  collectTeePoints,
} from '../../src/lib/nuthing/endpoints';
import type { SpriteTemplate } from '../../src/lib/nuthing/endpoints';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';
import { decodeRgbaBin } from './decode';

const native = decodeRgbaBin('/workspace/nuthing-work/traces-py/TheRec-native.rgba.bin');
const vp = detectMapViewport(native);
console.log(`native viewport: [${vp.top}, ${vp.bottom}) of ${native.height}`);
const image = cropRows(native, vp);
const stage = runBadgeStage(image);
const model = JSON.parse(
  readFileSync('resources/nuthing-p2/digits/models/logistic.json', 'utf8'),
) as LogisticModel;
const readings = readCourseBadges(stage, {
  name: 'logistic',
  scores: (m) => predictProbs(model, m),
});
console.log(`badges found: ${stage.badges.length}, labeled: ${readings.filter((r) => r.label).length}`);
for (const r of readings) {
  console.log(`  badge at (${r.badge.cx.toFixed(0)},${r.badge.cy.toFixed(0)}) -> "${r.label}"`);
}
const template = prepareSpriteTemplate(
  JSON.parse(readFileSync('resources/nuthing-p2/endpoints/basket-sprite.json', 'utf8')) as SpriteTemplate,
);
const sprites = matchBasketSprites(stage.brightMask, template);
console.log(`sprites: ${sprites.length}`);
for (const s of sprites) console.log(`  sprite (${s.cx},${s.cy}) tip (${s.tipX},${s.tipY}) score ${s.score.toFixed(3)}`);

// And the half-scale geometry raster: tee stages only.
const half = decodeRgbaBin('/workspace/nuthing-work/traces-py/TheRec-full.rgba.bin');
const hvp = detectMapViewport(half);
console.log(`half viewport: [${hvp.top}, ${hvp.bottom}) of ${half.height}`);
const halfImage = cropRows(half, hvp);
const hstage = runBadgeStage(halfImage);
console.log(`half-scale stage: badges ${hstage.badges.length}, brightComponents ${hstage.brightComponents.length}`);
const rings = detectTeeRings(hstage.brightMask);
const hsprites = matchBasketSprites(hstage.brightMask, template);
console.log(`half-scale: rings ${rings.length}, sprites(FP check) ${hsprites.length}`);
const badgeLabels = new Set(hstage.badges.map((b) => b.label));
const teeComponents = hstage.brightComponents.filter((c) => !badgeLabels.has(c.label));
const tees = collectTeePoints(rings, teeComponents, hsprites);
console.log(`half-scale tee candidates: ${tees.length}`);
for (const t of tees) console.log(`  tee (${t.cx.toFixed(0)},${t.cy.toFixed(0)}) tier ${t.tier}`);
