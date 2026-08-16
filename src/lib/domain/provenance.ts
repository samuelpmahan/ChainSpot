/**
 * ChainSpot source provenance & transform contract (CHSPT-55 SOURCE-PIPELINE
 * bundle; CHSPT-49/50/51 implement against this file).
 *
 * LOCKED CONTRACT — this file defines the shared representation every
 * SOURCE-PIPELINE slice (provenance/persistence, generalized stitch,
 * auto-first UX, generic sprite pose) reads and writes. Do not redefine an
 * equivalent shape elsewhere; do not change a field's meaning without
 * updating every consumer in the same change. If a slice needs a field this
 * file doesn't have, that is an integration question for the orchestrator,
 * not a local workaround.
 *
 * WHY THIS EXISTS: an `AnnotatedHole`'s points are source-image pixels, and
 * today "the source image" always means one flat PNG with no memory of how
 * it was produced. CHSPT-49 requires that the exact annotated raster be
 * reconstructible from the original capture(s) alone, without rerunning
 * AutoCrop/AutoStitch. That requires recording the derivation, not just the
 * result: which original file(s), what crop, what transform placed each
 * capture into the final raster, and exactly how they were combined. This
 * module models that derivation as coordinate spaces + explicit operations,
 * per CHSPT-55 — not a loose metadata bag.
 *
 * COORDINATE SPACES
 *
 * - Source raster space: one per original capture, pixels, origin (0,0) at
 *   the top-left of the *full, uncropped, undecoded-transform* frame exactly
 *   as browser-decoded from the uploaded file. Matches `ImageAsset.widthPx` /
 *   `heightPx` for that capture. `SourceCapture.crop` and `.transform` are
 *   both defined in this space — `transform` maps the FULL raster (not a
 *   crop-relative sub-raster) into composite space; the crop is a fact about
 *   which sub-region of that full raster actually contributes visible
 *   pixels, not a change of coordinate origin. This keeps `crop` and
 *   `transform` independently meaningful, matching CHSPT-49's requirement
 *   that both be preserved as distinct facts.
 *
 * - Composite space: the assembled output raster's pixels, origin (0,0)
 *   top-left, `CompositeProvenance.outputWidthPx/heightPx` in extent. For
 *   N=1 (AutoCrop only, no stitch) this is simply the one capture's cropped
 *   region at identity placement; for N>1 (AutoCrop + AutoStitch) it is
 *   Stitch Map's assembled mosaic. Once handed off, composite space IS
 *   `source-overview` image-pixel space for every downstream consumer
 *   (`ProjectState`, `AnnotatedRound`, annotate-course, create-graphics) —
 *   there is no separate "post-stitch" space named anywhere else in the
 *   codebase, and this module does not invent one either.
 *
 * Transform direction is always source -> composite, and the six-coefficient
 * application convention is IDENTICAL to `src/lib/alignment/types.ts`'s
 * `SerializableTransform` (`xOut = a*xIn + c*yIn + e`, `yOut = b*xIn + d*yIn
 * + f`, coefficient order `[a,b,c,d,e,f]`) so the two conventions never need
 * translating between each other's callers. `SourceTransform` is a distinct
 * type (not a reuse of `SerializableTransform`) only because its `model`
 * union additionally allows `'translation'` — alignment's source->target
 * basemap correspondence is a different feature with no translation-only
 * case. The underlying six-coefficient math (apply/invert/derive) is shared
 * via `src/lib/geometry/affine6.ts`, not reimplemented here.
 *
 * TRANSFORM FAMILY: use the smallest family the evidence justifies —
 * translation first, similarity (rotation + uniform scale) next, affine only
 * when actually required (CHSPT-50). The ordinary axis-aligned 2x2 capture
 * set is `model: 'translation'` with `coefficients = [1,0,0,1,e,f]`; this
 * must remain exactly representable and is the regression case every
 * consumer of this contract must keep green.
 *
 * DETERMINISTIC RECONSTRUCTION AND RESAMPLING (load-bearing constraint):
 * CHSPT-49 requires that reconstructing from provenance + original bytes
 * reproduces the exact final raster, verified by SHA-256. `canvas`/
 * `OffscreenCanvas` `drawImage` at 1:1 scale with an integer translation and
 * no rotation copies source pixels exactly (today's translation-only
 * behavior; `resampling: 'none'`) and is safe to keep using for that case.
 * It is NOT safe to rely on for anything that resamples (a rotated or
 * non-integer-scaled placement): browsers do not guarantee a bit-identical,
 * deterministic resampling algorithm for a transformed `drawImage`, so two
 * runs (different browser builds, software vs. GPU rasterization) can
 * legitimately disagree at the pixel level. Any renderer that composites a
 * `'similarity'` or `'affine'` transform MUST resample with a hand-written,
 * pure-TypeScript pixel sampler (nearest or bilinear, whichever `resampling`
 * declares) operating on raw pixel arrays, so reconstruction is byte-for-byte
 * identical regardless of environment. `resampling` on `CompositeProvenance`
 * records which algorithm was actually used, and `renderVersion` pins the
 * exact algorithm implementation so a future change to it can never be
 * silently assumed compatible with older provenance.
 *
 * FAIL LOUDLY: missing or internally contradictory provenance (a coverage
 * polygon that doesn't match `transform` applied to `crop`, a hash that
 * doesn't match the referenced `ImageAsset`, an overlap edge naming an
 * unknown source, a `paintOrder` that isn't a permutation of the source
 * list) must never be silently patched or guessed around. Validate with
 * `assertCoherentProvenance` at every boundary provenance crosses (save,
 * open, handoff) and throw a structured error on violation.
 */

