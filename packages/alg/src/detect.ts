// Detector contract — the boundary between the app and any detection
// implementation (in-app worker, LAB process, experimental notebook).
// The LAB codes against THIS file; it never needs the app's tree.
//
// Rules (see docs/cv-orchestration.md):
// - Coordinates are IMAGE-LOCAL pixels of the ORIGINAL (uncropped) image.
// - Emissions are immutable observations; identity resolution happens app-side.
// - Detectors are pure over (pixels, params): same input ⇒ same emissions.
//
// Three separable jobs, three event kinds on one channel:
//   'object'      — something IS at (x, y): badge, basket, tee, droplet…
//   'label'       — that badge reads "7" (with candidates when unsure)
//   'association' — that badge belongs to that basket/tee/path
// A detector may emit any subset; later passes may emit labels/associations
// for detIds produced by an earlier pass over the same image.

/** Content-addressed image identity: sha256 hex of the original file bytes. */
export type ImageId = string;

/** Detection identity, unique within (imageId, algo): e.g. "badge-3". */
export type DetId = string;

/** RGBA pixels, row-major, 4 bytes per pixel — color detectors need color. */
export interface RgbaRaster {
	readonly imageId: ImageId;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly rgba: Uint8ClampedArray;
}

export type UiObjectType =
	| 'hole-badge'
	| 'basket'
	| 'tee'
	| 'landing-droplet'
	| 'walk-vertex' // ordered along the trace via `seq`
	| 'purple-mass'; // cheap thrown-round classifier signal

interface EmissionBase {
	readonly imageId: ImageId;
	/** 0..1 */
	readonly confidence: number;
	/** implementation name + version, for caching and LAB diffing */
	readonly algo: string;
	readonly algoVersion: string;
	/**
	 * sha256 of the resolved engine config that produced this emission —
	 * the cache/replay key third leg (imageId, algo+version, paramsHash).
	 */
	readonly paramsHash?: string;
}

/** "Something is at (x, y)." No semantics beyond its type. */
export interface UiObjectDetected extends EmissionBase {
	readonly kind: 'object';
	readonly detId: DetId;
	readonly objType: UiObjectType;
	readonly xPx: number;
	readonly yPx: number;
	/** ordering index for 'walk-vertex' */
	readonly seq?: number;
}

/** "That detection reads as hole number N." Candidates when the glyph is ambiguous. */
export interface UiLabelRead extends EmissionBase {
	readonly kind: 'label';
	readonly detId: DetId;
	readonly n: number;
	/** alternates, best-first, when confidence is shared around */
	readonly candidates?: readonly { n: number; confidence: number }[];
}

/** "Those two detections belong together" (badge↔basket, tee↔path, …). */
export interface UiAssociation extends EmissionBase {
	readonly kind: 'association';
	readonly fromDetId: DetId;
	readonly toDetId: DetId;
	readonly relation: 'badge-of' | 'tee-of' | 'basket-of' | 'on-path';
	/** alternates, best-first */
	readonly candidates?: readonly { toDetId: DetId; confidence: number }[];
}

/**
 * "This IMAGE, as a whole, has trait X" — e.g. it is the thrown round
 * (walk trace + droplets present). `confidence` carries the score; the app
 * compares across the session's images and picks the argmax, so emit a
 * calibrated-ish score even when unsure rather than staying silent.
 */
export interface UiClassification extends EmissionBase {
	readonly kind: 'classification';
	readonly trait: 'thrown-round';
}

/**
 * "Hole N's tee/badge/basket triple is self-consistent — pre-approved."
 * Emitted by the CV service when a bendless hole's collinearity divergence
 * (see detectors/strongHole.ts) is within the strong gate. The app
 * auto-accepts these holes in GuidedReview; they never enter the queue as
 * pending. The DECISION lives here, algorithm-side — the app only obeys.
 */
export interface UiStrongHole extends EmissionBase {
	readonly kind: 'strong-hole';
	readonly n: number;
	/** RMSE of perpendicular offsets / tee->basket length (0.015 = 1.5%) */
	readonly divergence: number;
}

export type DetectorEmission =
	| UiObjectDetected
	| UiLabelRead
	| UiAssociation
	| UiClassification
	| UiStrongHole;

export type OnDetectorEmission = (emission: DetectorEmission) => void;

/**
 * One detector run over one image. Emit as things are found (the app renders
 * them live); resolve when finished; reject only on genuine failure.
 */
export type Detector = (image: RgbaRaster, emit: OnDetectorEmission) => Promise<void>;
