/**
 * The single parser for the toolkit boundary: `chainspot.course-geometry` version 1.
 *
 * Import data flow is screenshots in, course geometry out, nothing else crosses. The toolkit (its Calculation
 * `fn.tk.export.course`, contract `export.course@1`) reads the user's screenshot and writes ONE JSON file; this
 * module is the only place the app reads it. `holes` and `numberBadges` are exactly ProjectState v7's
 * `AnnotatedHole` and `HoleNumberBadgeAnchor`, so they go through the same strict readers a saved project does
 * (`readHoles`, `readNumberBadges`); nothing the CV is unsure of is ever inside them. Confidence, status and the
 * unproven candidates stay in `evidence` / `candidates`, for the correction UI.
 *
 * Coordinates are in the ORIGINAL UPLOAD frame (`source.frame`), px of the screenshot named by `source.sha256`.
 * Data conditions are results, not throws: every failure here is a structured `{ ok: false, error }`; a wrong
 * source (hash or size) is a visible message.
 */
import { createImageAsset, createProjectState, findImageByRole } from '../domain/project';
import type {
	AnnotatedHole,
	HoleNumberBadgeAnchor,
	ImageAsset,
	ProjectState
} from '../domain/project';
import { SchemaFailure, readHoles, readNumberBadges } from '../projectSchema';
import type { ProjectSchemaError } from '../projectSchema';

export const COURSE_GEOMETRY_FORMAT = 'chainspot.course-geometry';
export const COURSE_GEOMETRY_VERSION = 1;

export type HoleStatus = 'resolved' | 'straight' | 'partial' | 'unresolved';
export type ConfidenceLevel = 'confirmed' | 'unconfirmed' | 'noReading';

export interface CourseGeometryCandidate {
	readonly label: string;
	readonly xPx: number;
	readonly yPx: number;
	readonly kind: 'basket' | 'tee' | 'badge';
}

export interface HoleEvidence {
	readonly holeId: string;
	readonly status: HoleStatus;
	/** How sure the CV is of the route (a hallway sensor reading), outside `AnnotatedHole` by design. */
	readonly confidence: {
		readonly level: ConfidenceLevel;
		readonly sensor?: number | null;
		readonly stations?: number | null;
	};
	readonly tee?: { readonly state: string; readonly source?: string | null };
	readonly basket?: { readonly state: string };
	readonly trace?: {
		readonly outcome: string;
		readonly lengthPx?: number | null;
		/** ft along the route, from the file's C1 ground scale (`scale`); absent in files that predate it. */
		readonly lengthFt?: number | null;
		readonly bendCount?: number | null;
	};
	readonly reasons: readonly string[];
}

export interface CourseGeometrySource {
	readonly fileName: string;
	readonly sha256: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly frame: 'original-upload';
	readonly s0Crop: { readonly rowsRemovedTop: number; readonly rowsRemovedBottom: number };
}

/**
 * The ground scale, read off the screenshot itself: the C1 putting circle drawn around every basket is 10 m in radius,
 * so 10 m = `rC1Px` px of `source.frame` (LOCAL, measured on this image). Absent in files that predate it.
 */
export interface CourseGeometryScale {
	readonly rC1Px: number;
	readonly metresPerPx: number;
	readonly feetPerPx: number;
	readonly rule?: string;
}

/** The radius of the C1 putting circle, the scale's referent. */
export const C1_RADIUS_METRES = 10;
export const METRES_PER_FOOT = 0.3048;

/** The scale implied by a C1 radius measured in px of the screenshot. */
export function scaleFromC1Radius(rC1Px: number): CourseGeometryScale {
	const metresPerPx = C1_RADIUS_METRES / rC1Px;
	return { rC1Px, metresPerPx, feetPerPx: metresPerPx / METRES_PER_FOOT };
}

export interface CourseGeometry {
	readonly format: typeof COURSE_GEOMETRY_FORMAT;
	readonly version: typeof COURSE_GEOMETRY_VERSION;
	readonly producer: { readonly name: string; readonly recipe?: string; readonly attemptId?: string; readonly stagesRun?: readonly number[] };
	readonly source: CourseGeometrySource;
	readonly holes: readonly AnnotatedHole[];
	readonly numberBadges: readonly HoleNumberBadgeAnchor[];
	readonly candidates: readonly CourseGeometryCandidate[];
	readonly evidence: readonly HoleEvidence[];
	readonly units: Readonly<Record<string, string>>;
	/** Absent when the file carries no ground scale (lengths then stay in px). */
	readonly scale?: CourseGeometryScale;
}

export type CourseGeometryErrorCode =
	| 'malformed-json'
	| 'format.unknown'
	| 'version.unsupported'
	| 'structure.invalid'
	| 'source.sha256-mismatch'
	| 'source.size-mismatch'
	| 'geometry.invalid';

export interface CourseGeometryError {
	readonly code: CourseGeometryErrorCode;
	readonly path: string;
	readonly message: string;
	/** The strict reader's own error when the failure came from `holes` / `numberBadges`. */
	readonly schemaError?: ProjectSchemaError;
}