import { applyAffine6, invertAffine6, deriveAffine6Values } from '../geometry/affine6';
import type { Affine6Coefficients, Affine6DerivedValues } from '../geometry/affine6';

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

export type SourceTransformModel = 'translation' | 'similarity' | 'affine';

/**
 * Source-raster-pixels -> composite-pixels transform for one capture. Same
 * six-coefficient application convention as `alignment/types.ts`'s
 * `SerializableTransform` (see module doc); `model` additionally allows
 * `'translation'`, the degenerate `[1,0,0,1,e,f]` case every ordinary 2x2
 * capture set uses today.
 */
export interface SourceTransform {
	readonly model: SourceTransformModel;
	readonly coefficients: Affine6Coefficients;
	readonly isInvertible: boolean;
	readonly determinant: number;
	/** Sign of the determinant: +1 direct orientation, -1 reflection (reflections are never expected from a real capture set; a negative value is evidence of a bad estimate, not a valid pose). */
	readonly orientation: number;
	readonly majorAxisScale: number;
	readonly minorAxisScale: number;
	readonly anisotropy: number;
	readonly shear: number;
}

/** A point in one capture's own full source-raster pixel space. */
export interface SourceRasterPoint {
	readonly xPx: number;
	readonly yPx: number;
}

/** A point in composite/output pixel space (== `source-overview` image-pixel space downstream). */
export interface CompositePoint {
	readonly xPx: number;
	readonly yPx: number;
}

export function applySourceTransform(point: SourceRasterPoint, transform: SourceTransform): CompositePoint {
	return applyAffine6(point, transform.coefficients);
}

export function invertSourceTransform(transform: SourceTransform): SourceTransform | null {
	const inverted = invertAffine6(transform.coefficients);
	if (!inverted) return null;
	return buildSourceTransform(transform.model, inverted);
}

/** Builds a `SourceTransform` from raw coefficients, deriving the redundant descriptive fields via the shared affine6 math (never hand-computed by a caller). */
export function buildSourceTransform(
	model: SourceTransformModel,
	coefficients: Affine6Coefficients
): SourceTransform {
	const [a, b, c, d] = coefficients;
	const derived: Affine6DerivedValues = deriveAffine6Values(a, b, c, d);
	return { model, coefficients, ...derived };
}

/** The identity transform (no crop offset, no rotation, no scale) — the "identity" case CHSPT-49 requires coverage for. */
export function identitySourceTransform(): SourceTransform {
	return buildSourceTransform('translation', [1, 0, 0, 1, 0, 0]);
}

/** A pure axis-aligned translation, e.g. today's `TilePlacement`-derived placement. */
export function translationSourceTransform(dxPx: number, dyPx: number): SourceTransform {
	return buildSourceTransform('translation', [1, 0, 0, 1, dxPx, dyPx]);
}

// ---------------------------------------------------------------------------
// Crop, coverage, one capture's provenance
// ---------------------------------------------------------------------------

/** The sub-rectangle of a capture's full source raster that contributes visible pixels, in that capture's own source-raster pixels (never crop-relative — see module doc). */
export interface SourceCropRect {
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx: number;
	readonly heightPx: number;
}

export type ResamplingMethod = 'none' | 'nearest' | 'bilinear';

/** Lowercase 64-hex SHA-256, matching `imageIntake.ts`'s `Sha256Hex`. Re-declared structurally here so this module has no dependency on the intake layer. */
export type Sha256Hex = string;

/**
 * One capture's full lineage: which original file, what part of it was used,
 * and where that part landed in the composite. `sourceId` is always the
 * `ImageAsset.id` of the *original, pre-crop, pre-stitch* upload — provenance
 * never invents a second identity for the same bytes.
 */
