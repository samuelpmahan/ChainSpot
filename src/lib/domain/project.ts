/**
 * ChainSpot project domain model.
 *
 * Terminology (detailed plan section 5):
 * - Image asset: an uploaded raster image with immutable metadata.
 * - Source image: initially the UDisc overview screenshot (role `source-overview`).
 * - Target image: initially the clean basemap (role `target-basemap`).
 * - Control point: one landmark position on one image (`ImagePoint`).
 * - Control-point pair: the source and target points for the same physical landmark.
 * - Image-space coordinate: a coordinate measured in original image pixels (`xPx`, `yPx`);
 *   fractional pixel values are allowed and authoritative.
 * - Normalized coordinate: an image-space coordinate divided by the original width or
 *   height; derived from pixels, never stored in this model.
 * - View transform: pan and zoom used only to display an image; separate from annotations.
 * - Pending pair: a pair with only one side defined; transient editor state, never stored.
 * - Complete pair: a pair with both source and target points defined; the only pair kind
 *   present in durable state.
 *
 * Durable vs transient boundary:
 * Durable project state is `ProjectState`: plain, JSON-serializable data only. Decoded
 * images, file objects, Konva nodes, active tool, selection, pending half-pairs, pointer,
 * hover, drag state, and history cursors are transient editor state and must never be
 * stored in or serialized as project state. The versioned saved document is owned by
 * P0-010 persistence work and wraps this state.
 */

import type { CompositeProvenance } from './provenance';

export type ImageRole = 'source-overview' | 'target-basemap';

export const IMAGE_ROLES: readonly ImageRole[] = ['source-overview', 'target-basemap'];

export function isImageRole(value: unknown): value is ImageRole {
	return IMAGE_ROLES.includes(value as ImageRole);
}

export interface ProjectMetadata {
	readonly id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
}

export interface ImageAsset {
	readonly id: string;
	role: ImageRole;
	fileName: string;
	mimeType: string;
	widthPx: number;
	heightPx: number;
	sha256: string | null;
	bundlePath: string | null;
	/**
	 * How this image's exact pixels were derived from original capture(s) (CHSPT-49/55).
	 * Non-null only for a `source-overview` image that went through AutoCrop/AutoStitch;
	 * always absent on `target-basemap` (never composited by that pipeline) and on a
	 * `source-overview` image that was uploaded directly with no stitch pipeline run.
	 * `null` and absent (omitted key) both mean "no provenance" and are normalized to the
	 * same absent representation on schema read/write (see `projectSchema.ts`), the same
	 * "no ambiguity between undefined and empty" convention `walkingPath` already uses.
	 */
	provenance?: CompositeProvenance | null;
}

export interface ImagePoint {
	readonly imageId: string;
	xPx: number;
	yPx: number;
}

export interface ControlPointPair {
	readonly id: string;
	ordinal: number;
	label: string | null;
	enabled: boolean;
	source: ImagePoint;
	target: ImagePoint;
	createdAt: string;
	updatedAt: string;
}

export interface ViewTransformState {
	zoom: number;
	panX: number;
	panY: number;
}

export interface ProjectViewState {
	source: ViewTransformState;
	target: ViewTransformState;
}

/**
 * Hole-annotation types live here, in the domain root, rather than in
 * `annotatedRound.ts` (which re-exports them): `ProjectState` holds holes as
 * durable data, and `annotatedRound.ts` already imports from this module, so
 * defining them there and importing here would be a cycle.
 *
 * Coordinate space: every hole point is in ORIGINAL source-image pixels, the
 * same authoritative convention as `ImagePoint.xPx/yPx`. Unlike `ImagePoint`
 * these carry no `imageId` — a hole always belongs to the `source-overview`
 * image, so the reference is structural rather than stored.
 */
export interface SourcePoint {
	readonly xPx: number;
	readonly yPx: number;
}

/**
 * One throw's resting position. Array order in `AnnotatedHole.shots` IS the
 * shot order — no `index` field, so a reorder can never desync from a stored
 * ordinal.
 */
export interface OrderedShot {
	readonly id: string;
	readonly landing: SourcePoint;
}

export interface AnnotatedHole {
	readonly id: string;
	readonly number: number;
	/** Scorecard par, when known. Absent, never a placeholder like 0 or -1. */
	readonly par?: number;
	readonly tee?: SourcePoint;
	readonly basket?: SourcePoint;
	readonly shots: readonly OrderedShot[];
	/**
	 * Corridor bend points in source-image pixels. Together with `tee` and
	 * `basket` they form the hole's centerline: [tee, ...corridorBends, basket].
	 * Zero bends is a valid straight hole; tee/basket are never duplicated here.
	 */
	readonly corridorBends: readonly SourcePoint[];
	/** Constant corridor width in source-image pixels; always persisted. */
	readonly corridorWidthPx: number;
}

