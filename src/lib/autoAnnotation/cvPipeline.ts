/**
 * Stage seam for the Pancake CV pipeline (P1 -> P6.2 -> final display
 * grammar), extracted FAITHFULLY from `basketDetection.worker.ts`'s
 * `PANCAKE_STACK_ONLY` branch. This module owns no browser/worker APIs
 * (no `OffscreenCanvas`, no `self.postMessage`, no `ImageBitmap`) -- the
 * worker still does image decoding/rasterization and hands this module an
 * already-decoded full-resolution RGBA raster.
 *
 * `runPancakePipeline` is called by the worker with `DEFAULT_CV_CONFIG` in
 * production. It is also the delegate a Node-only headless replay harness
 * calls with an arbitrary `ChainSpotCvConfig`, so a Toph-style counterfactual
 * replay can re-execute the exact same pipeline with different parameters
 * and observe each stage as it runs. No `@toph`/Toph imports live here or
 * anywhere in `src/lib` -- trace synthesis from `StageExecutionRecord`s is a
 * concern of the Node harness only.
 */

import { asNumberTemplateScale } from './cvCalibration';
import type { ChainSpotCvConfig } from './cvConfig';
import type { HoleNumberCvModule, HoleNumberTemplate } from './holeNumberDetection';
import { labelKnownHoleNumberBadges } from './holeNumberDetection';
import { buildPancakeDisplayGrammar } from './pancakeCourseDisplay';
import type { P2LabeledBadge } from './rawObjectOwnership';
import { deriveP3Ownership } from './rawObjectOwnership';
import type { RawObjectMaskResult } from './rawObjectMask';
import { detectRawObjectMask } from './rawObjectMask';
import { DEFAULT_RIBBON_MASS_PARAMS, segmentRibbonMass } from './ribbonMass';
import type { RibbonMassSegmentation } from './ribbonMass';
import { deriveP4RibbonOwnership } from './p4RibbonOwnership';
import type { P4RibbonOwnershipResult } from './p4RibbonOwnership';
import { deriveP5SparseAssignment } from './p5SparseAssignment';
import type { P5SparseAssignmentResult } from './p5SparseAssignment';
import { deriveP6GatedSnapshotPhase, deriveP6SwapPhase } from './p6LowParBasketAssignment';
import type { P6LowParBasketAssignmentResult } from './p6LowParBasketAssignment';
import type { HoleNumberDetection } from './holeNumberDetection';
import type { CourseGrammarResult } from './courseGrammar';

/** Canonical stage ids, in execution order. Toph correlates runs by id, never by name/position alone. */
export type CvStageId =
	| 'source'
	| 'p1.rawObjectMask'
	| 'p2.holeNumbers'
	| 'p3.ownership'
	| 'p4.ribbonSegmentation'
	| 'p4.ribbonOwnership'
	| 'p5.sparseAssignment'
	| 'p6.lowParAssignment'
	| 'p6.swapAdjudication'
	| 'final.displayGrammar';

export interface CvStage<I, O, C> {
	readonly id: CvStageId;
	run(input: I, config: C): O | Promise<O>;
}

export type StageSummaryValue = number | string | boolean | null;

export interface StageExecutionRecord {
	readonly id: CvStageId;
	readonly ms: number;
	readonly config: unknown;
	readonly summary: Record<string, StageSummaryValue>;
}

export type PancakeObserver = (record: StageExecutionRecord) => void;

/** Already-decoded full-resolution source raster. Decoding is a worker/browser concern; this module never touches ImageBitmap/OffscreenCanvas. */
export interface PancakeInput {
	readonly cv: HoleNumberCvModule;
	readonly holeNumberTemplates: readonly HoleNumberTemplate[];
	readonly full: {
		readonly rgba: Uint8ClampedArray | Uint8Array;
		readonly widthPx: number;
		readonly heightPx: number;
	};
	/** Time already spent producing `full` (rasterization), recorded verbatim into the `source` stage. */
	readonly fullRasterMs: number;
}

export interface PancakeResult {
	readonly rawMaskObjects: RawObjectMaskResult;
	readonly p2BadgeDetection: HoleNumberDetection;
	readonly p2LabeledBadges: readonly P2LabeledBadge[];
	readonly p3Ownership: ReturnType<typeof deriveP3Ownership>;
	readonly ribbonSegmentation: RibbonMassSegmentation;
	readonly p4RibbonOwnership: P4RibbonOwnershipResult;
	readonly p5SparseAssignment: P5SparseAssignmentResult;
	readonly p6LowParBasketAssignment: P6LowParBasketAssignmentResult;
	readonly grammar: CourseGrammarResult;
	readonly timings: {
		readonly fullRasterMs: number;
		readonly p1MaskMs: number;
		readonly p2BadgeLabelMs: number;
		readonly p3Ms: number;
		readonly ribbonSegmentationMs: number;
		readonly p4Ms: number;
		readonly p5Ms: number;
		readonly p6Ms: number;
	};
	readonly stages: readonly StageExecutionRecord[];
}

function num(value: number): number {
	return Number.isFinite(value) ? value : 0;
}

