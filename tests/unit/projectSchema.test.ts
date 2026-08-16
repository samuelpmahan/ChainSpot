import { describe, expect, it } from 'vitest';
import { ProjectEditor } from '../../src/lib/domain/editor';
import type { ImageAsset, ProjectState } from '../../src/lib/domain/project';
import {
	CURRENT_SCHEMA_VERSION,
	parseProjectDocument,
	parseProjectJson,
	serializeProjectState
} from '../../src/lib/projectSchema';
import type {
	ProjectDocumentV4,
	ProjectParseResult,
	ProjectSchemaError,
	ProjectSchemaErrorCategory
} from '../../src/lib/projectSchema';
import {
	applySourceTransform,
	AUTO_SOURCE_CAPTURE_ORIGIN,
	buildSourceTransform,
	CURRENT_PROVENANCE_SCHEMA_VERSION,
	CURRENT_RENDER_VERSION,
	identitySourceTransform,
	translationSourceTransform
} from '../../src/lib/domain/provenance';
import type { CompositeProvenance, SourceCapture, SourceCropRect } from '../../src/lib/domain/provenance';

const FIXED_TIMESTAMP = '2026-08-02T00:00:00.000Z';

function sourceAsset(overrides: Partial<ImageAsset> = {}): ImageAsset {
	return {
		id: 'image-source',
		role: 'source-overview',
		fileName: 'udisc-overview.png',
		mimeType: 'image/png',
		widthPx: 1179,
		heightPx: 2556,
		sha256: 'a'.repeat(64),
		bundlePath: 'images/source-original.png',
		...overrides
	};
}

function targetAsset(overrides: Partial<ImageAsset> = {}): ImageAsset {
	return {
		id: 'image-target',
		role: 'target-basemap',
		fileName: 'clean-map.png',
		mimeType: 'image/png',
		widthPx: 1600,
		heightPx: 1200,
		sha256: null,
		bundlePath: null,
		...overrides
	};
}

function buildState(overrides: Partial<ProjectState> = {}): ProjectState {
	return {
		project: {
			id: 'project-1',
			name: 'Sample Round',
			createdAt: FIXED_TIMESTAMP,
			updatedAt: FIXED_TIMESTAMP
		},
		images: [sourceAsset(), targetAsset()],
		controlPointPairs: [
			{
				id: 'cp-0001',
				ordinal: 1,
				label: 'Parking corner',
				enabled: true,
				source: { imageId: 'image-source', xPx: 748.25, yPx: 720.5 },
				target: { imageId: 'image-target', xPx: 788.0, yPx: 403.25 },
				createdAt: FIXED_TIMESTAMP,
				updatedAt: FIXED_TIMESTAMP
			},
			{
				id: 'cp-0003',
				ordinal: 3,
				label: null,
				enabled: false,
				source: { imageId: 'image-source', xPx: 0.5, yPx: 2555.5 },
				target: { imageId: 'image-target', xPx: 1599.25, yPx: 0.25 },
				createdAt: FIXED_TIMESTAMP,
				updatedAt: FIXED_TIMESTAMP
			}
		],
		holes: [],
		numberBadges: [],
		viewState: {
			source: { zoom: 1.4, panX: -92, panY: 17 },
			target: { zoom: 1.1, panX: 0, panY: -35 }
		},
		...overrides
	};
}

function docFromState(state: ProjectState): ProjectDocumentV4 {
	return serializeProjectState(state);
}

/** Deep plain-object copy of a serialized document so tests can mutate fields freely. */
function plainDoc(state: ProjectState): Record<string, unknown> {
	return JSON.parse(JSON.stringify(docFromState(state))) as Record<string, unknown>;
}

function expectParsedState(state: ProjectState): ProjectState {
	const result = parseProjectDocument(JSON.parse(JSON.stringify(docFromState(state))));
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(`expected parse to succeed: ${result.error.message}`);
	return result.state;
}

function expectDocumentOk(doc: unknown): ProjectState {
	const result = parseProjectDocument(doc);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(`expected parse to succeed: ${result.error.message}`);
	return result.state;
}

function expectError(
	value: unknown,
	category: ProjectSchemaErrorCategory,
	code?: string,
	path?: string
): ProjectSchemaError {
	const result = parseProjectDocument(value);
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error('expected a structured parse failure');
	expect(result.error.category).toBe(category);
	expect(result.error.message.length).toBeGreaterThan(0);
	if (code !== undefined) expect(result.error.code).toBe(code);
	if (path !== undefined) expect(result.error.path).toBe(path);
	return result.error;
}

function expectJsonError(text: string, category: ProjectSchemaErrorCategory, code?: string): ProjectSchemaError {
	const result = parseProjectJson(text);
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error('expected a structured parse failure');
	expect(result.error.category).toBe(category);
	expect(result.error.message.length).toBeGreaterThan(0);
	if (code !== undefined) expect(result.error.code).toBe(code);
	return result.error;
}

