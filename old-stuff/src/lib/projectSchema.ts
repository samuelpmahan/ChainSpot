/**
 * ChainSpot versioned project document — serialization, validation, and migration.
 *
 * The saved document (`ProjectDocumentV4` — the exported type name predates v5 and is
 * kept stable for callers outside this module; only its `schemaVersion` literal and
 * shape changed) is the durable, portable boundary of a ChainSpot project. It wraps the
 * plain authoritative domain state (`ProjectState` from P0-002) with an explicit
 * `schemaVersion` and stores derived normalized coordinates alongside the authoritative
 * pixel coordinates:
 *
 *   { "schemaVersion": 5,
 *     "project": { "id", "name", "createdAt", "updatedAt" },
 *     "images": [ <source-overview manifest>, <target-basemap manifest> ],
 *     "controlPointPairs": [ <complete pair with source/target pixel + normalized points> ],
 *     "holes": [ <hole with tee/basket/ordered shots/corridorBends/corridorWidthPx in source-image pixels> ],
 *     "numberBadges": [ <hole-number badge anchor: number/xPx/yPx/confidence> ],
 *     "walkingPath": [ <xPx/yPx point, source-image pixels> ] (optional, omitted when unset),
 *     "viewState": null | { "source": {"zoom","panX","panY"}, "target": {...} } }
 *
 * Versions: v1 documents (written before hole annotation existed) are still readable and
 * are migrated forward by treating `holes` as empty — the only difference between the two
 * versions. The version was bumped rather than adding `holes` as an optional v1 field on
 * purpose: unknown fields are dropped on re-serialization, so a v1-only build opening a
 * document with holes would silently discard them on the next save. A version bump makes
 * that case fail loudly with `schema.version.unsupported` instead of losing user work.
 *
 * v2 -> v3: v2 holes carried a hand-traced `corridor` polygon; v3 replaces it with a
 * centerline representation (`corridorBends` + one `corridorWidthPx`). Old polygon data
 * is dev-era and is DROPPED on read: a v2 hole is migrated to empty bends and the current
 * default width. No legacy polygon compatibility subsystem is kept.
 *
 * v3 -> v4: adds `numberBadges`, hole-number-badge anchor points captured alongside
 * `holes` (course-shape signature input for smart course recognition; see
 * `courseSignature.ts`). Absent on v1-v3 documents, which migrate to an empty array —
 * one migration rule covering all three older versions at once, the same trick already
 * used for `holes` migrating from v1. Badge anchors carry a `confidence` field but are
 * never authoritative like tee/basket: they exist purely to fingerprint a course's shape,
 * not to annotate a round.
 *
 * v4 -> v5: adds optional `walkingPath`, UDisc's purple walking route as one open
 * polyline of source-image-pixel points (`ProjectState.walkingPath`, mirroring
 * `AnnotatedRound.walkingPath`). Absent on v1-v4 documents, which migrate to
 * `undefined` — an "absent by default" field rather than an "empty array by default"
 * one like `holes`/`numberBadges`, because "no walking path" and "not yet annotated"
 * are the same state and must have exactly one representation. An empty array is
 * likewise normalized to `undefined` on both read and write.
 *
 * v5 -> v6: adds optional `provenance` on an image manifest (`ImageAsset.provenance`,
 * CHSPT-49/55's `CompositeProvenance` from `domain/provenance.ts`) — how a
 * `source-overview` image's exact pixels were derived from original capture(s) via
 * AutoCrop/AutoStitch. Absent on v1-v5 documents (and on every `target-basemap` image,
 * and on a `source-overview` image uploaded directly with no stitch pipeline run), which
 * migrate to absent — the same "one representation of absent" rule `walkingPath` already
 * uses: a `null` manifest value normalizes to the same absent state as an omitted key, on
 * both read and write. A present `provenance` is validated with
 * `assertCoherentProvenance` (structural self-consistency: coverage polygons match
 * `transform(crop)`, `paintOrder` is a permutation, overlap edges reference known
 * sources) and cross-checked against the owning image's own `sha256` (`assertCoherent-
 * Provenance` deliberately does not do this cross-check itself — see its own doc — so
 * this module does it at the point where it actually has both values). Either violation
 * is a structured `provenance` category `ProjectSchemaError`, never a silent drop: CHSPT-
 * 49 requires failing loudly on contradictory lineage. The transform's redundant derived
 * fields (`isInvertible`/`determinant`/`orientation`/axis scales/`shear`) are never
 * trusted from the document — they are always recomputed from `model` + `coefficients`
 * via `buildSourceTransform`, the same shared `geometry/affine6.ts` math that produced
 * them in the first place, so a hand-edited or foreign document can never smuggle in a
 * self-inconsistent transform.
 *
 * v6 -> v7: adds optional `rotationDeg` on an image manifest (`ImageAsset.rotationDeg`,
 * CHSPT-44's manual clean-target rotation pose) — a display/pose transform rotated about
 * the image's own center, never a resampled bitmap and never touching any stored
 * `ImagePoint`/hole coordinate, which stay in original, unrotated target-image pixels
 * regardless of this value. Absent on v1-v6 documents, which migrate to absent (0°) — the
 * same "one representation of absent" rule `walkingPath`/`provenance` already use: a `0`
 * or `null` manifest value normalizes to the same absent state as an omitted key, on both
 * read and write, so an unrotated project's document stays byte-identical to one built
 * before this field existed. Only a `target-basemap` image may carry one; a
 * `source-overview` manifest with a present `rotationDeg` is a structured `rotation`
 * category failure, the same role-guard `provenance` uses in the other direction.
 *
 * Coordinate rule (detailed plan section 9.2): pixel coordinates remain authoritative.
 * Normalized values are derived on serialization from pixels and intrinsic dimensions and
 * are only checked (never trusted) on load. A present finite normalized value that does
 * not match the pixels is tolerated: pixels win, the stored value is discarded, and the
 * next serialization emits the corrected value. Missing normalized values are accepted.
 * An invalid-type or non-finite normalized value is a structured failure (no coercion).
 *
 * Validation order: the root must be a plain object and `schemaVersion` is read and
 * checked before anything else, so an unsupported version (any value other than 1, 2, 3,
 * 4, or 5, with newer versions clearly classified) fails before any other validation and
 * never leads to partial state replacement. Unknown fields at every level of a supported
 * version are ignored during parsing and are never emitted by the serializer, so they
 * cannot survive a re-serialization.
 *
 * Error contract: every failure is one `ProjectSchemaError` with a stable `category` and
 * `code`, a document `path` and optional `context`, and a human-readable `message`. The
 * parsing entry points return a tagged `ProjectParseResult`; the serializer throws the
 * same error type on invalid domain state, so non-finite values can never be silently
 * stringified as JSON `null`.
 *
 * Atomicity: parsing and serialization are pure functions over plain data. They never
 * touch a `ProjectEditor`, Svelte store, Konva node, decoded image, file object, or UI
 * state, so a failed parse cannot mutate an existing in-memory project.
 *
 * Out of scope: ZIP bundle I/O, image-byte hashing, downloads/uploads, autosave, and UI
 * repair flows belong to P0-011 and later tickets. No generic validation library,
 * reflection, decorators, placeholder migration registry, or generic validator framework
 * is used; validation and the explicit forward migrations (v1 predating holes, v2's
 * polygon corridor dropped for v3's centerline) are explicit and close to the versioned
 * document definition.
 */

