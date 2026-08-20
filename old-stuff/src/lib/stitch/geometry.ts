/**
 * ChainSpot Stitch Map geometry (P05-002; generalized to N tiles).
 *
 * Pure crop, placement, overlap, and output-bounds math in original/cropped
 * screenshot pixel space. Preview scale, device pixel ratio, and fit never enter
 * these values; every placement is an integer pixel position so export never
 * resamples or blurs. The shared crop and tile positions are always independent
 * of preview size.
 *
 * A session's tiles are no longer a fixed 2x2/1x2/2x1 slot vocabulary: `TileSlot`
 * is any stable string id, and the set of expected-neighbor relationships
 * between slots (`TileNeighbors`) is data produced by arrangement (see
 * `autoLayout.ts`'s `assignN`) rather than a hardcoded topology. Before any
 * arrangement has run, `gridNeighbors` supplies a reasonable placeholder
 * topology for an empty/manually-filled session.
 */
export type TileSlot = string;

/** Adjacency: for each slot, the other slots it is expected to overlap. */
export type TileNeighbors = Readonly<Record<TileSlot, readonly TileSlot[]>>;

/** Generates the N stable slot ids a fresh session (or a fresh arrangement) uses, in order. */
export function defaultSlotOrder(count: number): readonly TileSlot[] {
	return Array.from({ length: count }, (_, i) => `tile-${i}`);
}

/**
 * Placeholder grid adjacency for `order`, used before any real arrangement
 * evidence exists (an empty or freshly manually-filled session). Tiles are laid
 * out left-to-right, wrapping every `ceil(sqrt(N))` columns; two tiles are
 * neighbors when they are horizontally or vertically adjacent in that grid.
 */
export function gridNeighbors(order: readonly TileSlot[]): TileNeighbors {
	const n = order.length;
	const columns = Math.max(1, Math.ceil(Math.sqrt(n)));
	const neighbors: Record<TileSlot, TileSlot[]> = {};
	for (const slot of order) neighbors[slot] = [];
	for (let i = 0; i < n; i += 1) {
		const row = Math.floor(i / columns);
		const col = i % columns;
		const right = i + 1;
		if (col + 1 < columns && right < n) {
			neighbors[order[i]].push(order[right]);
			neighbors[order[right]].push(order[i]);
		}
		const below = i + columns;
		if (below < n) {
			neighbors[order[i]].push(order[below]);
			neighbors[order[below]].push(order[i]);
		}
		void row;
	}
	return neighbors;
}

/** The expected-neighbor slots of `slot` within `neighbors` (empty when absent). */
export function expectedNeighbors(slot: TileSlot, neighbors: TileNeighbors): readonly TileSlot[] {
	return neighbors[slot] ?? [];
}

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
 * The documented 25% overlap starting layout for `order`, arranged in the same
 * `gridNeighbors` grid. Positions are rounded integers so placement never
 * becomes fractional; this is also exactly what "Reset arrangement" restores.
 */
export function initialPlacements(
	order: readonly TileSlot[],
	croppedWidthPx: number,
	croppedHeightPx: number
): Partial<Record<TileSlot, TilePlacement>> {
	const columns = Math.max(1, Math.ceil(Math.sqrt(order.length)));
	const offsetX = Math.round((croppedWidthPx * 3) / 4);
	const offsetY = Math.round((croppedHeightPx * 3) / 4);
	const placements: Partial<Record<TileSlot, TilePlacement>> = {};
	order.forEach((slot, i) => {
		const row = Math.floor(i / columns);
		const col = i % columns;
		placements[slot] = { xPx: col * offsetX, yPx: row * offsetY, visible: true };
	});
	return placements;
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
 * The session's required dimensions: established by the first valid tile in
 * `order` and kept while any tile remains loaded. Returns null only when every
 * slot in `order` is empty.
 */
export function sessionDimensions(
	tiles: Partial<Record<TileSlot, { readonly widthPx: number; readonly heightPx: number }>>,
	order: readonly TileSlot[]
): { widthPx: number; heightPx: number } | null {
	for (const slot of order) {
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
	 * Movable tiles that cannot reach the anchor through positive-area overlaps
	 * along expected-neighbor edges. Two internally overlapping clusters that
	 * are not connected to each other keep this non-empty.
	 */
	readonly disconnected: readonly TileSlot[];
}

/**
 * Export readiness: every tile of `order` present, all matching the session
 * requirement, a valid shared crop, and a connected arrangement — starting from
 * `order`'s anchor slot (its first entry), every loaded tile must be reachable
 * through positive-area overlaps along `neighbors`' expected-neighbor edges
 * only. A pair of detached but internally overlapping clusters is therefore
 * never ready. Visibility and opacity are preview concerns and never affect
 * readiness. Readiness never claims visual alignment; that stays the user's
 * judgment.
 */
export function readiness(
	tiles: Partial<Record<TileSlot, { readonly widthPx: number; readonly heightPx: number }>>,
	crop: CropInsets,
	placements: Partial<Record<TileSlot, TilePlacement>>,
	required: { widthPx: number; heightPx: number } | null,
	order: readonly TileSlot[],
	neighbors: TileNeighbors
): ReadinessReport {
	const anchor = order[0];
	const missing: TileSlot[] = [];
	const dimensionMismatch: TileSlot[] = [];
	for (const slot of order) {
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
			for (const neighbor of expectedNeighbors(slot, neighbors)) {
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
		for (const slot of order) {
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
