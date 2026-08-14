import { base } from '$app/paths';
import type { CourseGrammarResult } from './courseGrammar';
import type {
	CalibratedBasketCandidate,
	CalibratedHoleNumberDetection
} from './cvCalibratedDetectors';
import { asUiScalePx } from './cvCalibration';
import type {
	BasketTemplateScale,
	NumberTemplateScale,
	TemplateScale,
	UiScalePx
} from './cvCalibration';
import type {
	TeePadCandidate,
	TeePadStageCounts,
	TeePadVariant,
	TeePadVariantResult
} from './teePadDetection';
import type { LocalSnapKind, LocalSnapPoint } from '../cv/localSnap';
import type { RawObjectMaskResult } from './rawObjectMask';
import type { HoleNumberDetection } from './holeNumberDetection';
import type { P3OwnershipResult } from './rawObjectOwnership';
import type { P4RibbonOwnershipResult } from './p4RibbonOwnership';
import type { P5SparseAssignmentResult } from './p5SparseAssignment';
import type { P6LowParBasketAssignmentResult } from './p6LowParBasketAssignment';

export type BasketCandidate = CalibratedBasketCandidate;

export interface CourseDetectionPerformance {
	readonly totalMs: number;
	/** Ribbon segmentation is computed once per detection pass and shared by P4 and P6.2; always 1 in the pancake path. */
	readonly ribbonSegmentationRuns?: number;
	readonly cachedAtStart: {
		readonly runtime: boolean;
		readonly templatePack: boolean;
	};
	readonly input: {
		readonly sourceWidthPx: number;
		readonly sourceHeightPx: number;
		readonly analysisWidthPx: number;
		readonly analysisHeightPx: number;
		readonly analysisScale: number;
	};
	readonly stages: {
		readonly bootstrapMs: number;
		readonly analysisRasterMs: number;
		readonly numbersMs: number;
		readonly basketsMs: number;
		readonly basketRasterMs: number;
		readonly basketAnchorMs: number;
		readonly basketCandidatesMs: number;
		readonly p1MaskMs: number;
		readonly p2BadgeLabelMs: number;
		readonly p3Ms: number;
		/** Shared ribbon segmentation cost, paid once and reused by P4 and P6.2 — not duplicated into p4Ms/p6Ms. */
		readonly ribbonSegmentationMs?: number;
		readonly p4Ms?: number;
		readonly p5Ms?: number;
		readonly p6Ms?: number;
		readonly teesMs: number;
		readonly teeRasterMs: number;
		readonly teeDetectionMs: number;
		readonly basketFallbackMs: number;
		readonly grammarMs: number;
	};
	readonly counts: {
		readonly numberTemplates: number;
		readonly numberCandidates: number;
		readonly labeledNumbers: number;
		readonly baskets: number;
		readonly tees: number;
		readonly p1MaskTees: number;
		readonly p1MaskBadges: number;
		readonly p1MaskBaskets: number;
		readonly p2LabeledBadges: number;
		readonly p2UniqueLabels: number;
		readonly p3OwnedTees: number;
		readonly p3StraightBasketHits: number;
		readonly p3TeeConflicts: number;
		readonly p3StraightBasketConflicts: number;
		readonly p4ResolvedTees?: number;
		readonly p4AmbiguousTees?: number;
		readonly p4NoRibbonSupportTees?: number;
		readonly p4BasketResolved?: number;
		readonly p4BasketAmbiguous?: number;
		readonly p4NoBasket?: number;
		readonly p4SharedComponents?: number;
		readonly p5AssignedTees?: number;
		readonly p5UnresolvedTees?: number;
		readonly p6LockedByP4?: number;
		readonly p6AssignedByLowPar?: number;
		readonly p6Unresolved?: number;
		readonly basketAnchorScaleEvaluations: number;
		readonly basketFallbackUnresolvedHoles: number;
		readonly basketFallbackRecovered: number;
	};
	readonly calibration: {
		readonly numberTemplateScale: NumberTemplateScale;
		readonly basketTemplateScale: BasketTemplateScale;
		readonly basketTemplateScalePerNumberTemplateScale: number;
	};
}