import { normalizeRotationDeg, pointInBounds, toNormalizedCoordinates } from './coords';
import { DEFAULT_CORRIDOR_WIDTH_PX } from './corridor';
import type {
	AnnotatedHole,
	ControlPointPair,
	HoleNumberBadgeAnchor,
	ImageAsset,
	ImagePoint,
	ImageRole,
	OrderedShot,
	ProjectMetadata,
	ProjectState,
	ProjectViewState,
	SourcePoint,
	ViewTransformState
} from './domain/project';
import { IMAGE_ROLES } from './domain/project';
import {
	assertCoherentProvenance,
	buildSourceTransform,
	CURRENT_PROVENANCE_SCHEMA_VERSION,
	ProvenanceCoherenceError
} from './domain/provenance';
import type {
	CompositeProvenance,
	CompositingPolicy,
	OverlapKind,
	ProvenanceOrigin,
	ResamplingMethod,
	SourceCapture,
	SourceCaptureOrigin,
	SourceCropRect,
	SourceOverlapEdge,
	SourceTransform,
	SourceTransformModel
} from './domain/provenance';
import type { Affine6Coefficients } from './geometry/affine6';

/** The schema version written by this build. */
export const CURRENT_SCHEMA_VERSION = 7 as const;

/** Every version this build can read; older ones are migrated forward on parse. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];

export interface ImagePointV1 {
	imageId: string;
	xPx: number;
	yPx: number;
	xNorm: number;
	yNorm: number;
}

export interface ControlPointPairV1 {
	id: string;
	ordinal: number;
	label: string | null;
	enabled: boolean;
	source: ImagePointV1;
	target: ImagePointV1;
	createdAt: string;
	updatedAt: string;
}

export interface NumberBadgeAnchorDoc {
	number: number;
	xPx: number;
	yPx: number;
	confidence: number;
}

export interface ProjectDocumentV4 {
	schemaVersion: 7;
	project: ProjectMetadata;
	images: ImageAsset[];
	controlPointPairs: ControlPointPairV1[];
	holes: AnnotatedHole[];
	numberBadges: NumberBadgeAnchorDoc[];
	/** UDisc's purple walking route as one open polyline; omitted when not annotated. */
	walkingPath?: SourcePoint[];
	viewState: ProjectViewState | null;
}

export type ProjectSchemaErrorCategory =
	| 'malformed-json'
	| 'required-type'
	| 'unsupported-version'
	| 'image-manifest'
	| 'image-role'
	| 'dimension'
	| 'duplicate-id'
	| 'reference'
	| 'coordinate'
	| 'normalized'
	| 'hole'
	| 'badge'
	| 'view'
	| 'provenance'
	| 'rotation';

export interface ProjectSchemaError {
	category: ProjectSchemaErrorCategory;
	code: string;
	path: string;
	context?: string;
	message: string;
}

export type ProjectParseResult =
	| { ok: true; state: ProjectState }
	| { ok: false; error: ProjectSchemaError };

class SchemaFailure extends Error {
	constructor(readonly error: ProjectSchemaError) {
		super(error.message);
		this.name = 'SchemaFailure';
	}
}

function schemaError(
	category: ProjectSchemaErrorCategory,
	code: string,
	path: string,
	message: string,
	context?: string
): ProjectSchemaError {
	return { category, code, path, message, context };
}

function failure(
	category: ProjectSchemaErrorCategory,
	code: string,
	path: string,
	message: string,
	context?: string
): SchemaFailure {
	return new SchemaFailure(schemaError(category, code, path, message, context));
}

function describeValue(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'number') return String(value);
	return typeof value;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readObject(input: unknown, path: string, label: string): Record<string, unknown> {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		throw failure(
			'required-type',
			'required.type',
			path,
			`${label} must be a plain object, got ${describeValue(input)}`
		);
	}
	return input as Record<string, unknown>;
}

function readNonEmptyString(input: unknown, path: string): string {
	if (typeof input !== 'string') {
		throw failure(
			'required-type',
			'required.type',
			path,
			`${path} must be a string, got ${describeValue(input)}`
		);
	}
	if (input.length === 0) {
		throw failure('required-type', 'required.nonempty', path, `${path} must be a non-empty string`);
	}
	return input;
}

function readString(input: unknown, path: string): string {
	if (typeof input !== 'string') {
		throw failure(
			'required-type',
			'required.type',
			path,
			`${path} must be a string, got ${describeValue(input)}`
		);
	}
	return input;
}

function readBoolean(input: unknown, path: string): boolean {
	if (typeof input !== 'boolean') {
		throw failure(
			'required-type',
			'required.type',
			path,
			`${path} must be a boolean, got ${describeValue(input)}`
		);
	}
	return input;
}

function readLabel(input: unknown, path: string): string | null {
	if (input === null) return null;
	if (typeof input !== 'string') {
		throw failure(
			'required-type',
			'required.type',
			path,
			`${path} must be a string or null, got ${describeValue(input)}`
		);
	}
	return input;
}

function readOrdinal(input: unknown, path: string): number {
	if (typeof input !== 'number' || !Number.isInteger(input) || input <= 0) {
		throw failure(
			'required-type',
			'pair.ordinal.invalid',
			path,
			`${path} must be a positive integer, got ${describeValue(input)}`
		);
	}
	return input;
}

function readPositiveInt(input: unknown, path: string): number {
	if (typeof input !== 'number' || !Number.isInteger(input) || input <= 0) {
		throw failure(
			'dimension',
			'dimension.invalid',
			path,
			`${path} must be a positive finite integer, got ${describeValue(input)}`
		);
	}
	return input;
}

function readStringOrNull(input: unknown, path: string): string | null {
	if (input === null) return null;
	if (typeof input !== 'string') {
		throw failure(
			'image-manifest',
			'manifest.nullable-string',
			path,
			`${path} must be a string or null, got ${describeValue(input)}`
		);
	}
	return input;
}

function readRole(input: unknown, path: string): ImageRole {
	if (!IMAGE_ROLES.includes(input as ImageRole)) {
		throw failure(
			'image-role',
			'role.unknown',
			path,
			`${path} must be 'source-overview' or 'target-basemap', got ${describeValue(input)}`
		);
	}
	return input as ImageRole;
}

function readFiniteCoordinate(input: unknown, path: string): number {
	if (typeof input !== 'number') {
		throw failure(
			'coordinate',
			'coordinate.type',
			path,
			`${path} must be a number, got ${describeValue(input)}`
		);
	}
	if (!Number.isFinite(input)) {
		throw failure(
			'coordinate',
			'coordinate.non-finite',
			path,
			`${path} must be finite, got ${String(input)}`
		);
	}
	return input;
}

