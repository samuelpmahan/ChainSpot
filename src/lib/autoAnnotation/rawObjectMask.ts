/**
 * Pancake 1: one cheap whole-raster mask pass that localizes the three
 * physical UDisc glyph families ChainSpot needs before any semantic ownership:
 *
 *   - white tee-pad frames
 *   - dark number-badge bodies (UNLABELED here)
 *   - white basket/pin glyphs
 *
 * This module intentionally does NOT know hole numbers, course grammar,
 * endpoint distance, tee->badge ownership, or basket ownership. It is a raw
 * object localizer only.
 *
 * The raster is scanned exactly once to build two binary masks:
 *
 *   bright: high-value, low-saturation overlay pixels
 *   dark:   near-black overlay pixels
 *
 * Connected components are then measured on those masks. Basket and badge
 * families are selected by repeated same-size glyph consensus; tees are the
 * remaining pad-sized bright components after removing badge interiors and
 * using the two UI glyph families as scale references, then a cheap
 * rotation-normalized appearance check (see teeAppearance.ts) against a
 * small real-tee template bank, since on-screen UI chrome (map-control
 * button text, attribution watermarks) can satisfy the same size/aspect/
 * fill bounds as a real tee-pad.
 *
 * Observability: every gate is a named Toph check (src/lib/toph/trace.ts).
 * Production passes no trace and pays only no-op comparisons; harnesses pass
 * a recording trace and get per-component first-loss attribution. Gate
 * thresholds are grouped in RAW_MASK_TUNING_DEFAULTS so offline sweeps can
 * override them without editing this module; production callers pass nothing
 * and get the tuned 4-course-corpus defaults (see
 * scripts/cv-probes/toph-p1-corpus-tuning-findings.md), not the pre-tuning
 * historical constants.
 */

import {
	bestTeeTemplateScore,
	extractCanonicalTeePatch,
	passesTeeAppearanceCheck,
	type TeeAppearanceCandidate
} from './teeAppearance';
import { NOOP, type Trace } from '../toph/trace';

