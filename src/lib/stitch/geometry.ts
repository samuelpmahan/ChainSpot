/**
 * ChainSpot Stitch Map geometry (P05-002).
 *
 * Pure crop, placement, overlap, and output-bounds math in original/cropped
 * screenshot pixel space. Preview scale, device pixel ratio, and fit never enter
 * these values; every placement is an integer pixel position so export never
 * resamples or blurs. The shared crop and tile positions are always independent
 * of preview size.
 */
export type TileSlot =
	| 'upper-left'
	| 'upper-right'
	| 'lower-left'
	| 'lower-right'
	| 'left'
	| 'right'
	| 'top'
	| 'bottom';

/** The three supported capture layouts: the original 2x2 grid, and two-tile side-by-side/stacked sets. */
export type StitchLayout = '2x2' | '1x2' | '2x1';

export const TILE_SLOTS: readonly TileSlot[] = [
	'upper-left',
	'upper-right',
	'lower-left',
	'lower-right'
];

/** Slot vocabulary and order for each supported layout; the first slot is always the anchor. */
export const TILE_SLOTS_BY_LAYOUT: Record<StitchLayout, readonly TileSlot[]> = {
	'2x2': TILE_SLOTS,
	'1x2': ['left', 'right'],
	'2x1': ['top', 'bottom']
};

/** Every slot name across every supported layout; useful for clearing per-slot state on reset. */
export const ALL_TILE_SLOTS: readonly TileSlot[] = [
	...TILE_SLOTS_BY_LAYOUT['2x2'],
	...TILE_SLOTS_BY_LAYOUT['1x2'],
	...TILE_SLOTS_BY_LAYOUT['2x1']
];

export type CropInsetField = 'topPx' | 'rightPx' | 'bottomPx' | 'leftPx';

export interface CropInsets {
	readonly topPx: number;
	readonly rightPx: number;
	readonly bottomPx: number;
	readonly leftPx: number;
}

export const ZERO_CROP: CropInsets = { topPx: 0, rightPx: 0, bottomPx: 0, leftPx: 0 };

export interface TilePlacement {
	readonly xPx: number;
	readonly yPx: number;
	readonly visible: boolean;
}

export interface TileRect {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

export type CropValidation =
	| { ok: true; widthPx: number; heightPx: number }
	| { ok: false; invalidFields: readonly CropInsetField[] };

/**
 * Validates the shared crop against the session's original screenshot size.
 * Non-finite, negative, or non-integer individual insets flag that field; a pair
 * of horizontal insets that removes all width flags both horizontal fields, and
 * the same applies to the vertical pair.
 */
export function cropSize(insets: CropInsets, widthPx: number, heightPx: number): CropValidation {
	const invalidFields: CropInsetField[] = [];
	for (const field of ['topPx', 'rightPx', 'bottomPx', 'leftPx'] as const) {
		const value = insets[field];
		if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
			invalidFields.push(field);
		}
	}
	if (invalidFields.length > 0) return { ok: false, invalidFields };
	if (insets.leftPx + insets.rightPx >= widthPx) {
		return { ok: false, invalidFields: ['leftPx', 'rightPx'] };
	}
	if (insets.topPx + insets.bottomPx >= heightPx) {
		return { ok: false, invalidFields: ['topPx', 'bottomPx'] };
	}
	return {
		ok: true,
		widthPx: widthPx - insets.leftPx - insets.rightPx,
		heightPx: heightPx - insets.topPx - insets.bottomPx
	};
}

/**
 * The documented 25% overlap starting layout. Positions are rounded integers so
 * placement never becomes fractional; this is also exactly what Reset arrangement
 * restores. Only the slots belonging to `layout` (default `'2x2'`, unchanged from
 * before this parameter existed) are populated.
 */
export function initialPlacements(
	croppedWidthPx: number,
	croppedHeightPx: number,
	layout: StitchLayout = '2x2'
): Partial<Record<TileSlot, TilePlacement>> {
	const offsetX = Math.round((croppedWidthPx * 3) / 4);
	const offsetY = Math.round((croppedHeightPx * 3) / 4);
	switch (layout) {
		case '2x2':
			return {
				'upper-left': { xPx: 0, yPx: 0, visible: true },
				'upper-right': { xPx: offsetX, yPx: 0, visible: true },
				'lower-left': { xPx: 0, yPx: offsetY, visible: true },
				'lower-right': { xPx: offsetX, yPx: offsetY, visible: true }
			};
		case '1x2':
			return {
				left: { xPx: 0, yPx: 0, visible: true },
				right: { xPx: offsetX, yPx: 0, visible: true }
			};
		case '2x1':
			return {
				top: { xPx: 0, yPx: 0, visible: true },
				bottom: { xPx: 0, yPx: offsetY, visible: true }
			};
	}
}

/**
 * The expected neighbor tiles whose overlap matters for export readiness, within
 * `layout` (default `'2x2'`, unchanged from before this parameter existed).
 */
export function expectedNeighbors(
	slot: TileSlot,
	layout: StitchLayout = '2x2'
): readonly TileSlot[] {
	switch (layout) {
		case '2x2':
			switch (slot) {
				case 'upper-left':
					return ['upper-right', 'lower-left'];
				case 'upper-right':
					return ['upper-left', 'lower-right'];
				case 'lower-left':
					return ['upper-left', 'lower-right'];
				case 'lower-right':
					return ['upper-right', 'lower-left'];
				default:
					return [];
			}
		case '1x2':
			if (slot === 'left') return ['right'];
			if (slot === 'right') return ['left'];
			return [];
		case '2x1':
			if (slot === 'top') return ['bottom'];
			if (slot === 'bottom') return ['top'];
			return [];
	}
}

