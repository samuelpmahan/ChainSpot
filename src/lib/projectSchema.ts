/**
 * ChainSpot versioned project document — serialization, validation, and migration.
 *
 * The saved document (`ProjectDocumentV2`) is the durable, portable boundary of a
 * ChainSpot project. It wraps the plain authoritative domain state (`ProjectState` from
 * P0-002) with an explicit `schemaVersion` and stores derived normalized coordinates
 * alongside the authoritative pixel coordinates:
 *
 *   { "schemaVersion": 2,
 *     "project": { "id", "name", "createdAt", "updatedAt" },
 *     "images": [ <source-overview manifest>, <target-basemap manifest> ],
 *     "controlPointPairs": [ <complete pair with source/target pixel + normalized points> ],
 *     "holes": [ <hole with tee/basket/ordered shots/corridor in source-image pixels> ],
 *     "viewState": null | { "source": {"zoom","panX","panY"}, "target": {...} } }
 *
 * Versions: v1 documents (written before hole annotation existed) are still readable and
 * are migrated forward by treating `holes` as empty — the only difference between the two
 * versions. The version was bumped rather than adding `holes` as an optional v1 field on
 * purpose: unknown fields are dropped on re-serialization, so a v1-only build opening a
 * document with holes would silently discard them on the next save. A version bump makes
 * that case fail loudly with `schema.version.unsupported` instead of losing user work.
 *
 * Coordinate rule (detailed plan section 9.2): pixel coordinates remain authoritative.
 * Normalized values are derived on serialization from pixels and intrinsic dimensions and
 * are only checked (never trusted) on load. A present finite normalized value that does
 * not match the pixels is tolerated: pixels win, the stored value is discarded, and the
 * next serialization emits the corrected value. Missing normalized values are accepted.
 * An invalid-type or non-finite normalized value is a structured failure (no coercion).
 *
 * Validation order: the root must be a plain object and `schemaVersion` is read and
 * checked before anything else, so an unsupported version (any value other than 1, with
 * newer versions clearly classified) fails before any other validation and never leads to
 * partial state replacement. Unknown fields at every level of a supported version are
 * ignored during parsing and are never emitted by the serializer, so they cannot survive
 * a re-serialization.
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
 * is used; validation and the single v1 -> v2 migration are explicit and close to the
 * versioned document definition.
 */

import { pointInBounds, toNormalizedCoordinates } from './coords';
import type {
	AnnotatedHole,
	ControlPointPair,
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
import { IMAGE_ROLES, MIN_CORRIDOR_POINTS } from './domain/project';

/** The schema version written by this build. */
export const CURRENT_SCHEMA_VERSION = 2 as const;

/** Every version this build can read; older ones are migrated forward on parse. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2];

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

export interface ProjectDocumentV2 {
	schemaVersion: 2;
	project: ProjectMetadata;
	images: ImageAsset[];
	controlPointPairs: ControlPointPairV1[];
	holes: AnnotatedHole[];
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
	| 'view';

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
		const image: ImageAsset = {
			id: readNonEmptyString(object.id, `images[${index}].id`),
			role,
			fileName: readString(object.fileName, `images[${index}].fileName`),
			mimeType: readString(object.mimeType, `images[${index}].mimeType`),
			widthPx: readPositiveInt(object.widthPx, `images[${index}].widthPx`),
			heightPx: readPositiveInt(object.heightPx, `images[${index}].heightPx`),
			sha256: readStringOrNull(object.sha256, `images[${index}].sha256`),
			bundlePath: readStringOrNull(object.bundlePath, `images[${index}].bundlePath`)
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

		let corridor: SourcePoint[] | undefined;
		if (object.corridor !== undefined && object.corridor !== null) {
			if (!Array.isArray(object.corridor)) {
				throw failure(
					'hole',
					'hole.corridor.type',
					`${path}.corridor`,
					`${path}.corridor must be an array`
				);
			}
			if (object.corridor.length < MIN_CORRIDOR_POINTS) {
				throw failure(
					'hole',
					'hole.corridor.too-few',
					`${path}.corridor`,
					`${path}.corridor must have at least ${MIN_CORRIDOR_POINTS} vertices, got ${object.corridor.length}`
				);
			}
			corridor = object.corridor.map((point, pointIndex) =>
				readHolePoint(point, `${path}.corridor[${pointIndex}]`, sourceImage)
			);
		}

		const hole: AnnotatedHole = {
			id,
			number,
			shots,
			...(object.tee !== undefined && object.tee !== null
				? { tee: readHolePoint(object.tee, `${path}.tee`, sourceImage) }
				: {}),
			...(object.basket !== undefined && object.basket !== null
				? { basket: readHolePoint(object.basket, `${path}.basket`, sourceImage) }
				: {}),
			...(corridor ? { corridor } : {})
		};
		holes.push(hole);
	}
	return holes;
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
	// Migration v1 -> v2: v1 predates hole annotation and simply has no `holes`, which
	// `readHoles` already reads as an empty list. Reading it unconditionally keeps the
	// migration a single well-defined default rather than a separate transform pass.
	const holes = readHoles(root.holes, images);
	const viewState = readViewState(root.viewState);

	return { project, images, controlPointPairs: pairs, holes, viewState };
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
 * Validates durable `ProjectState` and throws a structured `ProjectSchemaError` on any
 * invalid domain value (non-finite or out-of-bounds coordinates, missing image role,
 * duplicate/colliding ids, invalid dimensions, incomplete/wrong references, invalid view
 * state). This prevalidation guarantees a serialized document can never contain a
 * non-finite value that would be silently stringified as JSON `null`.
 */
function validateState(state: ProjectState): void {
	const project = readProject(state.project);
	const images = readImages(state.images);
	const pairs = readPairs(state.controlPointPairs, images);
	assertUniqueIds(project, images, pairs);
	readHoles(state.holes, images);
	readViewState(state.viewState);
}

/**
 * Serializes durable `ProjectState` into a fresh schema-v1 document. The output contains
 * only recognized document fields (no transient or unknown data is spread in) and derives
 * normalized coordinates from the authoritative pixels and intrinsic dimensions; the
 * returned document never stores normalized state back into the domain. Throws a
 * structured `ProjectSchemaError` when the domain state is invalid.
 */
export function serializeProjectState(state: ProjectState): ProjectDocumentV2 {
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
			bundlePath: image.bundlePath
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
			...(hole.tee ? { tee: { xPx: hole.tee.xPx, yPx: hole.tee.yPx } } : {}),
			...(hole.basket ? { basket: { xPx: hole.basket.xPx, yPx: hole.basket.yPx } } : {}),
			...(hole.corridor
				? { corridor: hole.corridor.map((point) => ({ xPx: point.xPx, yPx: point.yPx })) }
				: {})
		})),
		viewState
	};
}
