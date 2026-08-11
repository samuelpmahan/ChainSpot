import type { TeePadCv, TeePadRaster } from './teePadDetection';
import type { UiScalePx } from './cvCalibration';

/**
 * Per-patch candidate metrics for the tee-overfitting harness
 * (`scripts/overfit-tees.ts`). Each metric is a scalar computed on a small
 * square patch of the full-resolution source raster; `teeMetricSearch.ts`
 * decides which of them (or which weighted combination) actually separates
 * the labeled truth tees from distractors on a given course.
 *
 * The battery is aimed at the known hard case: a pad whose rectangle is
 * broken by a bright C2 putting-circle dash. The dashes are themselves small
 * bright bars, so the discriminating physics is: a pad is a bright RIM
 * around a darker gray INTERIOR at a known size, while a dash is a solid
 * bright bar with background on both sides.
 *
 * Environment-agnostic like `teePadDetection.ts`: callers supply the OpenCV
 * module and an RGBA raster; nothing here loads WASM or touches the DOM.
 */

export type TeePatchLabel = 'truth' | 'distractor' | 'hard-negative';

export interface TeePatch {
	readonly centerXPx: number;
	readonly centerYPx: number;
	readonly halfSizePx: number;
	readonly label: TeePatchLabel;
	readonly holeNumber?: number;
}

export type PatchMetrics = Readonly<Record<string, number>>;

export const METRIC_NAMES = [
	'medianValue',
	'medianSaturation',
	'valueIqr',
	'satIqr',
	'grayBandFraction',
	'softGrayFraction',
	'interiorRimContrast',
	'edgeDensity',
	'bestRectangularity',
	'bestRectAspect',
	'bestRectMinorPx',
	'minorAxisBandScore',
	'houghRailScore',
	'gradientOrientationCoherence',
	'templateNcc',
	'dtGrayDistance',
	'offStructureBrightFraction',
	'offStructureBrightDensity',
	'onStructureBrightDensity',
	'offStructureCleanBrightDensity',
	'padEvidenceScore',
	'perpendicularCapScore',
	'railCapScore'
] as const;

/**
 * Known dash-generating course structures. On UDisc-style maps every bright
 * dash belongs to a dashed circle centered on a basket or to the dashed
 * connector from basket N to tee N+1 — so bright evidence NEAR one of these
 * is "explained" (probably a dash), while bright evidence OFF all of them is
 * unexplained (probably a tee-pad rim, the thing we are hunting).
 */
export interface DashStructures {
	readonly circles: readonly Readonly<{ xPx: number; yPx: number; radiusPx: number }>[];
	readonly segments: readonly Readonly<{ axPx: number; ayPx: number; bxPx: number; byPx: number }>[];
	/** A bright pixel within this distance of a structure counts as explained. */
	readonly bandPx: number;
}

/** UDisc pad footprint in UI pixels; multiplied by uiScalePx for source px. */
const PAD_MAJOR_UI = 13;
const PAD_MINOR_UI = 8;
/** Production gray-center interior window (see `teePadDetection.ts`). */
const GRAY_VALUE_MIN = 148;
const GRAY_VALUE_MAX = 168;
const GRAY_SATURATION_MAX = 18;
/**
 * Widened interior window: measured on the golden fixture, hole 5's pad
 * interior is S 15-18 / V 171-172 — outside the production band, because
 * its basemap tile tints the semi-transparent fill. This is exactly why
 * gray-center cannot see that pad.
 */
const SOFT_GRAY_VALUE_MIN = 145;
const SOFT_GRAY_VALUE_MAX = 180;
const SOFT_GRAY_SATURATION_MAX = 25;
/** Same Canny thresholds as the production edge-loop detector. */
const CANNY_LOW = 50;
const CANNY_HIGH = 150;

