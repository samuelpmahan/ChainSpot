// The detector contract now lives in @chainspot/map-reader, which owns both the
// algorithm and the LAB that develops it. This file is a re-export so app code
// can keep importing `$lib/detect`, and so the app has exactly one place where
// it reaches across the package boundary.
//
// Add nothing here. A new type that detectors emit belongs in the package's
// contract (packages/map-reader/src/contract.ts), where the LAB can see it.
export type {
	DetId,
	Detector,
	DetectorEmission,
	ImageId,
	OnDetectorEmission,
	RgbaRaster,
	UiAssociation,
	UiClassification,
	UiLabelRead,
	UiObjectDetected,
	UiObjectType,
	UiStrongHole
} from '@chainspot/map-reader';
