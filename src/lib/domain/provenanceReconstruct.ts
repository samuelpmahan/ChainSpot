/**
 * ChainSpot deterministic provenance reconstruction & hash verification (CHSPT-49/55).
 *
 * This module makes CHSPT-49's core acceptance requirement testable and real: given a
 * `CompositeProvenance`, the exact bytes of every original capture it references, a
 * decode function, and an injected renderer, it reconstructs the composite raster from
 * provenance + original bytes ALONE (no CV rerun, no re-detecting crops/placements) and
 * verifies the result's SHA-256 against `finalRasterSha256`.
 *
 * INJECTED RENDERER: `renderPipelineComposite` (`src/lib/stitch/pipelineResult.ts`,
 * Agent B's locked-contract boundary) is not implemented here — this module accepts a
 * function shaped exactly like it (`ReconstructRenderComposite`, re-exporting that
 * module's own `RenderPipelineComposite` type rather than redefining an equivalent shape)
 * as a parameter, the same "inject the boundary" convention `StitchRenderEnv` and
 * `DecodeImageFile` already use elsewhere in this codebase. Whatever renderer is wired at
 * call time is trusted to honor `domain/provenance.ts`'s deterministic-resampling
 * constraint (hand-written pixel sampler for anything beyond pure integer translation) —
 * this module does not and cannot re-verify that guarantee itself, only that the bytes it
 * receives back hash to what provenance claims.
 *
 * FAIL LOUDLY vs. REPORTABLE OUTCOME: structurally incoherent provenance (a coverage
 * polygon that doesn't match `transform(crop)`, a non-permutation `paintOrder`, an
 * overlap edge naming an unknown source) is a bug, not a legitimate runtime outcome —
 * `assertCoherentProvenance` runs first and THROWS before any reconstruction is
 * attempted. A hash mismatch after a successful, coherent reconstruction is the opposite:
 * an expected, reportable outcome (the original bytes were altered, or reconstruction
 * genuinely cannot reproduce the recorded raster), so it is returned as a structured
 * `{ ok: false, reason: 'hash-mismatch', ... }`, never thrown.
 */

import { assertCoherentProvenance } from './provenance';
import type { CompositeProvenance, DraftComposite, Sha256Hex } from './provenance';
import type { RenderPipelineComposite } from '../stitch/pipelineResult';
import type { DecodeImageFile } from '../imageIntake';
import { sha256Hex } from '../imageIntake';
import type { HashBytes } from '../imageIntake';

/** Re-exported so callers of this module don't also need to import `stitch/pipelineResult.ts` directly just to name the type. */
export type ReconstructRenderComposite = RenderPipelineComposite;

export type ReconstructProvenanceFailureReason =
	| 'missing-source-bytes'
	| 'decode-failure'
	| 'render-failure'
	| 'hash-mismatch';

export type ReconstructProvenanceResult =
	| { readonly ok: true; readonly blob: Blob; readonly actualSha256: Sha256Hex }
	| {
			readonly ok: false;
			readonly reason: ReconstructProvenanceFailureReason;
			readonly message: string;
			readonly expectedSha256?: Sha256Hex;
			readonly actualSha256?: Sha256Hex;
	  };

export interface ReconstructProvenanceOptions {
	readonly provenance: CompositeProvenance;
	/** Original, unmodified capture bytes keyed by `SourceCapture.sourceId` — exactly what `ProjectEditor.setSourceCaptureBytes`/`persistence.ts` retain. */
	readonly sourceBytes: ReadonlyMap<string, Uint8Array>;
	readonly decode: DecodeImageFile;
	readonly render: ReconstructRenderComposite;
	/** Injectable SHA-256; defaults to native Web Crypto, same as the rest of the codebase. */
	readonly hash?: HashBytes;
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
	return new Uint8Array(await blob.arrayBuffer());
}