interface PatchPlanes {
	readonly width: number;
	readonly height: number;
	readonly gray: Uint8Array;
	readonly saturation: Uint8Array;
	readonly value: Uint8Array;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function extractPlanes(raster: TeePadRaster, patch: TeePatch): PatchPlanes | undefined {
	const half = Math.max(2, Math.round(patch.halfSizePx));
	const startX = Math.round(patch.centerXPx) - half;
	const startY = Math.round(patch.centerYPx) - half;
	const size = half * 2 + 1;
	if (startX < 0 || startY < 0 || startX + size > raster.widthPx || startY + size > raster.heightPx) return undefined;
	const gray = new Uint8Array(size * size);
	const saturation = new Uint8Array(size * size);
	const value = new Uint8Array(size * size);
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			const sourceOffset = ((startY + y) * raster.widthPx + startX + x) * 4;
			const red = raster.rgba[sourceOffset];
			const green = raster.rgba[sourceOffset + 1];
			const blue = raster.rgba[sourceOffset + 2];
			const maximum = Math.max(red, green, blue);
			const minimum = Math.min(red, green, blue);
			const index = y * size + x;
			gray[index] = (red * 0.299 + green * 0.587 + blue * 0.114 + 0.5) | 0;
			value[index] = maximum;
			saturation[index] = maximum === 0 ? 0 : (((maximum - minimum) * 255) / maximum + 0.5) | 0;
		}
	}
	return { width: size, height: size, gray, saturation, value };
}

function quantiles(values: number[]): { median: number; iqr: number } {
	if (values.length === 0) return { median: Number.NaN, iqr: Number.NaN };
	const sorted = [...values].sort((a, b) => a - b);
	const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
	return { median: at(0.5), iqr: at(0.75) - at(0.25) };
}

/** Interior = central disc of radius 0.45·patch; rim = annulus 0.55..0.9. */
function interiorAndRim(planes: PatchPlanes): {
	interiorValues: number[];
	interiorSaturations: number[];
	rimValues: number[];
} {
	const center = (planes.width - 1) / 2;
	const interiorRadius = planes.width * 0.45 * 0.5;
	const rimInner = planes.width * 0.55 * 0.5;
	const rimOuter = planes.width * 0.9 * 0.5;
	const interiorValues: number[] = [];
	const interiorSaturations: number[] = [];
	const rimValues: number[] = [];
	for (let y = 0; y < planes.height; y += 1) {
		for (let x = 0; x < planes.width; x += 1) {
			const distance = Math.hypot(x - center, y - center);
			const index = y * planes.width + x;
			if (distance <= interiorRadius) {
				interiorValues.push(planes.value[index]);
				interiorSaturations.push(planes.saturation[index]);
			} else if (distance >= rimInner && distance <= rimOuter) {
				rimValues.push(planes.value[index]);
			}
		}
	}
	return { interiorValues, interiorSaturations, rimValues };
}

function grayMask(planes: PatchPlanes): Uint8Array {
	const mask = new Uint8Array(planes.width * planes.height);
	for (let index = 0; index < mask.length; index += 1) {
		mask[index] =
			planes.saturation[index] <= GRAY_SATURATION_MAX &&
			planes.value[index] >= GRAY_VALUE_MIN &&
			planes.value[index] <= GRAY_VALUE_MAX
				? 1
				: 0;
	}
	return mask;
}

/** Two-pass chamfer distance (3-4 weights) to the nearest mask pixel. */
function chamferDistanceMean(mask: Uint8Array, width: number, height: number, sampleRadiusFraction: number): number {
	const INF = 1 << 20;
	const distance = new Int32Array(width * height);
	let any = false;
	for (let index = 0; index < distance.length; index += 1) {
		if (mask[index]) any = true;
		distance[index] = mask[index] ? 0 : INF;
	}
	if (!any) return width;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const index = y * width + x;
			if (x > 0) distance[index] = Math.min(distance[index], distance[index - 1] + 3);
			if (y > 0) {
				distance[index] = Math.min(distance[index], distance[index - width] + 3);
				if (x > 0) distance[index] = Math.min(distance[index], distance[index - width - 1] + 4);
				if (x < width - 1) distance[index] = Math.min(distance[index], distance[index - width + 1] + 4);
			}
		}
	}
	for (let y = height - 1; y >= 0; y -= 1) {
		for (let x = width - 1; x >= 0; x -= 1) {
			const index = y * width + x;
			if (x < width - 1) distance[index] = Math.min(distance[index], distance[index + 1] + 3);
			if (y < height - 1) {
				distance[index] = Math.min(distance[index], distance[index + width] + 3);
				if (x < width - 1) distance[index] = Math.min(distance[index], distance[index + width + 1] + 4);
				if (x > 0) distance[index] = Math.min(distance[index], distance[index + width - 1] + 4);
			}
		}
	}
	const center = (width - 1) / 2;
	const radius = width * sampleRadiusFraction * 0.5;
	let total = 0;
	let count = 0;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			if (Math.hypot(x - center, y - center) > radius) continue;
			total += distance[y * width + x] / 3;
			count += 1;
		}
	}
	return count === 0 ? width : total / count;
}

