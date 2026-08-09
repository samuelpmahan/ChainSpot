/**
 * Hole-number badge detection for clean UDisc course maps.
 *
 * This is intentionally worker-safe and transport-free: the caller supplies a
 * decoded grayscale/RGBA raster plus canonical badge rasters, and retains
 * ownership of decoding, scaling, and worker messaging. All returned points
 * are in the supplied source raster's pixel coordinate system.
 *
 * The implementation keeps the successful glyph-only classifier from the
 * Python probes, but avoids expensive full-image template matching for physical
 * badge localization and cheaply prunes implausible glyph labels before NCC:
 *
 * 1. threshold the image once and find connected dark components;
 * 2. identify the dominant repeated badge-body size cluster;
 * 3. derive template scale from observed badge-body dimensions;
 * 4. use NonBlackWidthRatio to retain only plausible glyph labels;
 * 5. NCC-score only retained tiny glyph ROIs and solve a one-to-one
 *    maximum-score assignment.
 *
 * Full 1..18 labeling therefore needs 18 canonical UDisc badge captures
 * (`hole-01.png` ... `hole-18.png`) from one unscaled UI style. The current
 * repository does not contain those captures. Passing a subset is still
 * useful: it produces ranked physical-badge candidates, but deliberately does
 * not publish the stage-one template label because the shared black border is
 * not discriminative enough to trust as a hole number.
 */

export type HoleNumberRaster =
	| {
		readonly format: 'gray';
		readonly widthPx: number;
		readonly heightPx: number;
		readonly data: Uint8Array;
	}
	| {
		readonly format: 'rgba';
		readonly widthPx: number;
		readonly heightPx: number;
		readonly data: Uint8Array | Uint8ClampedArray;
	};

/** A canonical, unscaled UDisc number-badge raster. */
export interface HoleNumberTemplate {
	/** The visible hole label represented by this badge (normally 1 through 18). */
	readonly label: number;
	readonly raster: HoleNumberRaster;
}

/**
 * The deliberately small OpenCV.js contract used here. Keeping this structural
 * lets an existing worker pass the already-loaded runtime without coupling the
 * detector to OpenCV globals or its package types.
 */
export interface HoleNumberCvModule {
	Mat: new (rows?: number, cols?: number, type?: number) => HoleNumberCvMat;
	CV_8UC1: number;
	TM_CCOEFF_NORMED: number;
	matchTemplate(
		image: HoleNumberCvMat,
		template: HoleNumberCvMat,
		result: HoleNumberCvMat,
		method: number
	): void;
}

export interface HoleNumberCvMat {
	readonly rows: number;
	readonly cols: number;
	readonly data: Uint8Array | Float32Array;
	readonly data32F?: Float32Array;
	delete(): void;
}

export interface HoleNumberCandidate {
	/** Center of the physical badge, in source-image pixels. */
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
	/** Measured UDisc UI scale relative to the supplied canonical templates. */
	readonly scale: number;
	/** Glyph score when labeled; otherwise the preliminary full-badge score. */
	readonly score: number;
	/** Full badge-template score used to locate the physical badge. */
	readonly badgeScore: number;
	/** Present only after glyph-only one-to-one label assignment. */
	readonly label?: number;
	readonly glyphScore?: number;
	/** Stable physical-candidate rank before the final labels are sorted. */
	readonly diagnosticId?: number;
	/** Independent raw glyph scores, sorted best-first, before one-to-one assignment. */
	readonly topGlyphMatches?: readonly Readonly<{ label: number; score: number }>[];
}

