/**
 * ChainSpot annotated-round artifact — the contract between Annotate Round
 * (producer) and Create Graphics (consumer).
 *
 * Coordinate space: every point is in ORIGINAL source-image pixels (xPx/yPx),
 * the same authoritative convention as ProjectState and
 * src/lib/alignment/types.ts. A point may be handed straight to
 * applyTransform/transformPoints without translation.
 *
 * PROVENANCE RULE (load-bearing, do not violate): once this artifact crosses
 * the Done boundary every feature is simply authoritative. No
 * `source: 'cv' | 'manual'`, no confidence score, no provisional flag may ever
 * appear on these types. A future annotation-review ticket may track
 * provisional-vs-confirmed state internally while the user is still
 * reviewing; that state must never be carried into this artifact.
 */

import { pointInBounds } from '../coords';
import type { ImageAsset } from './project';

export interface SourcePoint {
	readonly xPx: number;
	readonly yPx: number;
}

/**
 * The UDisc source map the round was annotated on, carried by value so the
 * artifact is self-contained (constructible in a test from a fixture PNG,
 * with no ProjectEditor). Field names/units mirror ImageAsset's intrinsic
 * subset; the project-scoped fields (id, role, sha256, bundlePath) are
 * deliberately absent — they're scoped to one ProjectEditor's asset registry
 * and would be misleading in a portable artifact.
 */
export interface AnnotatedSourceImage {
	readonly fileName: string;
	readonly mimeType: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly blob: Blob;
}

/**
 * One throw's resting position. Array order in AnnotatedHole.shots IS the
 * shot order — no `index` field, so a reorder can never desync from a stored
 * ordinal. `id` is stable identity for future edit tools (add/remove/
 * move/reorder/reassign) and for correlating a transferred feature back to
 * its source. Shot connections (UDisc's pale-blue lines) are implied by
 * tee -> shots -> basket order and are NOT stored as geometry.
 */
export interface OrderedShot {
	readonly id: string;
	readonly landing: SourcePoint;
}

/** Minimum vertex count for a closed `corridor` polygon. */
export const MIN_CORRIDOR_POINTS = 3;
/** Minimum point count for an open tee-to-basket route. */
export const MIN_CENTERLINE_POINTS = 2;

export interface AnnotatedHole {
	readonly id: string;
	readonly number: number;
	readonly tee?: SourcePoint;
	readonly basket?: SourcePoint;
	readonly shots: readonly OrderedShot[];
	/**
	 * The authoritative tee-to-basket routing path as an open polyline in source
	 * image pixels. This is the compact geometry the static-course CV probe now
	 * extracts. Band width/treatment are rendering choices, not source geometry.
	 */
	readonly centerline?: readonly SourcePoint[];
	/**
	 * Legacy/optional fairway outline as a closed polygon (first and last vertex
	 * are implicit ends of the same closed loop — the last point is never
	 * repeated) in source-image pixels. Kept for manually traced projects and
	 * compatibility; new automatic extraction does not need to recover it.
	 */
	readonly corridor?: readonly SourcePoint[];
}

export interface AnnotatedRound {
	readonly sourceImage: AnnotatedSourceImage;
	readonly holes: readonly AnnotatedHole[];
	/** UDisc's purple walking route as one open polyline; absent when not annotated. */
	readonly walkingPath?: readonly SourcePoint[];
}

export interface CreateAnnotatedRoundOptions {
	sourceImage: AnnotatedSourceImage;
	holes?: readonly AnnotatedHole[];
	walkingPath?: readonly SourcePoint[];
}

function assertPositiveDimensions(sourceImage: AnnotatedSourceImage): void {
	const { widthPx, heightPx } = sourceImage;
	if (
		!Number.isFinite(widthPx) ||
		!Number.isFinite(heightPx) ||
		widthPx <= 0 ||
		heightPx <= 0
	) {
		throw new Error(
			`createAnnotatedRound: source image dimensions must be positive finite numbers, got width=${widthPx}, height=${heightPx}`
		);
	}
}

/**
 * Validates a feature point against the source image bounds via the existing
 * `pointInBounds`, which itself rejects non-finite coordinates — so this one
 * check covers both the "finite" and "inside bounds" requirements.
 */
function assertPointInBounds(
	point: SourcePoint,
	widthPx: number,
	heightPx: number,
	context: string
): void {
	if (!pointInBounds(point, widthPx, heightPx)) {
		throw new Error(
			`${context}: point ${JSON.stringify(point)} must be finite and inside the source image bounds (${widthPx} x ${heightPx})`
		);
	}
}

/**
 * The only sanctioned way to build an artifact. Validates the source image
 * has positive finite dimensions and every supplied feature point is finite
 * and inside source bounds. Present centerlines need at least two points and
 * present corridor polygons need at least three.
 */
export function createAnnotatedRound(options: CreateAnnotatedRoundOptions): AnnotatedRound {
	const { sourceImage, holes = [], walkingPath } = options;
	assertPositiveDimensions(sourceImage);
	const { widthPx, heightPx } = sourceImage;

	for (const hole of holes) {
		if (hole.tee) {
			assertPointInBounds(hole.tee, widthPx, heightPx, `createAnnotatedRound: hole ${hole.number} tee`);
		}
		if (hole.basket) {
			assertPointInBounds(
				hole.basket,
				widthPx,
				heightPx,
				`createAnnotatedRound: hole ${hole.number} basket`
			);
		}
		hole.shots.forEach((shot, index) => {
			assertPointInBounds(
				shot.landing,
				widthPx,
				heightPx,
				`createAnnotatedRound: hole ${hole.number} shot ${index + 1} landing`
			);
		});
		if (hole.centerline) {
			if (hole.centerline.length < MIN_CENTERLINE_POINTS) {
				throw new Error(
					`createAnnotatedRound: hole ${hole.number} centerline must have at least ${MIN_CENTERLINE_POINTS} points, got ${hole.centerline.length}`
				);
			}
			hole.centerline.forEach((point, index) => {
				assertPointInBounds(
					point,
					widthPx,
					heightPx,
					`createAnnotatedRound: hole ${hole.number} centerline point ${index + 1}`
				);
			});
		}
		if (hole.corridor) {
			if (hole.corridor.length < MIN_CORRIDOR_POINTS) {
				throw new Error(
					`createAnnotatedRound: hole ${hole.number} corridor must have at least ${MIN_CORRIDOR_POINTS} vertices, got ${hole.corridor.length}`
				);
			}
			hole.corridor.forEach((point, index) => {
				assertPointInBounds(
					point,
					widthPx,
					heightPx,
					`createAnnotatedRound: hole ${hole.number} corridor point ${index + 1}`
				);
			});
		}
	}

	if (walkingPath) {
		walkingPath.forEach((point, index) => {
			assertPointInBounds(
				point,
				widthPx,
				heightPx,
				`createAnnotatedRound: walkingPath[${index}]`
			);
		});
	}

	return { sourceImage, holes, walkingPath };
}

/** Convenience: build the AnnotatedSourceImage half from an existing ImageAsset + its bytes. */
export function annotatedSourceImageFromAsset(
	asset: ImageAsset,
	bytes: Uint8Array
): AnnotatedSourceImage {
	return {
		fileName: asset.fileName,
		mimeType: asset.mimeType,
		widthPx: asset.widthPx,
		heightPx: asset.heightPx,
		blob: new Blob([bytes as BufferSource], { type: asset.mimeType })
	};
}
