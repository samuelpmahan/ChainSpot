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
import type { AnnotatedHole, ImageAsset, OrderedShot, SourcePoint } from './project';

/**
 * The hole types are defined in `./project` (they are durable `ProjectState`
 * data) and re-exported here so this module stays the single import site for
 * anything working with an annotated round.
 */
export type { AnnotatedHole, OrderedShot, SourcePoint };

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
 * has positive finite dimensions and that every supplied feature point
 * (tee/basket/shot landings/corridor bends/walkingPath points) is finite
 * and inside the source image bounds, via the existing pointInBounds from
 * src/lib/coords.ts. Corridor bends are validated per-point (zero bends is a
 * valid straight hole) and the constant corridor width must be finite and
 * positive. Throws on violation — a malformed artifact must never reach
 * Create Graphics.
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
		hole.corridorBends.forEach((point, index) => {
			assertPointInBounds(
				point,
				widthPx,
				heightPx,
				`createAnnotatedRound: hole ${hole.number} corridor bend ${index + 1}`
			);
		});
		if (!Number.isFinite(hole.corridorWidthPx) || hole.corridorWidthPx <= 0) {
			throw new Error(
				`createAnnotatedRound: hole ${hole.number} corridorWidthPx must be a finite number greater than zero, got ${JSON.stringify(hole.corridorWidthPx)}`
			);
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