export interface HoleNumberScaleAnchor {
	readonly label: number;
	readonly score: number;
	readonly scale: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface HoleNumberDetection {
	readonly candidates: readonly HoleNumberCandidate[];
	readonly anchor: HoleNumberScaleAnchor | null;
	/** `assigned` means labels came from glyph-only one-to-one assignment. */
	readonly labeling: 'assigned' | 'candidate-only';
	/**
	 * Human-readable integration status. In particular, this makes a missing
	 * template pack a normal MVP state rather than an opaque detector failure.
	 */
	readonly note?: string;
}

export interface HoleNumberDetectionOptions {
	/** Broad #1-template search window. The probe's proven defaults are 0.40–1.60. */
	readonly minScale?: number;
	readonly maxScale?: number;
	readonly scaleStep?: number;
	/** The constrained stage-two window around the measured #1 scale. */
	readonly scaleTolerance?: number;
	readonly constrainedScaleSteps?: number;
	readonly minBadgeScore?: number;
	readonly maxCandidates?: number;
	/** Bounds retained response peaks per template/scale before spatial clustering. */
	readonly maxPeaksPerSearch?: number;
}

interface GrayRaster {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly data: Uint8Array;
}

interface ResizedTemplate extends GrayRaster {
	readonly label: number;
	readonly scale: number;
}

interface TemplateHit {
	readonly label: number;
	readonly score: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly scale: number;
}

interface BadgeCluster {
	readonly xPx: number;
	readonly yPx: number;
	readonly hits: TemplateHit[];
}

const DEFAULTS = {
	minScale: 0.4,
	maxScale: 1.6,
	scaleStep: 0.01,
	scaleTolerance: 0.08,
	constrainedScaleSteps: 9,
	minBadgeScore: 0.6,
	maxCandidates: 18,
	maxPeaksPerSearch: 96
} as const;


/**
 * UDisc's badge body is nearly black while the map underneath it is not.
 * These values are intentionally aligned with the offline clean-course probe.
 */
const BADGE_DARK_THRESHOLD = 50;
const BADGE_MIN_WIDTH_PX = 12;
const BADGE_MIN_HEIGHT_PX = 9;
const BADGE_MAX_WIDTH_PX = 120;
const BADGE_MAX_HEIGHT_PX = 90;
const BADGE_MIN_ASPECT = 1.12;
const BADGE_MAX_ASPECT = 1.75;
const BADGE_MIN_FILL_RATIO = 0.55;
const BADGE_SIZE_LOG_TOLERANCE = Math.log(1.2);

/**
 * Grid-searched on the current clean-course fixture.
 *
 * The safety floor deliberately uses 3 rather than the absolute grid optimum
 * of 1: it costs only six extra NCC comparisons on the fixture (89 vs 83) while
 * ensuring every physical badge keeps at least three plausible labels.
 */
const GLYPH_FOREGROUND_THRESHOLD = 150;
const GLYPH_MIN_COLUMN_PIXELS = 5;
const GLYPH_WIDTH_RATIO_TOLERANCE = 0.04;
const GLYPH_MIN_KEEP = 3;
/** Lower than any valid TM_CCOEFF_NORMED score; Hungarian treats pruned pairs as impossible. */
const GLYPH_PRUNED_SCORE = -2;

interface DarkComponent {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly areaPx: number;
	readonly fillRatio: number;
}

function darkComponents(source: GrayRaster): DarkComponent[] {
	const { widthPx, heightPx, data } = source;
	const pixelCount = widthPx * heightPx;
	const visited = new Uint8Array(pixelCount);
	const queue = new Int32Array(pixelCount);
	const components: DarkComponent[] = [];

	for (let seed = 0; seed < pixelCount; seed += 1) {
		if (visited[seed]) continue;
		visited[seed] = 1;
		if (data[seed] > BADGE_DARK_THRESHOLD) continue;

		let head = 0;
		let tail = 0;
		queue[tail++] = seed;
		let minX = widthPx;
		let minY = heightPx;
		let maxX = -1;
		let maxY = -1;
		let areaPx = 0;

		while (head < tail) {
			const index = queue[head++];
			const y = Math.floor(index / widthPx);
			const x = index - y * widthPx;
			areaPx += 1;
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);

			const firstY = Math.max(0, y - 1);
			const lastY = Math.min(heightPx - 1, y + 1);
			const firstX = Math.max(0, x - 1);
			const lastX = Math.min(widthPx - 1, x + 1);
			for (let neighborY = firstY; neighborY <= lastY; neighborY += 1) {
				const row = neighborY * widthPx;
				for (let neighborX = firstX; neighborX <= lastX; neighborX += 1) {
					const neighbor = row + neighborX;
					if (visited[neighbor]) continue;
					visited[neighbor] = 1;
					if (data[neighbor] <= BADGE_DARK_THRESHOLD) queue[tail++] = neighbor;
				}
			}
		}

		const componentWidth = maxX - minX + 1;
		const componentHeight = maxY - minY + 1;
		components.push({
			xPx: minX,
			yPx: minY,
			widthPx: componentWidth,
			heightPx: componentHeight,
			areaPx,
			fillRatio: areaPx / (componentWidth * componentHeight)
		});
	}

	return components;
}

function plausibleBadgeBody(component: DarkComponent): boolean {
	const aspect = component.widthPx / component.heightPx;
	return (
		component.widthPx >= BADGE_MIN_WIDTH_PX &&
		component.heightPx >= BADGE_MIN_HEIGHT_PX &&
		component.widthPx <= BADGE_MAX_WIDTH_PX &&
		component.heightPx <= BADGE_MAX_HEIGHT_PX &&
		aspect >= BADGE_MIN_ASPECT &&
		aspect <= BADGE_MAX_ASPECT &&
		component.fillRatio >= BADGE_MIN_FILL_RATIO
	);
}

