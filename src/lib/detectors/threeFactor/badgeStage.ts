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
import { computeBrightDarkMasks, DEFAULT_HSV_KNOBS, type HsvKnobs } from './raster';
import type { ComponentStats } from './components';
import { extractComponents } from './components';
import { anchoredFamilies, bboxSizeDistance } from './families';

/**
 * g1.badges knobs, threaded down as plain parameters. Copied from LAB's P1
 * constants originally (see file header); badgeSizeTolFactor is the
 * human-readable knob (1.15) — Math.log(...) is applied at the use site
 * (anchoredFamilies) per knob-inventory merge note 4, not baked into a
 * pre-logged constant, so the config value stays human-readable.
 * badgeAspectMin (1.15) and badgeSizeTolFactor (1.15) are coincidentally
 * equal, separate knobs. plateInteriorMargin and plateBboxMargin are also
 * coincidentally both 4, separate knobs.
 *
 * badgeInsidePadding is NOT read by any function in this file — it's the
 * measure.ts makeTees tee-exclusion padding (a g1.badges knob per the
 * cluster's row list). Bundled here anyway, unlike the g5.ribbon/g5.routing
 * CorridorParams-riding knobs: it doesn't ride any separate mechanism, it's
 * just consumed by a different file, so one shared bundle type threaded to
 * both badgeStage.ts and measure.ts is simpler than a second knobs type.
 */
export interface BadgeStageKnobs {
	readonly badgeAspectMin: number;
	readonly badgeAspectMax: number;
	readonly badgeDarkInteriorMin: number;
	readonly badgeSizeTolFactor: number;
	readonly plateMinWidth: number;
	readonly plateMaxWidth: number;
	readonly plateMinHeight: number;
	readonly plateMaxHeight: number;
	readonly plateAspectMin: number;
	readonly plateAspectMax: number;
	readonly plateFillMin: number;
	readonly plateInteriorMargin: number;
	readonly plateGlyphFractionMin: number;
	readonly plateGlyphFractionMax: number;
	readonly plateProximityThreshold: number;
	readonly plateBboxMargin: number;
	readonly badgeInsidePadding: number;
}

export const DEFAULT_BADGE_STAGE_KNOBS: BadgeStageKnobs = {
	badgeAspectMin: 1.15,
	badgeAspectMax: 1.8,
	badgeDarkInteriorMin: 0.45,
	badgeSizeTolFactor: 1.15,
	plateMinWidth: 34,
	plateMaxWidth: 78,
	plateMinHeight: 24,
	plateMaxHeight: 54,
	plateAspectMin: 1,
	plateAspectMax: 2.4,
	plateFillMin: 0.55,
	plateInteriorMargin: 4,
	plateGlyphFractionMin: 0.04,
	plateGlyphFractionMax: 0.4,
	plateProximityThreshold: 22,
	plateBboxMargin: 4,
	badgeInsidePadding: 3
};

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
	brightComponents: readonly ComponentStats[],
	knobs: BadgeStageKnobs = DEFAULT_BADGE_STAGE_KNOBS
): ComponentStats[] {
	const badgeCandidates: ComponentStats[] = [];
	for (const c of brightComponents) {
		if (c.bboxH <= 0) continue;
		const aspect = c.bboxW / c.bboxH;
		if (aspect < knobs.badgeAspectMin || aspect > knobs.badgeAspectMax) continue;
		let darkCount = 0;
		for (let y = c.bboxY; y < c.bboxY + c.bboxH; y++) {
			const row = y * width;
			for (let x = c.bboxX; x < c.bboxX + c.bboxW; x++) {
				if (dark.data[row + x]) darkCount++;
			}
		}
		if (darkCount / (c.bboxW * c.bboxH) >= knobs.badgeDarkInteriorMin) badgeCandidates.push(c);
	}
	const families = anchoredFamilies(badgeCandidates, Math.log(knobs.badgeSizeTolFactor), bboxSizeDistance);
	return families.length > 0 ? families[0] : [];
}

export function runBadgeStage(
	image: RgbaImage,
	knobs: BadgeStageKnobs = DEFAULT_BADGE_STAGE_KNOBS,
	hsvKnobs: HsvKnobs = DEFAULT_HSV_KNOBS
): BadgeStageResult {
	const { width, height } = image;
	const { bright, dark } = computeBrightDarkMasks(image, hsvKnobs);
	const { labels: brightLabels, components: brightComponents } = extractComponents(bright);

	const badges = detectBadgeFamily(width, dark, brightComponents, knobs);
	const badgeSources: ('bright-family' | 'dark-plate-recovery')[] = badges.map(
		() => 'bright-family'
	);
	const plateBboxes: (readonly [number, number, number, number] | null)[] = badges.map(
		() => null
	);
	const { components: darkComponents } = extractComponents(dark);
	for (const component of darkComponents) {
		if (
			component.bboxW < knobs.plateMinWidth ||
			component.bboxW > knobs.plateMaxWidth ||
			component.bboxH < knobs.plateMinHeight ||
			component.bboxH > knobs.plateMaxHeight
		)
			continue;
		const aspect = component.bboxW / component.bboxH;
		if (aspect < knobs.plateAspectMin || aspect > knobs.plateAspectMax) continue;
		if (component.area / (component.bboxW * component.bboxH) < knobs.plateFillMin) continue;
		let glyphCount = 0;
		let interior = 0;
		for (let y = component.bboxY + knobs.plateInteriorMargin; y < component.bboxY + component.bboxH - knobs.plateInteriorMargin; y++) {
			const row = y * width;
			for (let x = component.bboxX + knobs.plateInteriorMargin; x < component.bboxX + component.bboxW - knobs.plateInteriorMargin; x++) {
				interior++;
				if (bright.data[row + x]) glyphCount++;
			}
		}
		const glyphFraction = interior ? glyphCount / interior : 0;
		if (glyphFraction < knobs.plateGlyphFractionMin || glyphFraction > knobs.plateGlyphFractionMax) continue;
		if (badges.some((badge) => Math.hypot(badge.cx - component.cx, badge.cy - component.cy) < knobs.plateProximityThreshold)) continue;
		const margin = knobs.plateBboxMargin;
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
