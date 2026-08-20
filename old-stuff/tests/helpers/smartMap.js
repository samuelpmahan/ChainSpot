/**
 * Deterministic synthetic 2×2 map used by the P1-001 smart-import fixtures.
 *
 * Shared by the unit-test raster helper and the PNG fixture generator so the
 * browser workflow and the pure analysis tests describe the same capture: four
 * 200×200 screenshots of one 350×350 synthetic course at 25% overlap, with a
 * repeated uniform chrome band at the top (4px) and bottom (3px) of every tile.
 * All content is derived from a seeded value-noise field plus roads, landmarks,
 * and the chrome bands, so the same rasters always produce the same pixels.
 */

export const TILE_W = 200;
export const TILE_H = 200;
/** Overlap width/height in px between neighbors (25% of a tile). */
export const OVERLAP_PX = 50;
/** Tile-to-tile grid step: TILE_W - OVERLAP_PX. */
export const STEP = TILE_W - OVERLAP_PX;

export const CHROME_TOP = 4;
export const CHROME_BOTTOM = 3;
export const CHROME_LEFT = 0;
export const CHROME_RIGHT = 0;

export const SLOT_ORIGINS = {
	'upper-left': { x: 0, y: 0 },
	'upper-right': { x: STEP, y: 0 },
	'lower-left': { x: 0, y: STEP },
	'lower-right': { x: STEP, y: STEP }
};

export const SLOT_FILE_NAMES = {
	'upper-left': 'smart-ul.png',
	'upper-right': 'smart-ur.png',
	'lower-left': 'smart-ll.png',
	'lower-right': 'smart-lr.png'
};

/**
 * @typedef {'upper-left'|'upper-right'|'lower-left'|'lower-right'} SlotKey
 * @typedef {{ chromeTop?: number, chromeBottom?: number, origin?: {x: number, y: number}, unrelated?: boolean, repetitive?: boolean }} RasterOverrides
 * @typedef {{ widthPx: number, heightPx: number, gray: Uint8Array, scale: number }} GrayRaster
 */

/**
 * Deterministic 32-bit hash for seeded noise.
 * @param {number} x
 * @param {number} y
 */
function hash(x, y) {
	let h = x * 374761393 + y * 668265263;
	h = (h ^ (h >>> 13)) * 1274126177;
	h = h ^ (h >>> 16);
	return (h >>> 0) / 4294967295;
}

/**
 * Smooth value noise; organic, non-repeating map texture.
 * @param {number} x
 * @param {number} y
 */
function valueNoise(x, y) {
	const cell = 16;
	const gx = Math.floor(x / cell);
	const gy = Math.floor(y / cell);
	const fx = (x % cell) / cell;
	const fy = (y % cell) / cell;
	const v00 = hash(gx, gy);
	const v10 = hash(gx + 1, gy);
	const v01 = hash(gx, gy + 1);
	const v11 = hash(gx + 1, gy + 1);
	const sx = fx * fx * (3 - 2 * fx);
	const sy = fy * fy * (3 - 2 * fy);
	return v00 * (1 - sx) * (1 - sy) + v10 * sx * (1 - sy) + v01 * (1 - sx) * sy + v11 * sx * sy;
}

/**
 * Grayscale value (0..255) of the 350×350 synthetic course at (x, y).
 * @param {number} x
 * @param {number} y
 */