export interface CourseGeometryNotice {
	readonly code: 'source.sha256-unverified';
	readonly message: string;
}

export type CourseGeometryParseResult =
	| {
			readonly ok: true;
			readonly geometry: CourseGeometry;
			/** The project with the geometry loaded: its source image, `holes` and `numberBadges`. */
			readonly state: ProjectState;
			/** Holes the CV could not finish or is unsure of, for the correction UI (status not resolved / straight, or confidence not confirmed). */
			readonly needsReview: readonly HoleEvidence[];
			readonly notices: readonly CourseGeometryNotice[];
	  }
	| { readonly ok: false; readonly error: CourseGeometryError };

export interface ParseCourseGeometryOptions {
	/**
	 * The user's project. Its `source-overview` image must be the screenshot the geometry was read from:
	 * the sha256 (when the project has one) and the size are checked, and the geometry is loaded into a copy of
	 * this project. Absent, a new project holding only the geometry's own source image is made.
	 */
	readonly project?: ProjectState;
}

const STATUSES: readonly string[] = ['resolved', 'straight', 'partial', 'unresolved'];
const LEVELS: readonly string[] = ['confirmed', 'unconfirmed', 'noReading'];
const KINDS: readonly string[] = ['basket', 'tee', 'badge'];

const fail = (code: CourseGeometryErrorCode, path: string, message: string, schemaError?: ProjectSchemaError): CourseGeometryParseResult => ({
	ok: false,
	error: { code, path, message, ...(schemaError ? { schemaError } : {}) }
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);
const isPositiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function mimeTypeOf(fileName: string): string {
	const lower = fileName.toLowerCase();
	if (lower.endsWith('.png')) return 'image/png';
	if (lower.endsWith('.webp')) return 'image/webp';
	return 'image/jpeg';
}

function readSource(value: unknown): CourseGeometrySource | string {
	if (!isRecord(value)) return 'source must be an object';
	if (typeof value.fileName !== 'string') return 'source.fileName must be a string';
	if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) return 'source.sha256 must be 64 lowercase hex characters';
	if (!isPositiveInt(value.widthPx) || !isPositiveInt(value.heightPx)) return 'source.widthPx and source.heightPx must be positive integers';
	if (value.frame !== 'original-upload') return "source.frame must be 'original-upload'";
	const crop = value.s0Crop;
	if (!isRecord(crop) || !Number.isInteger(crop.rowsRemovedTop) || !Number.isInteger(crop.rowsRemovedBottom)) {
		return 'source.s0Crop must carry integer rowsRemovedTop and rowsRemovedBottom';
	}
	return {
		fileName: value.fileName,
		sha256: value.sha256,
		widthPx: value.widthPx,
		heightPx: value.heightPx,
		frame: 'original-upload',
		s0Crop: { rowsRemovedTop: crop.rowsRemovedTop as number, rowsRemovedBottom: crop.rowsRemovedBottom as number }
	};
}

/** Reads `scale`; its three numbers must agree (10 m = rC1Px px; 1 ft = 0.3048 m) to 0.1%. */
function readScale(value: unknown): CourseGeometryScale | undefined | string {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return 'scale must be an object';
	const { rC1Px, metresPerPx, feetPerPx, rule } = value;
	if (!isFiniteNumber(rC1Px) || rC1Px <= 0 || !isFiniteNumber(metresPerPx) || metresPerPx <= 0 || !isFiniteNumber(feetPerPx) || feetPerPx <= 0) {
		return 'scale needs positive rC1Px, metresPerPx and feetPerPx';
	}
	const implied = scaleFromC1Radius(rC1Px);
	const agrees = (a: number, b: number) => Math.abs(a - b) <= 1e-3 * b;
	if (!agrees(metresPerPx, implied.metresPerPx) || !agrees(feetPerPx, implied.feetPerPx)) {
		return `scale is inconsistent: rC1Px ${rC1Px} implies ${implied.metresPerPx} m/px and ${implied.feetPerPx} ft/px`;
	}
	return { rC1Px, metresPerPx, feetPerPx, ...(typeof rule === 'string' ? { rule } : {}) };
}

function readCandidates(value: unknown): CourseGeometryCandidate[] | string {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return 'candidates must be an array';
	const out: CourseGeometryCandidate[] = [];
	for (const [index, item] of value.entries()) {
		if (!isRecord(item) || typeof item.label !== 'string' || !isFiniteNumber(item.xPx) || !isFiniteNumber(item.yPx) || !KINDS.includes(item.kind as string)) {
			return `candidates[${index}] needs a label, finite xPx / yPx and a kind of basket, tee or badge`;
		}
		out.push({ label: item.label, xPx: item.xPx, yPx: item.yPx, kind: item.kind as CourseGeometryCandidate['kind'] });
	}
	return out;
}

