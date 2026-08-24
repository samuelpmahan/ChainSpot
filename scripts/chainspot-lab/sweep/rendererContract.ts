// The plug interface `./lab sweep` renders artifacts through.
//
// LAB never recomputes anything a detector produced (owner hard rule) — a
// renderer takes the EXACT bytes @chainspot/alg's sink already wrote and
// turns them into something a human can open: a PNG, an SVG overlay, or a
// text table. It reads and presents; it never derives.
//
// One RendererFn per ArtifactKind (the 8 kinds @chainspot/alg/exec's
// contract.ts declares), plus a REGISTRY the sweep CLI dispatches
// through. Implement a kind by filling in RENDERERS[kind]; an unset kind
// falls back to the CLI writing the raw artifact bytes + a one-line stub
// note (see sweepCli.ts's renderArtifact()) — sweep runs end-to-end with
// zero kinds implemented, it's just plain until you fill one in.
//
// Payload formats documented below were read directly off
// packages/alg/src/exec/operations.ts's ARTIFACT_EXTRACTORS map and its
// jsonBytes/maskBytes/floatBytes helpers (checked against that file on
// 2026-08-23, at commit e1ab6ee + Chunk A's exec core). They are NOT
// invented or guessed. If @chainspot/alg changes an extractor's encoding,
// this file's comments go stale before the code does — re-check
// operations.ts first, this doc second.

import type { ArtifactKind, ArtifactRef } from '@chainspot/alg/exec';

// ---------------------------------------------------------------------------
// Per-kind payload formats, as actually written by operations.ts today.
// ---------------------------------------------------------------------------
//
// rgba              Uint8Array of raw RGBA bytes (Uint8ClampedArray.data),
//                    length = width*height*4. Source: RgbaImage.data.
//                    Example producer: 'badgeStage.masks' -> localImage.
//
// mask               Uint8Array = Mask.data alone (Mask.width/height are
//                    NOT included — maskBytes() drops them). One byte per
//                    element; this codebase's Mask is 0/255 per pixel, not
//                    bit-packed (confirm against raster.ts's mask writers
//                    before assuming bit-packing).
//
// scalarField        Float32Array's raw bytes (floatBytes(): a view over
// orientationField    the buffer, no header). Example: supportField's
//                    `support` (scalarField) and `bestTheta`
//                    (orientationField) — both sized to whatever grid
//                    supportField was computed over, which is NOT
//                    necessarily the full image (see the GAP note below).
//
// componentSet        JSON bytes (jsonBytes(): UTF-8 JSON.stringify).
// candidateSet        Parse with JSON.parse(new TextDecoder().decode(bytes)),
// polyline            or just use RendererInput.parsed, which the CLI
// measurementTable    already did this for. Shapes are whatever the
//                    producing op's board value serializes to — read
//                    operations.ts's ARTIFACT_EXTRACTORS entry for the
//                    specific op to know the exact TS type (e.g.
//                    'assignment.selection' -> ThreeFactorAssignment[
//                    'assignments'], 'badgeStage.components' ->
//                    ComponentStats[]).
//
// ---------------------------------------------------------------------------
// GAP — report to Chunk A, do not work around it here:
// ---------------------------------------------------------------------------
//
// None of rgba/mask/scalarField/orientationField's .bin bytes carry their
// own width/height. rgba is bare RGBA data (w*h*4 bytes — w and h are NOT
// individually recoverable from the length alone); mask is Mask.data with
// Mask.width/height dropped; scalarField/orientationField are a bare
// Float32Array with no shape at all. A renderer CANNOT safely rasterize
// without dimensions, and LAB's hard rule is to never guess/derive
// detector-shaped data — so when RendererInput.dims is undefined, decline
// to rasterize and return a text stub instead (see RasterDims below).
//
// Candidate fix for A (pick one, not LAB's call): (a) extend ArtifactRef
// with an optional `dims?: {width,height}` the gateway fills in when the
// producing op's board value carries it (badgeStage's Mask objects DO
// have width/height in memory — maskBytes() just doesn't forward them);
// or (b) have the 4 raster extractors prefix the payload with an 8-byte
// LE (u32 width, u32 height) header before the pixel/float data. Either
// closes this without LAB recomputing anything.

