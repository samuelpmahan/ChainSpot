/**
 * ChainSpot Stitch Map auto-first UX (CHSPT-55/56) — pure UI-side glue
 * between the manual-correction surface's legacy shared-crop/placement
 * editing model (`stitch/geometry.ts`'s `CropInsets`/`TilePlacement`) and the
 * locked `domain/provenance.ts` draft/composite shape, plus the badge-flash
 * coordinate mapping. Deliberately not "stitch algorithm/renderer
 * internals" (CHSPT-50/Agent B's territory): nothing here estimates a
 * placement or a crop from pixels — it only re-expresses placements/crops
 * the user (or the pipeline) already decided, so `renderPipelineComposite`
 * has one shape to render for both the automatic result and a manually
 * adjusted one.
 */
import {
	applySourceTransform,
	translationSourceTransform,
	CURRENT_PROVENANCE_SCHEMA_VERSION,
	CURRENT_RENDER_VERSION
} from '../domain/provenance';
import type {
	DraftComposite,
	Sha256Hex,
	SourceCapture,
	SourceCaptureOrigin,
	SourceCropRect,
	SourceRasterPoint
} from '../domain/provenance';
import { cropSize, tileRect, translatedOrigin, unionBounds } from './geometry';
import type { CropInsets, TilePlacement, TileSlot } from './geometry';

function cropCornersOf(crop: SourceCropRect): readonly SourceRasterPoint[] {
	return [
		{ xPx: crop.xPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx + crop.heightPx },
		{ xPx: crop.xPx, yPx: crop.yPx + crop.heightPx }
	];
}

