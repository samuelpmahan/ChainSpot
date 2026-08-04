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

export interface ProjectState {
	project: ProjectMetadata;
	images: ImageAsset[];
	controlPointPairs: ControlPointPair[];
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
		bundlePath
	} = options;
	return {
		id: id ?? createId(),
		role,
		fileName,
		mimeType,
		widthPx,
		heightPx,
		sha256: sha256 ?? null,
		bundlePath: bundlePath ?? null
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
