/**
 * A REAL (not stamped-peak) grayscale template matcher satisfying the
 * `BasketCv` surface, for tests that need genuine normalized
 * cross-correlation -- e.g. proving a rotated glyph actually fails to match
 * its own unrotated template. `basketTemplateDetection.test.ts`'s `fakeCv`
 * deliberately stamps peaks and ignores template pixels, which is right for
 * isolating that module's own NMS/scale-fusion logic but cannot demonstrate
 * "does rotation actually break upright-only matching" -- this module can,
 * cheaply, because the rasters these tests use are small (tens of pixels).
 */
import type { BasketCv } from '../../src/lib/autoAnnotation/basketTemplateDetection';

interface RealMat {
	rows: number;
	cols: number;
	data: Uint8Array;
	data32F?: Float32Array;
	delete(): void;
}

class Mat implements RealMat {
	rows: number;
	cols: number;
	data: Uint8Array;
	data32F?: Float32Array;
	constructor(rows = 0, cols = 0) {
		this.rows = rows;
		this.cols = cols;
		this.data = new Uint8Array(Math.max(0, rows * cols));
	}
	delete(): void {}
}

class Size {
	constructor(
		public readonly width: number,
		public readonly height: number
	) {}
}

/** Brute-force TM_CCOEFF_NORMED and nearest-neighbor resize -- O(outputPositions * templatePixels), fine for the tens-of-pixels rasters these tests use, far too slow for a production raster. */
export function createBruteForceBasketCv(): BasketCv {
	return {
		Mat: Mat as unknown as BasketCv['Mat'],
		Size: Size as unknown as BasketCv['Size'],
		CV_8UC1: 0,
		TM_CCOEFF_NORMED: 0,
		INTER_AREA: 0,
		INTER_CUBIC: 1,
		resize: (source: unknown, destination: unknown, size: unknown) => {
			const src = source as unknown as RealMat;
			const dst = destination as unknown as RealMat;
			const { width, height } = size as unknown as Size;
			const out = new Uint8Array(Math.max(0, width * height));
			for (let y = 0; y < height; y += 1) {
				const sourceY = Math.min(src.rows - 1, Math.floor(((y + 0.5) * src.rows) / height));
				for (let x = 0; x < width; x += 1) {
					const sourceX = Math.min(src.cols - 1, Math.floor(((x + 0.5) * src.cols) / width));
					out[y * width + x] = src.data[sourceY * src.cols + sourceX];
				}
			}
			dst.cols = width;
			dst.rows = height;
			dst.data = out;
		},
		matchTemplate: (image: unknown, templ: unknown, result: unknown) => {
			const img = image as unknown as RealMat;
			const template = templ as unknown as RealMat;
			const res = result as unknown as RealMat;
			const outRows = Math.max(0, img.rows - template.rows + 1);
			const outCols = Math.max(0, img.cols - template.cols + 1);
			res.rows = outRows;
			res.cols = outCols;
			const data = new Float32Array(outRows * outCols);
			const templateCount = template.rows * template.cols;
			let templateMean = 0;
			for (let i = 0; i < templateCount; i += 1) templateMean += template.data[i];
			templateMean /= templateCount;
			const templateCentered = new Float64Array(templateCount);
			let templateEnergy = 0;
			for (let i = 0; i < templateCount; i += 1) {
				const value = template.data[i] - templateMean;
				templateCentered[i] = value;
				templateEnergy += value * value;
			}
			for (let outY = 0; outY < outRows; outY += 1) {
				for (let outX = 0; outX < outCols; outX += 1) {
					let patchSum = 0;
					for (let ty = 0; ty < template.rows; ty += 1) {
						const rowBase = (outY + ty) * img.cols + outX;
						for (let tx = 0; tx < template.cols; tx += 1) patchSum += img.data[rowBase + tx];
					}
					const patchMean = patchSum / templateCount;
					let cross = 0;
					let patchEnergy = 0;
					for (let ty = 0; ty < template.rows; ty += 1) {
						const rowBase = (outY + ty) * img.cols + outX;
						const templateRow = ty * template.cols;
						for (let tx = 0; tx < template.cols; tx += 1) {
							const patchValue = img.data[rowBase + tx] - patchMean;
							cross += patchValue * templateCentered[templateRow + tx];
							patchEnergy += patchValue * patchValue;
						}
					}
					const denominator = Math.sqrt(patchEnergy * templateEnergy);
					data[outY * outCols + outX] = denominator > 1e-6 ? cross / denominator : 0;
				}
			}
			res.data32F = data;
		},
		minMaxLoc: (mat: unknown) => {
			const m = mat as unknown as RealMat;
			const data = m.data32F ?? new Float32Array(0);
			let maxVal = -Infinity;
			let minVal = Infinity;
			let maxIndex = 0;
			let minIndex = 0;
			for (let i = 0; i < data.length; i += 1) {
				const value = data[i];
				if (value > maxVal) {
					maxVal = value;
					maxIndex = i;
				}
				if (value < minVal) {
					minVal = value;
					minIndex = i;
				}
			}
			const cols = m.cols || 1;
			return {
				maxVal,
				minVal,
				maxLoc: { x: maxIndex % cols, y: Math.floor(maxIndex / cols) },
				minLoc: { x: minIndex % cols, y: Math.floor(minIndex / cols) }
			};
		}
	} as unknown as BasketCv;
}