export function tileRect(
	placement: TilePlacement,
	croppedWidthPx: number,
	croppedHeightPx: number
): TileRect {
	return {
		xPx: placement.xPx,
		yPx: placement.yPx,
		widthPx: croppedWidthPx,
		heightPx: croppedHeightPx
	};
}

/** Intersection area in cropped pixels; zero when the rects do not overlap. */
export function overlapArea(a: TileRect, b: TileRect): number {
	const width = Math.min(a.xPx + a.widthPx, b.xPx + b.widthPx) - Math.max(a.xPx, b.xPx);
	const height = Math.min(a.yPx + a.heightPx, b.yPx + b.heightPx) - Math.max(a.yPx, b.yPx);
	if (width <= 0 || height <= 0) return 0;
	return width * height;
}

/**
 * The session's required dimensions: established by the first valid tile in fixed
 * slot order and kept while any tile remains loaded. Returns null only when every
 * slot is empty.
 */
export function sessionDimensions(
	tiles: Partial<Record<TileSlot, { readonly widthPx: number; readonly heightPx: number }>>,
	layout: StitchLayout = '2x2'
): { widthPx: number; heightPx: number } | null {
	for (const slot of TILE_SLOTS_BY_LAYOUT[layout]) {
		const tile = tiles[slot];
		if (tile) return { widthPx: tile.widthPx, heightPx: tile.heightPx };
	}
	return null;
}

export interface ReadinessReport {
	readonly ready: boolean;
	readonly missing: readonly TileSlot[];
	readonly dimensionMismatch: readonly TileSlot[];
	readonly invalidCrop: boolean;
	/**
	 * Movable tiles that cannot reach the upper-left anchor through positive-area
	 * overlaps along expected-neighbor edges. Two internally overlapping clusters
	 * that are not connected to each other keep this non-empty.
	 */
	readonly disconnected: readonly TileSlot[];
}

/**
 * Export readiness: every tile of `layout` present, all matching the session
 * requirement, a valid shared crop, and a connected arrangement — starting from
 * the layout's anchor slot (its first slot; `upper-left` for `'2x2'`), every
 * loaded tile must be reachable through positive-area overlaps along
 * expected-neighbor edges only. A pair of detached but internally overlapping
 * clusters is therefore never ready. Visibility and opacity are preview concerns
 * and never affect readiness. Readiness never claims visual alignment; that stays
 * the user's judgment.
 */
export function readiness(
	tiles: Partial<Record<TileSlot, { readonly widthPx: number; readonly heightPx: number }>>,
	crop: CropInsets,
	placements: Partial<Record<TileSlot, TilePlacement>>,
	required: { widthPx: number; heightPx: number } | null,
	layout: StitchLayout = '2x2'
): ReadinessReport {
	const slots = TILE_SLOTS_BY_LAYOUT[layout];
	const anchor = slots[0];
	const missing: TileSlot[] = [];
	const dimensionMismatch: TileSlot[] = [];
	for (const slot of slots) {
		const tile = tiles[slot];
		if (!tile) {
			missing.push(slot);
		} else if (
			!required ||
			tile.widthPx !== required.widthPx ||
			tile.heightPx !== required.heightPx
		) {
			dimensionMismatch.push(slot);
		}
	}
	const validation = required ? cropSize(crop, required.widthPx, required.heightPx) : null;
	const invalidCrop = !validation?.ok;
	const disconnected: TileSlot[] = [];
	if (validation?.ok) {
		const visited = new Set<TileSlot>([anchor]);
		const queue: TileSlot[] = tiles[anchor] ? [anchor] : [];
		while (queue.length > 0) {
			const slot = queue.shift() as TileSlot;
			const placement = placements[slot];
			if (!placement) continue;
			const rect = tileRect(placement, validation.widthPx, validation.heightPx);
			for (const neighbor of expectedNeighbors(slot, layout)) {
				if (visited.has(neighbor) || !tiles[neighbor] || !placements[neighbor]) continue;
				if (
					overlapArea(
						rect,
						tileRect(placements[neighbor], validation.widthPx, validation.heightPx)
					) > 0
				) {
					visited.add(neighbor);
					queue.push(neighbor);
				}
			}
		}
		for (const slot of slots) {
			if (slot === anchor || !tiles[slot]) continue;
			if (!visited.has(slot)) disconnected.push(slot);
		}
	}
	return {
		ready:
			missing.length === 0 &&
			dimensionMismatch.length === 0 &&
			!invalidCrop &&
			disconnected.length === 0,
		missing,
		dimensionMismatch,
		invalidCrop,
		disconnected
	};
}

/** The smallest rectangle containing every tile rect; null for an empty set. */
export function unionBounds(rects: readonly TileRect[]): TileRect | null {
	if (rects.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const rect of rects) {
		minX = Math.min(minX, rect.xPx);
		minY = Math.min(minY, rect.yPx);
		maxX = Math.max(maxX, rect.xPx + rect.widthPx);
		maxY = Math.max(maxY, rect.yPx + rect.heightPx);
	}
	return { xPx: minX, yPx: minY, widthPx: maxX - minX, heightPx: maxY - minY };
}

/** Translates the union's minimum corner to the output origin. */
export function translatedOrigin(union: TileRect): { dxPx: number; dyPx: number } {
	return { dxPx: -union.xPx || 0, dyPx: -union.yPx || 0 };
}