export interface CourseDetectionResult {
	readonly numberDetection: CalibratedHoleNumberDetection;
	readonly tees: readonly TeePadCandidate[];
	readonly baskets: readonly BasketCandidate[];
	readonly grammar: CourseGrammarResult;
	/** Pancake-1 shadow result: raw physical objects only, no ownership. */
	readonly rawMaskObjects?: RawObjectMaskResult;
	/** Pancake-2 shadow result: labels only the badge bodies P1 supplied. */
	readonly p2BadgeDetection?: HoleNumberDetection;
	/** Pancake-3 shadow result: tee->badge axis ownership + straight-ray basket hits. */
	readonly p3Ownership?: P3OwnershipResult;
	/** Pancake-4 shadow result: ribbon-component candidate elimination and basket membership. */
	readonly p4RibbonOwnership?: P4RibbonOwnershipResult;
	/** Pancake-5 shadow result: sparse one-to-one tee -> labeled-badge assignment. */
	readonly p5SparseAssignment?: P5SparseAssignmentResult;
	/** Pancake-6 shadow result: local LowPar one-to-one basket assignment. */
	readonly p6LowParBasketAssignment?: P6LowParBasketAssignmentResult;
	/** Present on production worker results; optional so existing test fixtures/mocks remain source-compatible. */
	readonly performance?: CourseDetectionPerformance;
}

export type { TeePadVariant, TeePadStageCounts, TeePadVariantResult } from './teePadDetection';
export type {
	BasketTemplateScale,
	NumberTemplateScale,
	TemplateScale,
	UiScalePx
} from './cvCalibration';

/**
 * Transitional public input for a user-supplied UI calibration. Plain numeric
 * CLI/UI values are accepted and immediately branded at the worker boundary,
 * but a TemplateScale is structurally rejected by TypeScript.
 */
type UnbrandedScaleNumber = number & { readonly __brand?: never };
export type UiScaleInput = UiScalePx | UnbrandedScaleNumber;

export interface DetectTeesOptions {
	readonly variants?: readonly TeePadVariant[];
	readonly uiScalePx?: UiScaleInput;
	readonly mapBoundsPx?: Readonly<{ topPx: number; bottomPx: number }>;
	readonly fullResolution?: boolean;
}

export interface DetectTeesResult {
	readonly uiScalePx: UiScalePx;
	readonly results: readonly TeePadVariantResult[];
}

export type CourseDetectionProgressStage =
	| 'opencv'
	| 'baskets'
	| 'templates'
	| 'numbers'
	| 'tees'
	| 'grammar';

export interface CourseDetectionProgress {
	readonly stage: CourseDetectionProgressStage;
	readonly message: string;
	/** Milliseconds elapsed since the detect-course request began. */
	readonly elapsedMs?: number;
}

interface BasketWorkerSuccess {
	ok: true;
	token: string;
	kind: 'detect' | 'detect-course' | 'prewarm' | 'detect-tees' | 'local-snap';
	candidates?: readonly BasketCandidate[];
	course?: CourseDetectionResult;
	uiScalePx?: number;
	results?: readonly TeePadVariantResult[];
	snapped?: LocalSnapPoint | null;
}

interface BasketWorkerProgress {
	ok: true;
	token: string;
	kind: 'progress';
	progress: CourseDetectionProgress;
}

interface BasketWorkerFailure {
	ok: false;
	token: string;
	kind: 'detect' | 'detect-course' | 'prewarm' | 'detect-tees' | 'local-snap';
	message: string;
}

type BasketWorkerReply = BasketWorkerSuccess | BasketWorkerProgress | BasketWorkerFailure;

interface BasketDetectionRequest {
	readonly kind: 'detect' | 'detect-course';
	readonly token: string;
	readonly basePath: string;
	readonly bitmap: ImageBitmap;
	readonly widthPx: number;
	readonly heightPx: number;
}

interface BasketPrewarmRequest {
	readonly kind: 'prewarm';
	readonly token: string;
	readonly basePath: string;
}

interface TeeDetectionRequest {
	readonly kind: 'detect-tees';
	readonly token: string;
	readonly basePath: string;
	readonly bitmap: ImageBitmap;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly variants: readonly TeePadVariant[];
	readonly uiScalePx?: UiScalePx;
	readonly mapBoundsPx?: { topPx: number; bottomPx: number };
	readonly fullResolution?: boolean;
}

interface LocalSnapWorkerRequest {
	readonly kind: 'local-snap';
	readonly token: string;
	readonly basePath: string;
	readonly bitmap: ImageBitmap;
	readonly snapKind: LocalSnapKind;
	readonly clickPx: LocalSnapPoint;
	readonly numberAnchor: { scale: number; widthPx: number; heightPx: number };
}

