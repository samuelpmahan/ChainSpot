export interface BasketColorRaster {
	readonly rgba: Uint8Array | Uint8ClampedArray;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface BasketColorComponent {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly areaPx: number;
	readonly fillFraction: number;
	readonly aspect: number;
}

export interface BasketColorScaleMode {
	readonly scale: number;
	readonly support: number;
	readonly weight: number;
	readonly medianAnisotropy: number;
	readonly representativeSource: Readonly<{ widthPx: number; heightPx: number }>;
	readonly representativeTemplate: Readonly<{ widthPx: number; heightPx: number }>;
}

export interface BasketColorScaleEstimate extends BasketColorScaleMode {
	readonly secondWeight: number;
	readonly dominance: number;
	readonly meanWeightPerSupport: number;
	readonly sourceComponentCount: number;
	readonly voteCount: number;
	readonly reliable: boolean;
}

export interface BasketColorScaleOptions {
	/** OpenCV-HSV-equivalent saturation threshold on a 0..255 scale. */
	readonly saturationMax?: number;
	/** Minimum HSV value/brightness on a 0..255 scale. */
	readonly valueMin?: number;
	readonly minScale?: number;
	readonly maxScale?: number;
	readonly scaleBin?: number;
	readonly modeHalfWidth?: number;
	readonly minReliableSupport?: number;
	readonly minReliableDominance?: number;
	readonly minReliableMeanWeight?: number;
}

interface MutableComponent {
	parent: number;
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	area: number;
}

interface RowRun {
	readonly startX: number;
	readonly endX: number;
	readonly label: number;
}

interface Vote {
	readonly scale: number;
	readonly weight: number;
	readonly sourceIndex: number;
	readonly templateIndex: number;
	readonly anisotropy: number;
}

const DEFAULT_SATURATION_MAX = 20;
const DEFAULT_VALUE_MIN = 190;
const DEFAULT_MIN_SCALE = 0.5;
const DEFAULT_MAX_SCALE = 4;
const DEFAULT_SCALE_BIN = 0.025;
const DEFAULT_MODE_HALF_WIDTH = 0.06;
const DEFAULT_MIN_RELIABLE_SUPPORT = 4;
const DEFAULT_MIN_RELIABLE_DOMINANCE = 3;
const DEFAULT_MIN_RELIABLE_MEAN_WEIGHT = 12;

function validateRaster(raster: BasketColorRaster, name: string): void {
	if (!Number.isInteger(raster.widthPx) || !Number.isInteger(raster.heightPx) || raster.widthPx <= 0 || raster.heightPx <= 0) {
		throw new Error(`${name} requires positive integer dimensions.`);
	}
	if (raster.rgba.length < raster.widthPx * raster.heightPx * 4) {
		throw new Error(`${name} RGBA buffer is shorter than its declared dimensions.`);
	}
}

/**
 * Equivalent to the successful research mask `HSV S <= 20 && V >= 190`
 * without paying for an RGB->HSV image conversion. For HSV, V=max(R,G,B)
 * and S=255*(max-min)/max, so this comparison is algebraically identical
 * apart from OpenCV's integer rounding at the threshold boundary.
 */
export function isBasketColorPixel(
	r: number,
	g: number,
	b: number,
	a = 255,
	saturationMax = DEFAULT_SATURATION_MAX,
	valueMin = DEFAULT_VALUE_MIN
): boolean {
	if (a < 128) return false;
	const maximum = Math.max(r, g, b);
	if (maximum < valueMin) return false;
	const minimum = Math.min(r, g, b);
	return (maximum - minimum) * 255 <= saturationMax * maximum;
}

function findRoot(components: MutableComponent[], label: number): number {
	let root = label;
	while (components[root]!.parent !== root) root = components[root]!.parent;
	let cursor = label;
	while (components[cursor]!.parent !== cursor) {
		const next = components[cursor]!.parent;
		components[cursor]!.parent = root;
		cursor = next;
	}
	return root;
}

function unionComponents(components: MutableComponent[], firstLabel: number, secondLabel: number): number {
	let first = findRoot(components, firstLabel);
	let second = findRoot(components, secondLabel);
	if (first === second) return first;
	if (components[first]!.area < components[second]!.area) [first, second] = [second, first];
	const keep = components[first]!;
	const merge = components[second]!;
	merge.parent = first;
	keep.minX = Math.min(keep.minX, merge.minX);
	keep.maxX = Math.max(keep.maxX, merge.maxX);
	keep.minY = Math.min(keep.minY, merge.minY);
	keep.maxY = Math.max(keep.maxY, merge.maxY);
	keep.area += merge.area;
	merge.area = 0;
	return first;
}

function addRun(components: MutableComponent[], label: number, startX: number, endX: number, y: number): number {
	const root = findRoot(components, label);
	const component = components[root]!;
	component.minX = Math.min(component.minX, startX);
	component.maxX = Math.max(component.maxX, endX);
	component.minY = Math.min(component.minY, y);
	component.maxY = Math.max(component.maxY, y);
	component.area += endX - startX + 1;
	return root;
}

/**
 * 8-connected component extraction using row runs instead of one label per
 * source pixel. The basket-color mask is sparse on course maps, so this keeps
 * memory bounded by the number of runs/components rather than allocating two
 * full-size label images for a stitched source.
 */
export function extractBasketColorComponents(
	raster: BasketColorRaster,
	options: BasketColorScaleOptions = {}
): readonly BasketColorComponent[] {
	validateRaster(raster, 'Basket color component extraction');
	const saturationMax = options.saturationMax ?? DEFAULT_SATURATION_MAX;
	const valueMin = options.valueMin ?? DEFAULT_VALUE_MIN;
	const components: MutableComponent[] = [
		{ parent: 0, minX: 0, maxX: 0, minY: 0, maxY: 0, area: 0 }
	];
	let previousRuns: RowRun[] = [];

	const masked = (x: number, y: number): boolean => {
		const offset = (y * raster.widthPx + x) * 4;
		return isBasketColorPixel(
			raster.rgba[offset]!,
			raster.rgba[offset + 1]!,
			raster.rgba[offset + 2]!,
			raster.rgba[offset + 3]!,
			saturationMax,
			valueMin
		);
	};

	for (let y = 0; y < raster.heightPx; y += 1) {
		const currentRuns: RowRun[] = [];
		let x = 0;
		let previousIndex = 0;
		while (x < raster.widthPx) {
			while (x < raster.widthPx && !masked(x, y)) x += 1;
			if (x >= raster.widthPx) break;
			const startX = x;
			while (x + 1 < raster.widthPx && masked(x + 1, y)) x += 1;
			const endX = x;

			while (previousIndex < previousRuns.length && previousRuns[previousIndex]!.endX < startX - 1) {
				previousIndex += 1;
			}
			const overlappingRoots: number[] = [];
			for (let index = previousIndex; index < previousRuns.length; index += 1) {
				const previous = previousRuns[index]!;
				if (previous.startX > endX + 1) break;
				const root = findRoot(components, previous.label);
				if (!overlappingRoots.includes(root)) overlappingRoots.push(root);
			}

			let label: number;
			if (overlappingRoots.length === 0) {
				label = components.length;
				components.push({
					parent: label,
					minX: Number.POSITIVE_INFINITY,
					maxX: Number.NEGATIVE_INFINITY,
					minY: Number.POSITIVE_INFINITY,
					maxY: Number.NEGATIVE_INFINITY,
					area: 0
				});
			} else {
				label = overlappingRoots[0]!;
				for (let index = 1; index < overlappingRoots.length; index += 1) {
					label = unionComponents(components, label, overlappingRoots[index]!);
				}
			}
			label = addRun(components, label, startX, endX, y);
			currentRuns.push({ startX, endX, label });
			x += 1;
		}
		previousRuns = currentRuns;
	}

	const result: BasketColorComponent[] = [];
	for (let label = 1; label < components.length; label += 1) {
		const root = findRoot(components, label);
		if (root !== label) continue;
		const component = components[root]!;
		if (component.area <= 0) continue;
		const widthPx = component.maxX - component.minX + 1;
		const heightPx = component.maxY - component.minY + 1;
		result.push({
			xPx: component.minX,
			yPx: component.minY,
			widthPx,
			heightPx,
			areaPx: component.area,
			fillFraction: component.area / (widthPx * heightPx),
			aspect: widthPx / heightPx
		});
	}
	return result;
}

function meaningfulTemplateComponents(
	components: readonly BasketColorComponent[]
): readonly BasketColorComponent[] {
	if (components.length === 0) return [];
	const largestArea = Math.max(...components.map((component) => component.areaPx));
	return components
		.filter(
			(component) =>
				component.areaPx >= Math.max(3, largestArea * 0.04) &&
				component.widthPx >= 2 &&
				component.heightPx >= 2
		)
		.sort((first, second) => second.areaPx - first.areaPx)
		.slice(0, 8);
}

function sourceScaleComponents(
	components: readonly BasketColorComponent[],
	widthPx: number,
	heightPx: number
): readonly BasketColorComponent[] {
	const maxWidth = Math.min(160, widthPx * 0.15);
	const maxHeight = Math.min(180, heightPx * 0.15);
	return components.filter(
		(component) =>
			component.areaPx >= 8 &&
			component.areaPx <= 8000 &&
			component.widthPx >= 2 &&
			component.widthPx <= maxWidth &&
			component.heightPx >= 2 &&
			component.heightPx <= maxHeight
	);
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1]! + sorted[middle]!) / 2
		: sorted[middle]!;
}