function readZoom(input: unknown, path: string): number {
	if (typeof input !== 'number') {
		throw failure('view', 'view.zoom.type', path, `${path} must be a number, got ${describeValue(input)}`);
	}
	if (!Number.isFinite(input) || input <= 0) {
		throw failure(
			'view',
			'view.zoom.invalid',
			path,
			`${path} must be a positive finite number, got ${describeValue(input)}`
		);
	}
	return input;
}

function readPanValue(input: unknown, path: string): number {
	if (typeof input !== 'number') {
		throw failure('view', 'view.pan.type', path, `${path} must be a number, got ${describeValue(input)}`);
	}
	if (!Number.isFinite(input)) {
		throw failure('view', 'view.pan.non-finite', path, `${path} must be finite, got ${String(input)}`);
	}
	return input;
}

function readProject(input: unknown): ProjectMetadata {
	const object = readObject(input, 'project', 'project metadata');
	return {
		id: readNonEmptyString(object.id, 'project.id'),
		name: readString(object.name, 'project.name'),
		createdAt: readString(object.createdAt, 'project.createdAt'),
		updatedAt: readString(object.updatedAt, 'project.updatedAt')
	};
}

// ---------------------------------------------------------------------------
// CompositeProvenance (v6+)
// ---------------------------------------------------------------------------

function readFiniteNumber(input: unknown, path: string): number {
	if (typeof input !== 'number' || !Number.isFinite(input)) {
		throw failure(
			'provenance',
			'provenance.number.invalid',
			path,
			`${path} must be a finite number, got ${describeValue(input)}`
		);
	}
	return input;
}

function readNonNegativeInteger(input: unknown, path: string): number {
	if (typeof input !== 'number' || !Number.isInteger(input) || input < 0) {
		throw failure(
			'provenance',
			'provenance.integer.invalid',
			path,
			`${path} must be a non-negative integer, got ${describeValue(input)}`
		);
	}
	return input;
}

const PROVENANCE_TRANSFORM_MODELS: readonly SourceTransformModel[] = ['translation', 'similarity', 'affine'];
const PROVENANCE_COMPOSITING_POLICIES: readonly CompositingPolicy[] = [
	'single-source-v1',
	'stitch-ascending-bottom-right-v1'
];
const PROVENANCE_RESAMPLING_METHODS: readonly ResamplingMethod[] = ['none', 'nearest', 'bilinear'];
const PROVENANCE_OVERLAP_KINDS: readonly OverlapKind[] = ['placement-edge', 'fusion-edge'];
const PROVENANCE_ORIGIN_VALUES: readonly ProvenanceOrigin[] = ['auto', 'manual'];

function readAffine6Coefficients(input: unknown, path: string): Affine6Coefficients {
	if (!Array.isArray(input) || input.length !== 6) {
		throw failure(
			'provenance',
			'provenance.transform.coefficients.invalid',
			path,
			`${path} must be an array of exactly 6 finite numbers, got ${describeValue(input)}`
		);
	}
	const values = input.map((value, index) => readFiniteNumber(value, `${path}[${index}]`));
	return values as unknown as Affine6Coefficients;
}

/**
 * Reads `model` + `coefficients` and rebuilds the full `SourceTransform` via the shared
 * `buildSourceTransform` (same as `domain/provenance.ts`'s own constructors) — the
 * redundant derived fields (`isInvertible`/`determinant`/`orientation`/axis scales/
 * `shear`) on the document are never trusted; they are always recomputed from the two
 * ground-truth fields (see the v5->v6 migration note in the module doc above).
 */
function readSourceTransform(input: unknown, path: string): SourceTransform {
	const object = readObject(input, path, 'source transform');
	if (!PROVENANCE_TRANSFORM_MODELS.includes(object.model as SourceTransformModel)) {
		throw failure(
			'provenance',
			'provenance.transform.model.invalid',
			`${path}.model`,
			`${path}.model must be one of ${PROVENANCE_TRANSFORM_MODELS.join(', ')}, got ${describeValue(object.model)}`
		);
	}
	const coefficients = readAffine6Coefficients(object.coefficients, `${path}.coefficients`);
	return buildSourceTransform(object.model as SourceTransformModel, coefficients);
}

function readSourceCropRect(input: unknown, path: string): SourceCropRect {
	const object = readObject(input, path, 'source crop rect');
	return {
		xPx: readFiniteNumber(object.xPx, `${path}.xPx`),
		yPx: readFiniteNumber(object.yPx, `${path}.yPx`),
		widthPx: readFiniteNumber(object.widthPx, `${path}.widthPx`),
		heightPx: readFiniteNumber(object.heightPx, `${path}.heightPx`)
	};
}

function readCompositePoint(input: unknown, path: string): { xPx: number; yPx: number } {
	const object = readObject(input, path, 'composite point');
	return {
		xPx: readFiniteNumber(object.xPx, `${path}.xPx`),
		yPx: readFiniteNumber(object.yPx, `${path}.yPx`)
	};
}

function readCoveragePolygon(input: unknown, path: string): SourceCapture['coveragePolygon'] {
	if (!Array.isArray(input)) {
		throw failure('provenance', 'provenance.coveragePolygon.invalid', path, `${path} must be an array`);
	}
	return input.map((point, index) => readCompositePoint(point, `${path}[${index}]`));
}

function readProvenanceOrigin(input: unknown, path: string): ProvenanceOrigin {
	if (!PROVENANCE_ORIGIN_VALUES.includes(input as ProvenanceOrigin)) {
		throw failure(
			'provenance',
			'provenance.origin.invalid',
			path,
			`${path} must be one of ${PROVENANCE_ORIGIN_VALUES.join(', ')}, got ${describeValue(input)}`
		);
	}
	return input as ProvenanceOrigin;
}

/**
 * `origin` differentiates automatic detection from a user's manual
 * correction, per-property (crop vs. transform independently) — see
 * `domain/provenance.ts`'s `SourceCaptureOrigin` doc comment. Required on
 * every `SourceCapture` in schema v6 (this field was part of v6 from its
 * introduction in this same bundle; there is no pre-existing v6 document
 * without it to migrate).
 */
function readSourceCaptureOrigin(input: unknown, path: string): SourceCaptureOrigin {
	const object = readObject(input, path, 'source capture origin');
	return {
		crop: readProvenanceOrigin(object.crop, `${path}.crop`),
		transform: readProvenanceOrigin(object.transform, `${path}.transform`)
	};
}

function readSourceCapture(input: unknown, path: string): SourceCapture {
	const object = readObject(input, path, 'source capture');
	return {
		sourceId: readNonEmptyString(object.sourceId, `${path}.sourceId`),
		fileName: readString(object.fileName, `${path}.fileName`),
		mimeType: readString(object.mimeType, `${path}.mimeType`),
		widthPx: readPositiveInt(object.widthPx, `${path}.widthPx`),
		heightPx: readPositiveInt(object.heightPx, `${path}.heightPx`),
		sha256: readNonEmptyString(object.sha256, `${path}.sha256`),
		crop: readSourceCropRect(object.crop, `${path}.crop`),
		transform: readSourceTransform(object.transform, `${path}.transform`),
		origin: readSourceCaptureOrigin(object.origin, `${path}.origin`),
		coveragePolygon: readCoveragePolygon(object.coveragePolygon, `${path}.coveragePolygon`),
		paintOrder: readNonNegativeInteger(object.paintOrder, `${path}.paintOrder`)
	};
}

