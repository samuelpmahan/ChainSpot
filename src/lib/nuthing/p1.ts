/**
 * NuThing P1 — pure TypeScript port of scripts/nuthing-p1-canonical.py.
 *
 * The Python file is the executable reference; this port preserves its
 * learned behavior (including stable-sort tie handling and float32 reduction
 * semantics) rather than improving it. See scripts/nuthing/README.md for the
 * parity harness that proves agreement on the hydrated corpus.
 *
 * Pipeline: RGBA -> bright/dark masks -> 8-connected components -> PCA
 * orientation/extents -> repeated families -> badge family -> basket family
 * -> remaining bright -> modal tee population -> tee seeds -> canonical
 * projection -> distance/fuzzy support -> projected-border scoring -> ranked
 * candidate pool.
 */

import type { RgbaImage, Mask } from './raster';
import { computeBrightDarkMasks } from './raster';
import type { ComponentStats } from './components';
import { extractComponents, componentPixels, majorAxisOf } from './components';
import {
	anchoredFamilies,
	bboxSizeDistance,
	familySpread,
	logSizeDistance,
	median
} from './families';
import {
	CANON_SIZE,
	distanceToForeground,
	distanceTransformL2Mask3,
	fuzzySupport,
	innerCore,
	shiftMask
} from './chamfer';
import { meanF32, rintHalfEven } from './npcompat';
import { CandidatePool, TEE_THEORETICAL_FLOOR } from './candidatePool';

export const BADGE_ASPECT_MIN = 1.15;
export const BADGE_ASPECT_MAX = 1.8;
export const BADGE_DARK_INTERIOR_MIN = 0.45;
export const BADGE_SIZE_TOL = Math.log(1.15);
export const FAMILY_SIZE_TOL = Math.log(1.2);
export const MAX_OBJECT_ASPECT = 3.0;
export const TEE_SEED_COUNT = 10;
export const CANON_MAJOR_SPAN = 60.0;
export const SHIFT_VALUES = [-4, -2, 0, 2, 4];
export const F_BETA = 0.5;
export const OBSERVED_CORE_FRACTION = 0.6;

export interface TeeScoreRow {
	component: ComponentStats;
	score: number;
	explained: number;
	coverage: number;
	dx: number;
	dy: number;
}

export interface NuThingP1Result {
	width: number;
	height: number;
	brightMask: Mask;
	darkMask: Mask;
	brightLabels: Int32Array;
	brightComponents: ComponentStats[];
	darkComponents: ComponentStats[];
	badges: ComponentStats[];
	badgeCount: number;
	baskets: ComponentStats[];
	remainingBright: ComponentStats[];
	teeModalFamily: ComponentStats[];
	teeModalMajor: number;
	teeModalMinor: number;
	teeSeeds: ComponentStats[];
	teeBorderTemplate: Uint8Array;
	teeRanked: TeeScoreRow[];
	teePrimary: TeeScoreRow[];
	teeSecondaryA: TeeScoreRow[];
	teeCulledA: TeeScoreRow[];
	teeSecondaryB: TeeScoreRow[];
	teeCulledB: TeeScoreRow[];
	/** The reusable ranked-candidate primitive over the tee scoring rows. */
	teePool: CandidatePool<TeeScoreRow>;
}

function fbeta(precision: number, recall: number, beta = F_BETA): number {
	if (precision <= 0 || recall <= 0) return 0;
	const b2 = beta * beta;
	return ((1 + b2) * precision * recall) / (b2 * precision + recall);
}

