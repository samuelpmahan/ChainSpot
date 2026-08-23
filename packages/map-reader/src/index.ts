// Public entry for @chainspot/map-reader.
//
// This file IS the boundary. Everything the app is allowed to see is named
// here; everything else in this package is an implementation detail free to
// change without coordinating with app branches.
//
// Changing what this file exports is a breaking change. tests/surface.test.ts
// snapshots the exported names so any such change shows up as a deliberate,
// reviewable diff rather than a surprise on someone else's branch.

// The detector contract: pixel input, emission output, and nothing else.
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
} from './contract';

// The three-factor map reader.
export {
	assignMeasuredThreeFactor,
	createThreeFactorDetector,
	emitThreeFactorRun,
	insertRecoveredEndpoints,
	measureThreeFactor,
	runThreeFactor,
	threeFactorDetector,
	THREE_FACTOR_ALGO,
	THREE_FACTOR_ALGO_VERSION
} from './threeFactor';

export type {
	AssignmentEvidence,
	BadgeEvidence,
	BasketEvidence,
	RecoveredTeeInput,
	TeeEvidence,
	ThreeFactorAssignment,
	ThreeFactorDetectorParams,
	ThreeFactorMeasurement,
	ThreeFactorParams,
	ThreeFactorRun
} from './threeFactor';