function readOverlapEdge(input: unknown, path: string): SourceOverlapEdge {
	const object = readObject(input, path, 'source overlap edge');
	if (!PROVENANCE_OVERLAP_KINDS.includes(object.kind as OverlapKind)) {
		throw failure(
			'provenance',
			'provenance.overlap.kind.invalid',
			`${path}.kind`,
			`${path}.kind must be one of ${PROVENANCE_OVERLAP_KINDS.join(', ')}, got ${describeValue(object.kind)}`
		);
	}
	return {
		a: readNonEmptyString(object.a, `${path}.a`),
		b: readNonEmptyString(object.b, `${path}.b`),
		kind: object.kind as OverlapKind,
		score: readFiniteNumber(object.score, `${path}.score`)
	};
}

function readProvenanceSchemaVersion(input: unknown, path: string): CompositeProvenance['schemaVersion'] {
	if (input !== CURRENT_PROVENANCE_SCHEMA_VERSION) {
		throw failure(
			'provenance',
			'provenance.schemaVersion.unsupported',
			path,
			`${path} must be ${CURRENT_PROVENANCE_SCHEMA_VERSION}, got ${describeValue(input)}`
		);
	}
	return input;
}

function readCompositingPolicy(input: unknown, path: string): CompositingPolicy {
	if (!PROVENANCE_COMPOSITING_POLICIES.includes(input as CompositingPolicy)) {
		throw failure(
			'provenance',
			'provenance.compositingPolicy.invalid',
			path,
			`${path} must be one of ${PROVENANCE_COMPOSITING_POLICIES.join(', ')}, got ${describeValue(input)}`
		);
	}
	return input as CompositingPolicy;
}

function readResamplingMethod(input: unknown, path: string): ResamplingMethod {
	if (!PROVENANCE_RESAMPLING_METHODS.includes(input as ResamplingMethod)) {
		throw failure(
			'provenance',
			'provenance.resampling.invalid',
			path,
			`${path} must be one of ${PROVENANCE_RESAMPLING_METHODS.join(', ')}, got ${describeValue(input)}`
		);
	}
	return input as ResamplingMethod;
}

/**
 * Reads and validates one image's `CompositeProvenance`: structural fields, then
 * `assertCoherentProvenance` (coverage polygons match `transform(crop)`, `paintOrder` is
 * a permutation, overlap edges reference known sources — see its own doc for the full
 * list), then the one cross-check `assertCoherentProvenance` deliberately leaves to its
 * callers — `finalRasterSha256` must equal the owning image's own `sha256` once both are
 * present, so a save/open can never end up with a provenance record silently describing
 * different bytes than the image it is attached to. Every violation is a structured
 * `provenance`-category `ProjectSchemaError`; CHSPT-49 requires failing loudly on
 * contradictory lineage, never silently dropping or coercing it.
 */
function readCompositeProvenance(input: unknown, path: string, imageSha256: string | null): CompositeProvenance {
	const object = readObject(input, path, 'composite provenance');
	if (!Array.isArray(object.sources)) {
		throw failure(
			'provenance',
			'provenance.sources.invalid',
			`${path}.sources`,
			`${path}.sources must be an array`
		);
	}
	if (!Array.isArray(object.overlaps)) {
		throw failure(
			'provenance',
			'provenance.overlaps.invalid',
			`${path}.overlaps`,
			`${path}.overlaps must be an array`
		);
	}
	const provenance: CompositeProvenance = {
		schemaVersion: readProvenanceSchemaVersion(object.schemaVersion, `${path}.schemaVersion`),
		renderVersion: readNonEmptyString(object.renderVersion, `${path}.renderVersion`),
		outputWidthPx: readFiniteNumber(object.outputWidthPx, `${path}.outputWidthPx`),
		outputHeightPx: readFiniteNumber(object.outputHeightPx, `${path}.outputHeightPx`),
		compositingPolicy: readCompositingPolicy(object.compositingPolicy, `${path}.compositingPolicy`),
		resampling: readResamplingMethod(object.resampling, `${path}.resampling`),
		sources: object.sources.map((source, index) => readSourceCapture(source, `${path}.sources[${index}]`)),
		overlaps: object.overlaps.map((edge, index) => readOverlapEdge(edge, `${path}.overlaps[${index}]`)),
		finalRasterSha256: readNonEmptyString(object.finalRasterSha256, `${path}.finalRasterSha256`)
	};
	try {
		assertCoherentProvenance(provenance);
	} catch (caught) {
		if (caught instanceof ProvenanceCoherenceError) {
			throw failure('provenance', 'provenance.incoherent', path, caught.message);
		}
		throw caught;
	}
	if (imageSha256 !== null && imageSha256 !== provenance.finalRasterSha256) {
		throw failure(
			'provenance',
			'provenance.hash-mismatch',
			`${path}.finalRasterSha256`,
			`${path}.finalRasterSha256 (${provenance.finalRasterSha256}) does not match the owning image's sha256 (${imageSha256})`
		);
	}
	return provenance;
}

/**
 * Reads the optional per-image `provenance` (v6+). Absent/`null` normalizes to fully
 * absent (no key at all) on every version, including a v6 document whose image never
 * went through AutoCrop/AutoStitch — the same "one representation of absent" rule
 * `readWalkingPath` uses for its own field. Only a `source-overview` image may carry
 * one; a `target-basemap` manifest with a present `provenance` is a structured failure
 * rather than a silently ignored field, since quietly dropping it could hide a real
 * upstream bug that put it there.
 */
function readImageProvenance(
	input: unknown,
	path: string,
	role: ImageRole,
	imageSha256: string | null
): CompositeProvenance | undefined {
	if (input === undefined || input === null) return undefined;
	if (role !== 'source-overview') {
		throw failure(
			'provenance',
			'provenance.role-invalid',
			path,
			`${path} may only be present on a 'source-overview' image, found on a '${role}' image`
		);
	}
	return readCompositeProvenance(input, path, imageSha256);
}

/**
 * Reads the optional per-image `rotationDeg` (v7+). Absent/`null`/`0` all normalize to
 * fully absent (no key at all), the same "one representation of absent" rule
 * `readImageProvenance` uses for its own field. A non-zero value is normalized into
 * `(-180, 180]` (`coords.ts`'s `normalizeRotationDeg`) exactly like `editor.ts`'s
 * `setTargetRotation`, so a hand-edited or externally-produced document (e.g.
 * `rotationDeg: 400` or `360`) can never desync the stored value from the single
 * canonical range every other write path already enforces — 360 collapses back to
 * the same "absent" as 0, and out-of-range values land in-range at their equivalent
 * angle instead of leaking past the rotation UI's own `[-180, 180]` slider bounds.
 * Only a `target-basemap` image may carry one; a `source-overview` manifest with a
 * present, non-zero `rotationDeg` is a structured failure rather than a silently
 * ignored field.
 */
