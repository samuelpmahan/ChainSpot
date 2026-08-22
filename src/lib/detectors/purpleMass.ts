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

function isPurple(r: number, g: number, b: number): boolean {
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
			if (!isPurple(image.rgba[i], image.rgba[i + 1], image.rgba[i + 2])) continue;
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
