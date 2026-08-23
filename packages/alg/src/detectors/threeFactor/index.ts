import type {
	Detector,
	OnDetectorEmission,
	RgbaRaster,
	UiAssociation,
	UiLabelRead,
	UiObjectDetected
} from '../../detect';
import { assignThreeFactor } from './assignment';
import { runEngine } from './engine';
import type { ResolvedConfig } from './config';
import type { RunTrace } from './features/types';
import { measureThreeFactor as measureStage } from './measure';
import {
	THREE_FACTOR_ALGO,
	THREE_FACTOR_ALGO_VERSION,
	type AssignmentEvidence,
	type BadgeEvidence,
	type RecoveredTeeInput,
	type TeeEvidence,
	type ThreeFactorAssignment,
	type ThreeFactorMeasurement,
	type ThreeFactorParams,
	type BasketEvidence,
	type RgbaImage
} from './types';

export { THREE_FACTOR_ALGO, THREE_FACTOR_ALGO_VERSION } from './types';
export type {
	AssignmentEvidence,
	BadgeEvidence,
	BasketEvidence,
	RecoveredTeeInput,
	TeeEvidence,
	ThreeFactorAssignment,
	ThreeFactorMeasurement,
	ThreeFactorParams
} from './types';

export interface ThreeFactorDetectorParams extends ThreeFactorParams {
	readonly recoveredTees?: readonly RecoveredTeeInput[];
	/** resolved engine config; omit for frozen defaults (no trace collected) */
	readonly config?: ResolvedConfig;
	/** sha256 of the resolved config's canonical JSON — caller-computed */
	readonly paramsHash?: string;
}

export interface ThreeFactorRun {
	readonly imageId: string;
	readonly measurement: ThreeFactorMeasurement;
	readonly assignment: ThreeFactorAssignment;
	readonly trace?: RunTrace;
	readonly paramsHash?: string;
}