export function sceneGray(x, y) {
	const noise = valueNoise(x, y);
	let value = 60 + noise * 140;
	const roadX = [40, 90, 175, 240, 305];
	const roadY = [55, 120, 190, 265, 310];
	for (const rx of roadX) {
		if (Math.abs(x - rx) < 3) value = 25;
	}
	for (const ry of roadY) {
		if (Math.abs(y - ry) < 3) value = 25;
	}
	const blobs = [
		[70, 80],
		[210, 60],
		[150, 230],
		[290, 180],
		[30, 260],
		[320, 300]
	];
	for (const [bx, by] of blobs) {
		const d2 = (x - bx) ** 2 + (y - by) ** 2;
		if (d2 < 100) value = 235;
	}
	return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Builds one tile's grayscale raster. Overrides:
 * - `origin`: the tile's top-left scene coordinate; used to build weak
 *   (reduced-overlap) and incompatible (inconsistent-grid) sets.
 * - `unrelated`: renders a deterministic high-contrast checkerboard instead of
 *   the course, simulating a tile from a different capture.
 * - `repetitive`: renders only a y-periodic stripe field, so many translations
 *   match equally and the arrangement is ambiguous.
 * @param {SlotKey} slot
 * @param {RasterOverrides} [overrides]
 * @returns {GrayRaster}
 */
export function buildGrayRaster(slot, overrides = {}) {
	const chromeTop = overrides.chromeTop ?? CHROME_TOP;
	const chromeBottom = overrides.chromeBottom ?? CHROME_BOTTOM;
	const origin = overrides.origin ?? SLOT_ORIGINS[slot];
	const widthPx = TILE_W;
	const heightPx = TILE_H;
	const gray = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y += 1) {
		for (let x = 0; x < widthPx; x += 1) {
			let value;
			if (overrides.unrelated) {
				value = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 20 : 235;
			} else if (overrides.repetitive) {
				value = Math.floor((origin.y + y) / 40) % 2 === 0 ? 120 : 225;
			} else {
				value = sceneGray(origin.x + x, origin.y + y);
			}
			if (y < chromeTop) value = 12;
			else if (y >= heightPx - chromeBottom) value = 30;
			gray[y * widthPx + x] = Math.max(0, Math.min(255, Math.round(value)));
		}
	}
	return { widthPx, heightPx, gray, scale: 1 };
}

/**
 * Builds one tile's 8-bit RGB bytes for PNG encoding (grayscale duplicated).
 * @param {SlotKey} slot
 * @param {RasterOverrides} [overrides]
 * @returns {{ widthPx: number, heightPx: number, rgb: Uint8Array }}
 */
export function buildRgbPixels(slot, overrides = {}) {
	return rgbFromRaster(buildGrayRaster(slot, overrides));
}

/** Converts a grayscale raster into duplicated 8-bit RGB bytes.
 * @param {GrayRaster} raster
 * @returns {{ widthPx: number, heightPx: number, rgb: Uint8Array }}
 */
export function rgbFromRaster(raster) {
	const rgb = new Uint8Array(raster.widthPx * raster.heightPx * 3);
	for (let i = 0, j = 0; i < raster.gray.length; i += 1, j += 3) {
		const value = raster.gray[i];
		rgb[j] = value;
		rgb[j + 1] = value;
		rgb[j + 2] = value;
	}
	return { widthPx: raster.widthPx, heightPx: raster.heightPx, rgb };
}

/**
 * Builds a large repository-controlled tile raster for Chromium performance
 * measurement (P1-002). The four large tiles form a coherent 2×2 with 25%
 * overlap so the analysis exercises realistic matching, not just content.
 * @param {SlotKey} slot
 * @param {{ widthPx?: number, heightPx?: number }} [size]
 * @returns {GrayRaster}
 */
export function buildLargeGrayRaster(slot, size = {}) {
	const widthPx = size.widthPx ?? 1600;
	const heightPx = size.heightPx ?? 1200;
	const widthStep = Math.round(widthPx * 0.75);
	const heightStep = Math.round(heightPx * 0.75);
	const columnIndex = slot === 'upper-right' || slot === 'lower-right' ? 1 : 0;
	const rowIndex = slot === 'lower-left' || slot === 'lower-right' ? 1 : 0;
	const originX = columnIndex * widthStep;
	const originY = rowIndex * heightStep;
	const gray = new Uint8Array(widthPx * heightPx);
	for (let y = 0; y < heightPx; y += 1) {
		for (let x = 0; x < widthPx; x += 1) {
			gray[y * widthPx + x] = sceneGray(originX + x, originY + y);
		}
	}
	return { widthPx, heightPx, gray, scale: 1 };
}