/** Background/foreground grayscale values for `glyphValueAt` -- deliberately high-contrast for a clean NCC signal on tiny test rasters. */
const GLYPH_BACKGROUND = 60;
const GLYPH_FOREGROUND = 220;

/**
 * An intentionally ASYMMETRIC "flag" glyph (a vertical bar with a foot
 * extending only to one side) in its own canonical, unrotated local frame
 * `(uPx, vPx)` centered on the glyph -- asymmetric so a genuine rotation
 * actually changes the pixel pattern (a rotationally-symmetric test shape
 * would prove nothing about rotation sensitivity).
 */
function glyphValueAt(uPx: number, vPx: number): number {
	const inBar = Math.abs(uPx) <= 3 && vPx >= -10 && vPx <= 10;
	const inFoot = uPx >= -3 && uPx <= 7 && vPx >= 5 && vPx <= 10;
	return inBar || inFoot ? GLYPH_FOREGROUND : GLYPH_BACKGROUND;
}

export const GLYPH_TEMPLATE_WIDTH_PX = 22;
export const GLYPH_TEMPLATE_HEIGHT_PX = 26;

/** The canonical, upright, scale-1 template raster for the asymmetric glyph -- the "canonical basket template" stand-in these tests match against. */
export function buildCanonicalGlyphTemplate(): { gray: Uint8Array; widthPx: number; heightPx: number } {
	const widthPx = GLYPH_TEMPLATE_WIDTH_PX;
	const heightPx = GLYPH_TEMPLATE_HEIGHT_PX;
	const gray = new Uint8Array(widthPx * heightPx);
	const centerXPx = widthPx / 2;
	const centerYPx = heightPx / 2;
	for (let y = 0; y < heightPx; y += 1) {
		for (let x = 0; x < widthPx; x += 1) {
			gray[y * widthPx + x] = glyphValueAt(x - centerXPx, y - centerYPx);
		}
	}
	return { gray, widthPx, heightPx };
}

/** A blank grayscale raster filled with the glyph's own background value, so painted glyphs sit in the same ambient tone the canonical template itself was built against. */
export function blankGlyphRaster(widthPx: number, heightPx: number): Uint8Array {
	return new Uint8Array(widthPx * heightPx).fill(GLYPH_BACKGROUND);
}

/**
 * Paints the SAME asymmetric glyph into `gray` (a `widthPx x heightPx`
 * grayscale raster) at `(centerXPx, centerYPx)`, rotated by `rotationDeg` and
 * scaled by `scale` -- via inverse mapping back to the glyph's own canonical
 * frame per output pixel, i.e. exactly what a renderer resampling a rotated
 * sprite into a raster does. Sign convention matches
 * `sourcePose.ts`'s `rotationDegreesForTransform`: painting at `rotationDeg`
 * is what a source-space glyph painted upright would look like once mapped
 * through a `SourceTransform` whose rotation is `rotationDeg`.
 */
export function paintGlyph(
	gray: Uint8Array,
	widthPx: number,
	heightPx: number,
	centerXPx: number,
	centerYPx: number,
	rotationDeg: number,
	scale: number
): void {
	const radians = (rotationDeg * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const halfExtentPx = Math.max(GLYPH_TEMPLATE_WIDTH_PX, GLYPH_TEMPLATE_HEIGHT_PX);
	const radius = Math.ceil(halfExtentPx * scale) + 2;
	const minX = Math.max(0, Math.round(centerXPx - radius));
	const maxX = Math.min(widthPx - 1, Math.round(centerXPx + radius));
	const minY = Math.max(0, Math.round(centerYPx - radius));
	const maxY = Math.min(heightPx - 1, Math.round(centerYPx + radius));
	for (let y = minY; y <= maxY; y += 1) {
		for (let x = minX; x <= maxX; x += 1) {
			const dx = (x - centerXPx) / scale;
			const dy = (y - centerYPx) / scale;
			const uPx = dx * cos + dy * sin;
			const vPx = -dx * sin + dy * cos;
			gray[y * widthPx + x] = glyphValueAt(uPx, vPx);
		}
	}
}

/** `basketTemplateDetection.ts`'s own semantic-endpoint fraction, restated here so tests can compute an expected candidate location independently of running the detector. */
export const BASKET_BASE_Y_FRACTION = 0.96;
