/**
 * Fast badge-only localization stage (experimental speed path).
 *
 * Runs P1's mask -> components stages and stops before tee scoring. Badge
 * localization is plate-first: the near-black badge plate is the stable
 * identity primitive because neighboring white renderer furniture can merge
 * into the white frame component. The repeated white-frame family remains a
 * backup source for any plate the primary path misses. Bright-mask components
 * are still computed unchanged because downstream basket/tee detectors use
 * that evidence independently of badge localization.
 */

import type { RgbaImage, Mask } from './raster';
import { computeBrightDarkMasks } from './raster';
import type { ComponentStats } from './components';
import { extractComponents } from './components';
import { anchoredFamilies, bboxSizeDistance } from './families';
import { BADGE_ASPECT_MIN, BADGE_ASPECT_MAX, BADGE_DARK_INTERIOR_MIN, BADGE_SIZE_TOL } from './p1';

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
	const { components: darkComponents } = extractComponents(dark);

	// Primary badge identity: the dark plate (~48x36 near-black rounded rect
	// with one or two white digit glyphs). Unlike the white frame, this cannot
	// merge with adjacent white tee/basket furniture, so its geometry remains
	// stable when the frame component is contaminated. Synthesized badges use
	// label -1 because there is intentionally no bright frame-component identity
	// to exclude during glyph extraction; badgeGlyph.ts instead rejects large
	// bright intruders by component area for label<0 observations.
	const badges: ComponentStats[] = [];
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
			fill: c.fill
		});
	}

	// Backup badge identity: repeated white frame + dark interior. This remains
	// useful when a plate is genuinely absent from the dark mask, but it no
	// longer defines the primary badge inventory. Do not duplicate a plate-first
	// observation when both render layers survive.
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
	const frameBadges = families.length > 0 ? families[0] : [];
	for (const frame of frameBadges) {
		if (badges.some((badge) => Math.hypot(badge.cx - frame.cx, badge.cy - frame.cy) < 22)) continue;
		badges.push(frame);
	}

	return {
		width,
		height,
		brightMask: bright,
		darkMask: dark,
		brightLabels,
		brightComponents,
		badges,
		badgeCount: badges.length
	};
}