/**
 * One resolved hole-number badge position, captured from CV course detection
 * (`CourseHoleProposal.numberBadge` in `autoAnnotation/courseGrammar.ts`)
 * alongside `holes`. This lives as its own top-level `ProjectState` array,
 * never inside `AnnotatedHole`/`AnnotatedRound`: badge geometry is course-shape
 * signature input (see `courseSignature.ts`), not round annotation, and the
 * "Done boundary" purity rule for `AnnotatedRound` forbids provisional/CV
 * metadata (like `confidence`) on that artifact. Coordinates are in
 * `source-overview` image pixels, the same convention as `SourcePoint`.
 */
export interface HoleNumberBadgeAnchor {
	readonly number: number;
	readonly xPx: number;
	readonly yPx: number;
	/** Detector/glyph-assignment confidence (0..1); signature-quality input only, never authoritative. */
	readonly confidence: number;
}

export interface ProjectState {
	project: ProjectMetadata;
	images: ImageAsset[];
	controlPointPairs: ControlPointPair[];
	/** Hole annotations against the `source-overview` image; empty until annotated. */
	holes: AnnotatedHole[];
	/** Hole-number badge anchors from CV detection; empty until detected. Course-signature input only — see `HoleNumberBadgeAnchor`. */
	numberBadges: HoleNumberBadgeAnchor[];
	/** UDisc's purple walking route as one open polyline; absent when not annotated. */
	readonly walkingPath?: readonly SourcePoint[];
	viewState: ProjectViewState | null;
}

export interface PointCoordinates {
	xPx: number;
	yPx: number;
}

export interface CreateProjectStateOptions {
	name?: string;
	createId?: () => string;
	now?: () => Date;
}

export interface CreateImageAssetOptions {
	role: ImageRole;
	fileName: string;
	mimeType: string;
	widthPx: number;
	heightPx: number;
	sha256?: string | null;
	bundlePath?: string | null;
	/** Omitted (the default) leaves the asset with no `provenance` key at all; `null` normalizes to the same absent state. */
	provenance?: CompositeProvenance | null;
	id?: string;
	createId?: () => string;
}

export interface CreateControlPointPairOptions {
	sourceImage: ImageAsset;
	targetImage: ImageAsset;
	sourceCoordinates: PointCoordinates;
	targetCoordinates: PointCoordinates;
	ordinal: number;
	label?: string | null;
	enabled?: boolean;
	id?: string;
	createId?: () => string;
	now?: () => Date;
}

function defaultCreateId(): string {
	return globalThis.crypto.randomUUID();
}

function defaultNow(): Date {
	return new Date();
}

export function createProjectState(options: CreateProjectStateOptions = {}): ProjectState {
	const { name = 'Untitled Project', createId = defaultCreateId, now = defaultNow } = options;
	const timestamp = now().toISOString();
	return {
		project: { id: createId(), name, createdAt: timestamp, updatedAt: timestamp },
		images: [],
		controlPointPairs: [],
		holes: [],
		numberBadges: [],
		viewState: null
	};
}

export function createImageAsset(options: CreateImageAssetOptions): ImageAsset {
	const {
		id,
		createId = defaultCreateId,
		role,
		fileName,
		mimeType,
		widthPx,
		heightPx,
		sha256,
		bundlePath,
		provenance
	} = options;
	return {
		id: id ?? createId(),
		role,
		fileName,
		mimeType,
		widthPx,
		heightPx,
		sha256: sha256 ?? null,
		bundlePath: bundlePath ?? null,
		// `provenance` stays entirely absent (no key) unless explicitly supplied with a
		// real value — an omitted or explicit-`null` option both normalize to "no key",
		// the one-representation-of-absent rule this field's own doc describes. A caller
		// that never mentions it (every existing call site) sees no behavior change,
		// matching the additive-only requirement for this field.
		...(provenance != null ? { provenance } : {})
	};
}

export function createControlPointPair(options: CreateControlPointPairOptions): ControlPointPair {
	const { sourceImage, targetImage, sourceCoordinates, targetCoordinates } = options;
	if (sourceImage.role !== 'source-overview') {
		throw new Error(
			`createControlPointPair: source image has role '${sourceImage.role}', expected 'source-overview'`
		);
	}
	if (targetImage.role !== 'target-basemap') {
		throw new Error(
			`createControlPointPair: target image has role '${targetImage.role}', expected 'target-basemap'`
		);
	}
	const {
		ordinal,
		label = null,
		enabled = true,
		id,
		createId = defaultCreateId,
		now = defaultNow
	} = options;
	const timestamp = now().toISOString();
	return {
		id: id ?? createId(),
		ordinal,
		label,
		enabled,
		source: {
			imageId: sourceImage.id,
			xPx: sourceCoordinates.xPx,
			yPx: sourceCoordinates.yPx
		},
		target: {
			imageId: targetImage.id,
			xPx: targetCoordinates.xPx,
			yPx: targetCoordinates.yPx
		},
		createdAt: timestamp,
		updatedAt: timestamp
	};
}

export function findImageByRole(
	images: readonly ImageAsset[],
	role: ImageRole
): ImageAsset | undefined {
	return images.find((image) => image.role === role);
}
