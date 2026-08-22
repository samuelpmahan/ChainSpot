/**
 * Canonical digit-mask normalization for all NuThing P2 digit experiments.
 *
 * Every real, synthetic, or augmented digit sample goes through THIS module
 * so competing feature/classifier experiments consume byte-identical
 * representations. Do not fork or re-implement the normalization elsewhere.
 *
 * A digit sample is a binary mask tightly cropped to the digit's bounding
 * box. Normalization scales it into a DIGIT_W x DIGIT_H grid preserving
 * aspect (nearest-neighbor), centered with equal margins.
 */

export const DIGIT_W = 24;
export const DIGIT_H = 32;

/** Row-major DIGIT_W x DIGIT_H binary mask (0/1 per byte). */
export type NormalizedDigit = Uint8Array;

export function normalizeDigitMask(
	mask: Uint8Array | number[],
	width: number,
	height: number
): NormalizedDigit {
	const out = new Uint8Array(DIGIT_W * DIGIT_H);
	if (width <= 0 || height <= 0) return out;
	const s = Math.min(DIGIT_W / width, DIGIT_H / height);
	const outW = Math.max(1, Math.round(width * s));
	const outH = Math.max(1, Math.round(height * s));
	const ox = Math.floor((DIGIT_W - outW) / 2);
	const oy = Math.floor((DIGIT_H - outH) / 2);
	for (let y = 0; y < outH; y++) {
		const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / outH));
		for (let x = 0; x < outW; x++) {
			const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / outW));
			if (mask[sy * width + sx]) out[(oy + y) * DIGIT_W + (ox + x)] = 1;
		}
	}
	return out;
}

/** Serialize a normalized digit as base64 (one byte per pixel, 0/1). */
export function digitToBase64(digit: NormalizedDigit): string {
	let bin = '';
	for (let i = 0; i < digit.length; i++) bin += String.fromCharCode(digit[i]);
	// btoa is unavailable in Node scripts without DOM; use Buffer when present.
	if (typeof Buffer !== 'undefined') return Buffer.from(digit).toString('base64');
	return btoa(bin);
}

export function digitFromBase64(b64: string): NormalizedDigit {
	if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