function sizeDistance(a: DarkComponent, b: DarkComponent): number {
	return Math.max(
		Math.abs(Math.log(a.widthPx / b.widthPx)),
		Math.abs(Math.log(a.heightPx / b.heightPx))
	);
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

function selectBadgeBodies(
	components: readonly DarkComponent[],
	maxCandidates: number
): DarkComponent[] {
	const plausible = components.filter(plausibleBadgeBody);
	if (plausible.length === 0) return [];

	let bestCluster: DarkComponent[] = [];
	let bestFill = -1;
	for (const seed of plausible) {
		const cluster = plausible.filter(
			(candidate) => sizeDistance(seed, candidate) <= BADGE_SIZE_LOG_TOLERANCE
		);
		const fill = cluster.reduce((sum, candidate) => sum + candidate.fillRatio, 0);
		if (
			cluster.length > bestCluster.length ||
			(cluster.length === bestCluster.length && fill > bestFill)
		) {
			bestCluster = cluster;
			bestFill = fill;
		}
	}

	const medianWidth = median(bestCluster.map((candidate) => candidate.widthPx));
	const medianHeight = median(bestCluster.map((candidate) => candidate.heightPx));
	return [...bestCluster]
		.sort((a, b) => {
			const aSizeError =
				Math.abs(Math.log(a.widthPx / medianWidth)) +
				Math.abs(Math.log(a.heightPx / medianHeight));
			const bSizeError =
				Math.abs(Math.log(b.widthPx / medianWidth)) +
				Math.abs(Math.log(b.heightPx / medianHeight));
			return aSizeError - bSizeError || b.fillRatio - a.fillRatio || a.yPx - b.yPx;
		})
		.slice(0, maxCandidates)
		.sort((a, b) => a.yPx - b.yPx || a.xPx - b.xPx);
}

function templateBadgeBody(template: GrayRaster): DarkComponent | null {
	return (
		darkComponents(template)
			.filter(plausibleBadgeBody)
			.sort((a, b) => b.areaPx - a.areaPx)[0] ?? null
	);
}

function componentAnchorScale(
	bodies: readonly DarkComponent[],
	canonicalBody: DarkComponent
): number {
	const observedWidth = median(bodies.map((candidate) => candidate.widthPx));
	const observedHeight = median(bodies.map((candidate) => candidate.heightPx));
	return (
		observedWidth / canonicalBody.widthPx +
		observedHeight / canonicalBody.heightPx
	) / 2;
}

function clustersFromBadgeBodies(
	bodies: readonly DarkComponent[],
	anchorTemplate: HoleNumberTemplate,
	anchorScale: number
): BadgeCluster[] {
	const widthPx = Math.max(5, Math.round(anchorTemplate.raster.widthPx * anchorScale));
	const heightPx = Math.max(5, Math.round(anchorTemplate.raster.heightPx * anchorScale));
	return bodies.map((body) => {
		const centerX = body.xPx + body.widthPx / 2;
		const centerY = body.yPx + body.heightPx / 2;
		const localizationScore = Math.max(0, Math.min(1, body.fillRatio));
		return {
			xPx: centerX,
			yPx: centerY,
			hits: [
				{
					label: anchorTemplate.label,
					score: localizationScore,
					xPx: centerX - widthPx / 2,
					yPx: centerY - heightPx / 2,
					widthPx,
					heightPx,
					scale: anchorScale
				}
			]
		};
	});
}

function localizationAnchor(
	anchorTemplate: HoleNumberTemplate,
	anchorScale: number,
	clusters: readonly BadgeCluster[],
	assigned: readonly HoleNumberCandidate[] | null
): HoleNumberScaleAnchor | null {
	const labeled = assigned?.find((candidate) => candidate.label === anchorTemplate.label);
	if (labeled) {
		return {
			label: anchorTemplate.label,
			score: labeled.badgeScore,
			scale: anchorScale,
			xPx: labeled.xPx - labeled.widthPx / 2,
			yPx: labeled.yPx - labeled.heightPx / 2,
			widthPx: labeled.widthPx,
			heightPx: labeled.heightPx
		};
	}

	const hit = clusters[0]?.hits[0];
	return hit
		? {
				label: anchorTemplate.label,
				score: hit.score,
				scale: anchorScale,
				xPx: hit.xPx,
				yPx: hit.yPx,
				widthPx: hit.widthPx,
				heightPx: hit.heightPx
			}
		: null;
}

function assertRaster(raster: HoleNumberRaster, name: string): void {
	if (!Number.isInteger(raster.widthPx) || !Number.isInteger(raster.heightPx)) {
		throw new Error(`${name} dimensions must be integers.`);
	}
	if (raster.widthPx <= 0 || raster.heightPx <= 0) {
		throw new Error(`${name} dimensions must be positive.`);
	}
	const expectedLength = raster.widthPx * raster.heightPx * (raster.format === 'rgba' ? 4 : 1);
	if (raster.data.length !== expectedLength) {
		throw new Error(`${name} data length does not match its dimensions and format.`);
	}
}

function grayscale(raster: HoleNumberRaster, name: string): GrayRaster {
	assertRaster(raster, name);
	if (raster.format === 'gray') {
		return { widthPx: raster.widthPx, heightPx: raster.heightPx, data: raster.data };
	}

	const gray = new Uint8Array(raster.widthPx * raster.heightPx);
	for (let rgbaIndex = 0, grayIndex = 0; rgbaIndex < raster.data.length; rgbaIndex += 4, grayIndex += 1) {
		gray[grayIndex] = (
			raster.data[rgbaIndex] * 0.299 +
			raster.data[rgbaIndex + 1] * 0.587 +
			raster.data[rgbaIndex + 2] * 0.114 +
			0.5
		) | 0;
	}
	return { widthPx: raster.widthPx, heightPx: raster.heightPx, data: gray };
}

/**
 * Bilinear resize keeps the module's CV surface to `matchTemplate` only.
 * The probe used OpenCV area/cubic interpolation; at the narrow +/-8% second
 * stage the distinction is immaterial, while avoiding another worker-only CV
 * API makes this detector easier to embed and test.
 */
function resizeGrayscale(source: GrayRaster, scale: number): GrayRaster {
	const widthPx = Math.max(5, Math.round(source.widthPx * scale));
	const heightPx = Math.max(5, Math.round(source.heightPx * scale));
	if (widthPx === source.widthPx && heightPx === source.heightPx) return source;

	const data = new Uint8Array(widthPx * heightPx);
	const xRatio = source.widthPx / widthPx;
	const yRatio = source.heightPx / heightPx;
	for (let y = 0; y < heightPx; y += 1) {
		const sourceY = Math.max(0, Math.min(source.heightPx - 1, (y + 0.5) * yRatio - 0.5));
		const y0 = Math.floor(sourceY);
		const y1 = Math.min(source.heightPx - 1, y0 + 1);
		const yWeight = sourceY - y0;
		for (let x = 0; x < widthPx; x += 1) {
			const sourceX = Math.max(0, Math.min(source.widthPx - 1, (x + 0.5) * xRatio - 0.5));
			const x0 = Math.floor(sourceX);
			const x1 = Math.min(source.widthPx - 1, x0 + 1);
			const xWeight = sourceX - x0;
			const top = source.data[y0 * source.widthPx + x0] * (1 - xWeight) + source.data[y0 * source.widthPx + x1] * xWeight;
			const bottom = source.data[y1 * source.widthPx + x0] * (1 - xWeight) + source.data[y1 * source.widthPx + x1] * xWeight;
			data[y * widthPx + x] = Math.round(top * (1 - yWeight) + bottom * yWeight);
		}
	}
	return { widthPx, heightPx, data };
}

function resizedTemplate(template: HoleNumberTemplate, scale: number): ResizedTemplate {
	const gray = grayscale(template.raster, `Hole ${template.label} template`);
	return { ...resizeGrayscale(gray, scale), label: template.label, scale };
}

function matFromBytes(cv: HoleNumberCvModule, raster: GrayRaster): HoleNumberCvMat {
	const mat = new cv.Mat(raster.heightPx, raster.widthPx, cv.CV_8UC1);
	(mat.data as Uint8Array).set(raster.data);
	return mat;
}

function responseValues(result: HoleNumberCvMat): Float32Array {
	return result.data32F ?? (result.data as Float32Array);
}

function bestResponse(result: HoleNumberCvMat): { score: number; xPx: number; yPx: number } | null {
	const values = responseValues(result);
	if (values.length === 0) return null;
	let bestIndex = 0;
	let bestScore = values[0];
	for (let index = 1; index < values.length; index += 1) {
		if (values[index] > bestScore) {
			bestScore = values[index];
			bestIndex = index;
		}
	}
	return { score: bestScore, xPx: bestIndex % result.cols, yPx: Math.floor(bestIndex / result.cols) };
}

/** Returns a bounded set of response peaks without sorting the full result Mat. */
function highResponses(
	result: HoleNumberCvMat,
	minimumScore: number,
	limit: number
): Array<{ score: number; xPx: number; yPx: number }> {
	const values = responseValues(result);
	const retained: Array<{ score: number; xPx: number; yPx: number }> = [];
	for (let index = 0; index < values.length; index += 1) {
		const score = values[index];
		if (score < minimumScore) continue;
		const candidate = { score, xPx: index % result.cols, yPx: Math.floor(index / result.cols) };
		if (retained.length < limit) {
			retained.push(candidate);
			continue;
		}
		let lowestIndex = 0;
		for (let retainedIndex = 1; retainedIndex < retained.length; retainedIndex += 1) {
			if (retained[retainedIndex].score < retained[lowestIndex].score) lowestIndex = retainedIndex;
		}
		if (candidate.score > retained[lowestIndex].score) retained[lowestIndex] = candidate;
	}
	retained.sort((a, b) => b.score - a.score);
	return retained;
}

function matchBest(
	cv: HoleNumberCvModule,
	image: HoleNumberCvMat,
	template: GrayRaster
): { score: number; xPx: number; yPx: number } | null {
	const templateMat = matFromBytes(cv, template);
	const result = new cv.Mat();
	try {
		cv.matchTemplate(image, templateMat, result, cv.TM_CCOEFF_NORMED);
		return bestResponse(result);
	} finally {
		templateMat.delete();
		result.delete();
	}
}

function measuredScale(template: GrayRaster, widthPx: number, heightPx: number): number {
	return (widthPx / template.widthPx + heightPx / template.heightPx) / 2;
}

function findScaleAnchor(
	cv: HoleNumberCvModule,
	image: HoleNumberCvMat,
	canonical: GrayRaster,
	label: number,
	options: Required<Pick<HoleNumberDetectionOptions, 'minScale' | 'maxScale' | 'scaleStep'>>
): HoleNumberScaleAnchor | null {
	let best: HoleNumberScaleAnchor | null = null;
	for (let scale = options.minScale; scale <= options.maxScale + options.scaleStep / 2; scale += options.scaleStep) {
		const template = resizeGrayscale(canonical, scale);
		if (template.widthPx >= image.cols || template.heightPx >= image.rows) continue;
		const response = matchBest(cv, image, template);
		if (!response || (best && response.score <= best.score)) continue;
		best = {
			label,
			score: response.score,
			scale: measuredScale(canonical, template.widthPx, template.heightPx),
			xPx: response.xPx,
			yPx: response.yPx,
			widthPx: template.widthPx,
			heightPx: template.heightPx
		};
	}
	return best;
}

function constrainedScales(anchorScale: number, tolerance: number, count: number): number[] {
	if (count === 1) return [anchorScale];
	const low = anchorScale * (1 - tolerance);
	const high = anchorScale * (1 + tolerance);
	return Array.from({ length: count }, (_, index) => low + ((high - low) * index) / (count - 1));
}

function collectTemplateHits(
	cv: HoleNumberCvModule,
	image: HoleNumberCvMat,
	templates: readonly HoleNumberTemplate[],
	anchorScale: number,
	options: Required<
		Pick<HoleNumberDetectionOptions, 'scaleTolerance' | 'constrainedScaleSteps' | 'minBadgeScore' | 'maxPeaksPerSearch'>
	>
): TemplateHit[] {
	const hits: TemplateHit[] = [];
	for (const template of templates) {
		for (const scale of constrainedScales(anchorScale, options.scaleTolerance, options.constrainedScaleSteps)) {
			const resized = resizedTemplate(template, scale);
			if (resized.widthPx >= image.cols || resized.heightPx >= image.rows) continue;
			const templateMat = matFromBytes(cv, resized);
			const result = new cv.Mat();
			try {
				cv.matchTemplate(image, templateMat, result, cv.TM_CCOEFF_NORMED);
				for (const response of highResponses(result, options.minBadgeScore, options.maxPeaksPerSearch)) {
					hits.push({
						label: template.label,
						score: response.score,
						xPx: response.xPx,
						yPx: response.yPx,
						widthPx: resized.widthPx,
						heightPx: resized.heightPx,
						scale
					});
				}
			} finally {
				templateMat.delete();
				result.delete();
			}
		}
	}
	return hits;
}

function clusterBadgeHits(hits: readonly TemplateHit[], anchorScale: number, maxCandidates: number): BadgeCluster[] {
	const radiusPx = Math.max(9, 12 * anchorScale);
	const clusters: BadgeCluster[] = [];
	for (const hit of [...hits].sort((a, b) => b.score - a.score)) {
		const centerX = hit.xPx + hit.widthPx / 2;
		const centerY = hit.yPx + hit.heightPx / 2;
		const cluster = clusters.find(
			(candidate) => Math.hypot(centerX - candidate.xPx, centerY - candidate.yPx) < radiusPx
		);
		if (cluster) {
			cluster.hits.push(hit);
		} else {
			clusters.push({ xPx: centerX, yPx: centerY, hits: [hit] });
		}
	}
	return clusters
		.sort((a, b) => b.hits[0].score - a.hits[0].score)
		.slice(0, maxCandidates);
}

function interior(template: GrayRaster): GrayRaster | null {
	const marginY = Math.max(3, Math.round(template.heightPx * 0.18));
	const marginX = Math.max(4, Math.round(template.widthPx * 0.16));
	const widthPx = template.widthPx - marginX * 2;
	const heightPx = template.heightPx - marginY * 2;
	if (widthPx < 2 || heightPx < 2) return null;
	return crop(template, marginX, marginY, widthPx, heightPx);
}

function crop(source: GrayRaster, xPx: number, yPx: number, widthPx: number, heightPx: number): GrayRaster {
	const data = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y += 1) {
		const start = (yPx + y) * source.widthPx + xPx;
		data.set(source.data.subarray(start, start + widthPx), y * widthPx);
	}
	return { widthPx, heightPx, data };
}