interface CannyPatch {
	readonly edges: Uint8Array;
	readonly edgeCount: number;
}

function cannyPatch(cv: TeePadCv, planes: PatchPlanes): CannyPatch {
	const source = new cv.Mat(planes.height, planes.width, cv.CV_8UC1);
	source.data.set(planes.gray);
	const blurred = new cv.Mat();
	const edges = new cv.Mat();
	try {
		cv.GaussianBlur(source, blurred, new cv.Size(3, 3), 0);
		cv.Canny(blurred, edges, CANNY_LOW, CANNY_HIGH);
		const bytes = new Uint8Array(edges.data);
		let edgeCount = 0;
		for (const byte of bytes) if (byte) edgeCount += 1;
		return { edges: bytes, edgeCount };
	} finally {
		source.delete();
		blurred.delete();
		edges.delete();
	}
}

interface BestRect {
	readonly rectangularity: number;
	readonly aspect: number;
	readonly minorPx: number;
}

function bestContourRect(cv: TeePadCv, edges: Uint8Array, width: number, height: number): BestRect | undefined {
	const mat = new cv.Mat(height, width, cv.CV_8UC1);
	mat.data.set(edges);
	const contours = new cv.MatVector();
	const hierarchy = new cv.Mat();
	try {
		cv.findContours(mat, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
		let best: BestRect | undefined;
		let bestArea = 0;
		for (let index = 0; index < contours.size(); index += 1) {
			const contour = contours.get(index);
			try {
				const area = cv.contourArea(contour);
				if (area <= bestArea || area < 4) continue;
				const rect = cv.minAreaRect(contour);
				const major = Math.max(rect.size.width, rect.size.height);
				const minor = Math.min(rect.size.width, rect.size.height);
				if (major <= 0 || minor <= 0) continue;
				bestArea = area;
				best = { rectangularity: area / (major * minor), aspect: major / minor, minorPx: minor };
			} finally {
				contour.delete();
			}
		}
		return best;
	} finally {
		mat.delete();
		contours.delete();
		hierarchy.delete();
	}
}

interface Segment {
	readonly x1: number;
	readonly y1: number;
	readonly x2: number;
	readonly y2: number;
	readonly length: number;
	readonly angleDeg: number;
}

function houghSegments(cv: TeePadCv, edges: Uint8Array, width: number, height: number, minLengthPx: number): Segment[] {
	const mat = new cv.Mat(height, width, cv.CV_8UC1);
	mat.data.set(edges);
	const lines = new cv.Mat();
	try {
		cv.HoughLinesP(mat, lines, 1, Math.PI / 180, Math.max(4, Math.round(minLengthPx * 0.75)), minLengthPx, 2);
		const data = lines.data32S;
		if (!data) return [];
		const segments: Segment[] = [];
		for (let offset = 0; offset + 3 < data.length; offset += 4) {
			const x1 = data[offset];
			const y1 = data[offset + 1];
			const x2 = data[offset + 2];
			const y2 = data[offset + 3];
			const length = Math.hypot(x2 - x1, y2 - y1);
			if (length < 2) continue;
			let angleDeg = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
			if (angleDeg < 0) angleDeg += 180;
			segments.push({ x1, y1, x2, y2, length, angleDeg });
		}
		return segments;
	} finally {
		mat.delete();
		lines.delete();
	}
}

function angleDifferenceDeg(a: number, b: number): number {
	const difference = Math.abs(a - b) % 180;
	return Math.min(difference, 180 - difference);
}

interface RailEvidence {
	readonly railScore: number;
	readonly capScore: number;
}

/**
 * Rails + end-cap: the best parallel pair (as `railScore`) plus evidence of
 * a third segment roughly PERPENDICULAR to the rails near the pair's ends.
 * Dashes are isolated collinear bars — a neighborhood where two parallel
 * rails meet a perpendicular cap is essentially always a real pad corner
 * region, which makes this the strongest auto-approve signal.
 */
function railAndCapEvidence(segments: readonly Segment[], expectedSeparationPx: number): RailEvidence {
	let bestRail = 0;
	let bestCap = 0;
	for (let first = 0; first < segments.length; first += 1) {
		for (let second = first + 1; second < segments.length; second += 1) {
			const a = segments[first];
			const b = segments[second];
			if (angleDifferenceDeg(a.angleDeg, b.angleDeg) > 12) continue;
			const midAx = (a.x1 + a.x2) / 2;
			const midAy = (a.y1 + a.y2) / 2;
			const midBx = (b.x1 + b.x2) / 2;
			const midBy = (b.y1 + b.y2) / 2;
			const angle = (a.angleDeg * Math.PI) / 180;
			const normalX = -Math.sin(angle);
			const normalY = Math.cos(angle);
			const separation = Math.abs((midBx - midAx) * normalX + (midBy - midAy) * normalY);
			if (separation < 2) continue;
			const separationScore = Math.exp(-((separation - expectedSeparationPx) ** 2) / (2 * 2.5 ** 2));
			const lengthScore = Math.min(1, (a.length + b.length) / (2 * expectedSeparationPx));
			const pairScore = separationScore * lengthScore;
			if (pairScore <= 0) continue;
			if (pairScore > bestRail) bestRail = pairScore;
			// A cap: any third segment perpendicular to the rails whose center
			// sits within the pair's span.
			const pairCenterX = (midAx + midBx) / 2;
			const pairCenterY = (midAy + midBy) / 2;
			for (let third = 0; third < segments.length; third += 1) {
				if (third === first || third === second) continue;
				const c = segments[third];
				const perpendicularity = angleDifferenceDeg(c.angleDeg, a.angleDeg);
				if (perpendicularity < 70) continue;
				const midCx = (c.x1 + c.x2) / 2;
				const midCy = (c.y1 + c.y2) / 2;
				const reach = Math.hypot(midCx - pairCenterX, midCy - pairCenterY);
				if (reach > 2.5 * expectedSeparationPx) continue;
				const capScore = pairScore * Math.min(1, c.length / expectedSeparationPx);
				if (capScore > bestCap) bestCap = capScore;
			}
		}
	}
	return { railScore: bestRail, capScore: bestCap };
}

/** Mean resultant length of doubled gradient angles, magnitude-weighted. */
function gradientCoherence(planes: PatchPlanes): number {
	let sumCos = 0;
	let sumSin = 0;
	let sumMagnitude = 0;
	for (let y = 1; y < planes.height - 1; y += 1) {
		for (let x = 1; x < planes.width - 1; x += 1) {
			const index = y * planes.width + x;
			const gx =
				planes.gray[index - planes.width + 1] +
				2 * planes.gray[index + 1] +
				planes.gray[index + planes.width + 1] -
				planes.gray[index - planes.width - 1] -
				2 * planes.gray[index - 1] -
				planes.gray[index + planes.width - 1];
			const gy =
				planes.gray[index + planes.width - 1] +
				2 * planes.gray[index + planes.width] +
				planes.gray[index + planes.width + 1] -
				planes.gray[index - planes.width - 1] -
				2 * planes.gray[index - planes.width] -
				planes.gray[index - planes.width + 1];
			const magnitude = Math.hypot(gx, gy);
			if (magnitude < 32) continue;
			const doubled = 2 * Math.atan2(gy, gx);
			sumCos += magnitude * Math.cos(doubled);
			sumSin += magnitude * Math.sin(doubled);
			sumMagnitude += magnitude;
		}
	}
	return sumMagnitude === 0 ? 0 : Math.hypot(sumCos, sumSin) / sumMagnitude;
}

interface PadTemplate {
	readonly width: number;
	readonly height: number;
	readonly values: Float32Array;
}

function synthesizePadTemplates(uiScalePx: UiScalePx, rotations: number): PadTemplate[] {
	const major = PAD_MAJOR_UI * uiScalePx;
	const minor = PAD_MINOR_UI * uiScalePx;
	const rim = Math.max(1, uiScalePx);
	const margin = Math.ceil(rim) + 1;
	const templates: PadTemplate[] = [];
	for (let step = 0; step < rotations; step += 1) {
		const angle = (step * Math.PI) / rotations;
		const cosine = Math.cos(angle);
		const sine = Math.sin(angle);
		const extentX = Math.ceil(Math.abs((major / 2) * cosine) + Math.abs((minor / 2) * sine)) + margin;
		const extentY = Math.ceil(Math.abs((major / 2) * sine) + Math.abs((minor / 2) * cosine)) + margin;
		const width = extentX * 2 + 1;
		const height = extentY * 2 + 1;
		const values = new Float32Array(width * height);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const dx = x - extentX;
				const dy = y - extentY;
				const localX = dx * cosine + dy * sine;
				const localY = -dx * sine + dy * cosine;
				const insideOuter = Math.abs(localX) <= major / 2 && Math.abs(localY) <= minor / 2;
				const insideInner = Math.abs(localX) <= major / 2 - rim && Math.abs(localY) <= minor / 2 - rim;
				// Background 120, bright rim 235, gray interior 158.
				values[y * width + x] = insideInner ? 158 : insideOuter ? 235 : 120;
			}
		}
		templates.push({ width, height, values });
	}
	return templates;
}