/** `CompositeProvenance` minus the not-yet-known-until-rendered `finalRasterSha256`, i.e. exactly what a renderer's `draft` parameter expects (see `domain/provenance.ts`'s `DraftComposite`). */
function draftOf(provenance: CompositeProvenance): DraftComposite {
	const { finalRasterSha256: _finalRasterSha256, ...draft } = provenance;
	return draft;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Reconstructs `options.provenance`'s composite from original capture bytes alone and
 * verifies the result's hash. `assertCoherentProvenance` runs first and throws (fail
 * loudly) on structurally incoherent provenance; every other failure — missing bytes, a
 * decode error, a renderer error, or a legitimate hash mismatch (either an original
 * capture's bytes no longer match their recorded hash, or the reconstructed raster
 * doesn't match `finalRasterSha256`) — is returned as a structured, non-throwing result.
 */
export async function reconstructProvenance(
	options: ReconstructProvenanceOptions
): Promise<ReconstructProvenanceResult> {
	const { provenance, sourceBytes, decode, render, hash = sha256Hex } = options;

	// Fail loudly on structurally incoherent provenance before attempting anything else.
	assertCoherentProvenance(provenance);

	const missing = provenance.sources.filter((source) => !sourceBytes.has(source.sourceId));
	if (missing.length > 0) {
		return {
			ok: false,
			reason: 'missing-source-bytes',
			message: `Missing original capture bytes for source(s): ${missing.map((source) => source.sourceId).join(', ')}.`
		};
	}

	// Verify every original capture's bytes against its recorded hash BEFORE decoding or
	// rendering: if the bytes we have don't match what provenance says they are, no
	// reconstruction attempt built from them could legitimately reproduce the recorded
	// raster, so this is reported the same way as a final-raster mismatch, not thrown.
	for (const source of provenance.sources) {
		const bytes = sourceBytes.get(source.sourceId) as Uint8Array;
		const actualSha256 = await hash(bytes);
		if (actualSha256 !== source.sha256) {
			return {
				ok: false,
				reason: 'hash-mismatch',
				message: `Original capture '${source.sourceId}' (${source.fileName}) bytes do not match the recorded SHA-256.`,
				expectedSha256: source.sha256,
				actualSha256
			};
		}
	}

	const decodedBySourceId = new Map<string, HTMLImageElement>();
	for (const source of provenance.sources) {
		const bytes = sourceBytes.get(source.sourceId) as Uint8Array;
		const file = new File([bytes as BufferSource], source.fileName, { type: source.mimeType });
		try {
			const decoded = await decode(file);
			decodedBySourceId.set(source.sourceId, decoded.image);
		} catch (caught) {
			return {
				ok: false,
				reason: 'decode-failure',
				message: `Could not decode original capture '${source.sourceId}' (${source.fileName}): ${messageOf(caught)}.`
			};
		}
	}

	let rendered: { readonly blob: Blob; readonly provenance: CompositeProvenance };
	try {
		rendered = await render(draftOf(provenance), decodedBySourceId);
	} catch (caught) {
		return {
			ok: false,
			reason: 'render-failure',
			message: `Reconstruction render failed: ${messageOf(caught)}.`
		};
	}

	// Independently hash the rendered bytes rather than trusting the renderer's own
	// self-reported `provenance.finalRasterSha256` — the whole point of this module is to
	// verify that guarantee, not assume it.
	let actualSha256: Sha256Hex;
	try {
		actualSha256 = await hash(await readBlobBytes(rendered.blob));
	} catch (caught) {
		return {
			ok: false,
			reason: 'render-failure',
			message: `Could not hash the reconstructed raster: ${messageOf(caught)}.`
		};
	}

	if (actualSha256 !== provenance.finalRasterSha256) {
		return {
			ok: false,
			reason: 'hash-mismatch',
			message: 'Reconstructed raster hash does not match the recorded finalRasterSha256.',
			expectedSha256: provenance.finalRasterSha256,
			actualSha256
		};
	}

	return { ok: true, blob: rendered.blob, actualSha256 };
}