export interface CanonicalProjection {
	mask: Uint8Array;
	/** Foreground pixel indices in raster order (y * CANON_SIZE + x). */
	pixels: Int32Array;
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/**
 * Project one component's pixels into the CANON_SIZE canonical square along
 * its PCA major/minor axes, scaled so the modal tee major axis spans
 * CANON_MAJOR_SPAN. Exported for reuse by downstream per-candidate tasks
 * (e.g. scripts/nuthing/two-pass-tees.ts) that need the same canonical mask
 * scoreTeeComponent() scores against.
 */
export function canonicalComponentMask(
	brightLabels: Int32Array,
	width: number,
	c: ComponentStats,
	canonScale: number
): CanonicalProjection {
	const mask = new Uint8Array(CANON_SIZE * CANON_SIZE);
	const { xs, ys, count } = componentPixels(brightLabels, width, c);
	if (count < 2) {
		return { mask, pixels: new Int32Array(0), minX: 0, minY: 0, maxX: -1, maxY: -1 };
	}
	let sx = 0;
	let sy = 0;
	for (let i = 0; i < count; i++) {
		sx += xs[i];
		sy += ys[i];
	}
	const cx = sx / count;
	const cy = sy / count;
	let cxx = 0;
	let cxy = 0;
	let cyy = 0;
	for (let i = 0; i < count; i++) {
		const dx = xs[i] - cx;
		const dy = ys[i] - cy;
		cxx += dx * dx;
		cxy += dx * dy;
		cyy += dy * dy;
	}
	cxx /= count;
	cxy /= count;
	cyy /= count;
	const { ax, ay } = majorAxisOf(cxx, cxy, cyy);
	const mx = -ay;
	const my = ax;
	const centerCanon = (CANON_SIZE - 1) / 2;
	for (let i = 0; i < count; i++) {
		const dx = xs[i] - cx;
		const dy = ys[i] - cy;
		const u = dx * ax + dy * ay;
		const v = dx * mx + dy * my;
		const px = rintHalfEven(centerCanon + u * canonScale);
		const py = rintHalfEven(centerCanon + v * canonScale);
		if (px >= 0 && px < CANON_SIZE && py >= 0 && py < CANON_SIZE) {
			mask[py * CANON_SIZE + px] = 1;
		}
	}
	let minX = CANON_SIZE;
	let minY = CANON_SIZE;
	let maxX = -1;
	let maxY = -1;
	const pix: number[] = [];
	for (let y = 0; y < CANON_SIZE; y++) {
		for (let x = 0; x < CANON_SIZE; x++) {
			if (mask[y * CANON_SIZE + x]) {
				pix.push(y * CANON_SIZE + x);
				if (x < minX) minX = x;
				if (y < minY) minY = y;
				if (x > maxX) maxX = x;
				if (y > maxY) maxY = y;
			}
		}
	}
	return { mask, pixels: Int32Array.from(pix), minX, minY, maxX, maxY };
}

const MAX_SHIFT = 4;
const PAD = MAX_SHIFT;
const PADDED = CANON_SIZE + 2 * PAD;

/**
 * Score one candidate against the border template across the 5x5 shift grid,
 * reproducing score_tee_component() exactly.
 *
 * Fast path: when the canonical pattern keeps >= 1 px of empty margin inside
 * the canonical square under every shift (bbox within [PAD+1, CANON-PAD-2]),
 * shifting commutes with inner_core and with the chamfer fields (chamfer
 * staircase paths stay inside the grid), so the observed core and a padded
 * distance-to-foreground field are computed once and only the two float32
 * means are recomputed per shift. Otherwise falls back to the literal
 * per-shift computation.
 */
function scoreTeeComponent(
	proj: CanonicalProjection,
	templateFuzzy: Float32Array,
	templatePixels: Int32Array,
	scratch: Float32Array
): { score: number; explained: number; coverage: number; dx: number; dy: number } | null {
	if (proj.pixels.length === 0) {
		// Baseline still evaluates the empty mask: observed core is empty for
		// every shift, so every shift is skipped and the component is dropped.
		return null;
	}
	const fastPath =
		proj.minX >= PAD + 1 &&
		proj.minY >= PAD + 1 &&
		proj.maxX <= CANON_SIZE - PAD - 2 &&
		proj.maxY <= CANON_SIZE - PAD - 2;

	let best: {
		score: number;
		explained: number;
		coverage: number;
		dx: number;
		dy: number;
	} | null = null;

	if (fastPath) {
		const core = innerCore(proj.mask, OBSERVED_CORE_FRACTION);
		const corePixels: number[] = [];
		for (let i = 0; i < core.length; i++) if (core[i]) corePixels.push(i);
		if (corePixels.length === 0) return null;
		// Padded distance-to-foreground of the unshifted pattern.
		const padded = new Uint8Array(PADDED * PADDED);
		for (const p of proj.pixels) {
			const x = p % CANON_SIZE;
			const y = (p / CANON_SIZE) | 0;
			padded[(y + PAD) * PADDED + (x + PAD)] = 1;
		}
		const paddedDist = distanceToForeground(padded, PADDED, PADDED);
		const paddedFuzzy = new Float32Array(paddedDist.length);
		for (let i = 0; i < paddedDist.length; i++) paddedFuzzy[i] = fuzzySupport(paddedDist[i]);

		for (const dy of SHIFT_VALUES) {
			for (const dx of SHIFT_VALUES) {
				// explained: template support at the shifted observed-core pixels.
				let k = 0;
				for (const p of corePixels) {
					const x = (p % CANON_SIZE) + dx;
					const y = ((p / CANON_SIZE) | 0) + dy;
					scratch[k++] = templateFuzzy[y * CANON_SIZE + x];
				}
				const explained = meanF32(scratch, k);
				// coverage: candidate support at the template pixels (padded lookup).
				k = 0;
				for (const t of templatePixels) {
					const x = (t % CANON_SIZE) - dx + PAD;
					const y = ((t / CANON_SIZE) | 0) - dy + PAD;
					scratch[k++] = paddedFuzzy[y * PADDED + x];
				}
				const coverage = meanF32(scratch, k);
				const score = fbeta(explained, coverage);
				if (best === null || score > best.score) {
					best = { score, explained, coverage, dx, dy };
				}
			}
		}
		return best;
	}

	// Literal fallback (patterns near/over the canonical border).
	for (const dy of SHIFT_VALUES) {
		for (const dx of SHIFT_VALUES) {
			const candidate = shiftMask(proj.mask, dx, dy);
			const core = innerCore(candidate, OBSERVED_CORE_FRACTION);
			let k = 0;
			for (let i = 0; i < core.length; i++) {
				if (core[i]) scratch[k++] = templateFuzzy[i];
			}
			if (k === 0) continue;
			const explained = meanF32(scratch, k);
			const candidateDist = distanceToForeground(candidate, CANON_SIZE, CANON_SIZE);
			k = 0;
			for (const t of templatePixels) {
				scratch[k++] = fuzzySupport(candidateDist[t]);
			}
			const coverage = meanF32(scratch, k);
			const score = fbeta(explained, coverage);
			if (best === null || score > best.score) {
				best = { score, explained, coverage, dx, dy };
			}
		}
	}
	return best;
}

export function runNuThingP1(image: RgbaImage): NuThingP1Result {
	const { width, height } = image;
	const { bright, dark } = computeBrightDarkMasks(image);
	const { labels: brightLabels, components: brightComponents } = extractComponents(bright);
	const { components: darkComponents } = extractComponents(dark);

	// Badge family: white screen-aligned frame + dark interior + repeated bbox size.
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
		const darkFraction = darkCount / (c.bboxW * c.bboxH);
		if (darkFraction >= BADGE_DARK_INTERIOR_MIN) badgeCandidates.push(c);
	}

