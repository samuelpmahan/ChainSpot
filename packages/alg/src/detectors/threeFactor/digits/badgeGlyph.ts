/**
 * Badge glyph extraction — the exact logic scripts/nuthing/build-manifest.ts
 * used to materialize the manifest's glyph masks, as a browser-portable
 * function so runtime badge reading and the training data share one
 * definition: interior = bounding box of dark pixels inside the badge bbox;
 * glyph = bright pixels inside that interior that are NOT part of the badge
 * frame component.
 *
 * FRAME EXCLUSION (fix contract C1, docs/seven-whys/g1-badge-digit-garbage.md):
 * a `bright-family` badge's own frame IS a bright component (`badge.label`),
 * so `brightLabels[i] !== badge.label` excludes it correctly on its own. A
 * `dark-plate-recovery` badge (badgeStage.ts's `recoverDarkPlateBadges`) has
 * no bright component of its own — it is stamped with the sentinel
 * `label: -1`, which no real bright pixel ever carries, so that same test is
 * a silent no-op and the plate's own bright rounded-rect outline is fed to
 * the digit segmenter as if it were a glyph.
 *
 * The fix is POSITIVE identification of the frame from the plate geometry
 * `recoverDarkPlateBadges` already measured, not a percentage-of-interior
 * heuristic: `recoverDarkPlateBadges` measures the plate's glyph-bearing
 * interior as `plateBbox` inset by `plateInteriorMargin` on every side (the
 * exact rectangle it scans for `plateGlyphFraction`). Any bright component
 * touching (within `plateFrameTolerancePx` raster cells, a raster-geometry
 * allowance per the footgun law, NOT a size threshold) all four edges of
 * that same rectangle is, by construction, tracing the rectangle's own
 * boundary — i.e. the plate's printed rim — because a real digit glyph is
 * rendered centered with margin on every side and never reaches all four
 * edges at once. This is reused, not reinvented, geometry: the identical
 * inset rectangle `recoverDarkPlateBadges` already computed to measure
 * `plateGlyphFraction` at badge-discovery time.
 */

import type { Mask } from '../raster';
import type { ComponentStats } from '../components';

export interface BadgeGlyph {
	/** [x, y, w, h] of the dark interior in image coordinates; w=h=0 if none. */
	interiorBbox: [number, number, number, number];
	/** Binary glyph mask of size interior w*h (row-major). */
	mask: Mask;
	/** Bright-component labels excluded as the plate's own frame (C1 receipt
	 * provenance); empty for badges with no plate-frame geometry supplied. */
	frameLabels: readonly number[];
	/** Human-readable provenance for the frame exclusion, or null when no
	 * plate geometry was supplied (bright-family badges rely solely on the
	 * badge's own component label, which is already a positive identity). */
	frameProvenance: string | null;
}

/** The plate geometry `recoverDarkPlateBadges` already measured for a
 * `dark-plate-recovery` badge, threaded down so glyph extraction can
 * positively identify the plate's own bright frame instead of guessing. */
export interface PlateFrameGeometry {
	/** [x, y, w, h] of the ORIGINAL dark plate component, image coordinates
	 * (badgeStage.ts's `plateBboxes[i]`, pre-margin-expansion). */
	readonly plateBbox: readonly [number, number, number, number];
	/** Same inset badgeStage.ts's `recoverDarkPlateBadges` used to measure
	 * `plateGlyphFraction` (its `plateInteriorMargin` knob). */
	readonly plateInteriorMarginPx: number;
	/** Raster-cell allowance for "touches the edge" (footgun law: commented
	 * as raster geometry, not a size threshold). */
	readonly plateFrameTolerancePx: number;
}

