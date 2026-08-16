/**
 * ChainSpot auto-first source-intake pipeline result contract (CHSPT-55/56).
 *
 * LOCKED CONTRACT — the boundary between the stitch algorithm/renderer
 * (CHSPT-50, `assignN`/`autoCrop`/`render`/`smartStitch.worker.ts` and
 * whatever replaces or extends them) and the Stitch Map UI (CHSPT-56). One
 * entry point, `runStitchPipeline`, covers BOTH N=1 (AutoCrop only) and N>1
 * (AutoCrop + AutoStitch): "Import capture(s)" is one call regardless of
 * count, per CHSPT-55's unified mental model. The UI never talks to the
 * worker, `assignN`, or `proposeCropDetailed` directly — it calls this
 * module's entry points and renders the result.
 *
 * Two-phase shape, mirroring `domain/provenance.ts`'s `DraftComposite` /
 * `CompositeProvenance` split: `runStitchPipeline` determines placement
 * (crop, transform, overlap topology) without touching a canvas and returns
 * a `DraftComposite`; `renderPipelineComposite` actually paints the
 * composite, hashes it, and returns the sealed `CompositeProvenance` the UI
 * hands off or persists. Manual adjustment mutates the draft (via whatever
 * local editing the UI does) and re-renders through the same
 * `renderPipelineComposite` — there is exactly one path from
 * "placements are decided" to "bytes exist", auto or manual.
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

/**
 * `'auto'` — high-confidence placement; the default auto-first flow proceeds
 * straight to the assembled result with no forced review step.
 * `'review'` — usable, but weak/ambiguous evidence exists somewhere (a weak
 * placement edge, low crop confidence, an abstained/incoherent sub-region):
 * the UI still shows this as the best result (never blocks on it) but must
 * visibly surface/open `Adjust manually` rather than leaving it implicit.
 * Generalizes `diagnostics.ts`'s existing `ConfidenceCategory` ('ok'/
 * 'review') to also fold in crop confidence and N=1's lack of any placement
 * evidence at all (a lone capture is always `'auto'` unless its own crop
 * confidence is low).
 */
export type StitchConfidence = 'auto' | 'review';

export interface StitchPipelineWarning {
	/** Same human-readable convention as today's `diagnostics.ts` warning strings — concrete and actionable, never a bare code. */
	readonly message: string;
}

/**
 * One capture's placement before rendering, carrying everything
 * `DraftComposite`'s `SourceCapture` needs plus the original File it came
 * from (not itself part of the durable/serializable contract, so it lives
 * here rather than on `SourceCapture`).
 */
export interface DraftSourceCapture extends SourceCapture {
	readonly file: File;
}

export interface StitchPipelineSuccess {
	readonly confidence: StitchConfidence;
	readonly warnings: readonly string[];
	readonly draft: DraftComposite;
	/** `draft.sources` restated with each source's originating `File` attached, in the same order — the UI's single source of truth for both rendering and per-capture display (filename, thumbnail). */
	readonly sources: readonly DraftSourceCapture[];
}

export type StitchPipelineFailureReason =
	| 'wrong-count'
	| 'duplicate'
	| 'incoherent';

export interface StitchPipelineFailure {
	readonly reason: StitchPipelineFailureReason;
	readonly message: string;
	/** Present only for `reason: 'duplicate'`; indices into the caller's own file list. */
	readonly duplicate?: { readonly firstIndex: number; readonly duplicateIndex: number };
}

export type StitchPipelineResult =
	| { readonly ok: true; readonly result: StitchPipelineSuccess }
	| { readonly ok: false; readonly failure: StitchPipelineFailure };

/**
 * Runs AutoCrop (N=1) or AutoCrop+AutoStitch (N>1) over `files` and returns a
 * placement-ready draft, or a structured failure. Never renders a raster —
 * see `renderPipelineComposite`. `reason: 'incoherent'` is CHSPT-50's
 * "reject/abstain on incoherent cycles rather than forcing a plausible-
 * looking bad stitch": returned only when no defensible global placement
 * exists at all (e.g. a genuinely disconnected overlap graph), which is
 * distinct from `confidence: 'review'` (a placement exists but is weak
 * somewhere).
 */
export type RunStitchPipeline = (
	files: readonly File[],
	options?: { readonly applyCropMargin?: boolean }
) => Promise<StitchPipelineResult>;

/**
 * Renders `draft` (either exactly as `runStitchPipeline` returned it, or
 * after manual placement/crop edits reshaped it) to composite bytes, hashes
 * them, and returns the sealed provenance alongside the rendered blob. The
 * ONLY function in the pipeline that touches a canvas/writes pixels — manual
 * adjustment must route back through this same function rather than
 * maintaining a second rendering path, so auto and manual results are
 * byte-identical for the same draft.
 */
export type RenderPipelineComposite = (
	draft: DraftComposite,
	sources: ReadonlyMap<string /* sourceId */, HTMLImageElement>
) => Promise<{ readonly blob: Blob; readonly provenance: CompositeProvenance }>;

export type { CompositingPolicy, CompositeProvenance, DraftComposite, ResamplingMethod, Sha256Hex, SourceCapture, SourceOverlapEdge };