function expectSerializeError(
	state: ProjectState,
	category: ProjectSchemaErrorCategory,
	code?: string,
	path?: string
): ProjectSchemaError {
	let thrown: unknown;
	try {
		serializeProjectState(state);
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeDefined();
	const error = thrown as ProjectSchemaError;
	expect(error.category).toBe(category);
	expect(typeof error.code).toBe('string');
	expect(typeof error.path).toBe('string');
	expect(error.message.length).toBeGreaterThan(0);
	if (code !== undefined) expect(error.code).toBe(code);
	if (path !== undefined) expect(error.path).toBe(path);
	return error;
}

describe('schema round trip', () => {
	it('serializes and parses a representative project byte-for-byte without coordinate drift', () => {
		const state = buildState();
		const doc = docFromState(state);
		expect(doc.schemaVersion).toBe(7);

		const result = parseProjectDocument(JSON.parse(JSON.stringify(doc)));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(JSON.stringify(result.state)).toBe(JSON.stringify(state));
		}
	});

	it('round-trips through the JSON text entry point', () => {
		const state = buildState();
		const result = parseProjectJson(JSON.stringify(docFromState(state)));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(JSON.stringify(result.state)).toBe(JSON.stringify(state));
		}
	});

	it('preserves fractional points, labels/null, enabled/disabled, noncontiguous ordinals, assets, and view', () => {
		const state = buildState();
		const parsed = expectParsedState(state);

		expect(parsed.project).toEqual(state.project);
		expect(parsed.images).toEqual(state.images);
		expect(parsed.viewState).toEqual(state.viewState);

		expect(parsed.controlPointPairs).toHaveLength(2);
		expect(parsed.controlPointPairs[0]).toEqual(state.controlPointPairs[0]);
		expect(parsed.controlPointPairs[1]).toEqual(state.controlPointPairs[1]);
		expect(parsed.controlPointPairs.map((pair) => pair.ordinal)).toEqual([1, 3]);
		expect(parsed.controlPointPairs[0].label).toBe('Parking corner');
		expect(parsed.controlPointPairs[1].label).toBeNull();
		expect(parsed.controlPointPairs[0].enabled).toBe(true);
		expect(parsed.controlPointPairs[1].enabled).toBe(false);
		expect(parsed.images[0].sha256).toBe('a'.repeat(64));
		expect(parsed.images[1].sha256).toBeNull();
		expect(parsed.images[0].bundlePath).toBe('images/source-original.png');
		expect(parsed.images[1].bundlePath).toBeNull();
	});

	it('derives normalized values on serialization from pixels and intrinsic dimensions', () => {
		const doc = docFromState(buildState());
		expect(doc.controlPointPairs[0].source.xNorm).toBeCloseTo(748.25 / 1179, 12);
		expect(doc.controlPointPairs[0].source.yNorm).toBeCloseTo(720.5 / 2556, 12);
		expect(doc.controlPointPairs[0].target.xNorm).toBeCloseTo(788.0 / 1600, 12);
		expect(doc.controlPointPairs[0].target.yNorm).toBeCloseTo(403.25 / 1200, 12);
		expect(doc.controlPointPairs[1].source.xNorm).toBeCloseTo(0.5 / 1179, 12);
		expect(doc.controlPointPairs[1].source.yNorm).toBeCloseTo(2555.5 / 2556, 12);
	});

	it('emits a fresh recognized document that shares nothing with the source state', () => {
		const state = buildState();
		const first = docFromState(state);
		const second = docFromState(state);

		first.project.name = 'mutated';
		(first.images[0] as { widthPx: number }).widthPx = 1;
		(first.controlPointPairs[0].source as { xPx: number }).xPx = -5;

		expect(state.project.name).toBe('Sample Round');
		expect(state.images[0].widthPx).toBe(1179);
		expect(state.controlPointPairs[0].source.xPx).toBe(748.25);
		expect(JSON.stringify(second)).not.toBe(JSON.stringify(first));
	});

	it('ignores unknown fields at every level and drops them on re-serialization', () => {
		const state = buildState();
		const doc = plainDoc(state);
		(doc as Record<string, unknown>).registrations = [];
		(doc as Record<string, unknown>).history = {};
		(doc.project as Record<string, unknown>).notes = 'ignored';
		((doc.images as Array<Record<string, unknown>>)[0] as Record<string, unknown>).decodedBytes = 'ignored';
		((doc.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).pending = true;
		(
			(doc.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>
		).source = {
			...((doc.controlPointPairs as Array<Record<string, unknown>>)[0].source as Record<string, unknown>),
			screen: { x: 1, y: 2 }
		} as Record<string, unknown>;
		((doc.viewState as Record<string, unknown>).source as Record<string, unknown>).fitted = true;

		const parsed = expectDocumentOk(doc);

		const reserialized = serializeProjectState(parsed);
		expect(reserialized).toEqual(docFromState(state));
		expect('registrations' in reserialized).toBe(false);
		expect('history' in reserialized).toBe(false);
		expect('notes' in reserialized.project).toBe(false);
		expect('decodedBytes' in reserialized.images[0]).toBe(false);
		expect('pending' in reserialized.controlPointPairs[0]).toBe(false);
		expect('screen' in reserialized.controlPointPairs[0].source).toBe(false);
		expect('fitted' in reserialized.viewState!.source).toBe(false);
	});
});

describe('normalized coordinate handling', () => {
	it('accepts exact normalized values', () => {
		const doc = docFromState(buildState());
		const result = parseProjectDocument(JSON.parse(JSON.stringify(doc)));
		expect(result.ok).toBe(true);
	});

	it('accepts missing normalized values', () => {
		const doc = plainDoc(buildState());
		const pairs = doc.controlPointPairs as Array<Record<string, unknown>>;
		const source = pairs[0].source as Record<string, unknown>;
		delete source.xNorm;
		delete source.yNorm;
		const target = pairs[1].target as Record<string, unknown>;
		delete target.xNorm;
		delete target.yNorm;
		const parsed = expectDocumentOk(doc);
		expect(parsed.controlPointPairs[0].source).toEqual({ imageId: 'image-source', xPx: 748.25, yPx: 720.5 });
	});

	it('tolerates a finite mismatch: pixels win, the stored norm is discarded, and the next serialization corrects it', () => {
		const doc = plainDoc(buildState());
		((doc.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).source = {
			imageId: 'image-source',
			xPx: 748.25,
			yPx: 720.5,
			xNorm: 0.5,
			yNorm: 0.25
		};

		const result = parseProjectDocument(doc);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.state.controlPointPairs[0].source).toEqual({
				imageId: 'image-source',
				xPx: 748.25,
				yPx: 720.5
			});
			const reserialized = serializeProjectState(result.state);
			expect(reserialized.controlPointPairs[0].source.xNorm).toBeCloseTo(748.25 / 1179, 12);
			expect(reserialized.controlPointPairs[0].source.yNorm).toBeCloseTo(720.5 / 2556, 12);
		}
	});

	it('rejects an invalid-type normalized value without coercion', () => {
		const doc = plainDoc(buildState());
		((doc.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).source = {
			imageId: 'image-source',
			xPx: 748.25,
			yPx: 720.5,
			xNorm: '0.6',
			yNorm: 0.25
		};
		const error = expectError(doc, 'normalized', 'normalized.type');
		expect(error.path).toContain('xNorm');
	});

	it('rejects a non-finite normalized value', () => {
		const doc = plainDoc(buildState());
		((doc.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).source = {
			imageId: 'image-source',
			xPx: 748.25,
			yPx: 720.5,
			xNorm: Number.NaN,
			yNorm: 0.25
		};
		const error = expectError(doc, 'normalized', 'normalized.non-finite');
		expect(error.path).toContain('xNorm');
	});
});

describe('JSON entry point and document root', () => {
	it('distinguishes malformed JSON from schema failures', () => {
		const error = expectJsonError('{"schemaVersion": 1,', 'malformed-json', 'json.parse');
		expect(error.message).toContain('not valid JSON');
		expectJsonError('not json at all', 'malformed-json');
		expectJsonError('', 'malformed-json');
	});

	it('rejects null, array, and primitive roots', () => {
		expectError(null, 'required-type', 'schema.root.object');
		expectError([], 'required-type', 'schema.root.object');
		expectError('text', 'required-type', 'schema.root.object');
		expectError(42, 'required-type', 'schema.root.object');
		expectError(true, 'required-type', 'schema.root.object');
	});
});

describe('schema version validation', () => {
	it('requires an explicit schemaVersion', () => {
		const doc = plainDoc(buildState());
		delete doc.schemaVersion;
		expectError(doc, 'required-type', 'schema.schemaVersion.missing', 'schemaVersion');
	});

	it('rejects a non-number schemaVersion', () => {
		const doc = plainDoc(buildState());
		doc.schemaVersion = '1';
		expectError(doc, 'required-type', 'schema.schemaVersion.type', 'schemaVersion');
	});

	it('classifies a newer unsupported version before any other validation', () => {
		const doc = plainDoc(buildState());
		doc.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
		doc.project = undefined;
		doc.images = 'not-an-array';
		const error = expectError(doc, 'unsupported-version', 'schema.version.unsupported', 'schemaVersion');
		expect(error.message).toContain('newer');
		expect(error.message).toContain(String(CURRENT_SCHEMA_VERSION + 1));
	});

	it('rejects older or otherwise unknown numeric versions', () => {
		const doc = plainDoc(buildState());
		doc.schemaVersion = 0;
		expectError(doc, 'unsupported-version', 'schema.version.unsupported', 'schemaVersion');

		const next = plainDoc(buildState());
		next.schemaVersion = 1.5;
		expectError(next, 'unsupported-version', 'schema.version.unsupported', 'schemaVersion');
	});

	it('exposes the single supported current version constant', () => {
		expect(CURRENT_SCHEMA_VERSION).toBe(7);
		expect(typeof CURRENT_SCHEMA_VERSION).toBe('number');
	});
});

describe('required primitive types and no coercion', () => {
	it('validates project metadata field types without coercion', () => {
		const doc = plainDoc(buildState());
		((doc.project as Record<string, unknown>).id as unknown) = 42;
		expectError(doc, 'required-type', 'required.type', 'project.id');

		const emptyId = plainDoc(buildState());
		(emptyId.project as Record<string, unknown>).id = '';
		expectError(emptyId, 'required-type', 'required.nonempty', 'project.id');

		const name = plainDoc(buildState());
		(name.project as Record<string, unknown>).name = 42;
		expectError(name, 'required-type', 'required.type', 'project.name');

		const createdAt = plainDoc(buildState());
		(createdAt.project as Record<string, unknown>).createdAt = 42;
		expectError(createdAt, 'required-type', 'required.type', 'project.createdAt');

		const updatedAt = plainDoc(buildState());
		(updatedAt.project as Record<string, unknown>).updatedAt = null;
		expectError(updatedAt, 'required-type', 'required.type', 'project.updatedAt');
	});

	it('validates image manifest field types', () => {
		const emptyId = plainDoc(buildState());
		((emptyId.images as Array<Record<string, unknown>>)[0] as Record<string, unknown>).id = '';
		expectError(emptyId, 'required-type', 'required.nonempty', 'images[0].id');

		const fileName = plainDoc(buildState());
		((fileName.images as Array<Record<string, unknown>>)[0] as Record<string, unknown>).fileName = 42;
		expectError(fileName, 'required-type', 'required.type', 'images[0].fileName');

		const mimeType = plainDoc(buildState());
		((mimeType.images as Array<Record<string, unknown>>)[0] as Record<string, unknown>).mimeType = null;
		expectError(mimeType, 'required-type', 'required.type', 'images[0].mimeType');

		const sha256 = plainDoc(buildState());
		((sha256.images as Array<Record<string, unknown>>)[0] as Record<string, unknown>).sha256 = 42;
		expectError(sha256, 'image-manifest', 'manifest.nullable-string', 'images[0].sha256');

		const bundlePath = plainDoc(buildState());
		((bundlePath.images as Array<Record<string, unknown>>)[0] as Record<string, unknown>).bundlePath =
			false;
		expectError(bundlePath, 'image-manifest', 'manifest.nullable-string', 'images[0].bundlePath');
	});

	it('validates pair field types without coercion', () => {
		const emptyId = plainDoc(buildState());
		((emptyId.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).id = '';
		expectError(emptyId, 'required-type', 'required.nonempty', 'controlPointPairs[0].id');

		const ordinalZero = plainDoc(buildState());
		((ordinalZero.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).ordinal = 0;
		expectError(ordinalZero, 'required-type', 'pair.ordinal.invalid', 'controlPointPairs[0].ordinal');

		const ordinalFloat = plainDoc(buildState());
		((ordinalFloat.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).ordinal = 1.5;
		expectError(ordinalFloat, 'required-type', 'pair.ordinal.invalid', 'controlPointPairs[0].ordinal');

		const ordinalString = plainDoc(buildState());
		((ordinalString.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).ordinal = '1';
		expectError(ordinalString, 'required-type', 'pair.ordinal.invalid', 'controlPointPairs[0].ordinal');

		const label = plainDoc(buildState());
		((label.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).label = 42;
		expectError(label, 'required-type', 'required.type', 'controlPointPairs[0].label');

		const enabled = plainDoc(buildState());
		((enabled.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).enabled = 'true';
		expectError(enabled, 'required-type', 'required.type', 'controlPointPairs[0].enabled');

		const createdAt = plainDoc(buildState());
		((createdAt.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).createdAt = 42;
		expectError(createdAt, 'required-type', 'required.type', 'controlPointPairs[0].createdAt');

		const updatedAt = plainDoc(buildState());
		((updatedAt.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).updatedAt = null;
		expectError(updatedAt, 'required-type', 'required.type', 'controlPointPairs[0].updatedAt');
	});

	it('never coerces a coordinate-like string or number across field kinds', () => {
		const doc = plainDoc(buildState());
		((doc.images as Array<Record<string, unknown>>)[0] as Record<string, unknown>).widthPx = '1179';
		expectError(doc, 'dimension', 'dimension.invalid', 'images[0].widthPx');

		const xPx = plainDoc(buildState());
		((xPx.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).source = {
			imageId: 'image-source',
			xPx: '748.25',
			yPx: 720.5
		};
		expectError(xPx, 'coordinate', 'coordinate.type', 'controlPointPairs[0].source.xPx');
	});
});

describe('image manifest cardinality, roles, and dimensions', () => {
	it('requires exactly one source-overview and one target-basemap image', () => {
		const none = plainDoc(buildState());
		none.images = [];
		expectError(none, 'image-manifest', 'images.cardinality', 'images');

		const onlySource = plainDoc(buildState());
		onlySource.images = [sourceAsset()];
		expectError(onlySource, 'image-manifest', 'images.cardinality', 'images');

		const three = plainDoc(buildState());
		three.images = [sourceAsset(), targetAsset(), targetAsset({ id: 'image-target-2' })];
		expectError(three, 'image-manifest', 'images.cardinality', 'images');

		const twoSources = plainDoc(buildState());
		twoSources.images = [sourceAsset(), sourceAsset({ id: 'image-source-2' })];
		expectError(twoSources, 'image-manifest', 'images.cardinality', 'images');
	});

	it('rejects an unknown image role', () => {
		const doc = plainDoc(buildState());
		((doc.images as Array<Record<string, unknown>>)[0] as Record<string, unknown>).role = 'basemap';
		expectError(doc, 'image-role', 'role.unknown', 'images[0].role');
	});

	it('rejects non-positive, non-finite, or non-integer dimensions', () => {
		for (const value of [0, -1, 100.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const width = plainDoc(buildState());
			((width.images as Array<Record<string, unknown>>)[0] as Record<string, unknown>).widthPx = value;
			expectError(width, 'dimension', 'dimension.invalid', 'images[0].widthPx');

			const height = plainDoc(buildState());
			((height.images as Array<Record<string, unknown>>)[1] as Record<string, unknown>).heightPx = value;
			expectError(height, 'dimension', 'dimension.invalid', 'images[1].heightPx');
		}
	});
});

describe('duplicate and colliding ids and ordinals', () => {
	it('rejects duplicate and colliding project/image/pair ids', () => {
		const duplicateImages = plainDoc(buildState());
		const dupImages = duplicateImages.images as Array<Record<string, unknown>>;
		dupImages[1].id = 'image-source';
		for (const pair of duplicateImages.controlPointPairs as Array<Record<string, unknown>>) {
			(pair.target as Record<string, unknown>).imageId = 'image-source';
		}
		expectError(duplicateImages, 'duplicate-id', 'id.duplicate');

		const duplicatePairs = plainDoc(buildState());
		((duplicatePairs.controlPointPairs as Array<Record<string, unknown>>)[1] as Record<string, unknown>).id =
			'cp-0001';
		expectError(duplicatePairs, 'duplicate-id', 'id.duplicate');

		const pairCollidesImage = plainDoc(buildState());
		((pairCollidesImage.controlPointPairs as Array<Record<string, unknown>>)[1] as Record<string, unknown>).id =
			'image-source';
		expectError(pairCollidesImage, 'duplicate-id', 'id.duplicate');

		const imageCollidesProject = plainDoc(buildState());
		const collImages = imageCollidesProject.images as Array<Record<string, unknown>>;
		collImages[1].id = 'project-1';
		for (const pair of imageCollidesProject.controlPointPairs as Array<Record<string, unknown>>) {
			(pair.target as Record<string, unknown>).imageId = 'project-1';
		}
		expectError(imageCollidesProject, 'duplicate-id', 'id.duplicate');
	});

	it('rejects duplicate ordinals while accepting non-contiguous ones', () => {
		const duplicateOrdinal = plainDoc(buildState());
		((duplicateOrdinal.controlPointPairs as Array<Record<string, unknown>>)[1] as Record<string, unknown>).ordinal = 1;
		const error = expectError(duplicateOrdinal, 'reference', 'pair.ordinal-duplicate');
		expect(error.path).toContain('ordinal');

		const nonContiguous = plainDoc(buildState());
		((nonContiguous.controlPointPairs as Array<Record<string, unknown>>)[1] as Record<string, unknown>).ordinal = 42;
		expectDocumentOk(nonContiguous);
	});
});

describe('references and pair completeness', () => {
	it('rejects an unknown source or target image reference', () => {
		const source = plainDoc(buildState());
		((source.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).source = {
			imageId: 'missing-image',
			xPx: 1,
			yPx: 1
		};
		expectError(source, 'reference', 'reference.unknown-image');

		const target = plainDoc(buildState());
		((target.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).target = {
			imageId: 'missing-image',
			xPx: 1,
			yPx: 1
		};
		expectError(target, 'reference', 'reference.unknown-image');
	});

	it('rejects swapped or wrong-role references on either side', () => {
		const swappedSource = plainDoc(buildState());
		((swappedSource.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).source = {
			imageId: 'image-target',
			xPx: 1,
			yPx: 1
		};
		expectError(swappedSource, 'reference', 'reference.swapped');

		const swappedTarget = plainDoc(buildState());
		((swappedTarget.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).target = {
			imageId: 'image-source',
			xPx: 1,
			yPx: 1
		};
		expectError(swappedTarget, 'reference', 'reference.swapped');

		const bothPointAtSource = plainDoc(buildState());
		((bothPointAtSource.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).target = {
			imageId: 'image-source',
			xPx: 1,
			yPx: 1
		};
		expectError(bothPointAtSource, 'reference', 'reference.swapped');
	});

	it('rejects incomplete pairs (missing either side)', () => {
		const missingSource = plainDoc(buildState());
		delete (missingSource.controlPointPairs as Array<Record<string, unknown>>)[0]
			.source;
		expectError(missingSource, 'reference', 'reference.incomplete-pair');

		const missingTarget = plainDoc(buildState());
		delete (missingTarget.controlPointPairs as Array<Record<string, unknown>>)[0]
			.target;
		expectError(missingTarget, 'reference', 'reference.incomplete-pair');
	});
});

describe('coordinate bounds on both images', () => {
	it('accepts the origin and in-bounds pixels for both images', () => {
		const doc = plainDoc(buildState());
		((doc.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).source = {
			imageId: 'image-source',
			xPx: 0,
			yPx: 0
		};
		((doc.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).target = {
			imageId: 'image-target',
			xPx: 0,
			yPx: 0
		};
		expectDocumentOk(doc);

		const edges = plainDoc(buildState());
		((edges.controlPointPairs as Array<Record<string, unknown>>)[1] as Record<string, unknown>).source = {
			imageId: 'image-source',
			xPx: 1179 - 0.5,
			yPx: 2556 - 0.25
		};
		((edges.controlPointPairs as Array<Record<string, unknown>>)[1] as Record<string, unknown>).target = {
			imageId: 'image-target',
			xPx: 1600 - 0.75,
			yPx: 1200 - 1e-9
		};
		expectDocumentOk(edges);
	});

	it('rejects negative and equal-to-dimension pixels using each image bounds', () => {
		const cases: Array<{ field: 'xPx' | 'yPx'; imageIndex: number; value: number; side: string }> = [
			{ field: 'xPx', imageIndex: 0, value: -1, side: 'source' },
			{ field: 'yPx', imageIndex: 0, value: -1, side: 'source' },
			{ field: 'xPx', imageIndex: 0, value: 1179, side: 'source' },
			{ field: 'yPx', imageIndex: 0, value: 2556, side: 'source' },
			{ field: 'xPx', imageIndex: 1, value: -0.0001, side: 'target' },
			{ field: 'yPx', imageIndex: 1, value: -1, side: 'target' },
			{ field: 'xPx', imageIndex: 1, value: 1600, side: 'target' },
			{ field: 'yPx', imageIndex: 1, value: 1200, side: 'target' }
		];
		for (const { field, value, side } of cases) {
			const doc = plainDoc(buildState());
			((doc.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[side] = {
				imageId: side === 'source' ? 'image-source' : 'image-target',
				xPx: side === 'source' ? 748.25 : 788.0,
				yPx: side === 'source' ? 720.5 : 403.25,
				[field]: value
			};
			const error = expectError(doc, 'coordinate', 'coordinate.out-of-bounds');
			expect(error.path).toContain(`controlPointPairs[0].${side}`);
		}
	});

	it('rejects non-finite coordinates', () => {
		const nan = plainDoc(buildState());
		((nan.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).source = {
			imageId: 'image-source',
			xPx: Number.NaN,
			yPx: 1
		};
		expectError(nan, 'coordinate', 'coordinate.non-finite');

		const inf = plainDoc(buildState());
		((inf.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).target = {
			imageId: 'image-target',
			xPx: 1,
			yPx: Number.POSITIVE_INFINITY
		};
		expectError(inf, 'coordinate', 'coordinate.non-finite');
	});
});

describe('view state validation', () => {
	it('accepts null and omitted viewState', () => {
		const doc = plainDoc(buildState());
		doc.viewState = null;
		const parsed = expectDocumentOk(doc);
		expect(parsed.viewState).toBeNull();

		const omitted = plainDoc(buildState());
		delete omitted.viewState;
		const omittedParsed = expectDocumentOk(omitted);
		expect(omittedParsed.viewState).toBeNull();
	});

	it('round-trips a valid view state and ignores unknown view fields', () => {
		const state = buildState();
		const parsed = expectParsedState(state);
		expect(parsed.viewState).toEqual(state.viewState);
	});

	it('rejects a non-object viewState and non-object sides', () => {
		const array = plainDoc(buildState());
		array.viewState = [];
		expectError(array, 'view', 'view.type', 'viewState');

		const stringView = plainDoc(buildState());
		stringView.viewState = 'fit';
		expectError(stringView, 'view', 'view.type', 'viewState');

		const missingSource = plainDoc(buildState());
		delete (missingSource.viewState as Record<string, unknown>).source;
		expectError(missingSource, 'required-type', 'required.type', 'viewState.source');
	});

	it('rejects invalid zoom and non-finite pan values', () => {
		for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const zoom = plainDoc(buildState());
			((zoom.viewState as Record<string, unknown>).source as Record<string, unknown>).zoom = value;
			expectError(zoom, 'view', 'view.zoom.invalid', 'viewState.source.zoom');
		}
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const pan = plainDoc(buildState());
			((pan.viewState as Record<string, unknown>).target as Record<string, unknown>).panY = value;
			expectError(pan, 'view', 'view.pan.non-finite', 'viewState.target.panY');
		}
	});
});

describe('numberBadges migration and validation (schema v3 -> v4)', () => {
	it('migrates v1, v2, and v3 documents (none of which have numberBadges) to an empty array', () => {
		for (const version of [1, 2, 3]) {
			const doc = plainDoc(buildState());
			doc.schemaVersion = version;
			delete doc.numberBadges;
			const parsed = expectDocumentOk(doc);
			expect(parsed.numberBadges).toEqual([]);
		}
	});

	it('round-trips numberBadges through parse and serialize without drift', () => {
		const state = buildState({
			numberBadges: [
				{ number: 1, xPx: 118.25, yPx: 200.5, confidence: 0.92 },
				{ number: 2, xPx: 12.75, yPx: 18.25, confidence: 0.5 }
			]
		});
		const parsed = expectParsedState(state);
		expect(parsed.numberBadges).toEqual(state.numberBadges);
	});

	it('rejects a duplicate badge number', () => {
		const doc = plainDoc(buildState());
		doc.numberBadges = [
			{ number: 1, xPx: 10, yPx: 10, confidence: 0.9 },
			{ number: 1, xPx: 20, yPx: 20, confidence: 0.8 }
		];
		expectError(doc, 'badge', 'badge.number-duplicate', 'numberBadges[1].number');
	});

	it('rejects an out-of-bounds badge coordinate', () => {
		const doc = plainDoc(buildState());
		doc.numberBadges = [{ number: 1, xPx: 999999, yPx: 10, confidence: 0.9 }];
		expectError(doc, 'coordinate', 'coordinate.out-of-bounds', 'numberBadges[0]');
	});

	it('rejects a confidence value outside [0, 1]', () => {
		for (const confidence of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const doc = plainDoc(buildState());
			doc.numberBadges = [{ number: 1, xPx: 10, yPx: 10, confidence }];
			expectError(doc, 'badge', 'badge.confidence.invalid', 'numberBadges[0].confidence');
		}
	});

	it('still rejects a newer schemaVersion as unsupported, even though numberBadges exists', () => {
		const doc = plainDoc(buildState());
		doc.schemaVersion = CURRENT_SCHEMA_VERSION + 1;
		expectError(doc, 'unsupported-version', 'schema.version.unsupported', 'schemaVersion');
	});
});

describe('walkingPath migration and validation (schema v4 -> v5)', () => {
	it('migrates v1-v4 documents (none of which have walkingPath) to undefined', () => {
		for (const version of [1, 2, 3, 4]) {
			const doc = plainDoc(buildState());
			doc.schemaVersion = version;
			delete doc.walkingPath;
			const parsed = expectDocumentOk(doc);
			expect(parsed.walkingPath).toBeUndefined();
		}
	});

	it('round-trips a walking path through parse and serialize without drift', () => {
		const state = buildState({
			walkingPath: [
				{ xPx: 12.5, yPx: 18.25 },
				{ xPx: 400, yPx: 512.75 },
				{ xPx: 900.125, yPx: 2000 }
			]
		});
		const doc = docFromState(state);
		expect(doc.walkingPath).toEqual(state.walkingPath);

		const parsed = expectParsedState(state);
		expect(parsed.walkingPath).toEqual(state.walkingPath);
	});

	it('omits walkingPath from the serialized document when undefined', () => {
		const doc = docFromState(buildState());
		expect('walkingPath' in doc).toBe(false);
	});

	it('normalizes an empty walkingPath array to undefined on both read and write', () => {
		const state = buildState({ walkingPath: [] });
		const doc = docFromState(state);
		expect('walkingPath' in doc).toBe(false);

		const withEmptyArray = plainDoc(buildState());
		withEmptyArray.walkingPath = [];
		const parsed = expectDocumentOk(withEmptyArray);
		expect(parsed.walkingPath).toBeUndefined();
	});

	it('rejects a non-array walkingPath', () => {
		const doc = plainDoc(buildState());
		doc.walkingPath = 'nope';
		expectError(doc, 'required-type', 'required.missing', 'walkingPath');
	});

	it('rejects a malformed walkingPath point', () => {
		const doc = plainDoc(buildState());
		doc.walkingPath = [{ xPx: 'nope', yPx: 1 }];
		expectError(doc, 'coordinate', 'coordinate.type', 'walkingPath[0].xPx');
	});

	it('rejects a non-finite walkingPath point', () => {
		const doc = plainDoc(buildState());
		doc.walkingPath = [{ xPx: Number.NaN, yPx: 1 }];
		expectError(doc, 'coordinate', 'coordinate.non-finite', 'walkingPath[0].xPx');
	});

	it('rejects an out-of-bounds walkingPath point', () => {
		const doc = plainDoc(buildState());
		doc.walkingPath = [{ xPx: 999999, yPx: 10 }];
		expectError(doc, 'coordinate', 'coordinate.out-of-bounds', 'walkingPath[0]');
	});

	it('serializer throws a structured error for an invalid walkingPath point', () => {
		const state = buildState({ walkingPath: [{ xPx: Number.NaN, yPx: 1 }] });
		expectSerializeError(state, 'coordinate', 'coordinate.non-finite');
	});
});

/** Coverage polygon corners in the module's documented order: [TL, TR, BR, BL]. */
function provenanceCoveragePolygonOf(crop: SourceCropRect, transform: ReturnType<typeof identitySourceTransform>) {
	const corners = [
		{ xPx: crop.xPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx },
		{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx + crop.heightPx },
		{ xPx: crop.xPx, yPx: crop.yPx + crop.heightPx }
	];
	return corners.map((corner) => applySourceTransform(corner, transform));
}

/** N=1, no crop, identity transform — the "identity" case CHSPT-49 requires coverage for. */
function identityProvenanceFixture(finalRasterSha256: string): CompositeProvenance {
	const transform = identitySourceTransform();
	const crop: SourceCropRect = { xPx: 0, yPx: 0, widthPx: 1179, heightPx: 2556 };
	const source: SourceCapture = {
		sourceId: 'capture-1',
		fileName: 'udisc-overview.png',
		mimeType: 'image/png',
		widthPx: 1179,
		heightPx: 2556,
		sha256: 'd'.repeat(64),
		crop,
		transform,
		origin: AUTO_SOURCE_CAPTURE_ORIGIN,
		coveragePolygon: provenanceCoveragePolygonOf(crop, transform),
		paintOrder: 0
	};
	return {
		schemaVersion: CURRENT_PROVENANCE_SCHEMA_VERSION,
		renderVersion: CURRENT_RENDER_VERSION,
		outputWidthPx: 1179,
		outputHeightPx: 2556,
		compositingPolicy: 'single-source-v1',
		resampling: 'none',
		sources: [source],
		overlaps: [],
		finalRasterSha256
	};
}

/** N=2, a rotated + a cropped-and-translated capture — fabricated directly from the locked types, no real estimator needed. */
function rotatedMultiSourceProvenanceFixture(finalRasterSha256: string): CompositeProvenance {
	const identityTransform = identitySourceTransform();
	const cropA: SourceCropRect = { xPx: 10, yPx: 20, widthPx: 400, heightPx: 300 };
	const sourceA: SourceCapture = {
		sourceId: 'capture-a',
		fileName: 'udisc-a.jpg',
		mimeType: 'image/jpeg',
		widthPx: 420,
		heightPx: 320,
		sha256: 'e'.repeat(64),
		crop: cropA,
		transform: identityTransform,
		origin: AUTO_SOURCE_CAPTURE_ORIGIN,
		coveragePolygon: provenanceCoveragePolygonOf(cropA, identityTransform),
		paintOrder: 1
	};
	// A 90-degree rotation (similarity: scale 1, no shear) placed to the right of A.
	const rotatedTransform = buildSourceTransform('similarity', [0, 1, -1, 0, 400, 50]);
	const cropB: SourceCropRect = { xPx: 0, yPx: 0, widthPx: 200, heightPx: 250 };
	const sourceB: SourceCapture = {
		sourceId: 'capture-b',
		fileName: 'udisc-b.png',
		mimeType: 'image/png',
		widthPx: 200,
		heightPx: 250,
		sha256: 'f'.repeat(64),
		crop: cropB,
		transform: rotatedTransform,
		origin: AUTO_SOURCE_CAPTURE_ORIGIN,
		coveragePolygon: provenanceCoveragePolygonOf(cropB, rotatedTransform),
		paintOrder: 0
	};
	return {
		schemaVersion: CURRENT_PROVENANCE_SCHEMA_VERSION,
		renderVersion: CURRENT_RENDER_VERSION,
		outputWidthPx: 650,
		outputHeightPx: 320,
		compositingPolicy: 'stitch-ascending-bottom-right-v1',
		resampling: 'bilinear',
		sources: [sourceA, sourceB],
		overlaps: [{ a: 'capture-a', b: 'capture-b', kind: 'fusion-edge', score: 0.42 }],
		finalRasterSha256
	};
}

describe('provenance migration and validation (schema v5 -> v6)', () => {
	it('migrates v1-v5 documents (none of which have provenance) to absent', () => {
		for (const version of [1, 2, 3, 4, 5]) {
			const doc = plainDoc(buildState());
			doc.schemaVersion = version;
			const parsed = expectDocumentOk(doc);
			expect(parsed.images[0].provenance).toBeUndefined();
			expect(parsed.images[1].provenance).toBeUndefined();
		}
	});

	it('round-trips the identity case (no crop, no transform) through parse and serialize without drift', () => {
		const provenance = identityProvenanceFixture('a'.repeat(64));
		const state = buildState({ images: [sourceAsset({ sha256: 'a'.repeat(64), provenance }), targetAsset()] });
		const doc = docFromState(state);
		expect(doc.images[0].provenance).toEqual(provenance);

		const parsed = expectParsedState(state);
		expect(parsed.images[0].provenance).toEqual(provenance);
	});

	it('round-trips a fabricated multi-source, rotated composite without drift', () => {
		const provenance = rotatedMultiSourceProvenanceFixture('b'.repeat(64));
		const state = buildState({ images: [sourceAsset({ sha256: 'b'.repeat(64), provenance }), targetAsset()] });
		const doc = docFromState(state);
		expect(doc.images[0].provenance).toEqual(provenance);

		const parsed = expectParsedState(state);
		expect(parsed.images[0].provenance).toEqual(provenance);
		expect(parsed.images[0].provenance?.sources).toHaveLength(2);
		expect(parsed.images[0].provenance?.sources[1].transform.model).toBe('similarity');
	});

	it('omits provenance from the serialized document when absent, and normalizes an explicit null the same way', () => {
		const withoutProvenance = docFromState(buildState());
		expect('provenance' in withoutProvenance.images[0]).toBe(false);

		const withNull = plainDoc(buildState());
		(withNull.images as Array<Record<string, unknown>>)[0].provenance = null;
		const parsed = expectDocumentOk(withNull);
		expect(parsed.images[0].provenance).toBeUndefined();
	});

	it('rejects provenance present on a target-basemap image', () => {
		const provenance = identityProvenanceFixture('a'.repeat(64));
		const doc = plainDoc(buildState());
		(doc.images as Array<Record<string, unknown>>)[1].provenance = provenance;
		expectError(doc, 'provenance', 'provenance.role-invalid', 'images[1].provenance');
	});

	it('rejects a finalRasterSha256 that does not match the owning image sha256', () => {
		const provenance = identityProvenanceFixture('a'.repeat(64));
		const doc = plainDoc(buildState());
		(doc.images as Array<Record<string, unknown>>)[0].sha256 = 'z'.repeat(64);
		(doc.images as Array<Record<string, unknown>>)[0].provenance = provenance;
		expectError(doc, 'provenance', 'provenance.hash-mismatch');
	});

	it('rejects structurally incoherent provenance (assertCoherentProvenance) as a structured provenance error', () => {
		const provenance = identityProvenanceFixture('a'.repeat(64));
		const incoherent: CompositeProvenance = {
			...provenance,
			overlaps: [{ a: 'capture-1', b: 'unknown-source', kind: 'placement-edge', score: 0.5 }]
		};
		const doc = plainDoc(buildState());
		(doc.images as Array<Record<string, unknown>>)[0].sha256 = 'a'.repeat(64);
		(doc.images as Array<Record<string, unknown>>)[0].provenance = incoherent;
		expectError(doc, 'provenance', 'provenance.incoherent');
	});

	it('recomputes transform derived fields from model + coefficients rather than trusting the document', () => {
		const provenance = identityProvenanceFixture('a'.repeat(64));
		const doc = plainDoc(buildState());
		(doc.images as Array<Record<string, unknown>>)[0].sha256 = 'a'.repeat(64);
		const tamperedProvenance = JSON.parse(JSON.stringify(provenance)) as Record<string, unknown>;
		const tamperedSource = (tamperedProvenance.sources as Array<Record<string, unknown>>)[0];
		const tamperedTransform = tamperedSource.transform as Record<string, unknown>;
		// A deliberately wrong stored derived value; the reader must recompute it from
		// model + coefficients rather than trust this.
		tamperedTransform.determinant = 999;
		(doc.images as Array<Record<string, unknown>>)[0].provenance = tamperedProvenance;

		const parsed = expectDocumentOk(doc);
		expect(parsed.images[0].provenance?.sources[0].transform.determinant).toBe(1);
	});

	it('serializer throws a structured provenance error for invalid domain state', () => {
		const provenance = identityProvenanceFixture('a'.repeat(64));
		const incoherent: CompositeProvenance = {
			...provenance,
			sources: provenance.sources.map((source) => ({ ...source, paintOrder: 5 }))
		};
		const state = buildState({
			images: [sourceAsset({ sha256: 'a'.repeat(64), provenance: incoherent }), targetAsset()]
		});
		expectSerializeError(state, 'provenance', 'provenance.incoherent');
	});
});

describe('rotationDeg migration and validation (schema v6 -> v7)', () => {
	it('migrates v1-v6 documents (none of which have rotationDeg) to absent (0deg)', () => {
		for (const version of [1, 2, 3, 4, 5, 6]) {
			const doc = plainDoc(buildState());
			doc.schemaVersion = version;
			const parsed = expectDocumentOk(doc);
			expect(parsed.images[0].rotationDeg).toBeUndefined();
			expect(parsed.images[1].rotationDeg).toBeUndefined();
		}
	});

	it('round-trips a present target rotation through serialize and parse', () => {
		const state = buildState({ images: [sourceAsset(), targetAsset({ rotationDeg: 32.5 })] });
		const doc = docFromState(state);
		expect(doc.images[1].rotationDeg).toBe(32.5);

		const parsed = expectParsedState(state);
		expect(parsed.images[1].rotationDeg).toBe(32.5);
	});

	it('omits rotationDeg from the serialized document when absent, and normalizes an explicit null or 0 the same way', () => {
		const withoutRotation = docFromState(buildState());
		expect('rotationDeg' in withoutRotation.images[1]).toBe(false);

		const withNull = plainDoc(buildState());
		(withNull.images as Array<Record<string, unknown>>)[1].rotationDeg = null;
		expect(expectDocumentOk(withNull).images[1].rotationDeg).toBeUndefined();

		const withZero = plainDoc(buildState());
		(withZero.images as Array<Record<string, unknown>>)[1].rotationDeg = 0;
		expect(expectDocumentOk(withZero).images[1].rotationDeg).toBeUndefined();
	});

	it('rejects a non-zero rotationDeg present on a source-overview image', () => {
		const doc = plainDoc(buildState());
		(doc.images as Array<Record<string, unknown>>)[0].rotationDeg = 12;
		expectError(doc, 'rotation', 'rotation.role-invalid', 'images[0].rotationDeg');
	});

	it('tolerates an explicit rotationDeg of 0 on a source-overview image (0 normalizes to absent before the role check)', () => {
		const doc = plainDoc(buildState());
		(doc.images as Array<Record<string, unknown>>)[0].rotationDeg = 0;
		const parsed = expectDocumentOk(doc);
		expect(parsed.images[0].rotationDeg).toBeUndefined();
	});

	it('rejects a non-finite or non-number rotationDeg', () => {
		const doc = plainDoc(buildState());
		(doc.images as Array<Record<string, unknown>>)[1].rotationDeg = 'north';
		expectError(doc, 'rotation', 'rotation.number.invalid', 'images[1].rotationDeg');
	});

	it('normalizes an out-of-range rotationDeg into (-180, 180] on load, matching editor.ts setTargetRotation', () => {
		const doc = plainDoc(buildState());
		(doc.images as Array<Record<string, unknown>>)[1].rotationDeg = 400;
		const parsed = expectDocumentOk(doc);
		expect(parsed.images[1].rotationDeg).toBeCloseTo(40, 9);
	});

	it('normalizes a 360deg rotationDeg to absent, same as 0', () => {
		const doc = plainDoc(buildState());
		(doc.images as Array<Record<string, unknown>>)[1].rotationDeg = 360;
		const parsed = expectDocumentOk(doc);
		expect(parsed.images[1].rotationDeg).toBeUndefined();
	});
});

describe('serializer validation of domain state', () => {
	it('throws structured errors for non-finite and out-of-bounds coordinates', () => {
		const nan = buildState();
		nan.controlPointPairs[0].source.xPx = Number.NaN;
		expectSerializeError(nan, 'coordinate', 'coordinate.non-finite');

		const outOfBounds = buildState();
		outOfBounds.controlPointPairs[1].target.yPx = 1200;
		expectSerializeError(outOfBounds, 'coordinate', 'coordinate.out-of-bounds');
	});

	it('throws structured errors for incomplete images, duplicate ids, and invalid dimensions', () => {
		const oneImage = buildState();
		oneImage.images = [sourceAsset()];
		expectSerializeError(oneImage, 'image-manifest', 'images.cardinality');

		const duplicateIds = buildState();
		(duplicateIds.images[1] as { id: string }).id = 'image-source';
		for (const pair of duplicateIds.controlPointPairs) {
			(pair.target as { imageId: string }).imageId = 'image-source';
		}
		expectSerializeError(duplicateIds, 'duplicate-id', 'id.duplicate');

		const zeroWidth = buildState();
		zeroWidth.images[0].widthPx = 0;
		expectSerializeError(zeroWidth, 'dimension', 'dimension.invalid');

		const nanWidth = buildState();
		nanWidth.images[0].widthPx = Number.NaN;
		expectSerializeError(nanWidth, 'dimension', 'dimension.invalid');
	});

	it('throws structured errors for bad references, labels, and project fields', () => {
		const badRef = buildState();
		(badRef.controlPointPairs[0].source as { imageId: string }).imageId = 'image-target';
		expectSerializeError(badRef, 'reference', 'reference.swapped');

		const badLabel = buildState();
		badLabel.controlPointPairs[0].label = 42 as unknown as string | null;
		expectSerializeError(badLabel, 'required-type', 'required.type');

		const badName = buildState();
		badName.project.name = 42 as unknown as string;
		expectSerializeError(badName, 'required-type', 'required.type', 'project.name');

		const badView = buildState();
		badView.viewState = { source: { zoom: 0, panX: 0, panY: 0 }, target: { zoom: 1, panX: 0, panY: 0 } };
		expectSerializeError(badView, 'view', 'view.zoom.invalid');
	});

	it('never emits transient editor state or derived normalized state', () => {
		const doc = docFromState(buildState());
		expect(Object.keys(doc).sort()).toEqual([
			'controlPointPairs',
			'holes',
			'images',
			'numberBadges',
			'project',
			'schemaVersion',
			'viewState'
		]);
		expect(Object.keys(doc.images[0]).sort()).toEqual([
			'bundlePath',
			'fileName',
			'heightPx',
			'id',
			'mimeType',
			'role',
			'sha256',
			'widthPx'
		]);
		expect(Object.keys(doc.controlPointPairs[0].source).sort()).toEqual([
			'imageId',
			'xNorm',
			'xPx',
			'yNorm',
			'yPx'
		]);

		const transientNames = [
			'selection',
			'pendingPair',
			'pending',
			'history',
			'dirty',
			'activeTool',
			'pointer',
			'hover',
			'drag',
			'decodedImage',
			'decodedBytes',
			'bytes',
			'file',
			'blob',
			'konva',
			'markersVisible',
			'course',
			'renderSettings',
			'registrations'
		];
		for (const name of transientNames) {
			expect(name in doc).toBe(false);
			expect(name in doc.images[0]).toBe(false);
			expect(name in doc.controlPointPairs[0]).toBe(false);
		}

		const parsed = expectParsedState(buildState());
		expect('xNorm' in parsed.controlPointPairs[0].source).toBe(false);
		expect('yNorm' in parsed.controlPointPairs[0].target).toBe(false);
	});
});

describe('atomicity and editor isolation', () => {
	it('a failed parse leaves an existing ProjectEditor byte-for-byte unchanged', () => {
		const editor = new ProjectEditor({ state: buildState() });
		const before = JSON.stringify(editor.state);
		const dirty = editor.isDirty;
		const canUndo = editor.canUndo;
		const canRedo = editor.canRedo;

		expect(dirty).toBe(true);
		expect(canUndo).toBe(false);

		parseProjectJson('{definitely not json');
		parseProjectJson(JSON.stringify({ schemaVersion: 3 }));
		parseProjectJson('null');
		parseProjectDocument({ schemaVersion: 1, project: {}, images: [], controlPointPairs: [], viewState: null });
		parseProjectDocument([]);

		expect(JSON.stringify(editor.state)).toBe(before);
		expect(editor.isDirty).toBe(dirty);
		expect(editor.canUndo).toBe(canUndo);
		expect(editor.canRedo).toBe(canRedo);
	});

	it('parsing is pure and never mutates its input document', () => {
		const doc = plainDoc(buildState());
		const snapshot = JSON.stringify(doc);
		const result = parseProjectDocument(doc) as ProjectParseResult;
		expect(result.ok).toBe(true);
		expect(JSON.stringify(doc)).toBe(snapshot);
	});

	it('the serializer output parses to an equivalent editor state and marks clean checkpoints', () => {
		const editor = new ProjectEditor({ state: buildState() });
		const doc = docFromState(editor.state);
		const result = parseProjectJson(JSON.stringify(doc));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(JSON.stringify(result.state)).toBe(JSON.stringify(editor.state));
		}
	});
});