function readImageRotation(input: unknown, path: string, role: ImageRole): number | undefined {
	if (input === undefined || input === null) return undefined;
	if (typeof input !== 'number' || !Number.isFinite(input)) {
		throw failure(
			'rotation',
			'rotation.number.invalid',
			path,
			`${path} must be a finite number, got ${describeValue(input)}`
		);
	}
	const degrees = normalizeRotationDeg(input);
	if (degrees === 0) return undefined;
	if (role !== 'target-basemap') {
		throw failure(
			'rotation',
			'rotation.role-invalid',
			path,
			`${path} may only be present on a 'target-basemap' image, found on a '${role}' image`
		);
	}
	return degrees;
}

function readImages(input: unknown): ImageAsset[] {
	if (!Array.isArray(input)) {
		throw failure('required-type', 'required.missing', 'images', 'images must be an array');
	}
	const images: ImageAsset[] = [];
	let sourceCount = 0;
	let targetCount = 0;
	for (let index = 0; index < input.length; index++) {
		const object = readObject(input[index], `images[${index}]`, 'image manifest');
		const role = readRole(object.role, `images[${index}].role`);
		const sha256 = readStringOrNull(object.sha256, `images[${index}].sha256`);
		const provenance = readImageProvenance(object.provenance, `images[${index}].provenance`, role, sha256);
		const rotationDeg = readImageRotation(object.rotationDeg, `images[${index}].rotationDeg`, role);
		const image: ImageAsset = {
			id: readNonEmptyString(object.id, `images[${index}].id`),
			role,
			fileName: readString(object.fileName, `images[${index}].fileName`),
			mimeType: readString(object.mimeType, `images[${index}].mimeType`),
			widthPx: readPositiveInt(object.widthPx, `images[${index}].widthPx`),
			heightPx: readPositiveInt(object.heightPx, `images[${index}].heightPx`),
			sha256,
			bundlePath: readStringOrNull(object.bundlePath, `images[${index}].bundlePath`),
			...(provenance !== undefined ? { provenance } : {}),
			...(rotationDeg !== undefined ? { rotationDeg } : {})
		};
		if (role === 'source-overview') sourceCount++;
		else targetCount++;
		images.push(image);
	}
	if (sourceCount !== 1 || targetCount !== 1) {
		throw failure(
			'image-manifest',
			'images.cardinality',
			'images',
			`project must contain exactly one 'source-overview' image and exactly one 'target-basemap' image, found ${sourceCount} source and ${targetCount} target`
		);
	}
	return images;
}

function readPoint(
	input: unknown,
	path: string,
	side: 'source' | 'target',
	sourceImage: ImageAsset,
	targetImage: ImageAsset
): ImagePoint {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		throw failure(
			'reference',
			'reference.incomplete-pair',
			path,
			`control-point pair is missing a complete ${side} point (expected an object with imageId, xPx, yPx)`
		);
	}
	const object = input as Record<string, unknown>;
	const imageId = readNonEmptyString(object.imageId, `${path}.imageId`);
	const required = side === 'source' ? sourceImage : targetImage;
	const other = side === 'source' ? targetImage : sourceImage;
	if (imageId === required.id) {
		// correct image for this side
	} else if (imageId === other.id) {
		throw failure(
			'reference',
			'reference.swapped',
			`${path}.imageId`,
			`${side} point references '${imageId}' (the ${side === 'source' ? 'target' : 'source'} image); source and target sides are swapped or the image roles are wrong`
		);
	} else {
		throw failure(
			'reference',
			'reference.unknown-image',
			`${path}.imageId`,
			`${side} point references unknown image '${imageId}'`
		);
	}
	const xPx = readFiniteCoordinate(object.xPx, `${path}.xPx`);
	const yPx = readFiniteCoordinate(object.yPx, `${path}.yPx`);
	if (!pointInBounds({ xPx, yPx }, required.widthPx, required.heightPx)) {
		throw failure(
			'coordinate',
			'coordinate.out-of-bounds',
			path,
			`${side} point (${xPx}, ${yPx}) is outside [0, ${required.widthPx}) x [0, ${required.heightPx}) of image '${required.id}'`
		);
	}
	if (object.xNorm !== undefined) {
		if (typeof object.xNorm !== 'number') {
			throw failure(
				'normalized',
				'normalized.type',
				`${path}.xNorm`,
				`xNorm must be a number, got ${describeValue(object.xNorm)}`
			);
		}
		if (!Number.isFinite(object.xNorm)) {
			throw failure(
				'normalized',
				'normalized.non-finite',
				`${path}.xNorm`,
				`xNorm must be finite, got ${String(object.xNorm)}`
			);
		}
	}
	if (object.yNorm !== undefined) {
		if (typeof object.yNorm !== 'number') {
			throw failure(
				'normalized',
				'normalized.type',
				`${path}.yNorm`,
				`yNorm must be a number, got ${describeValue(object.yNorm)}`
			);
		}
		if (!Number.isFinite(object.yNorm)) {
			throw failure(
				'normalized',
				'normalized.non-finite',
				`${path}.yNorm`,
				`yNorm must be finite, got ${String(object.yNorm)}`
			);
		}
	}
	return { imageId, xPx, yPx };
}

function readPairs(input: unknown, images: ImageAsset[]): ControlPointPair[] {
	if (!Array.isArray(input)) {
		throw failure(
			'required-type',
			'required.missing',
			'controlPointPairs',
			'controlPointPairs must be an array'
		);
	}
	const sourceImage = images.find((image) => image.role === 'source-overview') as ImageAsset;
	const targetImage = images.find((image) => image.role === 'target-basemap') as ImageAsset;
	const pairs: ControlPointPair[] = [];
	const ordinals = new Map<number, string>();
	for (let index = 0; index < input.length; index++) {
		const object = readObject(input[index], `controlPointPairs[${index}]`, 'control-point pair');
		const id = readNonEmptyString(object.id, `controlPointPairs[${index}].id`);
		const ordinal = readOrdinal(object.ordinal, `controlPointPairs[${index}].ordinal`);
		const prior = ordinals.get(ordinal);
		if (prior !== undefined) {
			throw failure(
				'reference',
				'pair.ordinal-duplicate',
				`controlPointPairs[${index}].ordinal`,
				`ordinal ${ordinal} is used by both ${prior} and controlPointPairs[${index}].id`
			);
		}
		ordinals.set(ordinal, `controlPointPairs[${index}].id`);
		pairs.push({
			id,
			ordinal,
			label: readLabel(object.label, `controlPointPairs[${index}].label`),
			enabled: readBoolean(object.enabled, `controlPointPairs[${index}].enabled`),
			source: readPoint(
				object.source,
				`controlPointPairs[${index}].source`,
				'source',
				sourceImage,
				targetImage
			),
			target: readPoint(
				object.target,
				`controlPointPairs[${index}].target`,
				'target',
				sourceImage,
				targetImage
			),
			createdAt: readString(object.createdAt, `controlPointPairs[${index}].createdAt`),
			updatedAt: readString(object.updatedAt, `controlPointPairs[${index}].updatedAt`)
		});
	}
	return pairs;
}

/**
 * Reads one hole feature point. Holes carry no `imageId` (a hole always belongs to the
 * `source-overview` image), so the bound image is passed in rather than resolved from
 * the document; bounds are enforced exactly as they are for control points.
 */