/** Max zero-normalized cross-correlation of each template over the patch. */
function templateNcc(planes: PatchPlanes, templates: readonly PadTemplate[]): number {
	let best = -1;
	for (const template of templates) {
		if (template.width > planes.width || template.height > planes.height) continue;
		let templateMean = 0;
		for (const value of template.values) templateMean += value;
		templateMean /= template.values.length;
		let templateEnergy = 0;
		for (const value of template.values) templateEnergy += (value - templateMean) ** 2;
		if (templateEnergy === 0) continue;
		for (let offsetY = 0; offsetY + template.height <= planes.height; offsetY += 1) {
			for (let offsetX = 0; offsetX + template.width <= planes.width; offsetX += 1) {
				let patchSum = 0;
				for (let y = 0; y < template.height; y += 1) {
					for (let x = 0; x < template.width; x += 1) {
						patchSum += planes.gray[(offsetY + y) * planes.width + offsetX + x];
					}
				}
				const patchMean = patchSum / (template.width * template.height);
				let cross = 0;
				let patchEnergy = 0;
				for (let y = 0; y < template.height; y += 1) {
					for (let x = 0; x < template.width; x += 1) {
						const patchValue = planes.gray[(offsetY + y) * planes.width + offsetX + x] - patchMean;
						const templateValue = template.values[y * template.width + x] - templateMean;
						cross += patchValue * templateValue;
						patchEnergy += patchValue * patchValue;
					}
				}
				if (patchEnergy === 0) continue;
				const ncc = cross / Math.sqrt(patchEnergy * templateEnergy);
				if (ncc > best) best = ncc;
			}
		}
	}
	return best;
}