	const badgeFamilies = anchoredFamilies(badgeCandidates, BADGE_SIZE_TOL, bboxSizeDistance);
	if (badgeFamilies.length === 0) {
		throw new Error('No repeated white badge-frame family found');
	}
	const badges = badgeFamilies[0];
	const badgeCount = badges.length;
	const badgeLabels = new Set(badges.map((c) => c.label));
	const brightWithoutBadges = brightComponents.filter((c) => !badgeLabels.has(c.label));

	// Basket family: repeated bright family whose cardinality is closest to badges.
	const basketPool = brightWithoutBadges.filter(
		(c) => c.minor > 0 && c.major / c.minor <= MAX_OBJECT_ASPECT
	);
	const basketFamilies = anchoredFamilies(basketPool, FAMILY_SIZE_TOL);
	if (basketFamilies.length === 0) {
		throw new Error('No repeated bright family available for basket discovery');
	}
	let baskets = basketFamilies[0];
	let bestKey: [number, number] = [
		Math.abs(basketFamilies[0].length - badgeCount),
		familySpread(basketFamilies[0])
	];
	for (let i = 1; i < basketFamilies.length; i++) {
		const key: [number, number] = [
			Math.abs(basketFamilies[i].length - badgeCount),
			familySpread(basketFamilies[i])
		];
		if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
			baskets = basketFamilies[i];
			bestKey = key;
		}
	}
	const basketLabels = new Set(baskets.map((c) => c.label));
	const remainingBright = brightWithoutBadges.filter((c) => !basketLabels.has(c.label));

	// Tee mode discovery: geometry discovers the normal population and scale only.
	const teeFamilyCandidates = anchoredFamilies(
		remainingBright.filter((c) => c.minor > 0 && c.major / c.minor <= MAX_OBJECT_ASPECT),
		FAMILY_SIZE_TOL
	);
	if (teeFamilyCandidates.length === 0) {
		throw new Error('No repeated tee-scale bright family found');
	}
	let modalFamily = teeFamilyCandidates[0];
	for (const fam of teeFamilyCandidates) {
		if (fam.length > modalFamily.length) modalFamily = fam;
	}
	const modalMajor = median(modalFamily.map((c) => c.major));
	const modalMinor = median(modalFamily.map((c) => c.minor));

	const distanceToTeeMode = (c: ComponentStats): number =>
		logSizeDistance(c.major, c.minor, modalMajor, modalMinor);
	const seedOrder = modalFamily
		.map((c, i) => [c, i] as const)
		.sort((a, b) => distanceToTeeMode(a[0]) - distanceToTeeMode(b[0]) || a[1] - b[1])
		.map(([c]) => c);
	const teeSeeds = seedOrder.slice(0, Math.min(TEE_SEED_COUNT, seedOrder.length));
	const canonScale = CANON_MAJOR_SPAN / modalMajor;

	// Border template: mean fuzzy support of the seed masks, thresholded at 0.5.
	// numpy reduces the seed stack sequentially in float32.
	const seedSupportSum = new Float32Array(CANON_SIZE * CANON_SIZE);
	for (const seed of teeSeeds) {
		const seedMask = canonicalComponentMask(brightLabels, width, seed, canonScale).mask;
		const seedDist = distanceToForeground(seedMask, CANON_SIZE, CANON_SIZE);
		for (let i = 0; i < seedSupportSum.length; i++) {
			seedSupportSum[i] = Math.fround(seedSupportSum[i] + fuzzySupport(seedDist[i]));
		}
	}
	const teeBorderTemplate = new Uint8Array(CANON_SIZE * CANON_SIZE);
	for (let i = 0; i < teeBorderTemplate.length; i++) {
		const likelihood = Math.fround(seedSupportSum[i] / teeSeeds.length);
		if (likelihood >= 0.5) teeBorderTemplate[i] = 1;
	}
	const templateDistance = distanceToForeground(teeBorderTemplate, CANON_SIZE, CANON_SIZE);
	const templateFuzzy = new Float32Array(templateDistance.length);
	for (let i = 0; i < templateDistance.length; i++) {
		templateFuzzy[i] = fuzzySupport(templateDistance[i]);
	}
	const templatePixelList: number[] = [];
	for (let i = 0; i < teeBorderTemplate.length; i++) {
		if (teeBorderTemplate[i]) templatePixelList.push(i);
	}
	const templatePixels = Int32Array.from(templatePixelList);

	const scratch = new Float32Array(CANON_SIZE * CANON_SIZE);
	const teeRanked: TeeScoreRow[] = [];
	for (const c of remainingBright) {
		const proj = canonicalComponentMask(brightLabels, width, c, canonScale);
		const row = scoreTeeComponent(proj, templateFuzzy, templatePixels, scratch);
		if (row !== null) teeRanked.push({ component: c, ...row });
	}
	teeRanked
		.map((r, i) => [r, i] as const)
		.sort((a, b) => b[0].score - a[0].score || a[1] - b[1])
		.forEach(([r], i) => {
			teeRanked[i] = r;
		});

	// Primary is priority/ranking status, not a truth claim.
	const primaryCount = Math.min(badgeCount, teeRanked.length);
	const teePrimary = teeRanked.slice(0, primaryCount);
	const teeLeftovers = teeRanked.slice(primaryCount);
	const teeSecondaryA = teeLeftovers.slice();
	const teeCulledA: TeeScoreRow[] = [];
	const teeSecondaryB = teeLeftovers.filter((r) => r.score >= TEE_THEORETICAL_FLOOR);
	const teeCulledB = teeLeftovers.filter((r) => r.score < TEE_THEORETICAL_FLOOR);

	const teePool = new CandidatePool(
		teeRanked.map((r) => ({ value: r, score: r.score })),
		{ primaryCount: badgeCount, theoreticalFloor: TEE_THEORETICAL_FLOOR, preRanked: true }
	);

	return {
		width,
		height,
		brightMask: bright,
		darkMask: dark,
		brightLabels,
		brightComponents,
		darkComponents,
		badges,
		badgeCount,
		baskets,
		remainingBright,
		teeModalFamily: modalFamily,
		teeModalMajor: modalMajor,
		teeModalMinor: modalMinor,
		teeSeeds,
		teeBorderTemplate,
		teeRanked,
		teePrimary,
		teeSecondaryA,
		teeCulledA,
		teeSecondaryB,
		teeCulledB,
		teePool
	};
}
