/**
 * ChainSpot auto-first source-intake pipeline result contract (CHSPT-55/56).
 *
 * `runStitchPipeline` covers both N=1 (AutoCrop only) and N>1
 * (AutoCrop+AutoStitch). Rendering remains a separate deterministic phase.
 */

import type {
	CompositingPolicy,
	CompositeProvenance,
	DraftComposite,
	ResamplingMethod,
	Sha256Hex,
	SourceCapture,
	SourceOverlapEdge
} from '../domain/provenance';
import type { SemanticLandmarkBatchResult } from './semanticLandmarks';
import type { SemanticPairDiagnostic } from './poseGraph';

export type StitchConfidence = 'auto' | 'review';

export interface StitchPipelineWarning {
	readonly message: string;
}

export interface DraftSourceCapture extends SourceCapture {
	readonly file: File;
}

/** Measured wall-clock/work slices emitted by the real browser pipeline. */
export interface StitchPipelinePerformance {
	readonly decodeAndHashMs: number;
	readonly cropMs: number;
	readonly semanticLandmarkMs: number;
	readonly opencvWarmMs: number;
	readonly poseMs: number;
	readonly semanticPairSolveMs: number;
	readonly localVerificationMs: number;
	readonly globalFallbackMs: number;
	readonly pathCounts: Readonly<{
		semanticLocalVerify: number;
		semanticDisagreement: number;
		globalFallback: number;
	}>;
}

export interface StitchPipelineSuccess {
	readonly confidence: StitchConfidence;
	readonly warnings: readonly string[];
	readonly draft: DraftComposite;
	readonly sources: readonly DraftSourceCapture[];
	/** Physical source-space badge/basket bodies retained for CHSPT-79 handoff. */
	readonly semanticLandmarks?: SemanticLandmarkBatchResult;
	/** Per unordered pair: semantic support, local verification, disagreement, or fallback. */
	readonly pairDiagnostics?: readonly SemanticPairDiagnostic[];
	readonly performance?: StitchPipelinePerformance;
}

export type StitchPipelineFailureReason =
	| 'wrong-count'
	| 'duplicate'
	| 'incoherent';

export interface StitchPipelineFailure {
	readonly reason: StitchPipelineFailureReason;
	readonly message: string;
	readonly duplicate?: { readonly firstIndex: number; readonly duplicateIndex: number };
}

export type StitchPipelineResult =
	| { readonly ok: true; readonly result: StitchPipelineSuccess }
	| { readonly ok: false; readonly failure: StitchPipelineFailure };

export type RunStitchPipeline = (
	files: readonly File[],
	options?: { readonly applyCropMargin?: boolean }
) => Promise<StitchPipelineResult>;

export type RenderPipelineComposite = (
	draft: DraftComposite,
	sources: ReadonlyMap<string /* sourceId */, HTMLImageElement>
) => Promise<{ readonly blob: Blob; readonly provenance: CompositeProvenance }>;

export type {
	CompositingPolicy,
	CompositeProvenance,
	DraftComposite,
	ResamplingMethod,
	Sha256Hex,
	SourceCapture,
	SourceOverlapEdge
};
