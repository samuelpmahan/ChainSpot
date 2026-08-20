import { describe, expect, it } from 'vitest';
import {
	type ImageIntent,
	type ImageIntentClassification,
	classifyImageIntent
} from '../../src/lib/imageHeuristics';

/**
 * Create a synthetic RGBA buffer filled with a single color.
 */
function createRgbaBuffer(
	widthPx: number,
	heightPx: number,
	fillRgba: [number, number, number, number]
): Uint8ClampedArray {
	const buffer = new Uint8ClampedArray(widthPx * heightPx * 4);
	const [r, g, b, a] = fillRgba;
	for (let i = 0; i < buffer.length; i += 4) {
		buffer[i] = r;
		buffer[i + 1] = g;
		buffer[i + 2] = b;
		buffer[i + 3] = a;
	}
	return buffer;
}

/**
 * Set a single pixel to saturated purple in an existing buffer.
 */
function setPurplePixel(buffer: Uint8ClampedArray, widthPx: number, x: number, y: number): void {
	const index = (y * widthPx + x) * 4;
	// Saturated purple: HSV(300°, 1.0, 1.0) => RGB(255, 0, 255)
	buffer[index] = 255; // R
	buffer[index + 1] = 0; // G
	buffer[index + 2] = 255; // B
	buffer[index + 3] = 255; // A
}

describe('imageHeuristics', () => {
	describe('classifyImageIntent', () => {
		it('classifies all-green synthetic map as likely-map', () => {
			// 200x200 all-green image (green is not purple/magenta)
			const buffer = createRgbaBuffer(200, 200, [0, 255, 0, 255]);

			const result = classifyImageIntent(buffer, 200, 200);

			expect(result.intent).toBe('likely-map');
			expect(result.signals).toHaveLength(1);
			expect(result.signals[0].name).toBe('purple-path-pixels');
			expect(result.signals[0].intent).toBe('likely-map');
			expect(result.signals[0].strength).toBeGreaterThan(0.5);
		});

		it('classifies synthetic map with purple polyline as likely-thrown', () => {
			// 200x200 green map with several hundred purple pixels scattered across it
			const buffer = createRgbaBuffer(200, 200, [0, 255, 0, 255]);

			// Add ~500 purple pixels in a scattered pattern
			// Stride will be ~2, so sampling ~10k out of 40k pixels
			// Expected purple samples: 500 * (10k/40k) = 125
			// Fraction: 125/10k = 0.0125, which is >= 0.004 => likely-thrown
			for (let i = 0; i < 500; i++) {
				const x = (i * 7) % 200; // Spread across width
				const y = (i * 13) % 200; // Spread across height
				setPurplePixel(buffer, 200, x, y);
			}

			const result = classifyImageIntent(buffer, 200, 200);

			expect(result.intent).toBe('likely-thrown');
			expect(result.signals[0].intent).toBe('likely-thrown');
			expect(result.signals[0].strength).toBeGreaterThan(0.5);
		});

		it('classifies handful of purple pixels as uncertain', () => {
			// 200x200 green map with just enough purple to land in uncertain zone
			const buffer = createRgbaBuffer(200, 200, [0, 255, 0, 255]);

			// Add 25 purple pixels at stride-aligned positions (even x, even y)
			// Stride is 2, so sampling 10k pixels out of 40k total
			// With 25 total purple at (even,even): all 25 are sampled
			// Fraction: 25/10k = 0.0025, which is between 0.0005 and 0.004 => uncertain
			const purplePositions = [
				[0, 0], [4, 4], [8, 8], [12, 12], [16, 16],
				[20, 20], [24, 24], [28, 28], [32, 32], [36, 36],
				[40, 40], [44, 44], [48, 48], [52, 52], [56, 56],
				[60, 60], [64, 64], [68, 68], [72, 72], [76, 76],
				[80, 80], [84, 84], [88, 88], [92, 92], [96, 96]
			];
			for (const [x, y] of purplePositions) {
				setPurplePixel(buffer, 200, x, y);
			}

			const result = classifyImageIntent(buffer, 200, 200);

			expect(result.intent).toBe('uncertain');
			expect(result.signals[0].intent).toBe('uncertain');
		});

		it('handles zero-dimension image without throwing', () => {
			const buffer = new Uint8ClampedArray(0);

			const result = classifyImageIntent(buffer, 0, 0);

			expect(result.intent).toBe('uncertain');
			expect(result.signals).toHaveLength(1);
			expect(result.signals[0].name).toBe('purple-path-pixels');
			expect(result.signals[0].detail).toContain('zero dimensions');
		});

		it('handles truncated buffer without throwing', () => {
			// Buffer is too short for the declared dimensions
			const buffer = new Uint8ClampedArray(100); // Not enough for 200x200 (need 160k)

			const result = classifyImageIntent(buffer, 200, 200);

			expect(result.intent).toBe('uncertain');
			expect(result.signals[0].intent).toBe('uncertain');
		});

		it('populates signals array with name, intent, strength, and detail', () => {
			const buffer = createRgbaBuffer(200, 200, [128, 128, 128, 255]); // Gray

			const result = classifyImageIntent(buffer, 200, 200);

			expect(result.signals).toHaveLength(1);
			const signal = result.signals[0];
			expect(signal.name).toBeDefined();
			expect(typeof signal.name).toBe('string');
			expect(['likely-thrown', 'likely-map', 'uncertain']).toContain(signal.intent);
			expect(signal.strength).toBeGreaterThanOrEqual(0);
			expect(signal.strength).toBeLessThanOrEqual(1);
			expect(signal.detail).toBeDefined();
			expect(typeof signal.detail).toBe('string');
		});

		it('accepts Uint8Array in addition to Uint8ClampedArray', () => {
			const greenBuffer = new Uint8Array(200 * 200 * 4);
			for (let i = 0; i < greenBuffer.length; i += 4) {
				greenBuffer[i] = 0; // R
				greenBuffer[i + 1] = 255; // G
				greenBuffer[i + 2] = 0; // B
				greenBuffer[i + 3] = 255; // A
			}

			const result = classifyImageIntent(greenBuffer, 200, 200);

			expect(result.intent).toBe('likely-map');
			expect(result.signals[0].intent).toBe('likely-map');
		});

		it('distinguishes between low and high purple fractions with strength scaling', () => {
			// Very little purple (should be strong likely-map)
			const sparseBuffer = createRgbaBuffer(200, 200, [0, 255, 0, 255]);
			for (let i = 0; i < 10; i++) {
				setPurplePixel(sparseBuffer, 200, i, 0);
			}
			const sparseResult = classifyImageIntent(sparseBuffer, 200, 200);
			expect(sparseResult.intent).toBe('likely-map');
			const sparseStrength = sparseResult.signals[0].strength;

			// Much purple (should be strong likely-thrown)
			const denseBuffer = createRgbaBuffer(200, 200, [0, 255, 0, 255]);
			for (let i = 0; i < 2000; i++) {
				const x = (i * 7) % 200;
				const y = (i * 13) % 200;
				setPurplePixel(denseBuffer, 200, x, y);
			}
			const denseResult = classifyImageIntent(denseBuffer, 200, 200);
			expect(denseResult.intent).toBe('likely-thrown');
			const denseStrength = denseResult.signals[0].strength;

			// The high-confidence results should have stronger confidence
			expect(denseStrength).toBeGreaterThan(sparseStrength);
		});
	});
});
