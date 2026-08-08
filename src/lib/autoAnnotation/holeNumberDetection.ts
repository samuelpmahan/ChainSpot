/**
 * Hole-number badge detection for clean UDisc course maps.
 *
 * This is intentionally worker-safe and transport-free: the caller supplies a
 * decoded grayscale/RGBA raster plus canonical badge rasters, and retains
 * ownership of decoding, scaling, and worker messaging. All returned points
 * are in the supplied source raster's pixel coordinate system.
 *
 * The implementation is the browser port of the successful Python probes:
 *
 * 1. match the canonical #1 badge over a broad scale range;
 * 2. search every available badge near that measured UI scale;
 * 3. cluster the overlapping physical-badge peaks;
 * 4. when every physical badge and every label is available, match only the
 *    inner glyphs and solve a one-to-one maximum-score assignment.
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
	const scores = clusters.map((cluster) =>
		usableTemplates.map((template) => glyphScore(cv, image, cluster.xPx, cluster.yPx, template.glyph))
	);
	const assignments = maximumScoreAssignment(scores);
	return clusters.map((cluster, index) => {
		const templateIndex = assignments[index];
		const template = usableTemplates[templateIndex];
		const badgeHit = cluster.hits[0];
		const glyph = scores[index][templateIndex];
		return {
			xPx: cluster.xPx,
			yPx: cluster.yPx,
			widthPx: template.outer.widthPx,
			heightPx: template.outer.heightPx,
			scale: anchorScale,
			score: glyph,
			badgeScore: badgeHit.score,
			label: template.label,
			glyphScore: glyph
		};
	});
}

function candidateOnly(clusters: readonly BadgeCluster[], anchorScale: number): HoleNumberCandidate[] {
	return clusters.map((cluster) => {
		const hit = cluster.hits[0];
		return {
			xPx: cluster.xPx,
			yPx: cluster.yPx,
			widthPx: hit.widthPx,
			heightPx: hit.heightPx,
			scale: anchorScale,
			score: hit.score,
			badgeScore: hit.score
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
	const imageMat = matFromBytes(cv, image);
	try {
		const anchor = findScaleAnchor(cv, imageMat, canonicalAnchor, anchorTemplate.label, options);
		if (!anchor) {
			return {
				candidates: [],
				anchor: null,
				labeling: 'candidate-only',
				note: 'Every supplied number template is larger than the source image at the requested scale range.'
			};
		}

		const clusters = clusterBadgeHits(
			collectTemplateHits(cv, imageMat, availableTemplates, anchor.scale, options),
			anchor.scale,
			options.maxCandidates
		);
		const assigned = assignedCandidates(cv, image, clusters, availableTemplates, anchor.scale);
		if (assigned) {
			return {
				candidates: assigned.sort((a, b) => (a.label ?? 0) - (b.label ?? 0)),
				anchor,
				labeling: 'assigned'
			};
		}

		const fullTemplatePack = availableTemplates.length === 18 && availableTemplates.every((template, index) => template.label === index + 1);
		return {
			candidates: candidateOnly(clusters, anchor.scale),
			anchor,
			labeling: 'candidate-only',
			note: fullTemplatePack
				? `Located ${clusters.length} badge candidates; glyph labels require one physical candidate for each of the 18 templates.`
				: 'Candidate-only mode: supply the complete canonical hole-01.png through hole-18.png template pack for one-to-one glyph labels.'
		};
	} finally {
		imageMat.delete();
	}
}