function readHolePoint(input: unknown, path: string, sourceImage: ImageAsset): SourcePoint {
	const object = readObject(input, path, 'hole point');
	const xPx = readFiniteCoordinate(object.xPx, `${path}.xPx`);
	const yPx = readFiniteCoordinate(object.yPx, `${path}.yPx`);
	if (!pointInBounds({ xPx, yPx }, sourceImage.widthPx, sourceImage.heightPx)) {
		throw failure(
			'coordinate',
			'coordinate.out-of-bounds',
			path,
			`hole point (${xPx}, ${yPx}) is outside [0, ${sourceImage.widthPx}) x [0, ${sourceImage.heightPx}) of the source image '${sourceImage.id}'`
		);
	}
	return { xPx, yPx };
}

function readHoleNumber(input: unknown, path: string): number {
	if (typeof input !== 'number' || !Number.isInteger(input) || input <= 0) {
		throw failure(
			'hole',
			'hole.number.invalid',
			path,
			`${path} must be a positive integer, got ${describeValue(input)}`
		);
	}
	return input;
}

/**
 * Reads the hole's constant corridor width. Required in v3; an absent value
 * (v1/v2 data predating the field) migrates to the current default width.
 */
function readCorridorWidthPx(input: unknown, path: string): number {
	if (input === undefined || input === null) return DEFAULT_CORRIDOR_WIDTH_PX;
	if (typeof input !== 'number') {
		throw failure(
			'hole',
			'hole.width.type',
			path,
			`${path} must be a number, got ${describeValue(input)}`
		);
	}
	if (!Number.isFinite(input) || input <= 0) {
		throw failure(
			'hole',
			'hole.width.invalid',
			path,
			`${path} must be a finite number greater than zero, got ${String(input)}`
		);
	}
	return input;
}

function readPar(input: unknown, path: string): number | undefined {
	if (input === undefined || input === null) return undefined;
	if (typeof input !== 'number') {
		throw failure('hole', 'hole.par.type', path, `${path} must be a number, got ${describeValue(input)}`);
	}
	if (!Number.isInteger(input) || input <= 0) {
		throw failure(
			'hole',
			'hole.par.invalid',
			path,
			`${path} must be a positive integer, got ${String(input)}`
		);
	}
	return input;
}

/**
 * Reads the `holes` array. Absent/null is an empty list, which is exactly how a migrated
 * v1 document (written before hole annotation existed) arrives here.
 */
function readHoles(input: unknown, images: ImageAsset[]): AnnotatedHole[] {
	if (input === undefined || input === null) return [];
	if (!Array.isArray(input)) {
		throw failure('required-type', 'required.missing', 'holes', 'holes must be an array');
	}
	const sourceImage = images.find((image) => image.role === 'source-overview') as ImageAsset;
	const holes: AnnotatedHole[] = [];
	const numbers = new Map<number, string>();
	for (let index = 0; index < input.length; index++) {
		const path = `holes[${index}]`;
		const object = readObject(input[index], path, 'hole');
		const id = readNonEmptyString(object.id, `${path}.id`);
		const number = readHoleNumber(object.number, `${path}.number`);
		const prior = numbers.get(number);
		if (prior !== undefined) {
			throw failure(
				'hole',
				'hole.number-duplicate',
				`${path}.number`,
				`hole number ${number} is used by both ${prior} and ${path}.id`
			);
		}
		numbers.set(number, `${path}.id`);

		if (!Array.isArray(object.shots)) {
			throw failure('hole', 'hole.shots.type', `${path}.shots`, `${path}.shots must be an array`);
		}
		const shots: OrderedShot[] = object.shots.map((shot, shotIndex) => {
			const shotPath = `${path}.shots[${shotIndex}]`;
			const shotObject = readObject(shot, shotPath, 'shot');
			return {
				id: readNonEmptyString(shotObject.id, `${shotPath}.id`),
				landing: readHolePoint(shotObject.landing, `${shotPath}.landing`, sourceImage)
			};
		});

		// Centerline bend points. Required (possibly empty) in v3; absent on
		// v1/v2 holes means no bends, and any legacy `corridor` polygon field on
		// v2 holes is deliberately ignored (dev-era data, dropped on read).
		let corridorBends: SourcePoint[] = [];
		if (object.corridorBends !== undefined && object.corridorBends !== null) {
			if (!Array.isArray(object.corridorBends)) {
				throw failure(
					'hole',
					'hole.corridorBends.type',
					`${path}.corridorBends`,
					`${path}.corridorBends must be an array`
				);
			}
			corridorBends = object.corridorBends.map((point, pointIndex) =>
				readHolePoint(point, `${path}.corridorBends[${pointIndex}]`, sourceImage)
			);
		}
		const corridorWidthPx = readCorridorWidthPx(object.corridorWidthPx, `${path}.corridorWidthPx`);

		const par = readPar(object.par, `${path}.par`);

		const hole: AnnotatedHole = {
			id,
			number,
			shots,
			corridorBends,
			corridorWidthPx,
			...(par !== undefined ? { par } : {}),
			...(object.tee !== undefined && object.tee !== null
				? { tee: readHolePoint(object.tee, `${path}.tee`, sourceImage) }
				: {}),
			...(object.basket !== undefined && object.basket !== null
				? { basket: readHolePoint(object.basket, `${path}.basket`, sourceImage) }
				: {})
		};
		holes.push(hole);
	}
	return holes;
}

function readConfidence01(input: unknown, path: string): number {
	if (typeof input !== 'number') {
		throw failure('badge', 'badge.confidence.type', path, `${path} must be a number, got ${describeValue(input)}`);
	}
	if (!Number.isFinite(input) || input < 0 || input > 1) {
		throw failure(
			'badge',
			'badge.confidence.invalid',
			path,
			`${path} must be a finite number in [0, 1], got ${String(input)}`
		);
	}
	return input;
}

/**
 * Reads the `numberBadges` array. Absent/null is an empty list — the single migration
 * rule covering v1, v2, and v3 documents (none of which had this field) uniformly, the
 * same trick `readHoles` already uses for its own v1 migration.
 */
function readNumberBadges(input: unknown, images: ImageAsset[]): HoleNumberBadgeAnchor[] {
	if (input === undefined || input === null) return [];
	if (!Array.isArray(input)) {
		throw failure('required-type', 'required.missing', 'numberBadges', 'numberBadges must be an array');
	}
	const sourceImage = images.find((image) => image.role === 'source-overview') as ImageAsset;
	const badges: HoleNumberBadgeAnchor[] = [];
	const numbers = new Map<number, string>();
	for (let index = 0; index < input.length; index++) {
		const path = `numberBadges[${index}]`;
		const object = readObject(input[index], path, 'number badge anchor');
		const number = readHoleNumber(object.number, `${path}.number`);
		const prior = numbers.get(number);
		if (prior !== undefined) {
			throw failure(
				'badge',
				'badge.number-duplicate',
				`${path}.number`,
				`badge number ${number} is used by both ${prior} and ${path}`
			);
		}
		numbers.set(number, path);
		const point = readHolePoint(object, path, sourceImage);
		const confidence = readConfidence01(object.confidence, `${path}.confidence`);
		badges.push({ number, xPx: point.xPx, yPx: point.yPx, confidence });
	}
	return badges;
}