export interface RawObjectMaskRaster {
	readonly rgba: Uint8Array | Uint8ClampedArray;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface RawMaskTee {
	readonly xPx: number;
	readonly yPx: number;
	readonly orientationDeg: number;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly areaPx: number;
	readonly fill: number;
}

export interface RawMaskBadge {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly areaPx: number;
	readonly fill: number;
}

export interface RawMaskBasket {
	readonly xPx: number;
	readonly yPx: number;
	readonly centerXPx: number;
	readonly centerYPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly areaPx: number;
	readonly fill: number;
}

export interface RawObjectMaskDiagnostics {
	readonly brightComponentCount: number;
	readonly darkComponentCount: number;
	readonly basketShapePoolCount: number;
	readonly badgeShapePoolCount: number;
	readonly thresholds: {
		readonly brightValueMin: number;
		readonly brightSaturationMax: number;
		readonly darkValueMax: number;
	};
}

export interface RawObjectMaskResult {
	readonly tees: readonly RawMaskTee[];
	readonly badges: readonly RawMaskBadge[];
	readonly baskets: readonly RawMaskBasket[];
	readonly diagnostics: RawObjectMaskDiagnostics;
}

interface MaskComponent {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly areaPx: number;
	readonly centroidX: number;
	readonly centroidY: number;
	readonly orientationDeg: number;
	readonly fill: number;
}

/**
 * Every numeric gate in the P1 pass, defaulting to the tuned 4-course-corpus
 * values in RAW_MASK_TUNING_DEFAULTS below (see
 * scripts/cv-probes/toph-p1-corpus-tuning-findings.md), not the pre-tuning
 * historical constants. Grey-interior COLOR band is deliberately excluded
 * (borrowed from teePadDetection's proven constants); only its fraction
 * floor is here.
 */
export interface RawMaskTuning {
	readonly brightValueMin: number;
	readonly brightSaturationMax: number;
	readonly darkValueMax: number;
	readonly basketPoolMinAreaPx: number;
	readonly basketPoolMinWidthPx: number;
	readonly basketPoolMinHeightPx: number;
	readonly basketPoolAspectMin: number;
	readonly basketPoolAspectMax: number;
	readonly basketPoolFillMin: number;
	readonly basketPoolFillMax: number;
	/**
	 * When non-null, bright components whose centroid falls inside a detected
	 * badge body (grown by this fraction of badge median height, min 2px) are
	 * excluded from the basket shape pool — the same exclusion the tee family
	 * already applies. Rationale: the white hole-number digits inside badges
	 * are pad-sized bright components that can outvote the real baskets in
	 * size consensus (observed: Lenard, 17-digit impostor cluster vs 16 real
	 * baskets). Null (the default) preserves the historical behavior exactly.
	 */
	readonly basketPoolExcludeInsideBadgeMarginFrac: number | null;
	readonly basketClusterSizeRelTolerance: number;
	readonly basketClusterAreaRelTolerance: number;
	readonly badgePoolMinAreaPx: number;
	readonly badgePoolMinWidthPx: number;
	readonly badgePoolMinHeightPx: number;
	readonly badgePoolAspectMin: number;
	readonly badgePoolAspectMax: number;
	readonly badgePoolFillMin: number;
	readonly badgeClusterSizeRelTolerance: number;
	readonly badgeClusterAreaRelTolerance: number;
	readonly teeVerticalMarginBadgeHeights: number;
	readonly teeBadgeOverlapMarginFrac: number;
	readonly teeAreaVsBasketMin: number;
	readonly teeAreaVsBasketMax: number;
	readonly teeMinDimBadgeHeightFrac: number;
	readonly teeMaxDimBasketWidthFactor: number;
	readonly teeBboxAspectMax: number;
	readonly teeFillMin: number;
	readonly teeFillMax: number;
	readonly teeMinGreyInteriorFraction: number;
	readonly teeAppearanceThreshold: number;
}

export const RAW_MASK_TUNING_DEFAULTS: RawMaskTuning = Object.freeze({
	brightValueMin: 210,
	brightSaturationMax: 45,
	darkValueMax: 45,
	basketPoolMinAreaPx: 80,
	basketPoolMinWidthPx: 8,
	basketPoolMinHeightPx: 12,
	basketPoolAspectMin: 1.25,
	basketPoolAspectMax: 2.2,
	basketPoolFillMin: 0.26,
	basketPoolFillMax: 0.8,
	basketPoolExcludeInsideBadgeMarginFrac: 0.08,
	basketClusterSizeRelTolerance: 0.12,
	basketClusterAreaRelTolerance: 0.22,
	badgePoolMinAreaPx: 80,
	badgePoolMinWidthPx: 12,
	badgePoolMinHeightPx: 9,
	badgePoolAspectMin: 1.15,
	badgePoolAspectMax: 1.75,
	badgePoolFillMin: 0.6,
	badgeClusterSizeRelTolerance: 0.12,
	badgeClusterAreaRelTolerance: 0.22,
	teeVerticalMarginBadgeHeights: 4,
	teeBadgeOverlapMarginFrac: 0.08,
	teeAreaVsBasketMin: 0.06,
	teeAreaVsBasketMax: 0.35,
	teeMinDimBadgeHeightFrac: 0.3,
	teeMaxDimBasketWidthFactor: 2,
	teeBboxAspectMax: 2.2,
	teeFillMin: 0.12,
	teeFillMax: 0.55,
	teeMinGreyInteriorFraction: 0.05,
	teeAppearanceThreshold: 0.38
});

function normalizeAxisDeg(value: number): number {
	return ((value % 180) + 180) % 180;
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

function collectComponents(
	mask: Uint8Array,
	width: number,
	height: number,
	queue: Int32Array,
	labels?: Uint16Array
): MaskComponent[] {
	const components: MaskComponent[] = [];
	for (let seed = 0; seed < mask.length; seed += 1) {
		if (mask[seed] !== 1) continue;

		const label = components.length + 1;
		let head = 0;
		let tail = 0;
		queue[tail++] = seed;
		mask[seed] = 2;

		let minX = width;
		let minY = height;
		let maxX = -1;
		let maxY = -1;
		let area = 0;
		let sumX = 0;
		let sumY = 0;
		let sumXX = 0;
		let sumXY = 0;
		let sumYY = 0;

		while (head < tail) {
			const index = queue[head++];
			if (labels) labels[index] = label;
			const x = index % width;
			const y = (index - x) / width;

			area += 1;
			sumX += x;
			sumY += y;
			sumXX += x * x;
			sumXY += x * y;
			sumYY += y * y;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;

			const y0 = Math.max(0, y - 1);
			const y1 = Math.min(height - 1, y + 1);
			const x0 = Math.max(0, x - 1);
			const x1 = Math.min(width - 1, x + 1);
			for (let ny = y0; ny <= y1; ny += 1) {
				const row = ny * width;
				for (let nx = x0; nx <= x1; nx += 1) {
					if (nx === x && ny === y) continue;
					const neighbor = row + nx;
					if (mask[neighbor] !== 1) continue;
					mask[neighbor] = 2;
					queue[tail++] = neighbor;
				}
			}
		}

		if (area === 0) continue;
		const centroidX = sumX / area;
		const centroidY = sumY / area;
		const covXX = sumXX / area - centroidX * centroidX;
		const covXY = sumXY / area - centroidX * centroidY;
		const covYY = sumYY / area - centroidY * centroidY;
		const orientationDeg = normalizeAxisDeg(
			(0.5 * Math.atan2(2 * covXY, covXX - covYY) * 180) / Math.PI
		);
		const widthPx = maxX - minX + 1;
		const heightPx = maxY - minY + 1;

		components.push({
			minX,
			minY,
			maxX,
			maxY,
			widthPx,
			heightPx,
			areaPx: area,
			centroidX,
			centroidY,
			orientationDeg,
			fill: area / (widthPx * heightPx)
		});
	}
	return components;
}

function dominantSizeCluster(
	components: readonly MaskComponent[],
	sizeRelativeTolerance: number,
	areaRelativeTolerance: number
): { cluster: MaskComponent[]; anchor: MaskComponent | null } {
	let best: MaskComponent[] = [];
	let bestAnchor: MaskComponent | null = null;
	for (const anchor of components) {
		const widthTolerance = Math.max(2, anchor.widthPx * sizeRelativeTolerance);
		const heightTolerance = Math.max(2, anchor.heightPx * sizeRelativeTolerance);
		const areaTolerance = Math.max(30, anchor.areaPx * areaRelativeTolerance);
		const cluster = components.filter(
			(component) =>
				Math.abs(component.widthPx - anchor.widthPx) <= widthTolerance &&
				Math.abs(component.heightPx - anchor.heightPx) <= heightTolerance &&
				Math.abs(component.areaPx - anchor.areaPx) <= areaTolerance
		);
		if (cluster.length > best.length) {
			best = cluster;
			bestAnchor = anchor;
		}
	}
	return { cluster: best, anchor: bestAnchor };
}

function bboxCenter(component: MaskComponent): { xPx: number; yPx: number } {
	return {
		xPx: (component.minX + component.maxX) / 2,
		yPx: (component.minY + component.maxY) / 2
	};
}

function centerFallsInsideBadge(
	component: MaskComponent,
	badges: readonly MaskComponent[],
	marginPx: number
): boolean {
	return badges.some(
		(badge) =>
			component.centroidX >= badge.minX - marginPx &&
			component.centroidX <= badge.maxX + marginPx &&
			component.centroidY >= badge.minY - marginPx &&
			component.centroidY <= badge.maxY + marginPx
	);
}

function sortComponents(components: readonly MaskComponent[]): MaskComponent[] {
	return [...components].sort(
		(a, b) => a.centroidY - b.centroidY || a.centroidX - b.centroidX
	);
}

/**
 * A real tee pad's bright rectangular frame surrounds a genuinely grey
 * rubber/concrete interior. Nothing upstream actually checks for that grey
 * interior: the `fill` gate (`component.fill` between 0.12 and 0.55, in
 * `detectRawObjectMask`) only requires that a chunk of the bounding box NOT
 * be part of the bright mask -- it accepts "not bright" at face value without
 * ever checking what that non-bright majority actually looks like. A large,
 * uniformly bright surface with irregular edges (a rooftop, a sunlit stretch
 * of pavement) can fragment into a similarly hollow-looking bright component
 * purely from occlusion/shadow noise at its boundary, without ever containing
 * a genuine grey pad interior anywhere inside it -- exactly the false
 * positive this rejects (a Heritage Park rooftop, auto-applied as hole 1's
 * tee 500+ px from the real one, live-tested against the real course image).
 *
 * The grey band itself is `teePadDetection.ts`'s own proven
 * `GRAY_CENTER_DEFAULT_*` constants (value 148-168, saturation < 18, widened
 * by that module's own adaptive margins) -- reused rather than reinvented,
 * since that module already empirically tuned this exact color against real
 * UDisc tee-pad interiors. A wider "just not bright, not dark" band was tried
 * first and rejected: it isn't a real detector against the actual false
 * positive (a real Heritage Park rooftop crop scores 34.6% under a wide
 * "not bright, not dark" band purely from shadow/pavement in the same
 * connected component, vs. 0.2% under this narrow one). The bar for "has a
 * grey interior" is deliberately low (a small fraction of the bounding box,
 * not a majority) -- this is a sanity check against "no grey at all", not a
 * positive detector; genuine tee-pad candidates with a thin grey sliver still
 * pass easily.
 */
const GREY_INTERIOR_VALUE_MIN = 142; // GRAY_CENTER_DEFAULT_VALUE_MIN(148) - ADAPTIVE_GRAY_CENTER_VALUE_MARGIN(6)
const GREY_INTERIOR_VALUE_MAX = 174; // GRAY_CENTER_DEFAULT_VALUE_MAX(168) + ADAPTIVE_GRAY_CENTER_VALUE_MARGIN(6)
const GREY_INTERIOR_SATURATION_MAX = 21; // GRAY_CENTER_DEFAULT_SATURATION_MAX(18) + ADAPTIVE_GRAY_CENTER_SATURATION_MARGIN(3)
const MIN_GREY_INTERIOR_FRACTION = 0.05;

/** The bounding-box subset `hasGreyInterior` needs -- deliberately narrower than the full (private) `MaskComponent`, so it stays directly testable without constructing one. */
export interface GreyInteriorBounds {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
}

export function greyInteriorFraction(
	raster: RawObjectMaskRaster,
	bounds: GreyInteriorBounds
): number {
	const { rgba, widthPx: width } = raster;
	let sampled = 0;
	let grey = 0;
	for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
		for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
			const offset = (y * width + x) * 4;
			const r = rgba[offset];
			const g = rgba[offset + 1];
			const b = rgba[offset + 2];
			const max = r > g ? (r > b ? r : b) : g > b ? g : b;
			const min = r < g ? (r < b ? r : b) : g < b ? g : b;
			const saturation = max === 0 ? 0 : Math.round(((max - min) * 255) / max);
			sampled += 1;
			if (
				max >= GREY_INTERIOR_VALUE_MIN &&
				max <= GREY_INTERIOR_VALUE_MAX &&
				saturation < GREY_INTERIOR_SATURATION_MAX
			) {
				grey += 1;
			}
		}
	}
	return sampled > 0 ? grey / sampled : 0;
}