function centeredCrop(
	source: GrayRaster,
	centerX: number,
	centerY: number,
	widthPx: number,
	heightPx: number
): GrayRaster | null {
	const xPx = Math.round(centerX - widthPx / 2);
	const yPx = Math.round(centerY - heightPx / 2);
	if (
		xPx < 0 ||
		yPx < 0 ||
		xPx + widthPx > source.widthPx ||
		yPx + heightPx > source.heightPx
	) {
		return null;
	}
	return crop(source, xPx, yPx, widthPx, heightPx);
}

/**
 * Horizontal span occupied by sufficiently bright foreground-bearing columns,
 * normalized by the glyph-interior width.
 *
 * This matches scripts/cv-probes/number_prefilter_grid.py.
 */
function nonBlackWidthRatio(glyph: GrayRaster): number {
	let firstActive = -1;
	let lastActive = -1;

	for (let x = 0; x < glyph.widthPx; x += 1) {
		let foregroundPixels = 0;
		for (let y = 0; y < glyph.heightPx; y += 1) {
			if (glyph.data[y * glyph.widthPx + x] >= GLYPH_FOREGROUND_THRESHOLD) {
				foregroundPixels += 1;
			}
		}
		if (foregroundPixels >= GLYPH_MIN_COLUMN_PIXELS) {
			if (firstActive < 0) firstActive = x;
			lastActive = x;
		}
	}

	return firstActive < 0 ? 0 : (lastActive - firstActive + 1) / glyph.widthPx;
}