/**
 * Reads the optional `walkingPath` (v5+). Absent/null is `undefined` on every
 * version, including a v5 document that was never annotated — unlike
 * `readHoles`/`readNumberBadges`, whose well-defined default is an empty array, this
 * field's well-defined default is "absent", matching `ProjectState.walkingPath`'s own
 * "absent when not annotated" convention. An empty array is likewise normalized to
 * `undefined` so there is exactly one representation of "no path".
 */
function readWalkingPath(input: unknown, images: ImageAsset[]): SourcePoint[] | undefined {
	if (input === undefined || input === null) return undefined;
	if (!Array.isArray(input)) {
		throw failure(
			'required-type',
			'required.missing',
			'walkingPath',
			'walkingPath must be an array'
		);
	}
	if (input.length === 0) return undefined;
	const sourceImage = images.find((image) => image.role === 'source-overview') as ImageAsset;
	return input.map((point, index) => readHolePoint(point, `walkingPath[${index}]`, sourceImage));
}

function assertUniqueIds(project: ProjectMetadata, images: ImageAsset[], pairs: ControlPointPair[]): void {
	const seen = new Map<string, string>([['project.id', project.id]]);
	for (let index = 0; index < images.length; index++) {
		const image = images[index];
		const prior = [...seen.entries()].find(([, id]) => id === image.id)?.[0];
		if (prior !== undefined) {
			throw failure(
				'duplicate-id',
				'id.duplicate',
				`images[${index}].id`,
				`duplicate or colliding id '${image.id}' already used by ${prior}`
			);
		}
		seen.set(`images[${index}].id`, image.id);
	}
	for (let index = 0; index < pairs.length; index++) {
		const pair = pairs[index];
		const prior = [...seen.entries()].find(([, id]) => id === pair.id)?.[0];
		if (prior !== undefined) {
			throw failure(
				'duplicate-id',
				'id.duplicate',
				`controlPointPairs[${index}].id`,
				`duplicate or colliding id '${pair.id}' already used by ${prior}`
			);
		}
		seen.set(`controlPointPairs[${index}].id`, pair.id);
	}
}

function readViewTransform(input: unknown, path: string): ViewTransformState {
	const object = readObject(input, path, 'view transform');
	return {
		zoom: readZoom(object.zoom, `${path}.zoom`),
		panX: readPanValue(object.panX, `${path}.panX`),
		panY: readPanValue(object.panY, `${path}.panY`)
	};
}

function readViewState(input: unknown): ProjectViewState | null {
	if (input === undefined || input === null) return null;
	if (typeof input !== 'object' || Array.isArray(input)) {
		throw failure(
			'view',
			'view.type',
			'viewState',
			`viewState must be null or an object, got ${describeValue(input)}`
		);
	}
	const object = input as Record<string, unknown>;
	return {
		source: readViewTransform(object.source, 'viewState.source'),
		target: readViewTransform(object.target, 'viewState.target')
	};
}

function readDocument(value: unknown): ProjectState {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw failure(
			'required-type',
			'schema.root.object',
			'',
			`project document root must be a plain object, got ${describeValue(value)}`
		);
	}
	const root = value as Record<string, unknown>;
	const schemaVersion = root.schemaVersion;
	if (schemaVersion === undefined) {
		throw failure(
			'required-type',
			'schema.schemaVersion.missing',
			'schemaVersion',
			'missing required schemaVersion'
		);
	}
	if (typeof schemaVersion !== 'number') {
		throw failure(
			'required-type',
			'schema.schemaVersion.type',
			'schemaVersion',
			`schemaVersion must be a number, got ${describeValue(schemaVersion)}`
		);
	}
	if (!SUPPORTED_SCHEMA_VERSIONS.includes(schemaVersion)) {
		const newer = schemaVersion > CURRENT_SCHEMA_VERSION;
		throw failure(
			'unsupported-version',
			'schema.version.unsupported',
			'schemaVersion',
			newer
				? `unsupported schema version ${schemaVersion}; this build supports version ${CURRENT_SCHEMA_VERSION} and cannot open newer documents`
				: `unsupported schema version ${schemaVersion}; this build supports versions ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`
		);
	}

	const project = readProject(root.project);
	const images = readImages(root.images);
	const pairs = readPairs(root.controlPointPairs, images);
	assertUniqueIds(project, images, pairs);
	// Migration from pre-hole documents: v1 simply has no `holes`, which
	// `readHoles` already reads as an empty list. Reading it unconditionally
	// keeps the migration a single well-defined default rather than a separate
	// transform pass.
	const holes = readHoles(root.holes, images);
	// Same one-migration-rule shape as holes above: numberBadges is absent on
	// every version prior to v4 and reads as an empty array regardless.
	const numberBadges = readNumberBadges(root.numberBadges, images);
	// walkingPath is absent on every version prior to v5 and reads as undefined
	// regardless — see readWalkingPath for why its default differs from holes/badges.
	const walkingPath = readWalkingPath(root.walkingPath, images);
	const viewState = readViewState(root.viewState);

	return {
		project,
		images,
		controlPointPairs: pairs,
		holes,
		numberBadges,
		...(walkingPath ? { walkingPath } : {}),
		viewState
	};
}

/**
 * Parses a schema-v1 project document from an already-parsed unknown value. Returns a
 * fresh recognized `ProjectState` or a structured `ProjectSchemaError`. The input is
 * never mutated and no editor or UI state is touched.
 */
export function parseProjectDocument(value: unknown): ProjectParseResult {
	try {
		return { ok: true, state: readDocument(value) };
	} catch (error) {
		if (error instanceof SchemaFailure) {
			return { ok: false, error: error.error };
		}
		throw error;
	}
}

/**
 * Parses a schema-v1 project document from its JSON text. Malformed JSON is reported as
 * a structured `malformed-json` failure distinct from schema validation failures.
 */
export function parseProjectJson(text: string): ProjectParseResult {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			error: schemaError(
				'malformed-json',
				'json.parse',
				'',
				`project document is not valid JSON: ${messageOf(error)}`
			)
		};
	}
	return parseProjectDocument(value);
}

function buildPoint(
	point: ImagePoint,
	sourceImage: ImageAsset,
	targetImage: ImageAsset
): ImagePointV1 {
	const image =
		point.imageId === sourceImage.id
			? sourceImage
			: point.imageId === targetImage.id
				? targetImage
				: undefined;
	const normalized = image
		? toNormalizedCoordinates({ xPx: point.xPx, yPx: point.yPx }, image.widthPx, image.heightPx)
		: { xNorm: Number.NaN, yNorm: Number.NaN };
	return {
		imageId: point.imageId,
		xPx: point.xPx,
		yPx: point.yPx,
		xNorm: normalized.xNorm,
		yNorm: normalized.yNorm
	};
}