export interface TeeMetricContext {
	readonly templates: readonly PadTemplate[];
	readonly uiScalePx: UiScalePx;
	readonly dashStructures?: DashStructures;
}

/** Precompute per-run state (rotated synthetic templates) once, not per patch. */
export function createTeeMetricContext(
	uiScalePx: UiScalePx,
	rotations = 16,
	dashStructures?: DashStructures
): TeeMetricContext {
	return { templates: synthesizePadTemplates(uiScalePx, rotations), uiScalePx, dashStructures };
}

/** Bright whitish overlay pixels: dash strokes, pad rims, glyph bodies. */
const BRIGHT_VALUE_MIN = 185;
const BRIGHT_SATURATION_MAX = 50;

function distanceToStructures(xPx: number, yPx: number, structures: DashStructures): number {
	let best = Number.POSITIVE_INFINITY;
	for (const circle of structures.circles) {
		const distance = Math.abs(Math.hypot(xPx - circle.xPx, yPx - circle.yPx) - circle.radiusPx);
		if (distance < best) best = distance;
	}
	for (const segment of structures.segments) {
		const vx = segment.bxPx - segment.axPx;
		const vy = segment.byPx - segment.ayPx;
		const lengthSquared = vx * vx + vy * vy;
		const t = lengthSquared === 0 ? 0 : clamp(((xPx - segment.axPx) * vx + (yPx - segment.ayPx) * vy) / lengthSquared, 0, 1);
		const distance = Math.hypot(xPx - (segment.axPx + t * vx), yPx - (segment.ayPx + t * vy));
		if (distance < best) best = distance;
	}
	return best;
}

interface StructureEvidence {
	readonly offFraction: number;
	readonly offDensity: number;
	readonly onDensity: number;
	readonly cleanOffDensity: number;
}

