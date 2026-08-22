/**
 * Occlusion-aware support patching at badge crossings.
 *
 * The badge is an opaque rounded rect drawn ON TOP of the corridor. Around
 * it the paired-edge field fails twice over: the badge's own black/white
 * boundary produces strong edge pairs at every orientation (a false halo
 * that attracts routes to the badge's corners — the observed "swerve along
 * the badge diagonal"), while the true ribbon loses one or both edges and
 * its support collapses. Both failures are fixable because the occluder is
 * KNOWN: badge bboxes are detected precisely, and the corridor is a
 * rectangle of one known width W per course.
 *
 * Two patches, applied to the support plane in place:
 *
 * 1. HALO CAP — support within bbox+3 is clamped to a moderate passable
 *    level. A known occluder's boundary is never ribbon evidence; the
 *    interior stays crossable (like the endpoint waiver) but stops being
 *    an attractor.
 *
 * 2. ONE-SIDED EDGE EVIDENCE — the slow detector for "we know one side is
 *    blocked": for cells in the badge's neighborhood and each test
 *    orientation, take the standard four paired samples at ±(W/2∓δ) along
 *    the normal, at full source resolution. If exactly one side's samples
 *    fall inside a badge bbox, score the cell from the VISIBLE side alone:
 *    positive-polarity paint lift (corridor interior is brighter than the
 *    ground outside its edge — measured +33..+48 gray) at the correct
 *    distance W/2, which places the centerline without seeing the blocked
 *    edge. The best orientation's score, normalized by the course's ribbon
 *    lift, is written into the support plane (max, capped below halo
 *    level's complement) so the route crosses the badge straight along the
 *    reconstructed centerline instead of hugging the badge diagonal.
 */

import type { RgbaImage } from './raster';
import type { SupportField } from './ribbon';

export interface BadgeBoxLike {
	bboxX: number;
	bboxY: number;
	bboxW: number;
	bboxH: number;
}

/** Per-course rendered corridor width (source px). Render-stack constants:
 * the corpus annotations carry ONE corridorWidthPx per course (identical for
 * every hole), and FWHM paint measurement agrees within a few px. */
export const COURSE_CORRIDOR_WIDTH: Record<string, number> = {
	'DashsTrack-full': 40,
	'HeritagePark-full': 30,
	'Lenard-full': 37,
	'TowneLake-full': 37
};
export const DEFAULT_CORRIDOR_WIDTH = 37;

const HALO_CAP = 0.5;
const ORIENTATIONS = 24;
const DELTA = 2.5;
const PATCH_MAX = 0.85;
/** Reference paint lift (gray) that maps to full one-sided confidence. */
const LIFT_REF = 45;

export interface BadgeOcclusionOptions {
	/** Enable the one-sided edge evidence pass (halo cap always applies). */
	oneSided?: boolean;
	/** Minimum normalized one-sided score to write (floor against weak flank
	 * lifts manufacturing false crossings). */
	minScore?: number;
}