function readEvidence(value: unknown, holeIds: ReadonlySet<string>): HoleEvidence[] | string {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return 'evidence must be an array';
	const out: HoleEvidence[] = [];
	for (const [index, item] of value.entries()) {
		const path = `evidence[${index}]`;
		if (!isRecord(item) || typeof item.holeId !== 'string') return `${path}.holeId must be a string`;
		if (!holeIds.has(item.holeId)) return `${path}.holeId '${item.holeId}' is not one of the holes`;
		if (!STATUSES.includes(item.status as string)) return `${path}.status must be one of ${STATUSES.join(', ')}`;
		const confidence = item.confidence;
		if (!isRecord(confidence) || !LEVELS.includes(confidence.level as string)) return `${path}.confidence.level must be one of ${LEVELS.join(', ')}`;
		const reasons = item.reasons ?? [];
		if (!Array.isArray(reasons) || !reasons.every((reason) => typeof reason === 'string')) return `${path}.reasons must be an array of strings`;
		out.push(item as unknown as HoleEvidence);
	}
	return out;
}

/** Whether a hole's evidence asks the user to look: not resolved or straight, or a route the CV did not confirm. */
export function needsReview(evidence: HoleEvidence): boolean {
	return (evidence.status !== 'resolved' && evidence.status !== 'straight') || evidence.confidence.level !== 'confirmed';
}

/**
 * Parses the text of a `chainspot.course-geometry` file. See the module comment for the contract; every failure is a
 * returned error. With `options.project`, the geometry is checked against that project's source image and loaded into
 * a copy of it.
 */
export function parseCourseGeometry(text: string, options: ParseCourseGeometryOptions = {}): CourseGeometryParseResult {
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch (error) {
		return fail('malformed-json', '', `course geometry is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(root) || root.format !== COURSE_GEOMETRY_FORMAT) {
		return fail('format.unknown', 'format', `not a ${COURSE_GEOMETRY_FORMAT} file`);
	}
	if (root.version !== COURSE_GEOMETRY_VERSION) {
		return fail(
			'version.unsupported',
			'version',
			`unsupported ${COURSE_GEOMETRY_FORMAT} version ${String(root.version)}; this build reads version ${COURSE_GEOMETRY_VERSION}`
		);
	}
	const source = readSource(root.source);
	if (typeof source === 'string') return fail('structure.invalid', 'source', source);

	const projectSource = options.project ? findImageByRole(options.project.images, 'source-overview') : undefined;
	const notices: CourseGeometryNotice[] = [];
	if (projectSource) {
		if (projectSource.sha256 === null) {
			notices.push({ code: 'source.sha256-unverified', message: `the project's source image has no sha256, so the geometry cannot be checked against it (geometry read from ${source.fileName})` });
		} else if (projectSource.sha256 !== source.sha256) {
			return fail(
				'source.sha256-mismatch',
				'source.sha256',
				`this geometry was read from a different screenshot (${source.fileName}, sha256 ${source.sha256.slice(0, 12)}) than the one loaded (${projectSource.fileName}, sha256 ${projectSource.sha256.slice(0, 12)})`
			);
		}
		if (projectSource.widthPx !== source.widthPx || projectSource.heightPx !== source.heightPx) {
			return fail(
				'source.size-mismatch',
				'source',
				`the geometry is in a ${source.widthPx} x ${source.heightPx} px frame; the loaded source image is ${projectSource.widthPx} x ${projectSource.heightPx} px`
			);
		}
	}

	const sourceImage: ImageAsset =
		projectSource ??
		createImageAsset({
			role: 'source-overview',
			fileName: source.fileName,
			mimeType: mimeTypeOf(source.fileName),
			widthPx: source.widthPx,
			heightPx: source.heightPx,
			sha256: source.sha256,
			id: 'source-overview'
		});

	let holes: AnnotatedHole[];
	let numberBadges: HoleNumberBadgeAnchor[];
	try {
		holes = readHoles(root.holes, [sourceImage]);
		numberBadges = readNumberBadges(root.numberBadges, [sourceImage]);
	} catch (error) {
		if (error instanceof SchemaFailure) return fail('geometry.invalid', error.error.path, error.error.message, error.error);
		throw error;
	}
	const scale = readScale(root.scale);
	if (typeof scale === 'string') return fail('structure.invalid', 'scale', scale);
	const candidates = readCandidates(root.candidates);
	if (typeof candidates === 'string') return fail('structure.invalid', 'candidates', candidates);
	const evidence = readEvidence(root.evidence, new Set(holes.map((hole) => hole.id)));
	if (typeof evidence === 'string') return fail('structure.invalid', 'evidence', evidence);

	const producer = isRecord(root.producer) && typeof root.producer.name === 'string' ? (root.producer as CourseGeometry['producer']) : { name: 'unknown' };
	const units = isRecord(root.units) ? (root.units as Record<string, string>) : {};
	const geometry: CourseGeometry = {
		format: COURSE_GEOMETRY_FORMAT,
		version: COURSE_GEOMETRY_VERSION,
		producer,
		source,
		holes,
		numberBadges,
		candidates,
		evidence,
		units,
		...(scale ? { scale } : {})
	};

	const base = options.project ?? { ...createProjectState({ name: source.fileName }), images: [sourceImage] };
	const state: ProjectState = { ...base, holes, numberBadges };
	return { ok: true, geometry, state, needsReview: evidence.filter(needsReview), notices };
}
