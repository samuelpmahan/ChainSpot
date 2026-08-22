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
// Copied from LAB's P1 constants. Keeping them here avoids importing the
// slower projected-border tee scorer that the quick endpoint pass does not use.
const BADGE_ASPECT_MIN = 1.15;
const BADGE_ASPECT_MAX = 1.8;
const BADGE_DARK_INTERIOR_MIN = 0.45;
const BADGE_SIZE_TOL = Math.log(1.15);

export interface BadgeStageResult {
	width: number;
	height: number;
	brightMask: Mask;
	darkMask: Mask;
	brightLabels: Int32Array;
	brightComponents: ComponentStats[];
	badges: ComponentStats[];
	badgeSources: ('bright-family' | 'dark-plate-recovery')[];
	plateBboxes: (readonly [number, number, number, number] | null)[];
	badgeCount: number;
}

/** Existing badge-family decision over already materialized mask/component evidence. */
export function detectBadgeFamily(
	width: number,
	dark: Mask,
	brightComponents: readonly ComponentStats[]
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
	const badgeSources: ('bright-family' | 'dark-plate-recovery')[] = badges.map(
		() => 'bright-family'
	);
	const plateBboxes: (readonly [number, number, number, number] | null)[] = badges.map(
		() => null
	);
	const { components: darkComponents } = extractComponents(dark);
	for (const component of darkComponents) {
		if (
			component.bboxW < 34 ||
			component.bboxW > 78 ||
			component.bboxH < 24 ||
			component.bboxH > 54
		)
			continue;
		const aspect = component.bboxW / component.bboxH;
		if (aspect < 1 || aspect > 2.4) continue;
		if (component.area / (component.bboxW * component.bboxH) < 0.55) continue;
		let glyphCount = 0;
		let interior = 0;
		for (let y = component.bboxY + 4; y < component.bboxY + component.bboxH - 4; y++) {
			const row = y * width;
			for (let x = component.bboxX + 4; x < component.bboxX + component.bboxW - 4; x++) {
				interior++;
				if (bright.data[row + x]) glyphCount++;
			}
		}
		const glyphFraction = interior ? glyphCount / interior : 0;
		if (glyphFraction < 0.04 || glyphFraction > 0.4) continue;
		if (badges.some((badge) => Math.hypot(badge.cx - component.cx, badge.cy - component.cy) < 22)) continue;
		const margin = 4;
		badges.push({
			label: -1,
			cx: component.cx,
			cy: component.cy,
			area: component.area,
			bboxX: component.bboxX - margin,
			bboxY: component.bboxY - margin,
			bboxW: component.bboxW + margin * 2,
			bboxH: component.bboxH + margin * 2,
			major: component.major,
			minor: component.minor,
			angle: component.angle,
			fill: component.fill
		});
		badgeSources.push('dark-plate-recovery');
		plateBboxes.push([
			component.bboxX,
			component.bboxY,
			component.bboxW,
			component.bboxH
		]);
	}
	return {
		width,
		height,
		brightMask: bright,
		darkMask: dark,
		brightLabels,
		brightComponents,
		badges,
		badgeSources,
		plateBboxes,
		badgeCount: badges.length
	};
}
