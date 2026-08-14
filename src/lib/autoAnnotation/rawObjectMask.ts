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
 * using the two UI glyph families as scale references.
 */

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

const BRIGHT_VALUE_MIN = 210;
const BRIGHT_SATURATION_MAX = 45;
const DARK_VALUE_MAX = 45;

const BASKET_WIDTH_HEIGHT_REL_TOLERANCE = 0.12;
const BASKET_AREA_REL_TOLERANCE = 0.22;
const BADGE_WIDTH_HEIGHT_REL_TOLERANCE = 0.12;
const BADGE_AREA_REL_TOLERANCE = 0.22;

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
	queue: Int32Array
): MaskComponent[] {
	const components: MaskComponent[] = [];
	for (let seed = 0; seed < mask.length; seed += 1) {
		if (mask[seed] !== 1) continue;

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
): MaskComponent[] {
	let best: MaskComponent[] = [];
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
		if (cluster.length > best.length) best = cluster;
	}
	return best;
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

export function detectRawObjectMask(raster: RawObjectMaskRaster): RawObjectMaskResult {
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

		if (max > BRIGHT_VALUE_MIN && saturation < BRIGHT_SATURATION_MAX) bright[index] = 1;
		if (max <= DARK_VALUE_MAX) dark[index] = 1;
	}

	const queue = new Int32Array(pixelCount);
	const brightComponents = collectComponents(bright, width, height, queue);
	const darkComponents = collectComponents(dark, width, height, queue);

	const basketShapePool = brightComponents.filter((component) => {
		if (component.areaPx < 80 || component.widthPx < 8 || component.heightPx < 12) return false;
		const aspect = component.heightPx / component.widthPx;
		return aspect >= 1.25 && aspect <= 2.2 && component.fill >= 0.4 && component.fill <= 0.8;
	});
	const basketComponents = dominantSizeCluster(
		basketShapePool,
		BASKET_WIDTH_HEIGHT_REL_TOLERANCE,
		BASKET_AREA_REL_TOLERANCE
	);

	const badgeShapePool = darkComponents.filter((component) => {
		if (component.areaPx < 80 || component.widthPx < 12 || component.heightPx < 9) return false;
		const aspect = component.widthPx / component.heightPx;
		return aspect >= 1.15 && aspect <= 1.75 && component.fill >= 0.6;
	});
	const badgeComponents = dominantSizeCluster(
		badgeShapePool,
		BADGE_WIDTH_HEIGHT_REL_TOLERANCE,
		BADGE_AREA_REL_TOLERANCE
	);

	const basketMedianArea = median(basketComponents.map((component) => component.areaPx));
	const basketMedianWidth = median(basketComponents.map((component) => component.widthPx));
	const badgeMedianHeight = median(badgeComponents.map((component) => component.heightPx));

	let teeComponents: MaskComponent[] = [];
	if (basketMedianArea > 0 && basketMedianWidth > 0 && badgeMedianHeight > 0 && badgeComponents.length > 0) {
		const badgeMinY = Math.min(...badgeComponents.map((component) => component.centroidY));
		const badgeMaxY = Math.max(...badgeComponents.map((component) => component.centroidY));
		const verticalMargin = badgeMedianHeight * 4;
		const minY = Math.max(0, badgeMinY - verticalMargin);
		const maxY = Math.min(height - 1, badgeMaxY + verticalMargin);
		const badgeOverlapMargin = Math.max(2, badgeMedianHeight * 0.08);

		teeComponents = brightComponents.filter((component) => {
			if (component.centroidY < minY || component.centroidY > maxY) return false;
			if (centerFallsInsideBadge(component, badgeComponents, badgeOverlapMargin)) return false;

			const minDimension = Math.min(component.widthPx, component.heightPx);
			const maxDimension = Math.max(component.widthPx, component.heightPx);
			const bboxAspect = maxDimension / Math.max(1, minDimension);

			return (
				component.areaPx >= basketMedianArea * 0.09 &&
				component.areaPx <= basketMedianArea * 0.35 &&
				minDimension >= badgeMedianHeight * 0.45 &&
				maxDimension <= basketMedianWidth * 2 &&
				bboxAspect <= 2.2 &&
				component.fill >= 0.12 &&
				component.fill <= 0.55
			);
		});
	}

	const tees = sortComponents(teeComponents).map(
		(component): RawMaskTee => ({
			xPx: component.centroidX,
			yPx: component.centroidY,
			orientationDeg: component.orientationDeg,
			widthPx: component.widthPx,
			heightPx: component.heightPx,
			areaPx: component.areaPx,
			fill: component.fill
		})
	);
	const badges = sortComponents(badgeComponents).map((component): RawMaskBadge => {
		const center = bboxCenter(component);
		return {
			...center,
			widthPx: component.widthPx,
			heightPx: component.heightPx,
			areaPx: component.areaPx,
			fill: component.fill
		};
	});
	const baskets = sortComponents(basketComponents).map((component): RawMaskBasket => {
		const center = bboxCenter(component);
		return {
			xPx: center.xPx,
			yPx: component.maxY,
			centerXPx: center.xPx,
			centerYPx: center.yPx,
			widthPx: component.widthPx,
			heightPx: component.heightPx,
			areaPx: component.areaPx,
			fill: component.fill
		};
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
				brightValueMin: BRIGHT_VALUE_MIN,
				brightSaturationMax: BRIGHT_SATURATION_MAX,
				darkValueMax: DARK_VALUE_MAX
			}
		}
	};
}