function retainedGlyphTemplateIndexes(
	candidateRatio: number,
	templateRatios: readonly number[]
): Set<number> {
	const ranked = templateRatios
		.map((ratio, index) => ({
			index,
			distance: Math.abs(ratio - candidateRatio)
		}))
		.sort((a, b) => a.distance - b.distance || a.index - b.index);

	const retained = new Set(
		ranked
			.filter((entry) => entry.distance <= GLYPH_WIDTH_RATIO_TOLERANCE)
			.map((entry) => entry.index)
	);

	for (const entry of ranked) {
		if (retained.size >= GLYPH_MIN_KEEP) break;
		retained.add(entry.index);
	}

	return retained;
}

function glyphScore(
	cv: HoleNumberCvModule,
	image: GrayRaster,
	centerX: number,
	centerY: number,
	glyphTemplate: GrayRaster
): number {
	const expectedX = Math.round(centerX - glyphTemplate.widthPx / 2);
	const expectedY = Math.round(centerY - glyphTemplate.heightPx / 2);
	const xPx = Math.max(0, expectedX - 3);
	const yPx = Math.max(0, expectedY - 3);
	const right = Math.min(image.widthPx, expectedX + glyphTemplate.widthPx + 3);
	const bottom = Math.min(image.heightPx, expectedY + glyphTemplate.heightPx + 3);
	if (right - xPx < glyphTemplate.widthPx || bottom - yPx < glyphTemplate.heightPx) return -1;

	const imageMat = matFromBytes(cv, crop(image, xPx, yPx, right - xPx, bottom - yPx));
	const templateMat = matFromBytes(cv, glyphTemplate);
	const result = new cv.Mat();
	try {
		cv.matchTemplate(imageMat, templateMat, result, cv.TM_CCOEFF_NORMED);
		return bestResponse(result)?.score ?? -1;
	} finally {
		imageMat.delete();
		templateMat.delete();
		result.delete();
	}
}

