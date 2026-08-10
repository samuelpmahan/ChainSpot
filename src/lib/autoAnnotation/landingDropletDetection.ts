/**
 * Round-marker (thrown-disc landing) detection for a UDisc round screenshot.
 *
 * A direct port of the proven CV probe (`find_droplets.py` / `classify_droplets.py`
 * from the droplet-detection handoff): threshold UDisc's highly saturated marker
 * blue in HSV, keep droplet-shaped connected components, and report the TIP
 * (bottom-most blue pixels, not the blob centroid) as the semantic landing
 * location. A second, independent stage classifies the small white/blue glyph
 * inside each droplet as C1 / C2 / OFF_FAIRWAY against bundled canonical
 * templates cropped from a real UDisc round.
 *
 * This module is deliberately narrow:
 *  - it detects standalone landing droplets and classifies their glyph;
 *  - it does NOT assign markers to holes, infer throw order, infer made
 *    putts, or reconstruct a round;
 *  - it does NOT attempt to split visually merged/overlapping droplets (a
 *    short missed putt can render two droplets close enough to form one
 *    blue connected component). Suspicious merged components are surfaced
 *    as `DeferredOverlapRegion`s, never as confident split detections. See
 *    `docs/cv-landing-droplet-detection.md`.
 *
 * Like `basketTemplateDetection.ts` and `teePadDetection.ts`, this is
 * worker-only-adjacent but environment-agnostic: the caller supplies an
 * already-decoded RGBA raster and the OpenCV instance it owns. It does not
 * load WASM, decode images, or mutate editor state, so it runs identically
 * in a browser worker or a Node CLI.
 */

export type LandingMarkerKind = 'c1' | 'c2' | 'off-fairway';

/**
 * A raster at any analysis resolution. `sourceScale` is source pixels per
 * raster pixel: use `1` for full resolution and `1 / analysisScale` after a
 * downsample. The bytes are standard RGBA row-major pixels.
 */
export interface LandingDropletRaster {
	readonly rgba: Uint8Array | Uint8ClampedArray;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly sourceScale: number;
}