/**
 * Rebuilds a `SourceTransform` field-by-field for the document (never spread), matching
 * the rest of this module's "unknown properties cannot survive a round trip" rule. The
 * derived fields are re-emitted from the in-memory value as-is (unlike the reader, which
 * recomputes them via `buildSourceTransform` instead of trusting the document) because by
 * this point `validateState`/parsing has already guaranteed every in-memory
 * `SourceTransform` came from `buildSourceTransform` in the first place.
 */
function buildSourceTransformDoc(transform: SourceTransform): SourceTransform {
	return {
		model: transform.model,
		coefficients: [...transform.coefficients] as Affine6Coefficients,
		isInvertible: transform.isInvertible,
		determinant: transform.determinant,
		orientation: transform.orientation,
		majorAxisScale: transform.majorAxisScale,
		minorAxisScale: transform.minorAxisScale,
		anisotropy: transform.anisotropy,
		shear: transform.shear
	};
}

function buildSourceCaptureDoc(source: SourceCapture): SourceCapture {
	return {
		sourceId: source.sourceId,
		fileName: source.fileName,
		mimeType: source.mimeType,
		widthPx: source.widthPx,
		heightPx: source.heightPx,
		sha256: source.sha256,
		crop: { xPx: source.crop.xPx, yPx: source.crop.yPx, widthPx: source.crop.widthPx, heightPx: source.crop.heightPx },
		transform: buildSourceTransformDoc(source.transform),
		origin: { crop: source.origin.crop, transform: source.origin.transform },
		coveragePolygon: source.coveragePolygon.map((point) => ({ xPx: point.xPx, yPx: point.yPx })),
		paintOrder: source.paintOrder
	};
}

function buildProvenanceDoc(provenance: CompositeProvenance): CompositeProvenance {
	return {
		schemaVersion: provenance.schemaVersion,
		renderVersion: provenance.renderVersion,
		outputWidthPx: provenance.outputWidthPx,
		outputHeightPx: provenance.outputHeightPx,
		compositingPolicy: provenance.compositingPolicy,
		resampling: provenance.resampling,
		sources: provenance.sources.map(buildSourceCaptureDoc),
		overlaps: provenance.overlaps.map((edge) => ({ a: edge.a, b: edge.b, kind: edge.kind, score: edge.score })),
		finalRasterSha256: provenance.finalRasterSha256
	};
}

/**
 * Validates durable `ProjectState` and throws a structured `ProjectSchemaError` on any
 * invalid domain value (non-finite or out-of-bounds coordinates, missing image role,
 * duplicate/colliding ids, invalid dimensions, incomplete/wrong references, invalid view
 * state). This prevalidation guarantees a serialized document can never contain a
 * non-finite value that would be silently stringified as JSON `null`. `readImages` (part
 * of that validation) also runs `assertCoherentProvenance` and the `finalRasterSha256`
 * cross-check on any `provenance` present, so an incoherent one can never reach `write`.
 */
function validateState(state: ProjectState): void {
	const project = readProject(state.project);
	const images = readImages(state.images);
	const pairs = readPairs(state.controlPointPairs, images);
	assertUniqueIds(project, images, pairs);
	readHoles(state.holes, images);
	readNumberBadges(state.numberBadges, images);
	readWalkingPath(state.walkingPath, images);
	readViewState(state.viewState);
}

/**
 * Serializes durable `ProjectState` into a fresh schema-v1 document. The output contains
 * only recognized document fields (no transient or unknown data is spread in) and derives
 * normalized coordinates from the authoritative pixels and intrinsic dimensions; the
 * returned document never stores normalized state back into the domain. Throws a
 * structured `ProjectSchemaError` when the domain state is invalid.
 */
export function serializeProjectState(state: ProjectState): ProjectDocumentV4 {
	try {
		validateState(state);
	} catch (error) {
		if (error instanceof SchemaFailure) throw error.error;
		throw error;
	}
	const sourceImage = state.images.find((image) => image.role === 'source-overview') as ImageAsset;
	const targetImage = state.images.find((image) => image.role === 'target-basemap') as ImageAsset;
	const viewState = state.viewState
		? {
				source: {
					zoom: state.viewState.source.zoom,
					panX: state.viewState.source.panX,
					panY: state.viewState.source.panY
				},
				target: {
					zoom: state.viewState.target.zoom,
					panX: state.viewState.target.panX,
					panY: state.viewState.target.panY
				}
			}
		: null;
	return {
		schemaVersion: CURRENT_SCHEMA_VERSION,
		project: {
			id: state.project.id,
			name: state.project.name,
			createdAt: state.project.createdAt,
			updatedAt: state.project.updatedAt
		},
		images: state.images.map((image) => ({
			id: image.id,
			role: image.role,
			fileName: image.fileName,
			mimeType: image.mimeType,
			widthPx: image.widthPx,
			heightPx: image.heightPx,
			sha256: image.sha256,
			bundlePath: image.bundlePath,
			// `null` and absent both normalize to "no key" — see the v5->v6 migration note
			// in the module doc for why (mirrors walkingPath's empty-array normalization).
			...(image.provenance != null ? { provenance: buildProvenanceDoc(image.provenance) } : {}),
			// `null`/`0`/absent all normalize to "no key" — see the v6->v7 migration note.
			...(image.rotationDeg != null && image.rotationDeg !== 0
				? { rotationDeg: image.rotationDeg }
				: {})
		})),
		controlPointPairs: state.controlPointPairs.map((pair) => ({
			id: pair.id,
			ordinal: pair.ordinal,
			label: pair.label,
			enabled: pair.enabled,
			source: buildPoint(pair.source, sourceImage, targetImage),
			target: buildPoint(pair.target, sourceImage, targetImage),
			createdAt: pair.createdAt,
			updatedAt: pair.updatedAt
		})),
		// Emitted field-by-field (never spread) so unknown properties on a hole object
		// cannot survive a round trip, matching how pairs and images are serialized.
		// Optional fields are omitted rather than written as null, so a re-parse
		// reproduces exactly the same shape.
		holes: state.holes.map((hole) => ({
			id: hole.id,
			number: hole.number,
			shots: hole.shots.map((shot) => ({
				id: shot.id,
				landing: { xPx: shot.landing.xPx, yPx: shot.landing.yPx }
			})),
			corridorBends: hole.corridorBends.map((point) => ({ xPx: point.xPx, yPx: point.yPx })),
			corridorWidthPx: hole.corridorWidthPx,
			...(hole.par !== undefined ? { par: hole.par } : {}),
			...(hole.tee ? { tee: { xPx: hole.tee.xPx, yPx: hole.tee.yPx } } : {}),
			...(hole.basket ? { basket: { xPx: hole.basket.xPx, yPx: hole.basket.yPx } } : {})
		})),
		numberBadges: state.numberBadges.map((badge) => ({
			number: badge.number,
			xPx: badge.xPx,
			yPx: badge.yPx,
			confidence: badge.confidence
		})),
		// Omitted (never an empty array) when unset — see the v4->v5 migration note
		// above for why "no path" has exactly one representation.
		...(state.walkingPath && state.walkingPath.length > 0
			? { walkingPath: state.walkingPath.map((point) => ({ xPx: point.xPx, yPx: point.yPx })) }
			: {}),
		viewState
	};
}