export interface SourceCapture {
	readonly sourceId: string;
	readonly fileName: string;
	readonly mimeType: string;
	/** Full decoded raster dimensions, pre-crop — matches `ImageAsset.widthPx/heightPx` for `sourceId`. */
	readonly widthPx: number;
	readonly heightPx: number;
	/** Hash of the original, unmodified capture bytes. Required (never null) once provenance exists for a capture — CHSPT-49 forbids new annotations depending on unhashed lineage. */
	readonly sha256: Sha256Hex;
	readonly crop: SourceCropRect;
	readonly transform: SourceTransform;
	/**
	 * `transform` applied to `crop`'s four corners, in composite pixels, in
	 * order [top-left, top-right, bottom-right, bottom-left] of the crop rect
	 * as it sits in source space. Stored explicitly (not left for every
	 * consumer to recompute) so overlap/pose-constraint consumers (CHSPT-51)
	 * have one canonical polygon to intersect against. Must equal
	 * `applySourceTransform` on each corner — `assertCoherentProvenance`
	 * checks this.
	 */
	readonly coveragePolygon: readonly CompositePoint[];
	/** 0-based ascending paint order actually used when this composite was produced (0 painted first). Ground truth for reconstruction — never re-derived from `compositingPolicy` at read time. */
	readonly paintOrder: number;
}

// ---------------------------------------------------------------------------
// Overlap topology
// ---------------------------------------------------------------------------

/**
 * `'placement-edge'` — one of the spanning-tree edges actually used to place
 * a capture (generalizes today's `autoLayout.ts` `PlacementEdge`).
 * `'fusion-edge'` — additional strong (non-tree) evidence used only to
 * refine a placement, never to place a capture for the first time
 * (generalizes `autoLayout.ts`'s multi-measurement averaging).
 */
export type OverlapKind = 'placement-edge' | 'fusion-edge';

export interface SourceOverlapEdge {
	readonly a: string;
	readonly b: string;
	readonly kind: OverlapKind;
	/** Matcher confidence for this edge; same scale as the matcher that produced it (today's `TranslationMatch.score`, [-1, 1]). Never authoritative — audit/diagnostic only. */
	readonly score: number;
}

// ---------------------------------------------------------------------------
// Composite provenance
// ---------------------------------------------------------------------------

/** Bumped whenever this module's *shape* changes in a way old documents can't be read as. Independent of `projectSchema.ts`'s `CURRENT_SCHEMA_VERSION` (that governs the whole project document; this governs this record alone, since provenance can also travel inside `AnnotatedRound`, which has no schema version of its own). */
export const CURRENT_PROVENANCE_SCHEMA_VERSION = 1 as const;

/**
 * Identifies the exact renderer/resampling implementation that produced
 * `finalRasterSha256`. Bump whenever a change to compositing, resampling, or
 * transform-estimation code could change output bytes for the same inputs —
 * reconstruction must refuse (fail loudly) to treat provenance from a
 * different `renderVersion` as safely replayable with the current renderer
 * unless the two are known-compatible.
 */
export type RenderVersion = string;

export const CURRENT_RENDER_VERSION: RenderVersion = 'chainspot-stitch-v1';

/**
 * Stable identifier for the compositing rule that produced `paintOrder` /
 * pixel ownership in overlaps — an audit label, not something reconstruction
 * re-derives from (see `SourceCapture.paintOrder`'s own doc). New policies
 * get new identifiers; an existing identifier's behavior never changes
 * silently.
 */
export type CompositingPolicy = 'single-source-v1' | 'stitch-ascending-bottom-right-v1';

export interface CompositeProvenance {
	readonly schemaVersion: typeof CURRENT_PROVENANCE_SCHEMA_VERSION;
	readonly renderVersion: RenderVersion;
	readonly outputWidthPx: number;
	readonly outputHeightPx: number;
	readonly compositingPolicy: CompositingPolicy;
	readonly resampling: ResamplingMethod;
	/** Every contributing capture, in stable `sourceId` order (NOT paint order — see `SourceCapture.paintOrder` for that). Exactly one entry for N=1 (AutoCrop only). */
	readonly sources: readonly SourceCapture[];
	readonly overlaps: readonly SourceOverlapEdge[];
	/** Hash of the exact composite raster bytes this provenance describes — must equal the owning `ImageAsset.sha256` once attached (see `domain/project.ts`). */
	readonly finalRasterSha256: Sha256Hex;
}

/**
 * Everything about a composite except the hash of its own rendered bytes —
 * which cannot exist until rendering actually happens (`finalRasterSha256`
 * is necessarily a chicken-and-egg field). Pipeline code computes a
 * `DraftComposite` first (placements/transforms/crops are fully determined
 * without touching a canvas), renders from it, hashes the result, and only
 * then calls `sealCompositeProvenance` to produce the real
 * `CompositeProvenance` that gets attached to an `ImageAsset` or handed off.
 * A `DraftComposite` must never be persisted or handed off on its own.
 */