type BasketWorkerRequest =
	| BasketDetectionRequest
	| BasketPrewarmRequest
	| TeeDetectionRequest
	| LocalSnapWorkerRequest;

interface PendingRequest {
	readonly worker: Worker;
	readonly resolve: (reply: BasketWorkerSuccess | BasketWorkerFailure) => void;
	readonly reject: (reason: Error) => void;
	readonly onProgress?: (progress: CourseDetectionProgress) => void;
}

let activeWorker: Worker | null = null;
let requestSequence = 0;
const pendingRequests = new Map<string, PendingRequest>();
let prewarmWorker: Worker | null = null;
let prewarmPromise: Promise<void> | null = null;

function nextToken(): string {
	requestSequence = (requestSequence + 1) >>> 0;
	return `${Date.now().toString(36)}-${requestSequence.toString(36)}-${Math.random()
		.toString(36)
		.slice(2)}`;
}

function workerErrorMessage(event: ErrorEvent | MessageEvent): string {
	const message = (event as { message?: unknown }).message;
	return typeof message === 'string' && message ? message : 'Basket detection worker failed.';
}

function rejectWorkerRequests(worker: Worker, message: string): void {
	for (const [token, pending] of pendingRequests) {
		if (pending.worker !== worker) continue;
		pendingRequests.delete(token);
		pending.reject(new Error(message));
	}
}

function retireWorker(worker: Worker, message: string): void {
	rejectWorkerRequests(worker, message);
	if (activeWorker !== worker) return;
	activeWorker = null;
	if (prewarmWorker === worker) {
		prewarmWorker = null;
		prewarmPromise = null;
	}
	worker.terminate();
}

function handleWorkerMessage(worker: Worker, event: MessageEvent<BasketWorkerReply>): void {
	const reply = event.data;
	if (!reply || typeof reply.token !== 'string') return;
	const pending = pendingRequests.get(reply.token);
	if (!pending || pending.worker !== worker) return;
	if (reply.ok && reply.kind === 'progress') {
		pending.onProgress?.(reply.progress);
		return;
	}
	pendingRequests.delete(reply.token);
	if (reply.ok) pending.resolve(reply);
	else {
		retireWorker(worker, reply.message);
		pending.reject(new Error(reply.message));
	}
}

function getWorker(): Worker {
	if (activeWorker) return activeWorker;
	const worker = new Worker(new URL('./basketDetection.worker.ts', import.meta.url), { type: 'module' });
	worker.addEventListener('message', (event: MessageEvent<BasketWorkerReply>) => handleWorkerMessage(worker, event));
	worker.addEventListener('error', (event) => retireWorker(worker, workerErrorMessage(event)));
	worker.addEventListener('messageerror', (event) => retireWorker(worker, workerErrorMessage(event)));
	activeWorker = worker;
	return worker;
}

function postToWorker(
	request: BasketWorkerRequest,
	transfer: Transferable[] = [],
	onProgress?: (progress: CourseDetectionProgress) => void
): Promise<BasketWorkerSuccess | BasketWorkerFailure> {
	const worker = getWorker();
	return new Promise((resolve, reject) => {
		pendingRequests.set(request.token, { worker, resolve, reject, onProgress });
		try {
			worker.postMessage(request, transfer);
		} catch (error) {
			pendingRequests.delete(request.token);
			const failure = error instanceof Error ? error : new Error(String(error));
			retireWorker(worker, failure.message);
			reject(failure);
		}
	});
}

function assertWorkerSupport(): void {
	if (typeof Worker === 'undefined') {
		throw new Error('CV detection requires a browser with Web Worker support.');
	}
}

export function prewarmBasketDetection(): Promise<void> {
	assertWorkerSupport();
	const worker = getWorker();
	if (prewarmWorker === worker && prewarmPromise) return prewarmPromise;
	const token = nextToken();
	prewarmWorker = worker;
	const warming = postToWorker({ kind: 'prewarm', token, basePath: base }).then((reply) => {
		if (!reply.ok) throw new Error(reply.message);
		if (reply.kind !== 'prewarm') throw new Error('Basket detection worker returned an invalid prewarm reply.');
	});
	prewarmPromise = warming.catch((error) => {
		if (prewarmWorker === worker) {
			prewarmWorker = null;
			prewarmPromise = null;
		}
		throw error;
	});
	return prewarmPromise;
}