function buildVotes(
	source: readonly BasketColorComponent[],
	template: readonly BasketColorComponent[],
	minScale: number,
	maxScale: number
): readonly Vote[] {
	const votes: Vote[] = [];
	for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
		const sourceComponent = source[sourceIndex]!;
		for (let templateIndex = 0; templateIndex < template.length; templateIndex += 1) {
			const templateComponent = template[templateIndex]!;
			const scaleX = sourceComponent.widthPx / templateComponent.widthPx;
			const scaleY = sourceComponent.heightPx / templateComponent.heightPx;
			const scale = Math.sqrt(scaleX * scaleY);
			if (scale < minScale || scale > maxScale) continue;
			const anisotropy = Math.abs(Math.log(scaleX / scaleY));
			const aspectError = Math.abs(Math.log(sourceComponent.aspect / templateComponent.aspect));
			const fillError = Math.abs(Math.log(sourceComponent.fillFraction / templateComponent.fillFraction));
			if (anisotropy > 0.16 || aspectError > 0.16 || fillError > 0.55) continue;
			const shapeWeight =
				Math.exp(-Math.pow(anisotropy / 0.08, 2)) *
				Math.exp(-Math.pow(fillError / 0.35, 2));
			votes.push({
				scale,
				weight: shapeWeight * Math.sqrt(Math.min(sourceComponent.areaPx, 1800)),
				sourceIndex,
				templateIndex,
				anisotropy
			});
		}
	}
	return votes;
}

