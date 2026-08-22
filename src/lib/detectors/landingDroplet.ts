// Landing-droplet detection for a UDisc thrown-round screenshot.
//
// Clean rederivation of the proven old-app approach (evidence:
// old-stuff/src/lib/autoAnnotation/landingDropletDetection.ts, itself a port
// of the validated find_droplets.py probe): threshold UDisc's saturated
// marker blue in HSV, keep droplet-shaped connected components, and report
// the TIP — the bottom-most blue pixels — as the semantic landing location,
// never the blob centroid (the droplet glyph hangs above the point it marks).
//
// Deliberately narrow, like the original:
// - no hole assignment, throw ordering, or round reconstruction;
// - no splitting of visually merged droplets — components failing the size
//   gates are dropped, not guessed at;
// - no C1/C2/off-fairway glyph classification (MappedRound carries positions
//   only for MVP).
// Pure TS over the RgbaRaster contract; no OpenCV, no DOM.

import type { Detector, RgbaRaster } from '../detect';
import { rgbToHsv } from './hsv';

export const LANDING_DROPLET_ALGO = 'landing-droplet-mask';
export const LANDING_DROPLET_ALGO_VERSION = '1.0.0';

// UDisc marker blue. The old detector gated OpenCV HSV at hue 95–125 (0–180
// scale), i.e. 190–250°, with sat/value ≥ 100/255.
const BLUE_HUE_MIN_DEG = 190;
const BLUE_HUE_MAX_DEG = 250;
const SATURATION_MIN = 100 / 255;
const VALUE_MIN = 100 / 255;

// Shape gates, carried over from the validated probe.
const MIN_COMPONENT_AREA_PX = 30;
const PIN_ASPECT_MIN = 1.15; // droplets are taller than wide
const PIN_WIDTH_MIN_PX = 6;
const PIN_HEIGHT_MIN_PX = 10;
const PIN_WIDTH_MAX_FRACTION = 0.08; // of image width
const PIN_HEIGHT_MAX_FRACTION = 0.12; // of image height

export interface DropletComponent {
	readonly tipXPx: number;
	readonly tipYPx: number;
	readonly boundsXPx: number;
	readonly boundsYPx: number;
	readonly boundsWidthPx: number;
	readonly boundsHeightPx: number;
	readonly areaPx: number;
}

function isMarkerBlue(r: number, g: number, b: number): boolean {
	const { h, s, v } = rgbToHsv(r, g, b);
	return h >= BLUE_HUE_MIN_DEG && h <= BLUE_HUE_MAX_DEG && s >= SATURATION_MIN && v >= VALUE_MIN;
}

/** Pure core: find droplet-shaped marker-blue components and their tips. */
export function findDroplets(image: RgbaRaster): DropletComponent[] {
	const { widthPx: w, heightPx: h, rgba } = image;
	if (w <= 0 || h <= 0) throw new Error('Droplet image dimensions must be positive.');
	if (rgba.length !== w * h * 4)
		throw new Error('Droplet RGBA byte length does not match image dimensions.');

	const mask = new Uint8Array(w * h);
	for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
		if (isMarkerBlue(rgba[p], rgba[p + 1], rgba[p + 2])) mask[i] = 1;
	}

	const widthMaxPx = Math.max(PIN_WIDTH_MIN_PX, Math.round(w * PIN_WIDTH_MAX_FRACTION));
	const heightMaxPx = Math.max(PIN_HEIGHT_MIN_PX, Math.round(h * PIN_HEIGHT_MAX_FRACTION));

	const out: DropletComponent[] = [];
	const stack: number[] = [];
	for (let start = 0; start < mask.length; start++) {
		if (mask[start] !== 1) continue;

		// 4-connected flood fill; mark visited by setting mask to 2.
		let area = 0;
		let minX = w;
		let maxX = -1;
		let minY = h;
		let maxY = -1;
		let bottomRowSumX = 0;
		let bottomRowCount = 0;
		stack.push(start);
		mask[start] = 2;
		while (stack.length > 0) {
			const idx = stack.pop() as number;
			const x = idx % w;
			const y = (idx - x) / w;
			area++;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) {
				maxY = y;
				bottomRowSumX = x;
				bottomRowCount = 1;
			} else if (y === maxY) {
				bottomRowSumX += x;
				bottomRowCount++;
			}
			if (x > 0 && mask[idx - 1] === 1) {
				mask[idx - 1] = 2;
				stack.push(idx - 1);
			}
			if (x + 1 < w && mask[idx + 1] === 1) {
				mask[idx + 1] = 2;
				stack.push(idx + 1);
			}
			if (y > 0 && mask[idx - w] === 1) {
				mask[idx - w] = 2;
				stack.push(idx - w);
			}
			if (y + 1 < h && mask[idx + w] === 1) {
				mask[idx + w] = 2;
				stack.push(idx + w);
			}
		}

		const bw = maxX - minX + 1;
		const bh = maxY - minY + 1;
		if (area < MIN_COMPONENT_AREA_PX) continue;
		if (bw < PIN_WIDTH_MIN_PX || bh < PIN_HEIGHT_MIN_PX) continue;
		if (bw > widthMaxPx || bh > heightMaxPx) continue;
		if (bh / bw < PIN_ASPECT_MIN) continue;

		out.push({
			tipXPx: Math.round(bottomRowSumX / bottomRowCount),
			tipYPx: maxY,
			boundsXPx: minX,
			boundsYPx: minY,
			boundsWidthPx: bw,
			boundsHeightPx: bh,
			areaPx: area
		});
	}
	return out;
}

export const landingDropletDetector: Detector = async (image, emit) => {
	const droplets = findDroplets(image);
	for (let i = 0; i < droplets.length; i++) {
		const d = droplets[i];
		emit({
			kind: 'object',
			detId: `landing-droplet-${i}`,
			objType: 'landing-droplet',
			xPx: d.tipXPx,
			yPx: d.tipYPx,
			// Shape-gated color mass, not a calibrated model; a component that
			// passed every gate is a droplet with high consistency in practice.
			confidence: 0.9,
			imageId: image.imageId,
			algo: LANDING_DROPLET_ALGO,
			algoVersion: LANDING_DROPLET_ALGO_VERSION
		});
	}
};