function validDimensions(widthPx: number, heightPx: number): void {
	if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
		throw new Error(`CV detection received invalid image dimensions (${widthPx} × ${heightPx}).`);
	}
}

async function sourceBitmap(bytes: Uint8Array, mimeType: string): Promise<ImageBitmap> {
	if (typeof createImageBitmap === 'undefined') {
		throw new Error('CV detection requires a browser with ImageBitmap support.');
	}
	return createImageBitmap(new Blob([bytes as BufferSource], { type: mimeType }));
}

export async function detectBasketCandidates(
	bytes: Uint8Array,
	mimeType: string,
	widthPx: number,
	heightPx: number
): Promise<readonly BasketCandidate[]> {
	assertWorkerSupport();
	validDimensions(widthPx, heightPx);
	const bitmap = await sourceBitmap(bytes, mimeType);
	const token = nextToken();
	try {
		const reply = await postToWorker(
			{ kind: 'detect', token, basePath: base, bitmap, widthPx, heightPx },
			[bitmap as unknown as Transferable]
		);
		if (!reply.ok) throw new Error(reply.message);
		if (reply.kind !== 'detect' || !reply.candidates) {
			throw new Error('Basket detection worker returned an invalid detection reply.');
		}
		return reply.candidates;
	} catch (error) {
		bitmap.close();
		throw error;
	}
}

