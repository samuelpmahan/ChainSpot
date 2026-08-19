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

/** Existing badge-family decision over already materialized mask/component evidence. */
export function detectBadgeFamily(
	width: number,
	dark: Mask,
	brightComponents: readonly ComponentStats[],
): ComponentStats[] {
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
	return families.length > 0 ? families[0] : [];
}

export function runBadgeStage(image: RgbaImage): BadgeStageResult {
  const { width, height } = image;
  const { bright, dark } = computeBrightDarkMasks(image);
  const { labels: brightLabels, components: brightComponents } = extractComponents(bright);

	const badges = detectBadgeFamily(width, dark, brightComponents);
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