/** Pixel dimensions for a raster-shaped payload (rgba/mask/scalarField/
 * orientationField). `undefined` means the sweep CLI could not establish
 * dimensions for this artifact — see the GAP note above. A renderer
 * receiving `undefined` for one of the 4 raster kinds MUST decline to
 * rasterize (return a text-stub RendererOutput) rather than guess. */
export interface RasterDims {
	readonly width: number;
	readonly height: number;
}

export interface RendererInput {
	/** The receipt-level reference the gateway returned for this artifact
	 * (id/kind/sha256/uri) — see @chainspot/alg/exec's ArtifactRef. */
	readonly artifactRef: ArtifactRef;
	/** Raw bytes read back from <outDir>/artifacts/<kind>/<id>.bin — exactly
	 * what the sink wrote, byte for byte. */
	readonly bytes: Uint8Array;
	/** JSON.parse(utf8(bytes)), pre-parsed for the 4 JSON kinds
	 * (componentSet/candidateSet/polyline/measurementTable) so a renderer
	 * doesn't need its own decode step. `undefined` for the 4 raster
	 * kinds (rgba/mask/scalarField/orientationField), whose bytes are
	 * binary, not JSON. */
	readonly parsed: unknown;
	/** Best-effort raster dimensions. Only ever populated by the CLI from
	 * a source OUTSIDE the artifact's own bytes (e.g. the decoded input
	 * image's known width/height, explicitly flagged where used as a
	 * fallback guess) — never inferred from the payload itself. See the
	 * GAP note above; expect this to be undefined for most receipt-
	 * produced raster artifacts until A closes the gap. */
	readonly dims?: RasterDims;
	/** Absolute path to an already-rendered PNG for a base rgba artifact
	 * from the SAME receipt, when one exists — overlay kinds
	 * (componentSet/candidateSet/polyline) should draw on top of this
	 * instead of a blank canvas when present. */
	readonly baseRasterPngPath?: string;
	/** Directory this call should write into. Already created by the CLI. */
	readonly outDir: string;
	/** Owning opId and gate, for filenames/labels only — never a
	 * scheduling or data input. */
	readonly opId: string;
	readonly gate: string;
}

export interface RendererOutput {
	/** Every file this call wrote — absolute paths, for the CLI to list
	 * back to the operator and for the operation timeline to reference. */
	readonly filesWritten: readonly string[];
	/** Short human-readable note the timeline prints next to the artifact
	 * ref, e.g. "512x512 PNG" or "18 components -> SVG + text table" or
	 * "dims unknown — stub only (see rendererContract.ts GAP note)". */
	readonly summary: string;
}

export type RendererFn = (input: RendererInput) => RendererOutput;

/**
 * kind -> renderer. An unregistered kind makes the sweep CLI fall back to
 * writing the raw artifact bytes as-is plus a one-line text stub note
 * (sweepCli.ts's renderArtifact()) — sweep is fully runnable with this
 * map empty.
 *
 * To implement a kind: add scripts/chainspot-lab/sweep/renderers/<kind>.ts
 * exporting a RendererFn, import it below, and assign it to its key. Do
 * not change RendererInput/RendererOutput's shape without updating every
 * already-implemented kind and this file's callers in the same commit —
 * this is the one contract every renderer and the CLI both compile
 * against.
 */
export const RENDERERS: Partial<Record<ArtifactKind, RendererFn>> = {
	// rgba: renderRgba,
	// mask: renderMask,
	// scalarField: renderScalarField,
	// orientationField: renderOrientationField,
	// componentSet: renderComponentSet,
	// candidateSet: renderCandidateSet,
	// polyline: renderPolyline,
	// measurementTable: renderMeasurementTable,
};