export interface LandingDropletBounds {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

/** Localizer output: "there is a landing droplet here; semantic location = tip." */
export interface LandingDropletLocalization {
	/** Semantic endpoint: the bottom of the droplet, never the blob/glyph center. */
	readonly tip: Readonly<{ xPx: number; yPx: number }>;
	readonly boundsPx: LandingDropletBounds;
	readonly areaPx: number;
}

export interface DeferredOverlapRegion {
	readonly boundsPx: LandingDropletBounds;
	readonly areaPx: number;
	readonly reason: string;
}

export interface LandingDropletDetectionResult {
	readonly droplets: readonly LandingDropletLocalization[];
	readonly deferredOverlaps: readonly DeferredOverlapRegion[];
}

/** Classifier output: "this droplet is C1 / C2 / OFF_FAIRWAY." */
export interface LandingDropletGlyphClassification {
	readonly kind: LandingMarkerKind;
	/**
	 * Best template's Dice-overlap score in [0, 1] against the interior glyph
	 * mask. Not a calibrated probability -- there is no trained model behind
	 * it, just a shape-similarity score against a single bundled reference per
	 * class. Callers should not treat it as a confidence percentage.
	 */
	readonly glyphConfidence: number;
}

/** Combined localizer + classifier candidate, matching the round-marker primitive's public shape. */
export interface LandingMarkerCandidate {
	readonly tip: Readonly<{ xPx: number; yPx: number }>;
	readonly boundsPx: LandingDropletBounds;
	readonly kind: LandingMarkerKind;
	readonly glyphConfidence: number;
}

/** A canonical interior-glyph template for one marker class, as a normalized binary mask. */
export interface LandingDropletGlyphTemplate {
	readonly kind: LandingMarkerKind;
	readonly size: number;
	/** Row-major mask, one float per pixel in [0, 1]. */
	readonly mask: Float32Array;
}

type CvMat = {
	readonly rows: number;
	readonly cols: number;
	readonly data: Uint8Array;
	readonly data32S?: Int32Array;
	type(): number;
	delete(): void;
};

type CvSize = unknown;

/** Narrow OpenCV surface used by this detector. */
export interface LandingDropletCv {
	Mat: new (rows?: number, cols?: number, type?: number, scalar?: unknown) => CvMat;
	Scalar: new (...values: number[]) => unknown;
	CV_8UC4: number;
	CV_32S: number;
	COLOR_RGBA2RGB: number;
	COLOR_RGB2HSV: number;
	cvtColor(source: CvMat, destination: CvMat, code: number): void;
	inRange(source: CvMat, lowerBound: CvMat, upperBound: CvMat, destination: CvMat): void;
	connectedComponentsWithStats(
		image: CvMat,
		labels: CvMat,
		stats: CvMat,
		centroids: CvMat,
		connectivity: number,
		ltype: number
	): number;
}

export interface FindLandingDropletsOptions {
	/** Optional raster-pixel vertical map extent. Everything outside is ignored. */
	readonly mapBoundsPx?: Readonly<{ topPx: number; bottomPx: number }>;
}

/**
 * UDisc marker blue is highly saturated and stable across screenshot scales.
 * OpenCV hue is [0, 179]; this matches the proven CV probe's `find_droplets.py`.
 */
const BLUE_HUE_LOW = 95;
const BLUE_HUE_HIGH = 125;
const BLUE_SAT_LOW = 100;
const BLUE_VALUE_LOW = 100;

/** Drops antialiasing speckle before any shape filtering. */
const MIN_COMPONENT_AREA_PX = 30;

/**
 * A standalone droplet is a vertically elongated pin. These bounds are
 * intentionally generous (not tuned to one fixed screenshot resolution) --
 * the real discriminators are the aspect ratio and the relative-area check
 * below, which both scale with the image itself. GPS-location dots are
 * roughly circular (aspect ~1); MAP/SAT chrome is very wide (aspect < 1).
 */
const PIN_ASPECT_MIN = 1.15;
const PIN_WIDTH_MIN_PX = 6;
const PIN_WIDTH_MAX_PX = 160;
const PIN_HEIGHT_MIN_PX = 10;
const PIN_HEIGHT_MAX_PX = 220;

/** Once a normal droplet area is known for this image, reject outliers relative to it. */
const RELATIVE_AREA_LOW = 0.55;
const RELATIVE_AREA_HIGH = 1.6;

/**
 * Suspicious-merge heuristic: roughly >=1.45x a standalone droplet's area,
 * but bounded to plausibly be two overlapping droplets rather than wide UI
 * chrome (a MAP/SAT control can still be "big enough" by area while being
 * far wider than two droplets ever would be).
 */
const DEFERRED_AREA_RATIO = 1.45;
const DEFERRED_MAX_DIMENSION_RATIO = 2.3;

function matFromRgba(cv: LandingDropletCv, rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): CvMat {
	const mat = new cv.Mat(height, width, cv.CV_8UC4);
	mat.data.set(rgba);
	return mat;
}

/** Caller frees every temporary Mat before returning or throwing, mirroring `basketTemplateDetection.ts`. */
function blueMask(cv: LandingDropletCv, raster: LandingDropletRaster): CvMat {
	const rgbaMat = matFromRgba(cv, raster.rgba, raster.widthPx, raster.heightPx);
	const rgbMat = new cv.Mat();
	const hsvMat = new cv.Mat();
	const mask = new cv.Mat();
	try {
		cv.cvtColor(rgbaMat, rgbMat, cv.COLOR_RGBA2RGB);
		cv.cvtColor(rgbMat, hsvMat, cv.COLOR_RGB2HSV);
		const low = new cv.Mat(hsvMat.rows, hsvMat.cols, hsvMat.type(), new cv.Scalar(BLUE_HUE_LOW, BLUE_SAT_LOW, BLUE_VALUE_LOW, 0));
		const high = new cv.Mat(hsvMat.rows, hsvMat.cols, hsvMat.type(), new cv.Scalar(BLUE_HUE_HIGH, 255, 255, 255));
		try {
			cv.inRange(hsvMat, low, high, mask);
		} finally {
			low.delete();
			high.delete();
		}
		return mask;
	} finally {
		rgbaMat.delete();
		rgbMat.delete();
		hsvMat.delete();
	}
}

interface RawComponent {
	readonly label: number;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly area: number;
}

function readComponents(cv: LandingDropletCv, mask: CvMat): { labels: CvMat; components: RawComponent[] } {
	const labels = new cv.Mat();
	const stats = new cv.Mat();
	const centroids = new cv.Mat();
	try {
		const count = cv.connectedComponentsWithStats(mask, labels, stats, centroids, 8, cv.CV_32S);
		const statsData = stats.data32S;
		if (!statsData) throw new Error('Landing droplet detection expected 32-bit connected-component stats.');
		const components: RawComponent[] = [];
		// Label 0 is always the background component; real components start at 1.
		for (let label = 1; label < count; label += 1) {
			const offset = label * 5;
			components.push({
				label,
				x: statsData[offset],
				y: statsData[offset + 1],
				width: statsData[offset + 2],
				height: statsData[offset + 3],
				area: statsData[offset + 4]
			});
		}
		return { labels, components };
	} finally {
		stats.delete();
		centroids.delete();
	}
}

/** Bottom-most blue point of one labeled component; averages x across the bottom 2 rows for stability. */
function componentTip(
	labelData: Int32Array,
	cols: number,
	label: number,
	x: number,
	y: number,
	width: number,
	height: number
): { xPx: number; yPx: number } {
	let bottomLocalY = -1;
	for (let localY = height - 1; localY >= 0 && bottomLocalY < 0; localY -= 1) {
		const rowOffset = (y + localY) * cols + x;
		for (let localX = 0; localX < width; localX += 1) {
			if (labelData[rowOffset + localX] === label) {
				bottomLocalY = localY;
				break;
			}
		}
	}
	if (bottomLocalY < 0) throw new Error('Landing droplet detection could not locate a component tip.');

	let sumX = 0;
	let count = 0;
	for (let localY = Math.max(0, bottomLocalY - 1); localY <= bottomLocalY; localY += 1) {
		const rowOffset = (y + localY) * cols + x;
		for (let localX = 0; localX < width; localX += 1) {
			if (labelData[rowOffset + localX] === label) {
				sumX += x + localX;
				count += 1;
			}
		}
	}
	return { xPx: Math.round(sumX / count), yPx: y + bottomLocalY };
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Consecutive-neighbor area ratio that still counts as "the same droplet size" when clustering. */
const AREA_CLUSTER_RATIO = 1.6;

/**
 * A screenshot can contain small, incidentally pin-shaped UI fragments (e.g.
 * a letter inside a MAP/SAT button) alongside the real droplets. Those
 * fragments are typically few and inconsistent in size, while real droplets
 * from the same round recur at a consistent size. Rather than trust a flat
 * median of every pin-shaped candidate's area (which a handful of small
 * noise fragments can drag down), cluster candidates by area and treat the
 * largest recurring cluster as "the droplet size" for this image.
 */
function dominantAreaCluster(components: readonly RawComponent[]): readonly RawComponent[] {
	if (components.length === 0) return [];
	const sorted = [...components].sort((a, b) => a.area - b.area);
	const clusters: RawComponent[][] = [];
	let current: RawComponent[] = [sorted[0]];
	for (const component of sorted.slice(1)) {
		const previous = current[current.length - 1];
		if (component.area <= previous.area * AREA_CLUSTER_RATIO) {
			current.push(component);
		} else {
			clusters.push(current);
			current = [component];
		}
	}
	clusters.push(current);

	let best = clusters[0];
	for (const cluster of clusters.slice(1)) {
		const better =
			cluster.length > best.length ||
			(cluster.length === best.length && median(cluster.map((c) => c.area)) > median(best.map((c) => c.area)));
		if (better) best = cluster;
	}
	return best;
}

function withinRows(centerY: number, rows: { first: number; last: number } | null): boolean {
	if (!rows) return true;
	return centerY >= rows.first && centerY <= rows.last;
}

function mapRows(
	raster: LandingDropletRaster,
	mapBoundsPx: FindLandingDropletsOptions['mapBoundsPx']
): { first: number; last: number } | null {
	if (!mapBoundsPx) return null;
	const first = Math.max(0, Math.min(raster.heightPx - 1, Math.ceil(mapBoundsPx.topPx / raster.sourceScale)));
	const last = Math.max(0, Math.min(raster.heightPx - 1, Math.floor(mapBoundsPx.bottomPx / raster.sourceScale)));
	return first <= last ? { first, last } : null;
}

function validateRaster(raster: LandingDropletRaster): void {
	if (!Number.isInteger(raster.widthPx) || !Number.isInteger(raster.heightPx) || raster.widthPx <= 0 || raster.heightPx <= 0) {
		throw new Error('Landing droplet detection received invalid raster dimensions.');
	}
	if (!Number.isFinite(raster.sourceScale) || raster.sourceScale <= 0) {
		throw new Error('Landing droplet detection requires a positive sourceScale.');
	}
	if (raster.rgba.length < raster.widthPx * raster.heightPx * 4) {
		throw new Error('Landing droplet detection raster does not contain RGBA pixels for its dimensions.');
	}
}

/**
 * Detect standalone landing droplets and flag (but do not split) suspicious
 * merged components. The caller owns every Mat passed through `cv`; this
 * function frees all temporary Mats before it returns or throws.
 */
export function findLandingDroplets(
	cv: LandingDropletCv,
	raster: LandingDropletRaster,
	options: FindLandingDropletsOptions = {}
): LandingDropletDetectionResult {
	validateRaster(raster);
	const rows = mapRows(raster, options.mapBoundsPx);

	const mask = blueMask(cv, raster);
	let labelsMat: CvMat | null = null;
	try {
		const { labels, components } = readComponents(cv, mask);
		labelsMat = labels;
		const labelData = labels.data32S;
		if (!labelData) throw new Error('Landing droplet detection expected 32-bit component labels.');

		const substantial = components.filter((component) => component.area >= MIN_COMPONENT_AREA_PX);

		const pinLike = substantial.filter(
			(component) =>
				component.width >= PIN_WIDTH_MIN_PX &&
				component.width <= PIN_WIDTH_MAX_PX &&
				component.height >= PIN_HEIGHT_MIN_PX &&
				component.height <= PIN_HEIGHT_MAX_PX &&
				component.height / component.width >= PIN_ASPECT_MIN
		);

		const dominantCluster = dominantAreaCluster(pinLike);
		const normalArea = median(dominantCluster.map((component) => component.area));
		const normalWidth = median(dominantCluster.map((component) => component.width));
		const normalHeight = median(dominantCluster.map((component) => component.height));

		const standalone = pinLike.filter((component) => {
			if (!normalArea) return true;
			return component.area >= RELATIVE_AREA_LOW * normalArea && component.area <= RELATIVE_AREA_HIGH * normalArea;
		});

		const droplets: LandingDropletLocalization[] = [];
		for (const component of standalone) {
			const tip = componentTip(labelData, raster.widthPx, component.label, component.x, component.y, component.width, component.height);
			if (!withinRows(tip.yPx, rows)) continue;
			droplets.push({
				tip: { xPx: tip.xPx * raster.sourceScale, yPx: tip.yPx * raster.sourceScale },
				boundsPx: {
					xPx: component.x * raster.sourceScale,
					yPx: component.y * raster.sourceScale,
					widthPx: component.width * raster.sourceScale,
					heightPx: component.height * raster.sourceScale
				},
				areaPx: component.area * raster.sourceScale * raster.sourceScale
			});
		}

		const standaloneLabels = new Set(standalone.map((component) => component.label));
		const deferredOverlaps: DeferredOverlapRegion[] = [];
		if (normalArea) {
			for (const component of substantial) {
				if (standaloneLabels.has(component.label)) continue;
				if (component.area < DEFERRED_AREA_RATIO * normalArea) continue;
				// Bound both dimensions to a plausible two-droplet footprint. This is what actually
				// tells a merged droplet pair apart from wide UI chrome (a MAP/SAT control can be
				// "big enough" by area alone while being far wider than two droplets ever would be).
				if (normalWidth && component.width > DEFERRED_MAX_DIMENSION_RATIO * normalWidth) continue;
				if (normalHeight && component.height > DEFERRED_MAX_DIMENSION_RATIO * normalHeight) continue;
				const centerY = component.y + component.height / 2;
				if (!withinRows(centerY, rows)) continue;
				deferredOverlaps.push({
					boundsPx: {
						xPx: component.x * raster.sourceScale,
						yPx: component.y * raster.sourceScale,
						widthPx: component.width * raster.sourceScale,
						heightPx: component.height * raster.sourceScale
					},
					areaPx: component.area * raster.sourceScale * raster.sourceScale,
					reason: 'possible merged/overlapped droplets; document & defer'
				});
			}
		}

		droplets.sort((a, b) => a.tip.yPx - b.tip.yPx || a.tip.xPx - b.tip.xPx);
		deferredOverlaps.sort((a, b) => a.boundsPx.yPx - b.boundsPx.yPx || a.boundsPx.xPx - b.boundsPx.xPx);
		return { droplets, deferredOverlaps };
	} finally {
		mask.delete();
		labelsMat?.delete();
	}
}

// --- Glyph classification -------------------------------------------------

/** Matches the bundled template generation size (see `scripts/generate-landing-droplet-templates.ts`). */
export const LANDING_GLYPH_TEMPLATE_SIZE = 28;
/** The baseline ignores roughly the lower quarter of the droplet, which contains the tip, not the glyph. */
const GLYPH_CROP_HEIGHT_FRACTION = 0.76;
const WHITE_SATURATION_MAX = 80;
const WHITE_VALUE_MIN = 180;
const MIN_GLYPH_FRAGMENT_AREA = 2;

/** Saturation and value only -- this stage looks for bright/low-saturation (white) pixels, not hue. */
function saturationAndValue(r: number, g: number, b: number): { s: number; v: number } {
	const maximum = Math.max(r, g, b);
	const minimum = Math.min(r, g, b);
	const s = maximum === 0 ? 0 : ((maximum - minimum) * 255) / maximum;
	return { s, v: maximum };
}

/**
 * Isolate bright, low-saturation pixels within a droplet's interior (ignoring
 * the tip), discard white fragments touching the crop border so the
 * droplet's white outer rim does not dominate, then resize to a fixed
 * canvas. Pure JS/typed-array logic -- no OpenCV Mat required, so this stage
 * is directly unit-testable against synthetic rasters.
 */
export function buildInteriorGlyphSignature(
	raster: LandingDropletRaster,
	boundsPx: LandingDropletBounds,
	size: number = LANDING_GLYPH_TEMPLATE_SIZE
): Float32Array {
	const x = Math.round(boundsPx.xPx / raster.sourceScale);
	const y = Math.round(boundsPx.yPx / raster.sourceScale);
	const width = Math.max(1, Math.round(boundsPx.widthPx / raster.sourceScale));
	const rawHeight = Math.max(1, Math.round(boundsPx.heightPx / raster.sourceScale));
	const height = Math.max(1, Math.round(rawHeight * GLYPH_CROP_HEIGHT_FRACTION));

	const white = new Uint8Array(width * height);
	for (let row = 0; row < height; row += 1) {
		for (let col = 0; col < width; col += 1) {
			const sourceX = x + col;
			const sourceY = y + row;
			if (sourceX < 0 || sourceY < 0 || sourceX >= raster.widthPx || sourceY >= raster.heightPx) continue;
			const offset = (sourceY * raster.widthPx + sourceX) * 4;
			const { s, v } = saturationAndValue(raster.rgba[offset], raster.rgba[offset + 1], raster.rgba[offset + 2]);
			if (s < WHITE_SATURATION_MAX && v > WHITE_VALUE_MIN) white[row * width + col] = 1;
		}
	}

	const kept = discardBorderConnectedFragments(white, width, height);
	return resizeMaskNearest(kept, width, height, size);
}

/** Flood-fills 4-connected white fragments from the crop border and zeroes them, matching the Python baseline. */
function discardBorderConnectedFragments(mask: Uint8Array, width: number, height: number): Uint8Array {
	const visited = new Uint8Array(width * height);
	const componentLabel = new Int32Array(width * height).fill(-1);
	const componentSizes: number[] = [];
	const componentTouchesBorder: boolean[] = [];

	for (let start = 0; start < mask.length; start += 1) {
		if (mask[start] === 0 || visited[start]) continue;
		const label = componentSizes.length;
		componentSizes.push(0);
		componentTouchesBorder.push(false);
		const stack = [start];
		visited[start] = 1;
		while (stack.length) {
			const index = stack.pop() as number;
			const row = Math.floor(index / width);
			const col = index % width;
			componentLabel[index] = label;
			componentSizes[label] += 1;
			if (row === 0 || col === 0 || row === height - 1 || col === width - 1) componentTouchesBorder[label] = true;
			const neighbors = [
				[row - 1, col],
				[row + 1, col],
				[row, col - 1],
				[row, col + 1]
			];
			for (const [neighborRow, neighborCol] of neighbors) {
				if (neighborRow < 0 || neighborCol < 0 || neighborRow >= height || neighborCol >= width) continue;
				const neighborIndex = neighborRow * width + neighborCol;
				if (mask[neighborIndex] === 0 || visited[neighborIndex]) continue;
				visited[neighborIndex] = 1;
				stack.push(neighborIndex);
			}
		}
	}

	const kept = new Uint8Array(width * height);
	for (let index = 0; index < mask.length; index += 1) {
		const label = componentLabel[index];
		if (label < 0) continue;
		if (componentTouchesBorder[label]) continue;
		if (componentSizes[label] < MIN_GLYPH_FRAGMENT_AREA) continue;
		kept[index] = 1;
	}
	return kept;
}

function resizeMaskNearest(mask: Uint8Array, width: number, height: number, size: number): Float32Array {
	const resized = new Float32Array(size * size);
	for (let row = 0; row < size; row += 1) {
		const sourceRow = Math.min(height - 1, Math.floor((row * height) / size));
		for (let col = 0; col < size; col += 1) {
			const sourceCol = Math.min(width - 1, Math.floor((col * width) / size));
			resized[row * size + col] = mask[sourceRow * width + sourceCol];
		}
	}
	return resized;
}

/** Dice-coefficient similarity between a signature and a template mask, penalized by pixel-count mismatch. */
function diceScore(signature: Float32Array, template: LandingDropletGlyphTemplate): number {
	let intersection = 0;
	let signatureSum = 0;
	let templateSum = 0;
	for (let index = 0; index < signature.length; index += 1) {
		const signatureValue = signature[index];
		const templateValue = template.mask[index] ?? 0;
		intersection += Math.min(signatureValue, templateValue);
		signatureSum += signatureValue;
		templateSum += templateValue;
	}
	const denominator = signatureSum + templateSum;
	const dice = denominator > 0 ? (2 * intersection) / denominator : 0;
	const countPenalty = Math.abs(signatureSum - templateSum) / Math.max(1, templateSum);
	return dice - 0.15 * countPenalty;
}

/**
 * Classify one already-localized droplet's interior glyph against bundled
 * canonical templates. Localization and classification are independent
 * stages: this never re-derives the tip or bounds.
 */
export function classifyLandingDropletGlyph(
	raster: LandingDropletRaster,
	localization: LandingDropletLocalization,
	templates: readonly LandingDropletGlyphTemplate[]
): LandingDropletGlyphClassification {
	if (templates.length === 0) throw new Error('Landing droplet glyph classification requires at least one template.');
	const size = templates[0].size;
	const signature = buildInteriorGlyphSignature(raster, localization.boundsPx, size);

	let best = templates[0];
	let bestScore = diceScore(signature, templates[0]);
	for (const template of templates.slice(1)) {
		const score = diceScore(signature, template);
		if (score > bestScore) {
			best = template;
			bestScore = score;
		}
	}
	return { kind: best.kind, glyphConfidence: bestScore };
}

/** Convenience wrapper combining localization + classification into the public round-marker shape. */
export function classifyLandingDropletGlyphs(
	raster: LandingDropletRaster,
	droplets: readonly LandingDropletLocalization[],
	templates: readonly LandingDropletGlyphTemplate[]
): readonly LandingMarkerCandidate[] {
	return droplets.map((droplet) => {
		const classification = classifyLandingDropletGlyph(raster, droplet, templates);
		return {
			tip: droplet.tip,
			boundsPx: droplet.boundsPx,
			kind: classification.kind,
			glyphConfidence: classification.glyphConfidence
		};
	});
}

/** Builds a `LandingDropletGlyphTemplate` from a decoded grayscale mask PNG (0 = background, >0 = glyph). */
export function landingDropletGlyphTemplateFromMask(
	kind: LandingMarkerKind,
	gray: Uint8Array,
	widthPx: number,
	heightPx: number
): LandingDropletGlyphTemplate {
	if (widthPx !== heightPx) throw new Error(`Landing droplet glyph template '${kind}' must be square.`);
	const mask = new Float32Array(widthPx * heightPx);
	for (let index = 0; index < mask.length; index += 1) mask[index] = gray[index] > 127 ? 1 : 0;
	return { kind, size: widthPx, mask };
}
