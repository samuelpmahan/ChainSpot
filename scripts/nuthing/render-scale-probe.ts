// Measurement: estimateRenderScale on all dev rasters (expected ring 84,
// geoScale ~1.0) and The Rec native composite (expected ring ~168, ~0.5).
import { readFileSync } from 'node:fs';
import { runBadgeStage } from '../../src/lib/nuthing/badgeStage';
import { prepareSpriteTemplate, matchBasketSprites } from '../../src/lib/nuthing/endpoints';
import type { SpriteTemplate } from '../../src/lib/nuthing/endpoints';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';
import { estimateRenderScale } from '../../src/lib/nuthing/renderScale';
import { decodeRgbaBin } from './decode';

const template = prepareSpriteTemplate(
  JSON.parse(readFileSync('resources/nuthing-p2/endpoints/basket-sprite.json', 'utf8')) as SpriteTemplate
);
for (const nm of ['DashsTrack-full', 'HeritagePark-full', 'Lenard-full', 'TowneLake-full', 'TheRec-native']) {
  const full = decodeRgbaBin(`/workspace/nuthing-work/traces-py/${nm}.rgba.bin`);
  const image = cropRows(full, detectMapViewport(full));
  const stage = runBadgeStage(image);
  const sprites = matchBasketSprites(stage.brightMask, template).filter((s) => s.score >= 0.8);
  const est = estimateRenderScale(image, sprites);
  console.log(
    `${nm}: sprites(score>=0.8)=${sprites.length} -> ` +
      (est
        ? `ring=${est.ringRadiusPx}px geoScale=${est.geoScale.toFixed(3)} voters=${est.perBasketRadiiPx.length} radii=[${est.perBasketRadiiPx.join(',')}]`
        : 'NO ESTIMATE')
  );
}
