// Detector contract — the boundary between the app and any detection
// implementation (in-app worker, LAB process, experimental notebook).
// The LAB codes against THIS file; it never needs the app's tree.
//
// Rules (see docs/cv-orchestration.md):
// - Coordinates are IMAGE-LOCAL pixels of the ORIGINAL (uncropped) image.
// - Emissions are immutable observations; identity resolution happens app-side.
// - Detectors are pure over (pixels, params): same input ⇒ same emissions.

/** Content-addressed image identity: sha256 hex of the original file bytes. */
export type ImageId = string;

/** RGBA pixels, row-major, 4 bytes per pixel — color detectors need color. */
export interface RgbaRaster {
	readonly imageId: ImageId;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly rgba: Uint8ClampedArray;
}

export type UiObjectType =
	| 'hole-badge' // numbered ribbon/chip; `n` required
	| 'basket'
	| 'tee'
	| 'landing-droplet'
	| 'walk-vertex' // ordered along the trace via `seq`
	| 'purple-mass'; // cheap thrown-round classifier signal

export interface UiObjectDetection {
	readonly imageId: ImageId;
	readonly objType: UiObjectType;
	readonly xPx: number;
	readonly yPx: number;
	/** hole number — required for 'hole-badge', optional context otherwise */
	readonly n?: number;
	/** ordering index for 'walk-vertex' */
	readonly seq?: number;
	/** 0..1 */
	readonly confidence: number;
	/** implementation name + version, for caching and LAB diffing */
	readonly algo: string;
	readonly algoVersion: string;
}

/** Streaming callback — your `uiObjectDetected(imgId, objType, pxX, pxY)`. */
export type OnUiObjectDetected = (detection: UiObjectDetection) => void;

/**
 * One detector run over one image. Emit as objects are found (the app renders
 * them live); resolve when finished; reject only on genuine failure.
 */
export type Detector = (image: RgbaRaster, emit: OnUiObjectDetected) => Promise<void>;