export async function detectCourseCandidates(
	bytes: Uint8Array,
	mimeType: string,
	widthPx: number,
	heightPx: number,
	onProgress?: (progress: CourseDetectionProgress) => void
): Promise<CourseDetectionResult> {
	assertWorkerSupport();
	validDimensions(widthPx, heightPx);
	const bitmap = await sourceBitmap(bytes, mimeType);
	const token = nextToken();
	try {
		const reply = await postToWorker(
			{ kind: 'detect-course', token, basePath: base, bitmap, widthPx, heightPx },
			[bitmap as unknown as Transferable],
			onProgress
		);
		if (!reply.ok) throw new Error(reply.message);
		if (reply.kind !== 'detect-course' || !reply.course) {
			throw new Error('Course detection worker returned an invalid detection reply.');
		}
		if (reply.course.performance) {
			console.info('[ChainSpot CV benchmark]', reply.course.performance);
			console.table(reply.course.performance.stages);
		}
		if (reply.course.rawMaskObjects) {
			console.info('[ChainSpot P1 raw-object mask]', reply.course.rawMaskObjects);
			console.table({
				tees: reply.course.rawMaskObjects.tees.length,
				badges: reply.course.rawMaskObjects.badges.length,
				baskets: reply.course.rawMaskObjects.baskets.length,
				ms: reply.course.performance?.stages.p1MaskMs ?? Number.NaN
			});
		}
		if (reply.course.p2BadgeDetection) {
			const labeled = reply.course.p2BadgeDetection.candidates.filter(
				(candidate) => candidate.label !== undefined
			);
			const glyphScores = labeled
				.map((candidate) => candidate.glyphScore)
				.filter((score): score is number => score !== undefined)
				.sort((a, b) => a - b);
			const middle = Math.floor(glyphScores.length / 2);
			const medianGlyphScore = glyphScores.length === 0
				? Number.NaN
				: glyphScores.length % 2 === 0
					? (glyphScores[middle - 1] + glyphScores[middle]) / 2
					: glyphScores[middle];
			console.info('[ChainSpot P2 badge labeling]', {
				labeling: reply.course.p2BadgeDetection.labeling,
				candidates: reply.course.p2BadgeDetection.candidates.map((candidate) => ({
					hole: candidate.label ?? null,
					xPx: candidate.xPx,
					yPx: candidate.yPx,
					glyphScore: candidate.glyphScore ?? null,
					badgeScore: candidate.badgeScore
				}))
			});
			console.table({
				labeled: labeled.length,
				uniqueLabels: new Set(labeled.map((candidate) => candidate.label)).size,
				minGlyphScore: glyphScores[0] ?? Number.NaN,
				medianGlyphScore,
				ms: reply.course.performance?.stages.p2BadgeLabelMs ?? Number.NaN
			});
		}
		if (reply.course.p3Ownership) {
			console.info('[ChainSpot P3 tee/badge/straight-ray ownership]');
			const p3Diagnostics = reply.course.p3Ownership.teeDiagnostics;
			console.table({
				ownedTees: reply.course.p3Ownership.teeBadgeHits.length,
				straightBasketHits: reply.course.p3Ownership.straightBasketHits.length,
				unresolvedTees: reply.course.p3Ownership.unresolvedTeeIndexes.length,
				teeConflicts: reply.course.p3Ownership.teeConflictIndexes.length,
				noBadgeHit: p3Diagnostics.filter((diagnostic) => diagnostic.teeBadgeStatus === 'noBadgeHit').length,
				bidirectionalBadgeConflicts: p3Diagnostics.filter(
					(diagnostic) => diagnostic.teeBadgeStatus === 'bidirectionalBadgeConflict'
				).length,
				sameDirectionTies: p3Diagnostics.filter(
					(diagnostic) => diagnostic.teeBadgeStatus === 'sameDirectionTie'
				).length,
				straightBasketConflicts: reply.course.p3Ownership.straightBasketConflictHoleNumbers.length,
				ms: reply.course.performance?.stages.p3Ms ?? Number.NaN
			});
			console.table(
				reply.course.p3Ownership.teeDiagnostics.map((diagnostic) => ({
					hole: diagnostic.holeNumber ?? (diagnostic.candidateHoleNumbers.join('/') || null),
					candidateHoles: diagnostic.candidateHoleNumbers.join('/') || null,
					teeHole: diagnostic.teeBadgeStatus === 'owned' ? diagnostic.holeNumber ?? null : null,
					teeBadgeStatus: diagnostic.teeBadgeStatus,
					badgeRayDirection: diagnostic.badgeRayDirection ?? null,
					badgeAlongPx: diagnostic.badgeAlongPx ?? null,
					badgeAxisErrorPx: diagnostic.badgeAxisErrorPx ?? null,
					basketHole: diagnostic.straightBasketStatus === 'hit' ? diagnostic.holeNumber ?? null : null,
					straightBasketStatus: diagnostic.straightBasketStatus,
					basketAlongAfterBadgePx: diagnostic.basketAlongAfterBadgePx ?? null,
					basketAxisErrorPx: diagnostic.basketAxisErrorPx ?? null
				}))
			);
		}
		if (reply.course.p4RibbonOwnership) {
			const p4 = reply.course.p4RibbonOwnership;
			console.info('[ChainSpot P4 ribbon ownership]');
			console.table({
				resolvedTees: p4.teeResolutions.filter((resolution) => resolution.status === 'resolved').length,
				ambiguousTees: p4.teeResolutions.filter((resolution) => resolution.status === 'ambiguous').length,
				noRibbonSupportTees: p4.teeResolutions.filter(
					(resolution) => resolution.status === 'noRibbonSupport'
				).length,
				basketResolved: p4.holes.filter((hole) => hole.status === 'basketResolved').length,
				basketAmbiguous: p4.holes.filter((hole) => hole.status === 'basketAmbiguous').length,
				noBasket: p4.holes.filter((hole) => hole.status === 'noBasket').length,
				sharedComponents: p4.sharedComponentLabels.length,
				endpointContactRadiusPx: p4.endpointContactRadiusPx,
				ms: reply.course.performance?.stages.p4Ms ?? Number.NaN
			});
			console.table(
				p4.teeResolutions.flatMap((resolution) =>
					resolution.candidateEvidence.map((evidence) => ({
						hole: evidence.holeNumber,
						teeStatus: resolution.status,
						badgeComponent: evidence.badgeComponentLabel,
						teeContactDistancePx: evidence.teeContactDistancePx,
						touches: evidence.teeTouchesComponent,
						badgeAxisErrorPx: evidence.badgeAxisErrorPx
					}))
				)
			);
			console.table(
				p4.holes.map((hole) => {
					const resolution = p4.teeResolutions.find((candidate) => candidate.teeIndex === hole.teeIndex);
					const resolvedEvidence = resolution?.candidateEvidence.find(
						(evidence) => evidence.holeNumber === hole.holeNumber
					);
					return {
						hole: hole.holeNumber,
						teeHole: hole.teeIndex === undefined ? null : hole.holeNumber,
						teeStatus: resolution?.status ?? 'unresolved',
						candidateBadges: resolution?.candidateHoleNumbers.join('/') ?? null,
						ribbonComponent: hole.ribbonComponentLabel ?? null,
						teeContactDistancePx: resolvedEvidence?.teeContactDistancePx ?? null,
						componentShared: hole.status === 'sharedComponent',
						basketStatus: hole.status,
						basketHole: hole.basketIndexes.length === 0 ? null : hole.holeNumber,
						basketCount: hole.basketIndexes.length,
						basketContactDistancesPx: hole.basketContactDistancesPx
					};
				})
			);
		}
		if (reply.course.p5SparseAssignment) {
			const p5 = reply.course.p5SparseAssignment;
			console.info('[ChainSpot P5 sparse assignment]');
			console.table({
				assignedTees: p5.assignedTees,
				unresolvedTees: p5.unresolvedTees,
				totalAssignmentCost: p5.totalAssignmentCost,
				disallowedAssignmentsRejected: p5.disallowedAssignmentsRejected,
				duplicateBadges: p5.duplicateBadges.join('/') || null,
				perfectMatchingFound: p5.perfectMatchingFound,
				ms: reply.course.performance?.stages.p5Ms ?? Number.NaN
			});
			console.table(
				p5.assignments.map((assignment) => ({
					teeHole: assignment.p4HoleNumber ?? assignment.assignedHoleNumber ?? null,
					p3Candidates: assignment.candidateHoleNumbers.join('/') || null,
					p4Status: assignment.p4Status,
					p4Hole: assignment.p4HoleNumber,
					assignedHole: assignment.assignedHoleNumber,
					assignmentReason: assignment.reason,
					assignedAxisErrorPx: assignment.assignedAxisErrorPx,
					status: assignment.status
				}))
			);
		}
		if (reply.course.p6LowParBasketAssignment) {
			const p6 = reply.course.p6LowParBasketAssignment;
			(globalThis as typeof globalThis & { __chainspotP6?: typeof p6 }).__chainspotP6 = p6;
			console.info('[ChainSpot P6 LowPar basket assignment]');
			console.table({
				lockedByP4: p6.lockedByP4,
				assignedByLowPar: p6.assignedByLowPar,
				unresolved: p6.unresolved,
					duplicateBaskets: p6.duplicateBaskets.join('/') || null,
					disallowedAssignmentsRejected: p6.disallowedAssignmentsRejected,
					totalAssignmentCost: p6.totalAssignmentCost,
					lowParHigherIsBetter: p6.lowParHigherIsBetter,
					forwardGateAngleDeg: p6.forwardGateAngleDeg,
					candidatesBeforeGate: p6.candidatesBeforeGate,
					candidatesAfterGate: p6.candidatesAfterGate,
					gateFallbackHoles: p6.gateFallbackHoles,
					changedHoleNumbers: p6.changedHoleNumbers?.join('/') || null,
					ms: reply.course.performance?.stages.p6Ms ?? Number.NaN
				});
			console.table(
				p6.assignments.map((assignment) => {
					const scores = p6.candidates
						.filter((candidate) => candidate.holeNumber === assignment.holeNumber)
						.map((candidate) => candidate.lowParScore)
						.filter((score): score is number => score !== null && Number.isFinite(score))
						.sort((left, right) => right - left);
					const bestScore = scores[0] ?? null;
					const secondBestScore = scores[1] ?? null;
					const assignedCandidate = p6.candidates.find(
						(candidate) =>
							candidate.holeNumber === assignment.holeNumber &&
							candidate.basketIndex === assignment.assignedBasketIndex
					);
					return {
						hole: assignment.holeNumber,
						teeIndex: assignment.teeIndex,
						p4BasketStatus: assignment.p4BasketStatus,
						p4BasketIndex: assignment.p4BasketIndex,
						candidateBasketCount: assignment.candidateBasketCount,
						candidatesBeforeGate: assignment.candidatesBeforeGate,
						candidatesAfterGate: assignment.candidatesAfterGate,
						bestScore,
						secondBestScore,
						scoreMargin: bestScore !== null && secondBestScore !== null ? bestScore - secondBestScore : null,
						assignedBasketIndex: assignment.assignedBasketIndex,
						assignedRank: assignedCandidate?.rankWithinHole ?? null,
						assignedForwardAngleDeg: assignment.assignedForwardAngleDeg,
						assignmentReason: assignment.assignmentReason,
						lowParScore: assignment.lowParScore,
						status: assignment.status
					};
				})
			);
			if (p6.swapAdjudication) {
				const swap = p6.swapAdjudication;
				console.info('[ChainSpot P6.2 local swap adjudication]');
				console.table({
					pairsConsidered: swap.pairsConsidered,
					swapsApplied: swap.swapsApplied,
					changedHoleNumbers: swap.changedHoleNumbers.join('/') || null,
					ms: swap.ms
				});
				console.table(
					swap.pairs.map((pair) => ({
						holeA: pair.holeA,
						holeB: pair.holeB,
						basketX: pair.basketX,
						basketY: pair.basketY,
						lowParAX: pair.lowParAX,
						lowParAY: pair.lowParAY,
						lowParBX: pair.lowParBX,
						lowParBY: pair.lowParBY,
						ribbonAX: pair.ribbonAX,
						ribbonAY: pair.ribbonAY,
						ribbonBX: pair.ribbonBX,
						ribbonBY: pair.ribbonBY,
						currentRibbonCost: pair.currentRibbonCost,
						swappedRibbonCost: pair.swappedRibbonCost,
						ribbonImprovementPx: pair.ribbonImprovementPx,
						swapApplied: pair.swapApplied
					}))
				);
			}
		}
		return reply.course;
	} catch (error) {
		bitmap.close();
		throw error;
	}
}

