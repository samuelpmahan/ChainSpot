/**
 * Classifies an uploaded screenshot as a played-round ("thrown") UDisc screenshot
 * vs. a clean course map, for the consolidated front door. Explicitly NON-AUTHORITATIVE:
 * an 'uncertain' result makes the UI ask the user instead of guessing.
 *
 * Designed as an evidence-combining seam — classifyImageIntent runs a list of
 * independent signal functions and combines them, so future cheap semantic UI
 * detections (score-card chrome detection, walk-path continuity, etc.) can be
 * added as new signals without changing any caller.
 */

export type ImageIntent = 'likely-thrown' | 'likely-map' | 'uncertain';

export interface ImageIntentSignal {
	readonly name: string;
	readonly intent: ImageIntent;
	readonly strength: number;
	readonly detail: string;
}

export interface ImageIntentClassification {
	readonly intent: ImageIntent;
	readonly signals: readonly ImageIntentSignal[];
}

// Unvalidated starting points: hue+saturation+value band for UDisc purple/magenta paths
// These constants are empirical thresholds for detecting rendered throw/walk paths.
// They are NOT validated against a real screenshot corpus (same caveat style as docs/course-memory.md's own thresholds).
const PURPLE_HUE_MIN = 270; // degrees
const PURPLE_HUE_MAX = 330; // degrees
const PURPLE_SAT_MIN = 0.35; // unitless [0, 1]
const PURPLE_VALUE_MIN = 0.35; // unitless [0, 1]

// Fraction thresholds (unvalidated starting points)
const HIGH_FRACTION = 0.004; // >= this => likely-thrown
const LOW_FRACTION = 0.0005; // <= this => likely-map
// Between them => uncertain

// Target number of samples regardless of image size (~20k puts us in 10-40k range)
const TARGET_SAMPLE_COUNT = 20000;

/**
 * Convert RGB [0, 255] to HSV.
 * Returns [hue_degrees, saturation, value] where:
 * - hue is in [0, 360)
 * - saturation and value are in [0, 1]
 */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
	const rNorm = r / 255;
	const gNorm = g / 255;
	const bNorm = b / 255;

	const max = Math.max(rNorm, gNorm, bNorm);
	const min = Math.min(rNorm, gNorm, bNorm);
	const delta = max - min;

	// Value
	const v = max;

	// Saturation
	const s = max === 0 ? 0 : delta / max;

	// Hue
	let h: number;
	if (delta === 0) {
		h = 0;
	} else if (max === rNorm) {
		h = 60 * (((gNorm - bNorm) / delta) % 6);
	} else if (max === gNorm) {
		h = 60 * ((bNorm - rNorm) / delta + 2);
	} else {
		h = 60 * ((rNorm - gNorm) / delta + 4);
	}

	// Normalize hue to [0, 360)
	if (h < 0) {
		h += 360;
	}

	return [h, s, v];
}

/**
 * Check if a pixel (given as HSV) is in the purple/magenta band.
 */
function isPurpleMagenta(h: number, s: number, v: number): boolean {
	return h >= PURPLE_HUE_MIN && h <= PURPLE_HUE_MAX && s >= PURPLE_SAT_MIN && v >= PURPLE_VALUE_MIN;
}

/**
 * Sample pixels from RGBA buffer and compute fraction of purple/magenta pixels.
 * Samples every Nth pixel to keep total samples around TARGET_SAMPLE_COUNT.
 */
function samplePurplePixels(
	rgba: Uint8ClampedArray | Uint8Array,
	widthPx: number,
	heightPx: number
): number {
	if (widthPx === 0 || heightPx === 0 || rgba.length === 0) {
		return 0;
	}

	// Calculate stride to hit target sample count
	// We sample every stride-th pixel in both x and y, giving stride^2 reduction in sample count
	const totalPixels = widthPx * heightPx;
	const stride = Math.max(1, Math.ceil(Math.sqrt(totalPixels / TARGET_SAMPLE_COUNT)));

	let purpleCount = 0;
	let sampleCount = 0;

	// Sample every stride-th pixel (row-major order)
	for (let y = 0; y < heightPx; y += stride) {
		for (let x = 0; x < widthPx; x += stride) {
			const pixelIndex = (y * widthPx + x) * 4;
			if (pixelIndex + 3 >= rgba.length) {
				// Guard against truncated buffer
				break;
			}

			const r = rgba[pixelIndex];
			const g = rgba[pixelIndex + 1];
			const b = rgba[pixelIndex + 2];
			// Ignore alpha for this detection

			const [h, s, v] = rgbToHsv(r, g, b);
			if (isPurpleMagenta(h, s, v)) {
				purpleCount++;
			}
			sampleCount++;
		}
	}

	return sampleCount > 0 ? purpleCount / sampleCount : 0;
}