function clamp01(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function toStageImage(image: RgbaRaster): RgbaImage {
	if (!Number.isInteger(image.widthPx) || image.widthPx <= 0)
		throw new RangeError('widthPx must be a positive integer');
	if (!Number.isInteger(image.heightPx) || image.heightPx <= 0)
		throw new RangeError('heightPx must be a positive integer');
	if (image.rgba.length !== image.widthPx * image.heightPx * 4)
		throw new RangeError('rgba length does not match image dimensions');
	return { width: image.widthPx, height: image.heightPx, data: image.rgba };
}

function validateParams(params: ThreeFactorDetectorParams): void {
	const viewport = params.viewport;
	if (!viewport) return;
	if (!Number.isInteger(viewport.topPx) || viewport.topPx < 0)
		throw new RangeError('viewport.topPx must be a non-negative integer');
	if (!Number.isInteger(viewport.bottomPx) || viewport.bottomPx < viewport.topPx)
		throw new RangeError('viewport.bottomPx must be an integer >= topPx');
}

/** Raw stage output. It preserves every primitive measurement for parity/debugging. */
export function measureThreeFactor(
	image: RgbaRaster,
	params: ThreeFactorParams = {}
): ThreeFactorMeasurement {
	const stageImage = toStageImage(image);
	validateParams(params);
	return measureStage(stageImage, params);
}

/** Explicit assignment seam: recovered/manual tees are inserted before pairing. */
export function insertRecoveredEndpoints(
	measurement: ThreeFactorMeasurement,
	recoveredTees: readonly RecoveredTeeInput[] = []
): ThreeFactorAssignment {
	return assignThreeFactor(measurement, recoveredTees);
}

export const assignMeasuredThreeFactor = insertRecoveredEndpoints;

export function runThreeFactor(
	image: RgbaRaster,
	params: ThreeFactorDetectorParams = {}
): ThreeFactorRun {
	const stageImage = toStageImage(image);
	validateParams(params);
	const { config, paramsHash, recoveredTees, ...stageParams } = params;
	const result = runEngine(stageImage, stageParams, recoveredTees ?? [], config, paramsHash);
	return {
		imageId: image.imageId,
		measurement: result.measurement,
		assignment: result.assignment,
		...(result.trace ? { trace: result.trace } : {}),
		...(paramsHash ? { paramsHash } : {})
	};
}

export { DEFAULT_EXECUTION, ENGINE_UNITS } from './engine';
export { parseConfig, resolveConfig, validateExecution, type ResolvedConfig, type ThreeFactorConfig } from './config';
export { canonicalJson, sha256Hex } from './hash';
export type { RunTrace, Drawable, UnitTrace } from './features/types';

function badgeConfidence(badge: BadgeEvidence): number {
	return clamp01(badge.confidence);
}

function basketConfidence(basket: BasketEvidence): number {
	return clamp01(basket.score);
}

function teeConfidence(tee: TeeEvidence): number {
	if (tee.tier === 'ring') return clamp01(tee.ring?.ringFrac ?? 0);
	if (tee.tier === 'component') return clamp01(tee.fill);
	return clamp01(tee.recovery?.score ?? 0.5);
}

function objectEmission(
	image: RgbaRaster,
	detId: string,
	objType: UiObjectDetected['objType'],
	xPx: number,
	yPx: number,
	confidence: number
): UiObjectDetected {
	return {
		kind: 'object',
		imageId: image.imageId,
		algo: THREE_FACTOR_ALGO,
		algoVersion: THREE_FACTOR_ALGO_VERSION,
		detId,
		objType,
		xPx,
		yPx,
		confidence: clamp01(confidence)
	};
}

function labelEmission(image: RgbaRaster, badge: BadgeEvidence): UiLabelRead | null {
	if (badge.label === null) return null;
	const n = Number(badge.label);
	if (!Number.isInteger(n) || n <= 0) return null;
	const selected = badge.labelCandidates.find((candidate) => candidate.label === n);
	const candidates = badge.labelCandidates
		.filter(
			(candidate) =>
				Number.isInteger(candidate.label) && candidate.label > 0 && candidate.label !== n
		)
		.map((candidate) => ({ n: candidate.label, confidence: clamp01(candidate.confidence) }));
	candidates.sort((a, b) => b.confidence - a.confidence || a.n - b.n);
	return {
		kind: 'label',
		imageId: image.imageId,
		algo: THREE_FACTOR_ALGO,
		algoVersion: THREE_FACTOR_ALGO_VERSION,
		detId: badge.detId,
		n,
		confidence: clamp01(selected?.confidence ?? badge.confidence),
		...(candidates.length ? { candidates } : {})
	};
}

function associationEmission(
	image: RgbaRaster,
	fromDetId: string,
	toDetId: string,
	relation: UiAssociation['relation'],
	confidence: number
): UiAssociation {
	return {
		kind: 'association',
		imageId: image.imageId,
		algo: THREE_FACTOR_ALGO,
		algoVersion: THREE_FACTOR_ALGO_VERSION,
		fromDetId,
		toDetId,
		relation,
		confidence: clamp01(confidence)
	};
}

function emitMeasurementObjects(
	image: RgbaRaster,
	measurement: ThreeFactorMeasurement,
	tees: readonly TeeEvidence[],
	emit: OnDetectorEmission
): void {
	for (const badge of [...measurement.badges].sort((a, b) => a.detId.localeCompare(b.detId))) {
		emit(
			objectEmission(
				image,
				badge.detId,
				'hole-badge',
				badge.cxPx,
				badge.cyPx,
				badgeConfidence(badge)
			)
		);
		const label = labelEmission(image, badge);
		if (label) emit(label);
	}
	for (const basket of [...measurement.baskets].sort((a, b) => a.detId.localeCompare(b.detId))) {
		emit(
			objectEmission(
				image,
				basket.detId,
				'basket',
				basket.tipXPx,
				basket.tipYPx,
				basketConfidence(basket)
			)
		);
	}
	for (const tee of [...tees].sort((a, b) => a.detId.localeCompare(b.detId))) {
		emit(objectEmission(image, tee.detId, 'tee', tee.xPx, tee.yPx, teeConfidence(tee)));
	}
}

function emitAssignmentAssociations(
	image: RgbaRaster,
	assignments: readonly AssignmentEvidence[],
	emit: OnDetectorEmission
): void {
	for (const assignment of [...assignments].sort((a, b) => a.badgeId.localeCompare(b.badgeId))) {
		const confidence = clamp01(assignment.score);
		// The endpoint points to the badge that owns the selected triple. Keeping
		// the two relations separate preserves the contract's pairwise event shape.
		emit(associationEmission(image, assignment.teeId, assignment.badgeId, 'tee-of', confidence));
		emit(
			associationEmission(image, assignment.basketId, assignment.badgeId, 'basket-of', confidence)
		);
	}
}

export function emitThreeFactorRun(
	image: RgbaRaster,
	run: ThreeFactorRun,
	emit: OnDetectorEmission
): void {
	// stamp paramsHash on every emission when the run carries one
	const stamped: OnDetectorEmission = run.paramsHash
		? (emission) => emit({ ...emission, paramsHash: run.paramsHash })
		: emit;
	emitMeasurementObjects(image, run.measurement, run.assignment.tees, stamped);
	emitAssignmentAssociations(image, run.assignment.assignments, stamped);
}

export function createThreeFactorDetector(params: ThreeFactorDetectorParams = {}): Detector {
	return async (image, emit): Promise<void> => {
		const run = runThreeFactor(image, params);
		emitThreeFactorRun(image, run, emit);
	};
}

export const threeFactorDetector: Detector = createThreeFactorDetector();

export default threeFactorDetector;