export async function detectTees(
	bytes: Uint8Array,
	mimeType: string,
	widthPx: number,
	heightPx: number,
	options: DetectTeesOptions = {}
): Promise<DetectTeesResult> {
	assertWorkerSupport();
	validDimensions(widthPx, heightPx);
	const bitmap = await sourceBitmap(bytes, mimeType);
	const token = nextToken();
	const explicitUiScale =
		options.uiScalePx === undefined
			? undefined
			: asUiScalePx(options.uiScalePx, 'Explicit browser tee UI scale');
	try {
		const reply = await postToWorker(
			{
				kind: 'detect-tees',
				token,
				basePath: base,
				bitmap,
				widthPx,
				heightPx,
				variants: options.variants ?? (['gray-center', 'edge-loop', 'fused'] as const),
				uiScalePx: explicitUiScale,
				mapBoundsPx: options.mapBoundsPx,
				fullResolution: options.fullResolution
			},
			[bitmap as unknown as Transferable]
		);
		if (!reply.ok) throw new Error(reply.message);
		if (reply.kind !== 'detect-tees' || !Number.isFinite(reply.uiScalePx) || !reply.results) {
			throw new Error('Tee detection worker returned an invalid detection reply.');
		}
		return {
			uiScalePx: asUiScalePx(reply.uiScalePx as number, 'Worker tee UI scale'),
			results: reply.results
		};
	} catch (error) {
		bitmap.close();
		throw error;
	}
}