export function extractBadgeGlyph(
	badge: ComponentStats,
	brightMask: Mask,
	darkMask: Mask,
	brightLabels: Int32Array,
	plateFrame?: PlateFrameGeometry | null
): BadgeGlyph {
	const width = brightMask.width;
	let ix0 = badge.bboxX + badge.bboxW;
	let iy0 = badge.bboxY + badge.bboxH;
	let ix1 = badge.bboxX - 1;
	let iy1 = badge.bboxY - 1;
	for (let y = badge.bboxY; y < badge.bboxY + badge.bboxH; y++) {
		const row = y * width;
		for (let x = badge.bboxX; x < badge.bboxX + badge.bboxW; x++) {
			if (darkMask.data[row + x]) {
				if (x < ix0) ix0 = x;
				if (y < iy0) iy0 = y;
				if (x > ix1) ix1 = x;
				if (y > iy1) iy1 = y;
			}
		}
	}
	if (ix1 < ix0 || iy1 < iy0) {
		return {
			interiorBbox: [0, 0, 0, 0],
			mask: { width: 0, height: 0, data: new Uint8Array(0) },
			frameLabels: [],
			frameProvenance: null
		};
	}
	const iw = ix1 - ix0 + 1;
	const ih = iy1 - iy0 + 1;

	let frameLabels: ReadonlySet<number> = new Set();
	let frameProvenance: string | null = null;
	if (plateFrame) {
		const [px, py, pw, ph] = plateFrame.plateBbox;
		const margin = plateFrame.plateInteriorMarginPx;
		const rx0 = px + margin;
		const ry0 = py + margin;
		const rx1 = px + pw - 1 - margin;
		const ry1 = py + ph - 1 - margin;
		const tol = plateFrame.plateFrameTolerancePx;
		type Bbox = { x0: number; y0: number; x1: number; y1: number };
		const labelBbox = new Map<number, Bbox>();
		for (let y = iy0; y <= iy1; y++) {
			const row = y * width;
			for (let x = ix0; x <= ix1; x++) {
				const i = row + x;
				if (!brightMask.data[i]) continue;
				const label = brightLabels[i];
				const bbox = labelBbox.get(label);
				if (!bbox) {
					labelBbox.set(label, { x0: x, y0: y, x1: x, y1: y });
				} else {
					if (x < bbox.x0) bbox.x0 = x;
					if (x > bbox.x1) bbox.x1 = x;
					if (y < bbox.y0) bbox.y0 = y;
					if (y > bbox.y1) bbox.y1 = y;
				}
			}
		}
		const found = new Set<number>();
		for (const [label, bbox] of labelBbox) {
			const reachesLeft = bbox.x0 <= rx0 + tol;
			const reachesRight = bbox.x1 >= rx1 - tol;
			const reachesTop = bbox.y0 <= ry0 + tol;
			const reachesBottom = bbox.y1 >= ry1 - tol;
			if (reachesLeft && reachesRight && reachesTop && reachesBottom) found.add(label);
		}
		frameLabels = found;
		frameProvenance =
			`plate frame excluded: bright component(s) [${[...found].join(',') || 'none'}] reach all ` +
			`4 edges of the measured plate interior [${rx0},${ry0},${rx1 - rx0 + 1}x${ry1 - ry0 + 1}] ` +
			`(plateBbox=[${px},${py},${pw},${ph}] inset by plateInteriorMargin=${margin}, ` +
			`tolerance=${tol}px raster allowance)`;
	}

	const data = new Uint8Array(iw * ih);
	for (let y = 0; y < ih; y++) {
		const src = (iy0 + y) * width;
		for (let x = 0; x < iw; x++) {
			const i = src + (ix0 + x);
			if (
				brightMask.data[i] &&
				brightLabels[i] !== badge.label &&
				!frameLabels.has(brightLabels[i])
			) {
				data[y * iw + x] = 1;
			}
		}
	}
	return {
		interiorBbox: [ix0, iy0, iw, ih],
		mask: { width: iw, height: ih, data },
		frameLabels: [...frameLabels],
		frameProvenance
	};
}