function scaleModes(
	votes: readonly Vote[],
	source: readonly BasketColorComponent[],
	template: readonly BasketColorComponent[],
	minScale: number,
	maxScale: number,
	scaleBin: number,
	modeHalfWidth: number
): readonly BasketColorScaleMode[] {
	const modes: BasketColorScaleMode[] = [];
	for (let center = minScale + scaleBin / 2; center < maxScale; center += scaleBin) {
		const bestBySource = new Map<number, Vote>();
		for (const vote of votes) {
			if (Math.abs(vote.scale - center) > modeHalfWidth) continue;
			const previous = bestBySource.get(vote.sourceIndex);
			if (!previous || vote.weight > previous.weight) bestBySource.set(vote.sourceIndex, vote);
		}
		const selected = [...bestBySource.values()];
		if (selected.length === 0) continue;
		const weight = selected.reduce((sum, vote) => sum + vote.weight, 0);
		const scale = selected.reduce((sum, vote) => sum + vote.scale * vote.weight, 0) / weight;
		const representative = selected.reduce((best, vote) => (vote.weight > best.weight ? vote : best));
		const sourceComponent = source[representative.sourceIndex]!;
		const templateComponent = template[representative.templateIndex]!;
		modes.push({
			scale,
			support: selected.length,
			weight,
			medianAnisotropy: median(selected.map((vote) => vote.anisotropy)),
			representativeSource: {
				widthPx: sourceComponent.widthPx,
				heightPx: sourceComponent.heightPx
			},
			representativeTemplate: {
				widthPx: templateComponent.widthPx,
				heightPx: templateComponent.heightPx
			}
		});
	}
	return modes;
}