export interface LocalSnapRequestOptions {
	readonly kind: LocalSnapKind;
	readonly clickPx: LocalSnapPoint;
	/** The same number-badge anchor `detectCourse`'s result already carries (`courseDetection.numberDetection.anchor`); the worker re-derives `UiScalePx`/`BasketTemplateScale` from it itself. */
	readonly numberAnchor: { scale: number; widthPx: number; heightPx: number };
}

/**
 * "Snap-to-detection" (see `src/lib/cv/localSnap.ts`'s doc comment for the
 * main-thread-vs-worker choice this makes). Routes through the same
 * `basketDetection.worker.ts` instance every other detection call uses --
 * typically already warm after "Detect course"/"Detect tees" -- rather than
 * loading a second OpenCV WASM runtime on the main thread. Never throws for
 * "nothing found": resolves to `null` exactly like a failed local pass
 * should. Callers on a latency budget (this feature's own wiring included)
 * should not await this before placing the raw click -- see
 * `$lib/components/AnnotationWorkspace.svelte`'s optimistic-placement call site.
 */
export async function requestLocalSnap(
	bytes: Uint8Array,
	mimeType: string,
	options: LocalSnapRequestOptions
): Promise<LocalSnapPoint | null> {
	assertWorkerSupport();
	const bitmap = await sourceBitmap(bytes, mimeType);
	const token = nextToken();
	try {
		const reply = await postToWorker(
			{
				kind: 'local-snap',
				token,
				basePath: base,
				bitmap,
				snapKind: options.kind,
				clickPx: options.clickPx,
				numberAnchor: options.numberAnchor
			},
			[bitmap as unknown as Transferable]
		);
		if (!reply.ok) throw new Error(reply.message);
		if (reply.kind !== 'local-snap') {
			throw new Error('Local snap worker returned an invalid reply.');
		}
		return reply.snapped ?? null;
	} catch (error) {
		bitmap.close();
		throw error;
	}
}