/** O(n³) Hungarian assignment, maximizing the supplied square score matrix. */
function maximumScoreAssignment(scores: readonly (readonly number[])[]): number[] {
	const size = scores.length;
	const potentialRows = new Float64Array(size + 1);
	const potentialColumns = new Float64Array(size + 1);
	const matching = new Int32Array(size + 1);
	const previousColumn = new Int32Array(size + 1);

	for (let row = 1; row <= size; row += 1) {
		matching[0] = row;
		let column = 0;
		const minimum = new Float64Array(size + 1);
		minimum.fill(Number.POSITIVE_INFINITY);
		const used = new Uint8Array(size + 1);
		do {
			used[column] = 1;
			const rowAtColumn = matching[column];
			let delta = Number.POSITIVE_INFINITY;
			let nextColumn = 0;
			for (let candidate = 1; candidate <= size; candidate += 1) {
				if (used[candidate]) continue;
				const cost = -scores[rowAtColumn - 1][candidate - 1] - potentialRows[rowAtColumn] - potentialColumns[candidate];
				if (cost < minimum[candidate]) {
					minimum[candidate] = cost;
					previousColumn[candidate] = column;
				}
				if (minimum[candidate] < delta) {
					delta = minimum[candidate];
					nextColumn = candidate;
				}
			}
			for (let candidate = 0; candidate <= size; candidate += 1) {
				if (used[candidate]) {
					potentialRows[matching[candidate]] += delta;
					potentialColumns[candidate] -= delta;
				} else {
					minimum[candidate] -= delta;
				}
			}
			column = nextColumn;
		} while (matching[column] !== 0);

		do {
			const previous = previousColumn[column];
			matching[column] = matching[previous];
			column = previous;
		} while (column !== 0);
	}

	const assignments = new Array<number>(size);
	for (let column = 1; column <= size; column += 1) {
		assignments[matching[column] - 1] = column - 1;
	}
	return assignments;
}