/** A bright pixel with any near-black pixel this close belongs to a black-
 * outlined glyph or number badge, never to a pad rim. */
const BLACK_ADJACENCY_RADIUS = 3;
const BLACK_VALUE_MAX = 70;

function nearBlack(planes: PatchPlanes, x: number, y: number): boolean {
	for (let dy = -BLACK_ADJACENCY_RADIUS; dy <= BLACK_ADJACENCY_RADIUS; dy += 1) {
		for (let dx = -BLACK_ADJACENCY_RADIUS; dx <= BLACK_ADJACENCY_RADIUS; dx += 1) {
			const nx = x + dx;
			const ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= planes.width || ny >= planes.height) continue;
			if (planes.value[ny * planes.width + nx] < BLACK_VALUE_MAX) return true;
		}
	}
	return false;
}

function structureEvidence(planes: PatchPlanes, patch: TeePatch, structures: DashStructures): StructureEvidence {
	const half = (planes.width - 1) / 2;
	const originX = Math.round(patch.centerXPx) - half;
	const originY = Math.round(patch.centerYPx) - half;
	let brightCount = 0;
	let offCount = 0;
	let cleanOffCount = 0;
	for (let y = 0; y < planes.height; y += 1) {
		for (let x = 0; x < planes.width; x += 1) {
			const index = y * planes.width + x;
			if (planes.value[index] < BRIGHT_VALUE_MIN || planes.saturation[index] > BRIGHT_SATURATION_MAX) continue;
			brightCount += 1;
			if (distanceToStructures(originX + x, originY + y, structures) > structures.bandPx) {
				offCount += 1;
				if (!nearBlack(planes, x, y)) cleanOffCount += 1;
			}
		}
	}
	const area = planes.width * planes.height;
	return {
		offFraction: brightCount === 0 ? Number.NaN : offCount / brightCount,
		offDensity: offCount / area,
		onDensity: (brightCount - offCount) / area,
		cleanOffDensity: cleanOffCount / area
	};
}

/**
 * Computes the battery for one patch. Returns undefined when the patch does
 * not fit inside the raster. NaN metric values mean "not measurable on this
 * patch" (e.g. no contour found) and are treated as worst-case by the search
 * layer. Pass `subset` to compute only those metrics (dense sliding-window
 * scoring only needs the tuned scorer's few metrics, and skipping the NCC
 * and Hough work there is a >10x speedup); omitted metrics are absent from
 * the result, not NaN.
 */
