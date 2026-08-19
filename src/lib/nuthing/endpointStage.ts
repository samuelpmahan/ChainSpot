import type { RgbaImage } from './raster';
import { runBadgeStage } from './badgeStage';
import {
  collectTeePoints,
  detectTeeRings,
  matchBasketSprites,
  prepareSpriteTemplate,
} from './endpoints';
import type { SpriteTemplate } from './endpoints';
import {
  detectScreenChromeRegions,
  pointInScreenChrome,
} from './screenChrome';

/**
 * Render-attributed endpoint extraction for the NuThing P1.5 experiments.
 *
 * This composes the endpoint stages in the order implied by the renderer:
 * badge family -> basket sprite family -> residual screen-chrome attribution
 * -> tee hollow-ring/fallback candidates.
 *
 * The important distinction is that chrome is attributed as a higher-level
 * screen-space render family. We do NOT tighten tee geometry and we do NOT
 * blanket-delete an edge strip. Only tee hypotheses whose centers belong to a
 * detected screen-chrome parent cluster are removed from the free tee pool.
 */
export function runEndpointStage(image: RgbaImage, spriteTemplate: SpriteTemplate) {
  const stage = runBadgeStage(image);
  const prepared = prepareSpriteTemplate(spriteTemplate);
  const sprites = matchBasketSprites(stage.brightMask, prepared);

  const chromeRegions = detectScreenChromeRegions(
    stage.brightComponents,
    image.width,
    image.height,
  );

  const insideBadge = (x: number, y: number): boolean =>
    stage.badges.some(
      (b) =>
        x >= b.bboxX - 3 &&
        x <= b.bboxX + b.bboxW + 3 &&
        y >= b.bboxY - 3 &&
        y <= b.bboxY + b.bboxH + 3,
    );

  const attributedToChrome = (x: number, y: number): boolean =>
    pointInScreenChrome(x, y, chromeRegions);

  const rings = detectTeeRings(stage.brightMask).filter(
    (r) => !insideBadge(r.cx, r.cy) && !attributedToChrome(r.cx, r.cy),
  );

  const badgeLabels = new Set(stage.badges.map((b) => b.label));
  const teeComponents = stage.brightComponents.filter(
    (c) =>
      !badgeLabels.has(c.label) &&
      !insideBadge(c.cx, c.cy) &&
      !attributedToChrome(c.cx, c.cy),
  );

  const tees = collectTeePoints(rings, teeComponents, sprites);

  return {
    ...stage,
    sprites,
    chromeRegions,
    rings,
    tees,
  };
}