export function hasGreyInterior(raster: RawObjectMaskRaster, bounds: GreyInteriorBounds): boolean {
	return greyInteriorFraction(raster, bounds) >= MIN_GREY_INTERIOR_FRACTION;
}

export function detectRawObjectMask(
	raster: RawObjectMaskRaster,
	trace?: Trace,
	tuning?: Partial<RawMaskTuning>
): RawObjectMaskResult {
	const t = trace ?? NOOP;
	const p: RawMaskTuning = tuning
		? { ...RAW_MASK_TUNING_DEFAULTS, ...tuning }
		: RAW_MASK_TUNING_DEFAULTS;
	const { rgba, widthPx: width, heightPx: height } = raster;
	if (
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width <= 0 ||
		height <= 0 ||
		rgba.length < width * height * 4
	) {
		throw new Error('Raw object mask received an invalid RGBA raster.');
	}

	const pixelCount = width * height;
	const bright = new Uint8Array(pixelCount);
	const dark = new Uint8Array(pixelCount);

	for (let index = 0; index < pixelCount; index += 1) {
		const offset = index * 4;
		const r = rgba[offset];
		const g = rgba[offset + 1];
		const b = rgba[offset + 2];
		const max = r > g ? (r > b ? r : b) : g > b ? g : b;
		const min = r < g ? (r < b ? r : b) : g < b ? g : b;
		const saturation = max === 0 ? 0 : Math.round(((max - min) * 255) / max);

		if (max > p.brightValueMin && saturation < p.brightSaturationMax) bright[index] = 1;
		if (max <= p.darkValueMax) dark[index] = 1;
	}

	t.stage('p1.masks');
	const brightMaskAsset = t.enabled
		? t.raster('brightMask', 'mask', bright, width, height, {
				op: {
					name: 'hsvThreshold',
					params: { valueMin: p.brightValueMin, saturationMax: p.brightSaturationMax }
				}
			})
		: 0;
	const darkMaskAsset = t.enabled
		? t.raster('darkMask', 'mask', dark, width, height, {
				op: { name: 'hsvThreshold', params: { valueMax: p.darkValueMax } }
			})
		: 0;

	const queue = new Int32Array(pixelCount);
	const brightLabels = t.enabled ? new Uint16Array(pixelCount) : undefined;
	const darkLabels = t.enabled ? new Uint16Array(pixelCount) : undefined;
	const brightComponents = collectComponents(bright, width, height, queue, brightLabels);
	const darkComponents = collectComponents(dark, width, height, queue, darkLabels);

	t.stage('p1.components');
	if (t.enabled && brightLabels && darkLabels) {
		const brightLabelAsset = t.raster('brightLabels', 'labelmap', brightLabels, width, height);
		const darkLabelAsset = t.raster('darkLabels', 'labelmap', darkLabels, width, height);
		for (let i = 0; i < brightComponents.length; i += 1) {
			const c = brightComponents[i];
			t.spawn('component', c, {
				geom: { x: c.centroidX, y: c.centroidY, w: c.widthPx, h: c.heightPx, angleDeg: c.orientationDeg },
				region: { asset: brightLabelAsset, label: i + 1 },
				attrs: { mask: 'bright', areaPx: c.areaPx, fill: c.fill }
			});
		}
		for (let i = 0; i < darkComponents.length; i += 1) {
			const c = darkComponents[i];
			t.spawn('component', c, {
				geom: { x: c.centroidX, y: c.centroidY, w: c.widthPx, h: c.heightPx },
				region: { asset: darkLabelAsset, label: i + 1 },
				attrs: { mask: 'dark', areaPx: c.areaPx, fill: c.fill }
			});
		}
		void brightMaskAsset;
		void darkMaskAsset;
	}

	// Badge family first: it is independent of the basket family, and the
	// optional basket-pool badge exclusion below needs the badge bodies.
	t.stage('p1.badgeShapePool');
	const badgeShapePool = darkComponents.filter((component) => {
		const e = t.idOf(component);
		const aspect = component.widthPx / component.heightPx;
		const pass =
			t.gte(e, 'minArea', component.areaPx, p.badgePoolMinAreaPx) &&
			t.gte(e, 'minWidth', component.widthPx, p.badgePoolMinWidthPx) &&
			t.gte(e, 'minHeight', component.heightPx, p.badgePoolMinHeightPx) &&
			t.range(e, 'aspect', aspect, p.badgePoolAspectMin, p.badgePoolAspectMax) &&
			t.gte(e, 'fill', component.fill, p.badgePoolFillMin);
		return pass;
	});
	const badgeConsensus = dominantSizeCluster(
		badgeShapePool,
		p.badgeClusterSizeRelTolerance,
		p.badgeClusterAreaRelTolerance
	);
	const badgeComponents = badgeConsensus.cluster;
	if (t.enabled) {
		const keptSet = new Set<MaskComponent>(badgeComponents);
		t.select(
			'badge.sizeConsensus',
			badgeComponents,
			badgeShapePool.filter((c) => !keptSet.has(c)),
			badgeConsensus.anchor
				? {
						anchorWidthPx: badgeConsensus.anchor.widthPx,
						anchorHeightPx: badgeConsensus.anchor.heightPx,
						anchorAreaPx: badgeConsensus.anchor.areaPx
					}
				: undefined
		);
	}

	t.stage('p1.basketShapePool');
	const badgeMedianHeightForExclusion = median(badgeComponents.map((c) => c.heightPx));
	const basketBadgeExclusionMargin =
		p.basketPoolExcludeInsideBadgeMarginFrac !== null && badgeComponents.length > 0
			? Math.max(2, badgeMedianHeightForExclusion * p.basketPoolExcludeInsideBadgeMarginFrac)
			: null;
	const basketShapePool = brightComponents.filter((component) => {
		const e = t.idOf(component);
		const aspect = component.heightPx / component.widthPx;
		if (
			basketBadgeExclusionMargin !== null &&
			!t.check(
				e,
				'outsideBadge',
				!centerFallsInsideBadge(component, badgeComponents, basketBadgeExclusionMargin)
			)
		) {
			return false;
		}
		const pass =
			t.gte(e, 'minArea', component.areaPx, p.basketPoolMinAreaPx) &&
			t.gte(e, 'minWidth', component.widthPx, p.basketPoolMinWidthPx) &&
			t.gte(e, 'minHeight', component.heightPx, p.basketPoolMinHeightPx) &&
			t.range(e, 'aspect', aspect, p.basketPoolAspectMin, p.basketPoolAspectMax) &&
			t.range(e, 'fill', component.fill, p.basketPoolFillMin, p.basketPoolFillMax);
		return pass;
	});
	const basketConsensus = dominantSizeCluster(
		basketShapePool,
		p.basketClusterSizeRelTolerance,
		p.basketClusterAreaRelTolerance
	);
	const basketComponents = basketConsensus.cluster;
	if (t.enabled) {
		const keptSet = new Set<MaskComponent>(basketComponents);
		t.select(
			'basket.sizeConsensus',
			basketComponents,
			basketShapePool.filter((c) => !keptSet.has(c)),
			basketConsensus.anchor
				? {
						anchorWidthPx: basketConsensus.anchor.widthPx,
						anchorHeightPx: basketConsensus.anchor.heightPx,
						anchorAreaPx: basketConsensus.anchor.areaPx
					}
				: undefined
		);
	}

	const basketMedianArea = median(basketComponents.map((component) => component.areaPx));
	const basketMedianWidth = median(basketComponents.map((component) => component.widthPx));
	const badgeMedianHeight = median(badgeComponents.map((component) => component.heightPx));

	const teeStage = t.stage('p1.teeFamily');
	t.measure(0, 'basketMedianArea', basketMedianArea);
	t.measure(0, 'basketMedianWidth', basketMedianWidth);
	t.measure(0, 'badgeMedianHeight', badgeMedianHeight);
	void teeStage;

	let teeComponents: MaskComponent[] = [];
	const teeScaleReferencesOk =
		basketMedianArea > 0 && basketMedianWidth > 0 && badgeMedianHeight > 0 && badgeComponents.length > 0;
	t.check(0, 'teeScaleReferences', teeScaleReferencesOk);
	if (teeScaleReferencesOk) {
		const badgeMinY = Math.min(...badgeComponents.map((component) => component.centroidY));
		const badgeMaxY = Math.max(...badgeComponents.map((component) => component.centroidY));
		const verticalMargin = badgeMedianHeight * p.teeVerticalMarginBadgeHeights;
		const minY = Math.max(0, badgeMinY - verticalMargin);
		const maxY = Math.min(height - 1, badgeMaxY + verticalMargin);
		const badgeOverlapMargin = Math.max(2, badgeMedianHeight * p.teeBadgeOverlapMarginFrac);

		teeComponents = brightComponents.filter((component) => {
			const e = t.idOf(component);
			if (!t.range(e, 'verticalBand', component.centroidY, minY, maxY)) return false;
			if (
				!t.check(
					e,
					'outsideBadge',
					!centerFallsInsideBadge(component, badgeComponents, badgeOverlapMargin)
				)
			) {
				return false;
			}

			const minDimension = Math.min(component.widthPx, component.heightPx);
			const maxDimension = Math.max(component.widthPx, component.heightPx);
			const bboxAspect = maxDimension / Math.max(1, minDimension);

			return (
				t.range(
					e,
					'areaVsBasket',
					component.areaPx,
					basketMedianArea * p.teeAreaVsBasketMin,
					basketMedianArea * p.teeAreaVsBasketMax
				) &&
				t.gte(e, 'minDim', minDimension, badgeMedianHeight * p.teeMinDimBadgeHeightFrac) &&
				t.lte(e, 'maxDim', maxDimension, basketMedianWidth * p.teeMaxDimBasketWidthFactor) &&
				t.lte(e, 'bboxAspect', bboxAspect, p.teeBboxAspectMax) &&
				t.range(e, 'fill', component.fill, p.teeFillMin, p.teeFillMax)
			);
		});

		// The fill gate above only requires that most of the bounding box NOT be
		// part of the bright mask -- it never checks what that non-bright
		// majority actually is. Reject candidates with no genuine grey pad
		// interior at all (see hasGreyInterior's doc comment): a big uniformly
		// bright surface (rooftop, sunlit pavement) can satisfy every geometry
		// gate above through boundary/occlusion noise alone.
		teeComponents = teeComponents.filter((component) => {
			const fraction = greyInteriorFraction(raster, component);
			return t.gte(t.idOf(component), 'greyInterior', fraction, p.teeMinGreyInteriorFraction);
		});

		teeComponents = teeComponents.filter((component) => {
			const candidate = {
				xPx: component.centroidX,
				yPx: component.centroidY,
				orientationDeg: component.orientationDeg,
				widthPx: component.widthPx,
				heightPx: component.heightPx
			};
			if (p.teeAppearanceThreshold === RAW_MASK_TUNING_DEFAULTS.teeAppearanceThreshold && !t.enabled) {
				return passesTeeAppearanceCheck(raster, candidate);
			}
			const score = bestTeeAppearanceScore(raster, candidate);
			return t.gte(t.idOf(component), 'appearanceNcc', score, p.teeAppearanceThreshold);
		});
	}

	const tees = sortComponents(teeComponents).map((component): RawMaskTee => {
		const tee: RawMaskTee = {
			xPx: component.centroidX,
			yPx: component.centroidY,
			orientationDeg: component.orientationDeg,
			widthPx: component.widthPx,
			heightPx: component.heightPx,
			areaPx: component.areaPx,
			fill: component.fill
		};
		if (t.enabled) {
			t.transform(component, tee);
			t.keep(t.idOf(component), tee);
		}
		return tee;
	});
	const badges = sortComponents(badgeComponents).map((component): RawMaskBadge => {
		const center = bboxCenter(component);
		const badge: RawMaskBadge = {
			...center,
			widthPx: component.widthPx,
			heightPx: component.heightPx,
			areaPx: component.areaPx,
			fill: component.fill
		};
		if (t.enabled) {
			t.transform(component, badge);
			t.keep(t.idOf(component), badge);
		}
		return badge;
	});
	const baskets = sortComponents(basketComponents).map((component): RawMaskBasket => {
		const center = bboxCenter(component);
		const basket: RawMaskBasket = {
			xPx: center.xPx,
			yPx: component.maxY,
			centerXPx: center.xPx,
			centerYPx: center.yPx,
			widthPx: component.widthPx,
			heightPx: component.heightPx,
			areaPx: component.areaPx,
			fill: component.fill
		};
		if (t.enabled) {
			t.transform(component, basket);
			t.keep(t.idOf(component), basket);
		}
		return basket;
	});

	return {
		tees,
		badges,
		baskets,
		diagnostics: {
			brightComponentCount: brightComponents.length,
			darkComponentCount: darkComponents.length,
			basketShapePoolCount: basketShapePool.length,
			badgeShapePoolCount: badgeShapePool.length,
			thresholds: {
				brightValueMin: p.brightValueMin,
				brightSaturationMax: p.brightSaturationMax,
				darkValueMax: p.darkValueMax
			}
		}
	};
}

/**
 * Appearance score for a component, via teeAppearance's exported primitives.
 * Kept here (not in teeAppearance) so that module's public surface is
 * unchanged; behavior at the default threshold is byte-identical to
 * `passesTeeAppearanceCheck`.
 */
function bestTeeAppearanceScore(
	raster: RawObjectMaskRaster,
	candidate: TeeAppearanceCandidate
): number {
	return bestTeeTemplateScore(extractCanonicalTeePatch(raster, candidate));
}