export function computePatchMetrics(
	cv: TeePadCv,
	raster: TeePadRaster,
	patch: TeePatch,
	context: TeeMetricContext,
	subset?: ReadonlySet<string>
): PatchMetrics | undefined {
	const planes = extractPlanes(raster, patch);
	if (!planes) return undefined;
	const wants = (name: string) => !subset || subset.has(name);
	const metrics: Record<string, number> = {};
	const expectedMinorPx = PAD_MINOR_UI * context.uiScalePx;

	if (
		wants('medianValue') ||
		wants('medianSaturation') ||
		wants('valueIqr') ||
		wants('satIqr') ||
		wants('interiorRimContrast')
	) {
		const { interiorValues, interiorSaturations, rimValues } = interiorAndRim(planes);
		const valueStats = quantiles(interiorValues);
		const saturationStats = quantiles(interiorSaturations);
		const rimMean = rimValues.length === 0 ? Number.NaN : rimValues.reduce((a, b) => a + b, 0) / rimValues.length;
		const interiorMean =
			interiorValues.length === 0 ? Number.NaN : interiorValues.reduce((a, b) => a + b, 0) / interiorValues.length;
		if (wants('medianValue')) metrics.medianValue = valueStats.median;
		if (wants('medianSaturation')) metrics.medianSaturation = saturationStats.median;
		if (wants('valueIqr')) metrics.valueIqr = valueStats.iqr;
		if (wants('satIqr')) metrics.satIqr = saturationStats.iqr;
		if (wants('interiorRimContrast')) metrics.interiorRimContrast = rimMean - interiorMean;
	}

	if (wants('grayBandFraction') || wants('dtGrayDistance')) {
		const mask = grayMask(planes);
		if (wants('grayBandFraction')) {
			let grayCount = 0;
			for (const bit of mask) grayCount += bit;
			metrics.grayBandFraction = grayCount / mask.length;
		}
		if (wants('dtGrayDistance')) {
			metrics.dtGrayDistance = chamferDistanceMean(mask, planes.width, planes.height, 0.5);
		}
	}

	let softGrayFraction: number | undefined;
	if (wants('softGrayFraction') || wants('padEvidenceScore')) {
		let softCount = 0;
		for (let index = 0; index < planes.gray.length; index += 1) {
			if (
				planes.saturation[index] <= SOFT_GRAY_SATURATION_MAX &&
				planes.value[index] >= SOFT_GRAY_VALUE_MIN &&
				planes.value[index] <= SOFT_GRAY_VALUE_MAX
			) {
				softCount += 1;
			}
		}
		softGrayFraction = softCount / planes.gray.length;
		if (wants('softGrayFraction')) metrics.softGrayFraction = softGrayFraction;
	}

	const needsCanny =
		wants('edgeDensity') ||
		wants('bestRectangularity') ||
		wants('bestRectAspect') ||
		wants('bestRectMinorPx') ||
		wants('minorAxisBandScore') ||
		wants('houghRailScore');
	if (needsCanny) {
		const canny = cannyPatch(cv, planes);
		if (wants('edgeDensity')) metrics.edgeDensity = canny.edgeCount / (planes.width * planes.height);
		if (wants('bestRectangularity') || wants('bestRectAspect') || wants('bestRectMinorPx') || wants('minorAxisBandScore')) {
			const rect = bestContourRect(cv, canny.edges, planes.width, planes.height);
			if (wants('bestRectangularity')) metrics.bestRectangularity = rect?.rectangularity ?? Number.NaN;
			if (wants('bestRectAspect')) metrics.bestRectAspect = rect?.aspect ?? Number.NaN;
			if (wants('bestRectMinorPx')) metrics.bestRectMinorPx = rect?.minorPx ?? Number.NaN;
			if (wants('minorAxisBandScore')) {
				metrics.minorAxisBandScore = rect ? Math.exp(-((rect.minorPx - expectedMinorPx) ** 2) / (2 * 3 ** 2)) : Number.NaN;
			}
		}
		if (wants('houghRailScore') || wants('perpendicularCapScore') || wants('railCapScore')) {
			const segments = houghSegments(cv, canny.edges, planes.width, planes.height, Math.max(4, expectedMinorPx * 0.6));
			const rails = railAndCapEvidence(segments, expectedMinorPx);
			if (wants('houghRailScore')) metrics.houghRailScore = rails.railScore;
			if (wants('perpendicularCapScore')) metrics.perpendicularCapScore = rails.capScore;
			if (wants('railCapScore')) metrics.railCapScore = rails.railScore > 0 && rails.capScore > 0 ? rails.railScore * rails.capScore : 0;
		}
	}

	if (wants('gradientOrientationCoherence')) metrics.gradientOrientationCoherence = gradientCoherence(planes);
	if (wants('templateNcc')) metrics.templateNcc = templateNcc(planes, context.templates);

	if (
		context.dashStructures &&
		(wants('offStructureBrightFraction') ||
			wants('offStructureBrightDensity') ||
			wants('onStructureBrightDensity') ||
			wants('offStructureCleanBrightDensity') ||
			wants('padEvidenceScore'))
	) {
		const evidence = structureEvidence(planes, patch, context.dashStructures);
		if (wants('offStructureBrightFraction')) metrics.offStructureBrightFraction = evidence.offFraction;
		if (wants('offStructureBrightDensity')) metrics.offStructureBrightDensity = evidence.offDensity;
		if (wants('onStructureBrightDensity')) metrics.onStructureBrightDensity = evidence.onDensity;
		if (wants('offStructureCleanBrightDensity')) metrics.offStructureCleanBrightDensity = evidence.cleanOffDensity;
		if (wants('padEvidenceScore') && softGrayFraction !== undefined) {
			// Conjunction the linear scorer cannot express: a pad has BOTH a
			// (soft) gray interior AND clean off-structure bright rim evidence.
			// Gray paths lack the rim; dashes are on-structure; glyphs and
			// badges are black-adjacent. Only pads keep both factors non-zero.
			metrics.padEvidenceScore = softGrayFraction * evidence.cleanOffDensity;
		}
	}
	return metrics;
}
