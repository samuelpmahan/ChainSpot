/**
 * Fast badge-only localization stage (experimental speed path).
 *
 * Runs exactly P1's mask -> components -> badge-family stages and stops:
 * the projected-border tee scoring (the dominant P1 cost) is skipped
 * because middle-out ribbon endpoint discovery (./ribbon.ts) replaces the
 * tee template ranking in the P1.5 pipeline. Badge semantics are identical
 * to runNuThingP1 — same masks, same components, same anchored family.
 */

import type { RgbaImage, Mask } from './raster';
import { computeBrightDarkMasks } from './raster';
import type { ComponentStats } from './components';
import { extractComponents } from './components';
import { anchoredFamilies, bboxSizeDistance } from './families';
import {
  BADGE_ASPECT_MIN,
  BADGE_ASPECT_MAX,
  BADGE_DARK_INTERIOR_MIN,
  BADGE_SIZE_TOL,
} from './p1';

export interface BadgeStageResult {
  width: number;
  height: number;
  brightMask: Mask;
  darkMask: Mask;
  brightLabels: Int32Array;
  brightComponents: ComponentStats[];
  badges: ComponentStats[];
  badgeCount: number;
}

export function runBadgeStage(image: RgbaImage): BadgeStageResult {
  const { width, height } = image;
  const { bright, dark } = computeBrightDarkMasks(image);
  const { labels: brightLabels, components: brightComponents } = extractComponents(bright);

  const badgeCandidates: ComponentStats[] = [];
  for (const c of brightComponents) {
    if (c.bboxH <= 0) continue;
    const aspect = c.bboxW / c.bboxH;
    if (aspect < BADGE_ASPECT_MIN || aspect > BADGE_ASPECT_MAX) continue;
    let darkCount = 0;
    for (let y = c.bboxY; y < c.bboxY + c.bboxH; y++) {
      const row = y * width;
      for (let x = c.bboxX; x < c.bboxX + c.bboxW; x++) {
        if (dark.data[row + x]) darkCount++;
      }
    }
    if (darkCount / (c.bboxW * c.bboxH) >= BADGE_DARK_INTERIOR_MIN) badgeCandidates.push(c);
  }
  const families = anchoredFamilies(badgeCandidates, BADGE_SIZE_TOL, bboxSizeDistance);
  const badges = families.length > 0 ? [...families[0]] : [];

  // Dark-plate recovery: when a basket sprite overlaps a badge's white
  // frame, the frame component merges with the sprite blob and the family
  // path above loses the badge (measured: 6 of 72 dev badges — Heritage
  // 2/12/13/15, Lenard 5/12). The badge's dark PLATE (~48x36 near-black
  // rounded rect with white digit glyphs) can never merge with anything
  // white, so it recovers those. Plate-detected badges are synthesized as
  // frame-sized ComponentStats (plate bbox + frame margin) with label -1
  // so glyph extraction's frame-pixel exclusion never fires on them.
  // Measured on dev: exactly 18 plates per course, zero false positives.
  const { components: darkComponents } = extractComponents(dark);
  for (const c of darkComponents) {
    if (c.bboxW < 34 || c.bboxW > 78 || c.bboxH < 24 || c.bboxH > 54) continue;
    const aspect = c.bboxW / c.bboxH;
    if (aspect < 1.0 || aspect > 2.4) continue;
    if (c.area / (c.bboxW * c.bboxH) < 0.55) continue;
    let glyphCount = 0;
    let interior = 0;
    for (let y = c.bboxY + 4; y < c.bboxY + c.bboxH - 4; y++) {
      const row = y * width;
      for (let x = c.bboxX + 4; x < c.bboxX + c.bboxW - 4; x++) {
        interior++;
        if (bright.data[row + x]) glyphCount++;
      }
    }
    if (interior === 0) continue;
    const gf = glyphCount / interior;
    if (gf < 0.04 || gf > 0.4) continue;
    if (badges.some((b) => Math.hypot(b.cx - c.cx, b.cy - c.cy) < 22)) continue;
    const M = 4; // white frame margin around the plate
    badges.push({
      label: -1,
      cx: c.cx,
      cy: c.cy,
      area: c.area,
      bboxX: c.bboxX - M,
      bboxY: c.bboxY - M,
      bboxW: c.bboxW + 2 * M,
      bboxH: c.bboxH + 2 * M,
      major: c.major,
      minor: c.minor,
      angle: c.angle,
      fill: c.fill,
    });
  }
  return {
    width,
    height,
    brightMask: bright,
    darkMask: dark,
    brightLabels,
    brightComponents,
    badges,
    badgeCount: badges.length,
  };
}