export function patchBadgeOcclusion(
	field: SupportField,
	image: RgbaImage,
	badges: readonly BadgeBoxLike[],
	corridorWidthPx: number,
	options?: BadgeOcclusionOptions
): { haloCells: number; patchedCells: number } {
	const oneSided = options?.oneSided ?? true;
	const minScore = options?.minScore ?? 0.5;
	const { width: fw, height: fh, scale, support } = field;
	const inflate = 3;
	const inBadge = (x: number, y: number): boolean => {
		for (const b of badges) {
			if (
				x >= b.bboxX - 2 &&
				x <= b.bboxX + b.bboxW + 2 &&
				y >= b.bboxY - 2 &&
				y <= b.bboxY + b.bboxH + 2
			)
				return true;
		}
		return false;
	};
	const gray = (x: number, y: number): number | null => {
		const xi = Math.round(x);
		const yi = Math.round(y);
		if (xi < 0 || xi >= image.width || yi < 0 || yi >= image.height) return null;
		const p = (yi * image.width + xi) * 4;
		return (image.data[p] + image.data[p + 1] + image.data[p + 2]) / 3;
	};

	let haloCells = 0;
	let patchedCells = 0;
	const half = corridorWidthPx / 2;
	const reach = half + 6; // neighborhood beyond the bbox where a side can be blocked

	for (const b of badges) {
		// 1. Halo cap on the badge box itself.
		const hx0 = Math.max(0, Math.floor((b.bboxX - inflate) / scale));
		const hx1 = Math.min(fw - 1, Math.ceil((b.bboxX + b.bboxW + inflate) / scale));
		const hy0 = Math.max(0, Math.floor((b.bboxY - inflate) / scale));
		const hy1 = Math.min(fh - 1, Math.ceil((b.bboxY + b.bboxH + inflate) / scale));
		for (let fy = hy0; fy <= hy1; fy++) {
			for (let fx = hx0; fx <= hx1; fx++) {
				const i = fy * fw + fx;
				if (support[i] > HALO_CAP) {
					support[i] = HALO_CAP;
					haloCells++;
				}
			}
		}

		// 2. One-sided evidence in the surrounding band.
		if (!oneSided) continue;
		const nx0 = Math.max(0, Math.floor((b.bboxX - reach) / scale));
		const nx1 = Math.min(fw - 1, Math.ceil((b.bboxX + b.bboxW + reach) / scale));
		const ny0 = Math.max(0, Math.floor((b.bboxY - reach) / scale));
		const ny1 = Math.min(fh - 1, Math.ceil((b.bboxY + b.bboxH + reach) / scale));
		for (let fy = ny0; fy <= ny1; fy++) {
			for (let fx = nx0; fx <= nx1; fx++) {
				const sx = fx * scale + scale / 2;
				const sy = fy * scale + scale / 2;
				let best = 0;
				for (let o = 0; o < ORIENTATIONS; o++) {
					const theta = (o / ORIENTATIONS) * Math.PI;
					const nxu = -Math.sin(theta);
					const nyu = Math.cos(theta);
					const pts = [
						[sx - nxu * (half - DELTA), sy - nyu * (half - DELTA)],
						[sx - nxu * (half + DELTA), sy - nyu * (half + DELTA)],
						[sx + nxu * (half - DELTA), sy + nyu * (half - DELTA)],
						[sx + nxu * (half + DELTA), sy + nyu * (half + DELTA)]
					];
					const leftBlocked = inBadge(pts[0][0], pts[0][1]) || inBadge(pts[1][0], pts[1][1]);
					const rightBlocked = inBadge(pts[2][0], pts[2][1]) || inBadge(pts[3][0], pts[3][1]);
					if (leftBlocked === rightBlocked) continue; // 0 or 2 sides blocked
					const io = leftBlocked ? [2, 3] : [0, 1];
					const gIn = gray(pts[io[0]][0], pts[io[0]][1]);
					const gOut = gray(pts[io[1]][0], pts[io[1]][1]);
					if (gIn === null || gOut === null) continue;
					if (inBadge(pts[io[0]][0], pts[io[0]][1]) || inBadge(pts[io[1]][0], pts[io[1]][1]))
						continue;
					// Positive paint polarity only: interior brighter than outside.
					const lift = gIn - gOut;
					if (lift <= 0) continue;
					// The center itself, when visible, must also look painted
					// (brighter than the visible-side outside ground).
					const gC = gray(sx, sy);
					if (gC !== null && !inBadge(sx, sy) && gC - gOut < -8) continue;
					const score = Math.min(1, lift / LIFT_REF);
					if (score > best) best = score;
				}
				if (best >= Math.max(1e-9, minScore)) {
					const i = fy * fw + fx;
					const patched = Math.min(PATCH_MAX, best);
					if (patched > support[i]) {
						support[i] = patched;
						patchedCells++;
					}
				}
			}
		}
	}
	return { haloCells, patchedCells };
}