/**
 * Runs the real Pancake pipeline (P1 through the final display grammar)
 * exactly as `basketDetection.worker.ts`'s `PANCAKE_STACK_ONLY` branch does
 * -- same call order, same arguments, same intermediate shapes -- just
 * extracted so it can run headlessly (Node replay harness) or be observed
 * stage-by-stage (a future counterfactual-replay adapter) without touching
 * the worker's browser-only plumbing.
 */
export async function runPancakePipeline(
	input: PancakeInput,
	config: ChainSpotCvConfig,
	observer?: PancakeObserver
): Promise<PancakeResult> {
	const { cv, holeNumberTemplates, full } = input;
	const stages: StageExecutionRecord[] = [];
	const emit = (record: StageExecutionRecord) => {
		stages.push(record);
		observer?.(record);
	};

	emit({
		id: 'source',
		ms: input.fullRasterMs,
		config: null,
		summary: { widthPx: full.widthPx, heightPx: full.heightPx }
	});

	const p1MaskStartedAt = performance.now();
	const rawMaskObjects = detectRawObjectMask({ rgba: full.rgba, widthPx: full.widthPx, heightPx: full.heightPx });
	const p1MaskMs = performance.now() - p1MaskStartedAt;
	emit({
		id: 'p1.rawObjectMask',
		ms: p1MaskMs,
		config: config.p1,
		summary: {
			tees: rawMaskObjects.tees.length,
			badges: rawMaskObjects.badges.length,
			baskets: rawMaskObjects.baskets.length
		}
	});

	const p2BadgeLabelStartedAt = performance.now();
	const p2BadgeDetectionRaw = labelKnownHoleNumberBadges(
		cv,
		{ format: 'rgba', widthPx: full.widthPx, heightPx: full.heightPx, data: full.rgba as Uint8ClampedArray },
		holeNumberTemplates,
		rawMaskObjects.badges
	);
	const p2BadgeDetection: HoleNumberDetection = {
		...p2BadgeDetectionRaw,
		anchor: p2BadgeDetectionRaw.anchor
			? { ...p2BadgeDetectionRaw.anchor, scale: asNumberTemplateScale(p2BadgeDetectionRaw.anchor.scale) }
			: null,
		candidates: p2BadgeDetectionRaw.candidates.map((candidate) => ({
			...candidate,
			scale: asNumberTemplateScale(candidate.scale)
		}))
	};
	const p2BadgeLabelMs = performance.now() - p2BadgeLabelStartedAt;
	const p2LabeledBadges: P2LabeledBadge[] = p2BadgeDetection.candidates
		.filter((candidate): candidate is typeof candidate & { label: number; glyphScore: number } =>
			candidate.label !== undefined && candidate.glyphScore !== undefined
		)
		.map((candidate) => ({
			holeNumber: candidate.label,
			glyphScore: candidate.glyphScore,
			xPx: candidate.xPx,
			yPx: candidate.yPx,
			widthPx: candidate.widthPx,
			heightPx: candidate.heightPx
		}));
	emit({
		id: 'p2.holeNumbers',
		ms: p2BadgeLabelMs,
		config: config.p2,
		summary: {
			candidates: p2BadgeDetection.candidates.length,
			labeled: p2LabeledBadges.length,
			uniqueLabels: new Set(p2LabeledBadges.map((badge) => badge.holeNumber)).size
		}
	});

	const p3StartedAt = performance.now();
	const p3Ownership = deriveP3Ownership(rawMaskObjects.tees, p2LabeledBadges, rawMaskObjects.baskets);
	const p3Ms = performance.now() - p3StartedAt;
	emit({
		id: 'p3.ownership',
		ms: p3Ms,
		config: config.p3,
		summary: {
			ownedTees: p3Ownership.teeBadgeHits.length,
			straightBasketHits: p3Ownership.straightBasketHits.length,
			teeConflicts: p3Ownership.teeConflictIndexes.length,
			straightBasketConflicts: p3Ownership.straightBasketConflictHoleNumbers.length
		}
	});

	// Ribbon segmentation is the expensive shared input to both P4 and P6.2's
	// ribbon-distance evidence. Run it exactly once and pass the same
	// segmentation object to both -- neither stage segments the raster itself.
	const ribbonSegmentationStartedAt = performance.now();
	const ribbonSegmentation = segmentRibbonMass(
		{ data: full.rgba as Uint8ClampedArray, widthPx: full.widthPx, heightPx: full.heightPx, channels: 4 },
		p2LabeledBadges.map((badge) => ({ xPx: badge.xPx, yPx: badge.yPx })),
		DEFAULT_RIBBON_MASS_PARAMS
	);
	const ribbonSegmentationMs = performance.now() - ribbonSegmentationStartedAt;
	emit({
		id: 'p4.ribbonSegmentation',
		ms: ribbonSegmentationMs,
		config: config.p4,
		summary: { components: ribbonSegmentation.components.length }
	});

	const p4StartedAt = performance.now();
	const p4RibbonOwnership = deriveP4RibbonOwnership(
		ribbonSegmentation,
		rawMaskObjects.tees,
		p2LabeledBadges,
		rawMaskObjects.baskets,
		p3Ownership
	);
	const p4Ms = performance.now() - p4StartedAt;
	emit({
		id: 'p4.ribbonOwnership',
		ms: p4Ms,
		config: config.p4,
		summary: {
			resolvedTees: p4RibbonOwnership.teeResolutions.filter((r) => r.status === 'resolved').length,
			ambiguousTees: p4RibbonOwnership.teeResolutions.filter((r) => r.status === 'ambiguous').length,
			noRibbonSupportTees: p4RibbonOwnership.teeResolutions.filter((r) => r.status === 'noRibbonSupport').length,
			basketResolved: p4RibbonOwnership.holes.filter((h) => h.status === 'basketResolved').length,
			basketAmbiguous: p4RibbonOwnership.holes.filter((h) => h.status === 'basketAmbiguous').length,
			noBasket: p4RibbonOwnership.holes.filter((h) => h.status === 'noBasket').length,
			sharedComponents: p4RibbonOwnership.sharedComponentLabels.length
		}
	});

	const p5StartedAt = performance.now();
	const p5SparseAssignment = deriveP5SparseAssignment(
		rawMaskObjects.tees,
		p2LabeledBadges,
		p3Ownership,
		p4RibbonOwnership
	);
	const p5Ms = performance.now() - p5StartedAt;
	emit({
		id: 'p5.sparseAssignment',
		ms: p5Ms,
		config: config.p5,
		summary: {
			assignedTees: p5SparseAssignment.assignedTees,
			unresolvedTees: p5SparseAssignment.unresolvedTees
		}
	});

	const p6StartedAt = performance.now();
	const { originalP6, gatedP6 } = deriveP6GatedSnapshotPhase(
		{
			data: full.rgba as Uint8ClampedArray,
			widthPx: full.widthPx,
			heightPx: full.heightPx,
			originXPx: 0,
			originYPx: 0,
			scale: 1,
			channels: 4
		},
		rawMaskObjects.tees,
		rawMaskObjects.baskets,
		p2LabeledBadges,
		p5SparseAssignment,
		p4RibbonOwnership,
		config.p6
	);
	const p6SnapshotMs = performance.now() - p6StartedAt;
	emit({
		id: 'p6.lowParAssignment',
		ms: p6SnapshotMs,
		config: config.p6,
		summary: {
			lockedByP4: gatedP6.lockedByP4,
			assignedByLowPar: gatedP6.assignedByLowPar,
			unresolved: gatedP6.unresolved,
			candidatesBeforeGate: gatedP6.candidatesBeforeGate,
			candidatesAfterGate: gatedP6.candidatesAfterGate,
			gateFallbackHoles: gatedP6.gateFallbackHoles
		}
	});

	const p6SwapStartedAt = performance.now();
	const { adjudicatedP6, swapAdjudication } = deriveP6SwapPhase(
		gatedP6,
		ribbonSegmentation,
		rawMaskObjects.baskets,
		p2LabeledBadges,
		config.p6
	);
	const p6SwapMs = performance.now() - p6SwapStartedAt;
	emit({
		id: 'p6.swapAdjudication',
		ms: p6SwapMs,
		config: config.p6.swap,
		summary: {
			pairsConsidered: swapAdjudication.pairsConsidered,
			swapsApplied: swapAdjudication.swapsApplied,
			changedHoleNumbersCount: swapAdjudication.changedHoleNumbers.length
		}
	});

	const p6Ms = p6SnapshotMs + p6SwapMs;
	const p6LowParBasketAssignment: P6LowParBasketAssignmentResult = {
		...adjudicatedP6,
		originalP6,
		changedHoleNumbers: gatedP6.assignments
			.filter((assignment) => {
				const original = originalP6.assignments.find((a) => a.holeNumber === assignment.holeNumber);
				return (
					original?.assignedBasketIndex !== assignment.assignedBasketIndex ||
					original?.status !== assignment.status
				);
			})
			.map((assignment) => assignment.holeNumber)
			.sort((left, right) => left - right),
		swapAdjudication
	};

	const grammar = buildPancakeDisplayGrammar(
		rawMaskObjects,
		p2BadgeDetection,
		p5SparseAssignment,
		p6LowParBasketAssignment
	);
	emit({
		id: 'final.displayGrammar',
		ms: 0,
		config: null,
		summary: { holes: grammar.holes.length }
	});

	return {
		rawMaskObjects,
		p2BadgeDetection,
		p2LabeledBadges,
		p3Ownership,
		ribbonSegmentation,
		p4RibbonOwnership,
		p5SparseAssignment,
		p6LowParBasketAssignment,
		grammar,
		timings: {
			fullRasterMs: num(input.fullRasterMs),
			p1MaskMs: num(p1MaskMs),
			p2BadgeLabelMs: num(p2BadgeLabelMs),
			p3Ms: num(p3Ms),
			ribbonSegmentationMs: num(ribbonSegmentationMs),
			p4Ms: num(p4Ms),
			p5Ms: num(p5Ms),
			p6Ms: num(p6Ms)
		},
		stages
	};
}
