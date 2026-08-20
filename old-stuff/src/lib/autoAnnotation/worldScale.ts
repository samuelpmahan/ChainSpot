/**
 * World-scale calibration from white tee-pad frames.
 *
 * `uiScalePx` (badge-derived) measures UI chrome, which UDisc draws at a
 * fixed on-screen size regardless of map zoom. Tee pads are painted terrain:
 * their pixel size tracks map zoom, which uiScalePx cannot see. This module
 * measures that second, empirically-independent scale directly from the one
 * white rectangular-FRAME family painted on the terrain — the pads
 * themselves — using only unitless gates (rectangularity, aspect, enclosed
 * hole, interior brightness), so it assumes nothing about how any UI element
 * scales. Validated in scripts/cv-probes/white-rect-scale-findings.md:
 * IMG_5641 median 30.4px vs ReferenceStitch 56.0px = 1.842, matching the
 * 1.83 terrain ratio, zero false positives on either render.
 *
 * `WorldScale` is deliberately a distinct branded type from `UiScalePx`:
 * the two are different physical concepts and must never be substituted for
 * one another.
 */

export type WorldScale = number & { readonly __brand: 'WorldScale' };

export function asWorldScale(value: number, context: string): WorldScale {
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${context}: world scale must be positive.`);
	return value as WorldScale;
}

export interface WorldScaleRaster {
	readonly rgba: Uint8Array | Uint8ClampedArray;
	readonly widthPx: number;
	readonly heightPx: number;
}

/**
 * Geometry of one white tee-pad frame that survived the same unitless gates
 * used for world-scale calibration. The scale detector always computed this
 * internally; expose it so tee detection can reuse the object instead of
 * throwing its location away after measuring only its size.
 */
export interface WhiteTeeFrameCandidate {
	readonly xPx: number;
	readonly yPx: number;
	readonly majorPx: number;
	readonly minorPx: number;
	/** Undirected major-axis orientation normalized to [0, 180). */
	readonly orientationDeg: number;
}

export interface WorldScaleMeasurement {
	readonly worldScale: WorldScale;
	readonly medianFrameMajorPx: number;
	readonly frameCount: number;
	/** Every accepted frame's major axis, sorted — diagnostics only. */
	readonly frameMajorsPx: readonly number[];
	/** Frames belonging to the winning same-size pad consensus cluster. */
	readonly frameCandidates?: readonly WhiteTeeFrameCandidate[];
}

/**
 * The measured median pad-frame major axis on IMG_5641 — the substrate every
 * tee constant was tuned against. worldScale is exactly 1.0 there, so the
 * tuned regime reproduces unchanged. Measured by THIS implementation
 * (consensus-cluster median on IMG_5641), not by the Python probe, so the
 * reference and the live measurement share every numerical quirk.
 */
export const REFERENCE_FRAME_MAJOR_PX = 31.7;

/** Same spirit as the Python probe's gates; all unitless or zoom-invariant. */
const VALUE_MIN = 175;
const SATURATION_MAX = 60;
const MIN_MAJOR_PX = 10;
const MIN_MINOR_PX = 4;
const MAX_AREA_FRACTION = 1e-3;
const MIN_RIM_AREA_PX = 30;
const ASPECT_MIN = 1.05;
const ASPECT_MAX = 2.2;
const FRAME_FILL_MIN = 0.15;
const FRAME_FILL_MAX = 0.6;
const HOLE_FRACTION_MIN = 0.25;
const INTERIOR_VALUE_MIN = 70;
const INTERIOR_VALUE_MAX = 220;
const BORDER_MARGIN_PX = 4;
/** Below this many accepted frames the median is too thin to trust. */
const MIN_FRAMES = 3;
/** Consensus window half-width, relative — see the cluster selection below. */
const CLUSTER_TOLERANCE = 0.12;

interface FrameComponent {
	readonly pixels: Int32Array;
	readonly count: number;
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
}

/**
 * Measures the median white-frame major axis and derives worldScale.
 * Returns null when too few frames survive the gates (heavy occlusion, or a
 * capture with no visible pads) — callers must treat that as "scale
 * unknown", not "scale 1".
 */
export function measureWorldScale(raster: WorldScaleRaster): WorldScaleMeasurement | null {
	const { rgba, widthPx: width, heightPx: height } = raster;
	const pixelCount = width * height;
	const bright = new Uint8Array(pixelCount);
	const value = new Uint8Array(pixelCount);
	for (let index = 0; index < pixelCount; index += 1) {
		const offset = index * 4;
		const r = rgba[offset];
		const g = rgba[offset + 1];
		const b = rgba[offset + 2];
		const max = r > g ? (r > b ? r : b) : g > b ? g : b;
		const min = r < g ? (r < b ? r : b) : g < b ? g : b;
		value[index] = max;
		// HSV saturation in 0..255, matching OpenCV's convention.
		const saturation = max === 0 ? 0 : Math.round(((max - min) * 255) / max);
		bright[index] = max >= VALUE_MIN && saturation <= SATURATION_MAX ? 1 : 0;
	}

	const labels = new Int32Array(pixelCount); // 0 = unlabeled
	const maxArea = Math.max(MIN_RIM_AREA_PX + 1, Math.round(MAX_AREA_FRACTION * pixelCount));
	const queue = new Int32Array(maxArea + 8);
	const frames: WhiteTeeFrameCandidate[] = [];
	let nextLabel = 0;

	for (let seed = 0; seed < pixelCount; seed += 1) {
		if (bright[seed] === 0 || labels[seed] !== 0) continue;
		nextLabel += 1;
		const component = growComponent(bright, labels, width, height, seed, nextLabel, queue, maxArea);
		if (!component) continue; // exceeded maxArea (roads/buildings) — already labeled, skip
		if (component.count < MIN_RIM_AREA_PX) continue;
		if (
			component.minX < BORDER_MARGIN_PX ||
			component.minY < BORDER_MARGIN_PX ||
			component.maxX > width - 1 - BORDER_MARGIN_PX ||
			component.maxY > height - 1 - BORDER_MARGIN_PX
		) {
			continue;
		}
		const frame = assessFrame(component, bright, value, width);
		if (frame !== null) frames.push(frame);
	}

	const majors = frames.map((frame) => frame.majorPx).sort((a, b) => a - b);
	if (majors.length < MIN_FRAMES) return null;
	// Consensus cluster: real pads on one map share one size to within a few
	// percent, while stray accepts (odd white structures) scatter. Keep the
	// largest ±12% agreement window and take its median — a mode, not a mean,
	// so a handful of outliers can never drag the scale.
	let clusterFrames: WhiteTeeFrameCandidate[] = [];
	for (const anchor of frames) {
		const windowFrames = frames.filter(
			(frame) => Math.abs(frame.majorPx - anchor.majorPx) <= anchor.majorPx * CLUSTER_TOLERANCE
		);
		if (windowFrames.length > clusterFrames.length) clusterFrames = windowFrames;
	}
	if (clusterFrames.length < MIN_FRAMES) return null;
	const clusterMajors = clusterFrames.map((frame) => frame.majorPx).sort((a, b) => a - b);
	const middle = Math.floor(clusterMajors.length / 2);
	const median =
		clusterMajors.length % 2 === 0
			? (clusterMajors[middle - 1] + clusterMajors[middle]) / 2
			: clusterMajors[middle];
	return {
		worldScale: asWorldScale(median / REFERENCE_FRAME_MAJOR_PX, 'measured white-frame world scale'),
		medianFrameMajorPx: median,
		frameCount: majors.length,
		frameMajorsPx: majors,
		frameCandidates: [...clusterFrames].sort((a, b) => a.yPx - b.yPx || a.xPx - b.xPx)
	};
}

/** BFS-labels one bright component; null (still labeling the region) once it exceeds maxArea. */
function growComponent(
	bright: Uint8Array,
	labels: Int32Array,
	width: number,
	height: number,
	seed: number,
	label: number,
	queue: Int32Array,
	maxArea: number
): FrameComponent | null {
	let head = 0;
	let tail = 0;
	// Grown (never wrapped) rather than used as a fixed-size ring buffer: labeling must
	// visit every reachable pixel of the component even past maxArea, so the outer seed
	// scan never re-discovers an unlabeled remnant of an already-rejected region as a new
	// "frame" candidate. A ring buffer sized to maxArea would either clobber unread entries
	// (corrupting the traversal) or stop early and leave the component partially labeled.
	let buffer = queue;
	buffer[tail] = seed;
	tail += 1;
	labels[seed] = label;
	let minX = width;
	let minY = height;
	let maxX = 0;
	let maxY = 0;
	let overflow = false;
	const pixels: number[] = [];
	while (head < tail) {
		const index = buffer[head];
		head += 1;
		if (!overflow) pixels.push(index);
		if (pixels.length >= maxArea) overflow = true;
		const x = index % width;
		const y = (index - x) / width;
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
		const neighbors = [index - 1, index + 1, index - width, index + width];
		for (const neighbor of neighbors) {
			if (neighbor < 0 || neighbor >= bright.length) continue;
			const nx = neighbor % width;
			if (Math.abs(nx - x) > 1) continue; // row wrap
			if (bright[neighbor] === 0 || labels[neighbor] !== 0) continue;
			labels[neighbor] = label;
			if (tail >= buffer.length) {
				const grown = new Int32Array(buffer.length * 2);
				grown.set(buffer);
				buffer = grown;
			}
			buffer[tail] = neighbor;
			tail += 1;
		}
	}
	if (overflow) return null;
	return { pixels: Int32Array.from(pixels), count: pixels.length, minX, minY, maxX, maxY };
}

/** Applies the frame gates; returns the accepted frame geometry, or null. */
function assessFrame(
	component: FrameComponent,
	bright: Uint8Array,
	value: Uint8Array,
	width: number
): WhiteTeeFrameCandidate | null {
	const { pixels, count } = component;
	// Principal axis via second moments.
	let sumX = 0;
	let sumY = 0;
	for (let i = 0; i < count; i += 1) {
		const index = pixels[i];
		sumX += index % width;
		sumY += Math.floor(index / width);
	}
	const meanX = sumX / count;
	const meanY = sumY / count;
	let covXX = 0;
	let covXY = 0;
	let covYY = 0;
	for (let i = 0; i < count; i += 1) {
		const index = pixels[i];
		const dx = (index % width) - meanX;
		const dy = Math.floor(index / width) - meanY;
		covXX += dx * dx;
		covXY += dx * dy;
		covYY += dy * dy;
	}
	covXX /= count;
	covXY /= count;
	covYY /= count;
	const trace = covXX + covYY;
	const det = covXX * covYY - covXY * covXY;
	const disc = Math.sqrt(Math.max(0, (trace * trace) / 4 - det));
	const lambda1 = trace / 2 + disc;
	// Scale-only callers previously did not care which axis was chosen when
	// covXY==0. Now that orientation escapes this function, pick the actual
	// principal image axis for horizontal/vertical frames too.
	const axisX = Math.abs(covXY) > 1e-9 ? lambda1 - covYY : covXX >= covYY ? 1 : 0;
	const axisY = Math.abs(covXY) > 1e-9 ? covXY : covXX >= covYY ? 0 : 1;
	const axisNorm = Math.hypot(axisX, axisY) || 1;
	const ux = axisX / axisNorm;
	const uy = axisY / axisNorm;
	// Extents by projection onto the principal axes.
	let minA = Infinity;
	let maxA = -Infinity;
	let minB = Infinity;
	let maxB = -Infinity;
	for (let i = 0; i < count; i += 1) {
		const index = pixels[i];
		const dx = (index % width) - meanX;
		const dy = Math.floor(index / width) - meanY;
		const a = dx * ux + dy * uy;
		const b = -dx * uy + dy * ux;
		if (a < minA) minA = a;
		if (a > maxA) maxA = a;
		if (b < minB) minB = b;
		if (b > maxB) maxB = b;
	}
	const extentMajor = maxA - minA + 1;
	const extentMinor = maxB - minB + 1;
	const firstAxisIsMajor = extentMajor >= extentMinor;
	const major = firstAxisIsMajor ? extentMajor : extentMinor;
	const minor = firstAxisIsMajor ? extentMinor : extentMajor;
	const majorUx = firstAxisIsMajor ? ux : -uy;
	const majorUy = firstAxisIsMajor ? uy : ux;
	if (major < MIN_MAJOR_PX || minor < MIN_MINOR_PX) return null;
	const aspect = major / minor;
	if (aspect < ASPECT_MIN || aspect > ASPECT_MAX) return null;
	const fill = count / (major * minor);
	if (fill < FRAME_FILL_MIN || fill > FRAME_FILL_MAX) return null;

	// Enclosed-hole check: flood non-bright pixels from the centroid inside
	// the bounding box (+1 margin). A frame's interior never reaches the
	// margin border; dashes, stripes, and open shapes always do.
	const x0 = component.minX - 1;
	const y0 = component.minY - 1;
	const x1 = component.maxX + 1;
	const y1 = component.maxY + 1;
	const boxWidth = x1 - x0 + 1;
	const boxHeight = y1 - y0 + 1;
	const startX = Math.round(meanX);
	const startY = Math.round(meanY);
	if (startX < x0 || startX > x1 || startY < y0 || startY > y1) return null;
	if (bright[startY * width + startX] !== 0) return null;
	const visited = new Uint8Array(boxWidth * boxHeight);
	const stack: number[] = [(startY - y0) * boxWidth + (startX - x0)];
	visited[stack[0]] = 1;
	let holeArea = 0;
	const holeValues: number[] = [];
	let touchesBorder = false;
	while (stack.length > 0) {
		const local = stack.pop() as number;
		const lx = local % boxWidth;
		const ly = (local - lx) / boxWidth;
		if (lx === 0 || ly === 0 || lx === boxWidth - 1 || ly === boxHeight - 1) {
			touchesBorder = true;
			break;
		}
		const globalIndex = (ly + y0) * width + (lx + x0);
		holeArea += 1;
		holeValues.push(value[globalIndex]);
		const localNeighbors = [local - 1, local + 1, local - boxWidth, local + boxWidth];
		for (const neighbor of localNeighbors) {
			if (neighbor < 0 || neighbor >= visited.length || visited[neighbor] !== 0) continue;
			const nx = neighbor % boxWidth;
			const ny = (neighbor - nx) / boxWidth;
			const globalNeighbor = (ny + y0) * width + (nx + x0);
			visited[neighbor] = 1;
			if (bright[globalNeighbor] === 0) stack.push(neighbor);
		}
	}
	if (touchesBorder) return null;
	if (holeArea / (holeArea + count) < HOLE_FRACTION_MIN) return null;
	holeValues.sort((a, b) => a - b);
	const interiorValue = holeValues[Math.floor(holeValues.length / 2)];
	if (interiorValue < INTERIOR_VALUE_MIN || interiorValue > INTERIOR_VALUE_MAX) return null;
	const rawOrientationDeg = (Math.atan2(majorUy, majorUx) * 180) / Math.PI;
	const orientationDeg = ((rawOrientationDeg % 180) + 180) % 180;
	return {
		xPx: meanX,
		yPx: meanY,
		majorPx: major,
		minorPx: minor,
		orientationDeg
	};
}

/**
 * Area-weighted (box-filter) RGBA downscale — the resize used to build the
 * canonical tee workspace. Downscale only: worldScale < 1 captures (zoomed
 * further out than IMG_5641) currently pass through unnormalized rather
 * than being upscaled into invented detail.
 */
export function resizeRgbaArea(raster: WorldScaleRaster, factor: number): {
	rgba: Uint8Array;
	widthPx: number;
	heightPx: number;
} {
	if (factor >= 1) throw new Error('resizeRgbaArea only downscales (factor < 1).');
	const sourceWidth = raster.widthPx;
	const sourceHeight = raster.heightPx;
	const width = Math.max(1, Math.round(sourceWidth * factor));
	const height = Math.max(1, Math.round(sourceHeight * factor));
	const out = new Uint8Array(width * height * 4);
	const inverse = 1 / factor;
	for (let y = 0; y < height; y += 1) {
		const srcY0 = y * inverse;
		const srcY1 = Math.min(sourceHeight, (y + 1) * inverse);
		for (let x = 0; x < width; x += 1) {
			const srcX0 = x * inverse;
			const srcX1 = Math.min(sourceWidth, (x + 1) * inverse);
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let weightSum = 0;
			for (let sy = Math.floor(srcY0); sy < srcY1; sy += 1) {
				const wy = Math.min(sy + 1, srcY1) - Math.max(sy, srcY0);
				if (wy <= 0) continue;
				for (let sx = Math.floor(srcX0); sx < srcX1; sx += 1) {
					const wx = Math.min(sx + 1, srcX1) - Math.max(sx, srcX0);
					if (wx <= 0) continue;
					const weight = wx * wy;
					const offset = (sy * sourceWidth + sx) * 4;
					r += raster.rgba[offset] * weight;
					g += raster.rgba[offset + 1] * weight;
					b += raster.rgba[offset + 2] * weight;
					a += raster.rgba[offset + 3] * weight;
					weightSum += weight;
				}
			}
			const outOffset = (y * width + x) * 4;
			out[outOffset] = Math.round(r / weightSum);
			out[outOffset + 1] = Math.round(g / weightSum);
			out[outOffset + 2] = Math.round(b / weightSum);
			out[outOffset + 3] = Math.round(a / weightSum);
		}
	}
	return { rgba: out, widthPx: width, heightPx: height };
}