function uniqueRankedModes(modes: readonly BasketColorScaleMode[]): readonly BasketColorScaleMode[] {
	const ranked = [...modes].sort((first, second) => second.weight - first.weight || second.support - first.support);
	const unique: BasketColorScaleMode[] = [];
	for (const mode of ranked) {
		if (unique.every((existing) => Math.abs(existing.scale - mode.scale) > 0.08)) unique.push(mode);
		if (unique.length >= 10) break;
	}
	return unique;
}

/**
 * Truth-free basket template-scale bootstrap.
 *
 * Research on GoldenBasketSet, AlexClarkSet, TheRec L/R, and the user's large
 * stitched Dash capture found a stable cool off-white basket interior near
 * RGB(231,234,241). The same fixed low-saturation/high-value mask turns each
 * rendered basket into a repeated component near 42x66 px. This estimator
 * recovers the canonical-template multiplier from those repeated components
 * without a blind full-image NCC scale sweep.
 *
 * `reliable` is deliberately conservative. Weak/ambiguous masks should fall
 * back to the existing grayscale sweep rather than forcing a scale.
 */
export function estimateBasketTemplateScaleFromColor(
	sourceRaster: BasketColorRaster,
	templateRaster: BasketColorRaster,
	options: BasketColorScaleOptions = {}
): BasketColorScaleEstimate | null {
	validateRaster(sourceRaster, 'Basket color scale source');
	validateRaster(templateRaster, 'Basket color scale template');
	const minScale = options.minScale ?? DEFAULT_MIN_SCALE;
	const maxScale = options.maxScale ?? DEFAULT_MAX_SCALE;
	const scaleBin = options.scaleBin ?? DEFAULT_SCALE_BIN;
	const modeHalfWidth = options.modeHalfWidth ?? DEFAULT_MODE_HALF_WIDTH;
	if (!(maxScale > minScale) || !(scaleBin > 0) || !(modeHalfWidth > 0)) {
		throw new Error('Basket color scale requires maxScale > minScale and positive bin widths.');
	}

	const source = sourceScaleComponents(
		extractBasketColorComponents(sourceRaster, options),
		sourceRaster.widthPx,
		sourceRaster.heightPx
	);
	const template = meaningfulTemplateComponents(extractBasketColorComponents(templateRaster, options));
	if (source.length === 0 || template.length === 0) return null;
	const votes = buildVotes(source, template, minScale, maxScale);
	if (votes.length === 0) return null;
	const ranked = uniqueRankedModes(
		scaleModes(votes, source, template, minScale, maxScale, scaleBin, modeHalfWidth)
	);
	const best = ranked[0];
	if (!best) return null;
	const secondWeight = ranked[1]?.weight ?? 0;
	const dominance = best.weight / Math.max(secondWeight, 1e-9);
	const meanWeightPerSupport = best.weight / best.support;
	const reliable =
		best.support >= (options.minReliableSupport ?? DEFAULT_MIN_RELIABLE_SUPPORT) &&
		dominance >= (options.minReliableDominance ?? DEFAULT_MIN_RELIABLE_DOMINANCE) &&
		meanWeightPerSupport >= (options.minReliableMeanWeight ?? DEFAULT_MIN_RELIABLE_MEAN_WEIGHT);
	return {
		...best,
		secondWeight,
		dominance,
		meanWeightPerSupport,
		sourceComponentCount: source.length,
		voteCount: votes.length,
		reliable
	};
}