function assignedCandidates(
	cv: HoleNumberCvModule,
	image: GrayRaster,
	clusters: readonly BadgeCluster[],
	templates: readonly HoleNumberTemplate[],
	anchorScale: number
): HoleNumberCandidate[] | null {
	if (clusters.length !== templates.length || templates.length === 0) return null;
	const glyphTemplates = templates.map((template) => {
		const resized = resizedTemplate(template, anchorScale);
		const glyph = interior(resized);
		return glyph ? { label: template.label, outer: resized, glyph } : null;
	});
	if (glyphTemplates.some((template) => !template)) return null;

	const usableTemplates = glyphTemplates as Array<{
		label: number;
		outer: ResizedTemplate;
		glyph: GrayRaster;
	}>;
	const templateRatios = usableTemplates.map((template) => nonBlackWidthRatio(template.glyph));
	const medianOuterWidth = Math.round(median(usableTemplates.map((template) => template.outer.widthPx)));
	const medianOuterHeight = Math.round(median(usableTemplates.map((template) => template.outer.heightPx)));

	const scores = clusters.map((cluster) => {
		const outerCandidate = centeredCrop(
			image,
			cluster.xPx,
			cluster.yPx,
			medianOuterWidth,
			medianOuterHeight
		);
		const candidateGlyph = outerCandidate ? interior(outerCandidate) : null;
		if (!candidateGlyph) {
			return usableTemplates.map(() => GLYPH_PRUNED_SCORE);
		}

		const candidateRatio = nonBlackWidthRatio(candidateGlyph);
		const retained = retainedGlyphTemplateIndexes(candidateRatio, templateRatios);
		return usableTemplates.map((template, templateIndex) =>
			retained.has(templateIndex)
				? glyphScore(cv, image, cluster.xPx, cluster.yPx, template.glyph)
				: GLYPH_PRUNED_SCORE
		);
	});
	const assignments = maximumScoreAssignment(scores);
	return clusters.map((cluster, index) => {
		const templateIndex = assignments[index];
		const template = usableTemplates[templateIndex];
		const badgeHit = cluster.hits[0];
		const glyph = scores[index][templateIndex];
		const topGlyphMatches = usableTemplates
			.map((candidateTemplate, candidateTemplateIndex) => ({
				label: candidateTemplate.label,
				score: scores[index][candidateTemplateIndex]
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, 3);
		return {
			xPx: cluster.xPx,
			yPx: cluster.yPx,
			widthPx: template.outer.widthPx,
			heightPx: template.outer.heightPx,
			scale: anchorScale,
			score: glyph,
			badgeScore: badgeHit.score,
			label: template.label,
			glyphScore: glyph,
			diagnosticId: index + 1,
			topGlyphMatches
		};
	});
}

function candidateOnly(clusters: readonly BadgeCluster[], anchorScale: number): HoleNumberCandidate[] {
	return clusters.map((cluster, index) => {
		const hit = cluster.hits[0];
		return {
			xPx: cluster.xPx,
			yPx: cluster.yPx,
			widthPx: hit.widthPx,
			heightPx: hit.heightPx,
			scale: anchorScale,
			score: hit.score,
			badgeScore: hit.score,
			diagnosticId: index + 1
		};
	});
}

function normalizedTemplates(templates: readonly HoleNumberTemplate[]): HoleNumberTemplate[] {
	const labels = new Set<number>();
	for (const template of templates) {
		if (!Number.isInteger(template.label) || template.label <= 0) {
			throw new Error('Hole-number template labels must be positive integers.');
		}
		if (labels.has(template.label)) throw new Error(`Duplicate hole-number template label ${template.label}.`);
		labels.add(template.label);
		assertRaster(template.raster, `Hole ${template.label} template`);
	}
	return [...templates].sort((a, b) => a.label - b.label);
}

/**
 * Detects UDisc hole-number badges in a source raster.
 *
 * The detector is intentionally conservative about labels. A preliminary
 * full-badge hit is allowed to locate a candidate, but a `label` is returned
 * only when every returned physical badge can be assigned one-to-one from the
 * glyph interiors. This avoids the known failure where the common black badge
 * body overwhelms the numeral during ordinary full-template matching.
 */
export function detectHoleNumberBadges(
	cv: HoleNumberCvModule,
	source: HoleNumberRaster,
	templates: readonly HoleNumberTemplate[],
	providedOptions: HoleNumberDetectionOptions = {}
): HoleNumberDetection {
	const options = { ...DEFAULTS, ...providedOptions };
	if (
		options.minScale <= 0 ||
		options.maxScale < options.minScale ||
		options.scaleStep <= 0 ||
		options.scaleTolerance < 0 ||
		!Number.isInteger(options.constrainedScaleSteps) ||
		options.constrainedScaleSteps <= 0 ||
		!Number.isInteger(options.maxCandidates) ||
		options.maxCandidates <= 0 ||
		!Number.isInteger(options.maxPeaksPerSearch) ||
		options.maxPeaksPerSearch <= 0
	) {
		throw new Error('Hole-number detection received invalid scale or candidate options.');
	}

	const image = grayscale(source, 'Hole-number source image');
	const availableTemplates = normalizedTemplates(templates);
	if (availableTemplates.length === 0) {
		return {
			candidates: [],
			anchor: null,
			labeling: 'candidate-only',
			note: 'No canonical hole-number templates were supplied. Supply hole-01.png through hole-18.png to detect and label badges.'
		};
	}

	const anchorTemplate = availableTemplates.find((template) => template.label === 1) ?? availableTemplates[0];
	const canonicalAnchor = grayscale(anchorTemplate.raster, `Hole ${anchorTemplate.label} template`);
	const canonicalBody = templateBadgeBody(canonicalAnchor);
	if (!canonicalBody) {
		return {
			candidates: [],
			anchor: null,
			labeling: 'candidate-only',
			note: `Hole ${anchorTemplate.label} template does not contain a plausible dark badge body.`
		};
	}

	const badgeBodies = selectBadgeBodies(darkComponents(image), options.maxCandidates);
	if (badgeBodies.length === 0) {
		return {
			candidates: [],
			anchor: null,
			labeling: 'candidate-only',
			note: 'No repeated dark UDisc badge-body population was found.'
		};
	}

	const anchorScale = componentAnchorScale(badgeBodies, canonicalBody);
	const clusters = clustersFromBadgeBodies(badgeBodies, anchorTemplate, anchorScale);
	const assigned = assignedCandidates(cv, image, clusters, availableTemplates, anchorScale);
	const anchor = localizationAnchor(anchorTemplate, anchorScale, clusters, assigned);

	if (assigned) {
		return {
			candidates: assigned.sort((a, b) => (a.label ?? 0) - (b.label ?? 0)),
			anchor,
			labeling: 'assigned'
		};
	}

	const fullTemplatePack =
		availableTemplates.length === 18 &&
		availableTemplates.every((template, index) => template.label === index + 1);
	return {
		candidates: candidateOnly(clusters, anchorScale),
		anchor,
		labeling: 'candidate-only',
		note: fullTemplatePack
			? `Located ${clusters.length} badge candidates from dark components; glyph labels require one physical candidate for each of the 18 templates.`
			: 'Candidate-only mode: supply the complete canonical hole-01.png through hole-18.png template pack for one-to-one glyph labels.'
	};
}