/**
 * Pure signal: purple/magenta pixel fraction from throw/walk paths.
 */
function purplePixelSignal(
	rgba: Uint8ClampedArray | Uint8Array,
	widthPx: number,
	heightPx: number
): ImageIntentSignal {
	// Guard degenerate inputs
	if (widthPx === 0 || heightPx === 0 || rgba.length === 0) {
		return {
			name: 'purple-path-pixels',
			intent: 'uncertain',
			strength: 1.0,
			detail: 'Image has zero dimensions or empty buffer'
		};
	}

	// Check if buffer is large enough for the declared dimensions
	const requiredBytes = widthPx * heightPx * 4;
	if (rgba.length < requiredBytes) {
		return {
			name: 'purple-path-pixels',
			intent: 'uncertain',
			strength: 1.0,
			detail: `Buffer is truncated (${rgba.length} bytes, need ${requiredBytes})`
		};
	}

	const fraction = samplePurplePixels(rgba, widthPx, heightPx);

	let intent: ImageIntent;
	let strength: number;

	if (fraction >= HIGH_FRACTION) {
		// Strong evidence of thrown round (many purple paths)
		intent = 'likely-thrown';
		// Scale strength: at HIGH_FRACTION give 0.5, at 1.0 give 1.0
		strength = Math.min(1.0, (fraction - HIGH_FRACTION) / (1.0 - HIGH_FRACTION) * 0.5 + 0.5);
	} else if (fraction <= LOW_FRACTION) {
		// Strong evidence of clean map (very few purple pixels)
		intent = 'likely-map';
		// Scale strength: at 0 give 1.0, at LOW_FRACTION give 0.5
		strength = Math.min(1.0, (1.0 - fraction / LOW_FRACTION) * 0.5 + 0.5);
	} else {
		// Ambiguous: between the thresholds
		intent = 'uncertain';
		// Strength indicates how far from a definitive threshold
		const midFraction = (HIGH_FRACTION + LOW_FRACTION) / 2;
		const distFromMid = Math.abs(fraction - midFraction);
		const maxDistFromMid = (HIGH_FRACTION - LOW_FRACTION) / 2;
		strength = 1.0 - (distFromMid / maxDistFromMid) * 0.5; // 0.5-1.0 range
	}

	return {
		name: 'purple-path-pixels',
		intent,
		strength,
		detail: `Purple/magenta pixels: ${(fraction * 100).toFixed(3)}% of sampled pixels`
	};
}

/**
 * Combine signals into a final classification.
 * With one signal, returns that signal's intent.
 * With multiple signals, uses a strength-weighted vote where 'uncertain' wins
 * unless a clear majority agree.
 */
function combineSignals(signals: readonly ImageIntentSignal[]): ImageIntent {
	if (signals.length === 0) {
		return 'uncertain';
	}

	// With one signal, just return its intent
	if (signals.length === 1) {
		return signals[0].intent;
	}

	// With multiple signals: strength-weighted vote
	// Count votes weighted by strength
	let thrownVotes = 0;
	let mapVotes = 0;

	for (const signal of signals) {
		if (signal.intent === 'likely-thrown') {
			thrownVotes += signal.strength;
		} else if (signal.intent === 'likely-map') {
			mapVotes += signal.strength;
		}
		// 'uncertain' votes don't contribute
	}

	// If neither side has a clear 2:1 majority, default to uncertain
	const majority = 1.5; // 2:1 threshold in weighted terms

	if (thrownVotes >= mapVotes * majority) {
		return 'likely-thrown';
	} else if (mapVotes >= thrownVotes * majority) {
		return 'likely-map';
	} else {
		return 'uncertain';
	}
}

export function classifyImageIntent(
	rgba: Uint8ClampedArray | Uint8Array,
	widthPx: number,
	heightPx: number
): ImageIntentClassification {
	const signals: ImageIntentSignal[] = [];

	// Run all independent signal functions
	signals.push(purplePixelSignal(rgba, widthPx, heightPx));

	// Combine signals into final classification
	const intent = combineSignals(signals);

	return {
		intent,
		signals
	};
}
