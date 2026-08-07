/**
 * In-memory provenance for NAIP target rasters.
 *
 * The clean-map UI already knows every geographic request before it fetches the
 * pixels. Keep that tiny bit of request geometry next to the in-memory session
 * so later tools (notably elevation profiles) can convert target pixels back to
 * WGS84 without rediscovering anything from the image.
 *
 * This intentionally mirrors the rest of ChainSpot's current session boundary:
 * a full page reload clears it. Durable project-schema georeferencing can be a
 * separate migration once the NAIP workflow itself is promoted from prototype.
 */
import type { GeoPoint } from './naip';
import type { TileGridPlan } from './naipGrid';

export interface SingleNaipReferenceRecord {
	readonly kind: 'single';
	readonly center: GeoPoint;
	readonly radiusMeters: number;
	readonly sizePx: number;
}

export interface GridNaipReferenceRecord {
	readonly kind: 'grid';
	readonly plan: TileGridPlan;
	readonly tileSizePx: number;
}

export type NaipReferenceRecord = SingleNaipReferenceRecord | GridNaipReferenceRecord;

let singleReference: SingleNaipReferenceRecord | null = null;
let gridReference: GridNaipReferenceRecord | null = null;

export function recordSingleNaipReference(center: GeoPoint, radiusMeters: number, sizePx: number): void {
	singleReference = {
		kind: 'single',
		center: { ...center },
		radiusMeters,
		sizePx
	};
}

export function recordGridNaipReference(plan: TileGridPlan, tileSizePx: number): void {
	gridReference = {
		kind: 'grid',
		plan: {
			...plan,
			centers: plan.centers.map((center) => ({ ...center }))
		},
		tileSizePx
	};
}

/**
 * Resolve only when the current target has the exact filename and dimensions
 * produced by the corresponding NAIP intake path. This prevents a stale fetch
 * record from being applied to an unrelated manually uploaded target.
 */
export function resolveNaipReferenceForTarget(target: {
	readonly fileName: string;
	readonly widthPx: number;
	readonly heightPx: number;
}): NaipReferenceRecord | null {
	if (
		target.fileName === 'naip-aerial.png' &&
		singleReference &&
		target.widthPx === singleReference.sizePx &&
		target.heightPx === singleReference.sizePx
	) {
		return singleReference;
	}
	if (
		target.fileName === 'naip-tile-grid.png' &&
		gridReference &&
		target.widthPx === gridReference.plan.cols * gridReference.tileSizePx &&
		target.heightPx === gridReference.plan.rows * gridReference.tileSizePx
	) {
		return gridReference;
	}
	return null;
}

/** Test/session reset only; production flow naturally replaces records on refetch. */
export function clearNaipReferenceSession(): void {
	singleReference = null;
	gridReference = null;
}
