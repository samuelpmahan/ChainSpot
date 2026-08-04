/**
 * ChainSpot Stitch Map native PNG export (P05-002).
 *
 * Offscreen canvas at native cropped-image resolution: identical source and
 * destination crop sizes (no resampling, no silent downsampling), union bounds
 * translated to the output origin, and a stable full-opacity draw order
 * (upper-left, upper-right, lower-left, lower-right). Preview visibility,
 * opacity, and fit never affect output pixels. The canvas environment is
 * injectable so deterministic tests can record the draw calls.
 */
import type { CropInsets, TilePlacement, TileSlot, TileRect } from './geometry';
import { cropSize, tileRect, translatedOrigin, unionBounds } from './geometry';

/** Chromium's practical per-dimension canvas limit; beyond it, fail loudly. */
export const MAX_CANVAS_DIMENSION = 16384;

export class StitchRenderError extends Error {
	readonly kind: 'canvas' | 'encode' | 'dimension';

	constructor(kind: 'canvas' | 'encode' | 'dimension', message: string) {
		super(message);
		this.name = 'StitchRenderError';
		this.kind = kind;
	}
}

export interface StitchRenderTile {
	readonly slot: TileSlot;
	readonly image: HTMLImageElement;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly placement: TilePlacement;
}

export interface StitchRenderEnv {
	createCanvas(): HTMLCanvasElement;
	toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null>;
}

export const defaultStitchRenderEnv: StitchRenderEnv = {
	createCanvas() {
		return document.createElement('canvas');
	},
	toBlob(canvas, type) {
		return new Promise((resolve, reject) => {
			canvas.toBlob(
				(blob) => {
					if (blob) resolve(blob);
					else {
						reject(
							new StitchRenderError(
								'encode',
								'PNG encoding failed. The session is unchanged; try again.'
							)
						);
					}
				},
				type
			);
		});
	}
};

const DRAW_ORDER: readonly TileSlot[] = ['upper-left', 'upper-right', 'lower-left', 'lower-right'];

export async function renderStitchedPng(
	tiles: readonly StitchRenderTile[],
	crop: CropInsets,
	env: StitchRenderEnv = defaultStitchRenderEnv
): Promise<Blob> {
	const anchor = tiles.find((tile) => tile.slot === 'upper-left') ?? tiles[0];
	if (!anchor) {
		throw new StitchRenderError('dimension', 'No tiles to stitch.');
	}
	const validation = cropSize(crop, anchor.widthPx, anchor.heightPx);
	if (!validation.ok) {
		throw new StitchRenderError(
			'dimension',
			'The shared crop is invalid. Correct the crop before exporting.'
		);
	}
	const { widthPx: croppedWidthPx, heightPx: croppedHeightPx } = validation;

	const bySlot = new Map<TileSlot, StitchRenderTile>();
	const rectBySlot = new Map<TileSlot, TileRect>();
	for (const tile of tiles) {
		bySlot.set(tile.slot, tile);
		rectBySlot.set(
			tile.slot,
			tileRect(tile.placement, croppedWidthPx, croppedHeightPx)
		);
	}
	const union = unionBounds([...rectBySlot.values()]);
	if (!union) {
		throw new StitchRenderError('dimension', 'No tiles to stitch.');
	}
	if (union.widthPx > MAX_CANVAS_DIMENSION || union.heightPx > MAX_CANVAS_DIMENSION) {
		throw new StitchRenderError(
			'dimension',
			`The stitched output (${union.widthPx} x ${union.heightPx}) exceeds the browser's practical canvas limit of ${MAX_CANVAS_DIMENSION} x ${MAX_CANVAS_DIMENSION} pixels.`
		);
	}

	const canvas = env.createCanvas();
	const context = canvas.getContext('2d');
	if (!context) {
		throw new StitchRenderError(
			'canvas',
			'Could not allocate an offscreen canvas for the stitch export. The session is unchanged.'
		);
	}
	const { dxPx, dyPx } = translatedOrigin(union);
	canvas.width = union.widthPx;
	canvas.height = union.heightPx;

	for (const slot of DRAW_ORDER) {
		const tile = bySlot.get(slot);
		if (!tile) continue;
		const rect = rectBySlot.get(slot);
		if (!rect) continue;
		context.drawImage(
			tile.image,
			crop.leftPx,
			crop.topPx,
			croppedWidthPx,
			croppedHeightPx,
			rect.xPx + dxPx,
			rect.yPx + dyPx,
			croppedWidthPx,
			croppedHeightPx
		);
	}

	const blob = await env.toBlob(canvas, 'image/png');
	if (!blob) {
		throw new StitchRenderError(
			'encode',
			'PNG encoding failed. The session is unchanged; try again.'
		);
	}
	return blob;
}

/** Default download name: first tile's base name or a timestamp, `-stitched.png`. */
export function stitchedFileName(tiles: readonly { fileName: string }[]): string {
	const first = tiles.find((tile) => tile.fileName.trim() !== '');
	const base = first ? first.fileName.replace(/\.[a-z0-9]+$/i, '') : `stitch-${Date.now()}`;
	return `${base}-stitched.png`;
}