export type DraftComposite = Omit<CompositeProvenance, 'finalRasterSha256'>;

export function sealCompositeProvenance(draft: DraftComposite, finalRasterSha256: Sha256Hex): CompositeProvenance {
	return { ...draft, finalRasterSha256 };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class ProvenanceCoherenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProvenanceCoherenceError';
	}
}

const COVERAGE_POLYGON_TOLERANCE_PX = 1e-6;

function cropCorners(crop: SourceCropRect): readonly SourceRasterPoint[] {
	return [
		{ xPx: crop.xPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx + crop.heightPx },
		{ xPx: crop.xPx, yPx: crop.yPx + crop.heightPx }
	];
}

/**
 * Throws `ProvenanceCoherenceError` on any internal contradiction: a
 * coverage polygon that doesn't match `transform(crop)`, a `paintOrder` that
 * isn't a permutation of `sources`, an overlap edge naming an unknown
 * `sourceId`, a non-finite/non-positive output dimension, or an empty
 * `sources` list. Does NOT check `finalRasterSha256` against real bytes or
 * cross-check against an owning `ImageAsset` — callers that have those
 * (persistence/handoff call sites) check them separately, since this
 * function only ever sees the provenance record itself. Pure and
 * synchronous; never mutates its input.
 */
export function assertCoherentProvenance(provenance: CompositeProvenance): void {
	if (provenance.sources.length === 0) {
		throw new ProvenanceCoherenceError('assertCoherentProvenance: sources must not be empty');
	}
	if (
		!Number.isFinite(provenance.outputWidthPx) ||
		!Number.isFinite(provenance.outputHeightPx) ||
		provenance.outputWidthPx <= 0 ||
		provenance.outputHeightPx <= 0
	) {
		throw new ProvenanceCoherenceError(
			`assertCoherentProvenance: outputWidthPx/outputHeightPx must be positive finite numbers, got ${provenance.outputWidthPx} x ${provenance.outputHeightPx}`
		);
	}

	const knownIds = new Set(provenance.sources.map((source) => source.sourceId));
	if (knownIds.size !== provenance.sources.length) {
		throw new ProvenanceCoherenceError('assertCoherentProvenance: duplicate sourceId in sources');
	}

	const paintOrders = [...provenance.sources].map((source) => source.paintOrder).sort((a, b) => a - b);
	const expectedOrders = provenance.sources.map((_, index) => index);
	if (!paintOrders.every((value, index) => value === expectedOrders[index])) {
		throw new ProvenanceCoherenceError(
			`assertCoherentProvenance: paintOrder across sources must be a permutation of 0..${provenance.sources.length - 1}, got [${provenance.sources.map((s) => s.paintOrder).join(', ')}]`
		);
	}

	for (const source of provenance.sources) {
		const expectedCorners = cropCorners(source.crop).map((corner) =>
			applySourceTransform(corner, source.transform)
		);
		if (expectedCorners.length !== source.coveragePolygon.length) {
			throw new ProvenanceCoherenceError(
				`assertCoherentProvenance: source '${source.sourceId}' coveragePolygon has ${source.coveragePolygon.length} points, expected ${expectedCorners.length}`
			);
		}
		for (let index = 0; index < expectedCorners.length; index += 1) {
			const expected = expectedCorners[index];
			const actual = source.coveragePolygon[index];
			const dx = Math.abs(expected.xPx - actual.xPx);
			const dy = Math.abs(expected.yPx - actual.yPx);
			if (dx > COVERAGE_POLYGON_TOLERANCE_PX || dy > COVERAGE_POLYGON_TOLERANCE_PX) {
				throw new ProvenanceCoherenceError(
					`assertCoherentProvenance: source '${source.sourceId}' coveragePolygon[${index}] (${actual.xPx}, ${actual.yPx}) does not match transform(crop) (${expected.xPx}, ${expected.yPx})`
				);
			}
		}
	}

	for (const edge of provenance.overlaps) {
		if (!knownIds.has(edge.a) || !knownIds.has(edge.b)) {
			throw new ProvenanceCoherenceError(
				`assertCoherentProvenance: overlap edge references unknown source ('${edge.a}' <-> '${edge.b}')`
			);
		}
		if (edge.a === edge.b) {
			throw new ProvenanceCoherenceError(
				`assertCoherentProvenance: overlap edge cannot self-reference source '${edge.a}'`
			);
		}
	}

	if (provenance.compositingPolicy === 'single-source-v1' && provenance.sources.length !== 1) {
		throw new ProvenanceCoherenceError(
			`assertCoherentProvenance: compositingPolicy 'single-source-v1' requires exactly one source, got ${provenance.sources.length}`
		);
	}
}
