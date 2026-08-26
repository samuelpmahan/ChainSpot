import type { Detector, RgbaRaster } from '../detect';

export const PURPLE_MASS_ALGO = 'purple-path-mass';
export const PURPLE_MASS_ALGO_VERSION = '1.0.0';

// Real UDisc thrown-round overlay measured at a dominant 255-260 degrees.
const HUE_MIN_DEG = 245;
const HUE_MAX_DEG = 275;
const SATURATION_MIN = 0.35;
const VALUE_MIN = 0.35;
const THROWN_FRACTION_MIN = 0.004;
const MAP_FRACTION_MAX = 0.0005;
const TARGET_SAMPLE_COUNT = 20_000;

export const PURPLE_MASS_MATH = {
	hueMinDeg: HUE_MIN_DEG,
	hueMaxDeg: HUE_MAX_DEG,
	saturationMin: SATURATION_MIN,
	valueMin: VALUE_MIN,
	thrownFractionMin: THROWN_FRACTION_MIN,
	mapFractionMax: MAP_FRACTION_MAX,
	targetSampleCount: TARGET_SAMPLE_COUNT
} as const;

export function describePurpleMassMath(): string {
	return [
		`purple pixel: hue in [${HUE_MIN_DEG}, ${HUE_MAX_DEG}] degrees, saturation >= ${SATURATION_MIN}, value >= ${VALUE_MIN}`,
		`sample stride: max(1, ceil(sqrt(width * height / ${TARGET_SAMPLE_COUNT})))`,
		'purpleFraction = purplePixels / sampledPixels',
		`classification: thrown when fraction >= ${THROWN_FRACTION_MIN}; map when fraction <= ${MAP_FRACTION_MAX}; otherwise unknown`,
		'purple region: half-open bounds [left,right) x [top,bottom) over every thumbnail pixel',
		'batch rule: exactly one thrown classification is retained; otherwise every row becomes unknown with reason no-unique-thrown'
	].join('\n');
}

export type PurpleMassIntent = 'likely-thrown' | 'likely-map' | 'uncertain';

export interface PurpleMassMeasurement {
	readonly intent: PurpleMassIntent;
	readonly fraction: number;
	readonly sampledPixels: number;
	readonly purplePixels: number;
	readonly centroidXPx: number | null;
	readonly centroidYPx: number | null;
	readonly confidence: number;
}

export function isPurplePixel(r: number, g: number, b: number): boolean {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const delta = max - min;
	if (max === 0 || delta === 0 || delta / max < SATURATION_MIN || max < VALUE_MIN) return false;

	let hue: number;
	if (max === rn) hue = 60 * (((gn - bn) / delta) % 6);
	else if (max === gn) hue = 60 * ((bn - rn) / delta + 2);
	else hue = 60 * ((rn - gn) / delta + 4);
	if (hue < 0) hue += 360;
	return hue >= HUE_MIN_DEG && hue <= HUE_MAX_DEG;
}

export function measurePurpleMass(image: RgbaRaster): PurpleMassMeasurement {
	if (image.widthPx <= 0 || image.heightPx <= 0)
		throw new Error('Purple-mass image dimensions must be positive.');
	if (image.rgba.length !== image.widthPx * image.heightPx * 4) {
		throw new Error('Purple-mass RGBA byte length does not match image dimensions.');
	}

	const stride = Math.max(
		1,
		Math.ceil(Math.sqrt((image.widthPx * image.heightPx) / TARGET_SAMPLE_COUNT))
	);
	let sampledPixels = 0;
	let purplePixels = 0;
	let sumX = 0;
	let sumY = 0;
	for (let y = 0; y < image.heightPx; y += stride) {
		for (let x = 0; x < image.widthPx; x += stride) {
			const i = (y * image.widthPx + x) * 4;
			sampledPixels++;
			if (!isPurplePixel(image.rgba[i], image.rgba[i + 1], image.rgba[i + 2])) continue;
			purplePixels++;
			sumX += x;
			sumY += y;
		}
	}

	const fraction = purplePixels / sampledPixels;
	let intent: PurpleMassIntent = 'uncertain';
	// This classification is a measured image trait, so preserve the mass
	// itself. The UI owns the tunable decision threshold.
	const confidence = fraction;
	if (fraction >= THROWN_FRACTION_MIN) {
		intent = 'likely-thrown';
	} else if (fraction <= MAP_FRACTION_MAX) {
		intent = 'likely-map';
	}

	return {
		intent,
		fraction,
		sampledPixels,
		purplePixels,
		centroidXPx: purplePixels > 0 ? sumX / purplePixels : null,
		centroidYPx: purplePixels > 0 ? sumY / purplePixels : null,
		confidence
	};
}

/** Emits one comparable image-level score on every valid image. */
export function purpleMassBounds(
	widthPx: number,
	heightPx: number,
	rgba: ArrayLike<number>
): { leftPx: number; topPx: number; rightPx: number; bottomPx: number } | null {
	let left = widthPx,
		top = heightPx,
		right = 0,
		bottom = 0,
		found = false;
	for (let y = 0; y < heightPx; y++)
		for (let x = 0; x < widthPx; x++) {
			const i = (y * widthPx + x) * 4;
			if (!isPurplePixel(rgba[i], rgba[i + 1], rgba[i + 2])) continue;
			found = true;
			left = Math.min(left, x);
			top = Math.min(top, y);
			right = Math.max(right, x + 1);
			bottom = Math.max(bottom, y + 1);
		}
	return found ? { leftPx: left, topPx: top, rightPx: right, bottomPx: bottom } : null;
}

export const purpleMassDetector: Detector = async (image, emit) => {
	const measurement = measurePurpleMass(image);
	emit({
		kind: 'classification',
		imageId: image.imageId,
		trait: 'thrown-round',
		confidence: measurement.confidence,
		algo: PURPLE_MASS_ALGO,
		algoVersion: PURPLE_MASS_ALGO_VERSION
	});
};