export interface ManualDraftTile {
	readonly fileName: string;
	readonly mimeType: string;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface ManualDraftInputs {
	readonly slots: readonly TileSlot[];
	readonly tiles: Partial<Record<TileSlot, ManualDraftTile>>;
	readonly placements: Partial<Record<TileSlot, TilePlacement>>;
	readonly crop: CropInsets;
	/** Hash of each slot's original, unmodified capture bytes; a slot missing from this map falls back to 64 zero-hex digits rather than throwing (never block a preview render on a hash that hasn't resolved yet). */
	readonly hashesBySlot: ReadonlyMap<TileSlot, Sha256Hex>;
	/**
	 * `true` when the user actually edited the shared crop this manual
	 * session (numeric fields or the drag guides) — the crop is one value
	 * shared by every source, so a touch marks EVERY source's `origin.crop`
	 * as `'manual'` at once. `false` (the common case: the user only moved a
	 * tile, or never opened Adjust manually) keeps every source's crop
	 * `'auto'`.
	 */
	readonly cropTouched: boolean;
	/**
	 * Slots whose placement (drag/nudge/numeric position/Snap) the user
	 * actually changed this manual session — tracked per slot, independently
	 * of `cropTouched`, so nudging one tile in a multi-source stitch never
	 * marks its neighbors' `origin.transform` as `'manual'` too.
	 */
	readonly transformTouchedSlots: ReadonlySet<TileSlot>;
}

const MISSING_HASH_PLACEHOLDER: Sha256Hex = '0'.repeat(64);

/**
 * Rebuilds a `DraftComposite` from the manual-correction surface's current
 * shared-crop + per-tile-translation editing state, so manual adjustment
 * renders through the exact same `renderPipelineComposite` path the
 * automatic result does (see `pipelineResult.ts`'s module doc: "exactly one
 * path from placements are decided to bytes exist, auto or manual"). Every
 * transform this produces is `translation`-only, matching the legacy
 * editing surface's own capability (drag/nudge/numeric position, no
 * rotate handle) and the "ordinary 2x2 remains an important regression
 * fixture" requirement. Returns null when there is nothing placeable yet
 * (no tiles, or an invalid shared crop) — the caller decides how to
 * surface that rather than this function throwing.
 */
export function buildManualDraftComposite(inputs: ManualDraftInputs): DraftComposite | null {
	const placed = inputs.slots
		.map((slot) => {
			const tile = inputs.tiles[slot];
			const placement = inputs.placements[slot];
			return tile && placement ? { slot, tile, placement } : null;
		})
		.filter((entry): entry is { slot: TileSlot; tile: ManualDraftTile; placement: TilePlacement } => entry !== null);
	if (placed.length === 0) return null;

	const first = placed[0].tile;
	const validation = cropSize(inputs.crop, first.widthPx, first.heightPx);
	if (!validation.ok) return null;

	const rects = placed.map(({ placement }) => tileRect(placement, validation.widthPx, validation.heightPx));
	const union = unionBounds(rects);
	if (!union) return null;
	const { dxPx, dyPx } = translatedOrigin(union);

	const paintOrder = [...placed].sort(
		(a, b) => a.placement.xPx + a.placement.yPx - (b.placement.xPx + b.placement.yPx)
	);
	const paintOrderIndex = new Map<TileSlot, number>(paintOrder.map((entry, index) => [entry.slot, index]));

	const cropRect: SourceCropRect = {
		xPx: inputs.crop.leftPx,
		yPx: inputs.crop.topPx,
		widthPx: validation.widthPx,
		heightPx: validation.heightPx
	};
	const corners = cropCornersOf(cropRect);

	const sources: SourceCapture[] = placed.map(({ slot, tile, placement }) => {
		const transform = translationSourceTransform(placement.xPx + dxPx, placement.yPx + dyPx);
		const origin: SourceCaptureOrigin = {
			crop: inputs.cropTouched ? 'manual' : 'auto',
			transform: inputs.transformTouchedSlots.has(slot) ? 'manual' : 'auto'
		};
		return {
			sourceId: slot,
			fileName: tile.fileName,
			mimeType: tile.mimeType,
			widthPx: tile.widthPx,
			heightPx: tile.heightPx,
			sha256: inputs.hashesBySlot.get(slot) ?? MISSING_HASH_PLACEHOLDER,
			crop: cropRect,
			transform,
			coveragePolygon: corners.map((corner) => applySourceTransform(corner, transform)),
			paintOrder: paintOrderIndex.get(slot)!,
			origin
		};
	});

	return {
		schemaVersion: CURRENT_PROVENANCE_SCHEMA_VERSION,
		renderVersion: CURRENT_RENDER_VERSION,
		outputWidthPx: union.widthPx,
		outputHeightPx: union.heightPx,
		compositingPolicy: sources.length === 1 ? 'single-source-v1' : 'stitch-ascending-bottom-right-v1',
		resampling: 'none',
		sources,
		overlaps: []
	};
}

export interface BadgeFlashAnchorPx {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface BadgeFlashPercent {
	readonly leftPct: number;
	readonly topPct: number;
}

/**
 * Maps a badge-detection anchor box (composite pixel space — the same
 * space the assembled result image is rendered in) to a percentage
 * position of the anchor's *center* within the composite, for an
 * absolutely-positioned marker over a `width:100%` `<img>`. Percentage
 * (not pixel) position is what keeps the flash correctly placed regardless
 * of how large the browser actually displays the composite — the one
 * failure mode ("badge flash drawn in the wrong coordinate space") this
 * function exists to get right. Returns `{0, 0}` for a non-positive output
 * size rather than dividing by zero.
 */
export function badgeFlashPercent(
	anchor: BadgeFlashAnchorPx,
	outputWidthPx: number,
	outputHeightPx: number
): BadgeFlashPercent {
	const centerXPx = anchor.xPx + anchor.widthPx / 2;
	const centerYPx = anchor.yPx + anchor.heightPx / 2;
	return {
		leftPct: outputWidthPx > 0 ? (centerXPx / outputWidthPx) * 100 : 0,
		topPct: outputHeightPx > 0 ? (centerYPx / outputHeightPx) * 100 : 0
	};
}
