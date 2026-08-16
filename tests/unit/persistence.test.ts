// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { ProjectEditor } from '../../src/lib/domain/editor';
import type { AssetResource } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { ImageAsset, ImageRole, ProjectState } from '../../src/lib/domain/project';
import {
	intakeImageFile,
	isValidSha256Hex,
	sha256Hex
} from '../../src/lib/imageIntake';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import {
	CURRENT_SCHEMA_VERSION,
	parseProjectJson,
	serializeProjectState
} from '../../src/lib/projectSchema';
import {
	createProjectBundle,
	isSafeBundlePath,
	projectFileName,
	readProjectBundle,
	resolveRepairWithArchivedBytes,
	resolveRepairWithFile,
	sanitizeFileNameBase,
	saveProject
} from '../../src/lib/persistence';
import type { PersistenceErrorKind, RepairCandidate, RepairResolutionResult } from '../../src/lib/persistence';
import { applySourceTransform, identitySourceTransform } from '../../src/lib/domain/provenance';
import type { CompositeProvenance, SourceCapture, SourceCropRect } from '../../src/lib/domain/provenance';

const NOW = () => new Date('2026-08-02T00:00:00.000Z');

let counter = 0;
const nextId = (): string => `asset-${++counter}`;

const SRC = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const TGT = new Uint8Array([9, 8, 7, 6]);

function fileOf(name: string, mime: string, bytes: Uint8Array): File {
	return new File([new Uint8Array(bytes)], name, { type: mime });
}

function fileFrom(bytes: Uint8Array, name = 'bundle.chainspot.zip'): File {
	return new File([new Uint8Array(bytes)], name, { type: 'application/zip' });
}

function decodeOf(widthPx: number, heightPx: number, fail = false): DecodeImageFile {
	return async () => {
		if (fail) throw new Error('simulated decode failure');
		return { image: { simulated: true } as unknown as HTMLImageElement, widthPx, heightPx };
	};
}

function decodeByDims(byName: Record<string, { widthPx: number; heightPx: number }>): DecodeImageFile {
	return async (file) => {
		const dims = byName[file.name];
		if (!dims) throw new Error(`no dims registered for ${file.name}`);
		return {
			image: { from: file.name } as unknown as HTMLImageElement,
			widthPx: dims.widthPx,
			heightPx: dims.heightPx
		};
	};
}

/** Decode matching the `loadedEditor` manifest dimensions (source 2x3, target 5x4). */
function loadedDecode(): DecodeImageFile {
	return decodeByDims({
		'udisc.png': { widthPx: 2, heightPx: 3 },
		'map.jpg': { widthPx: 5, heightPx: 4 }
	});
}

async function loadedEditor(opts: { hash?: (bytes: Uint8Array) => Promise<string> } = {}): Promise<{
	editor: ProjectEditor;
	src: Uint8Array;
	tgt: Uint8Array;
}> {
	const hash = opts.hash ?? sha256Hex;
	const editor = new ProjectEditor({
		state: createProjectState({ createId: () => 'project-1', now: NOW }),
		createId: nextId,
		now: NOW
	});
	const source = await intakeImageFile({
		editor,
		role: 'source-overview',
		file: fileOf('udisc.png', 'image/png', SRC),
		decode: decodeOf(2, 3),
		createAssetId: nextId,
		hash
	});
	const target = await intakeImageFile({
		editor,
		role: 'target-basemap',
		file: fileOf('map.jpg', 'image/jpeg', TGT),
		decode: decodeOf(5, 4),
		createAssetId: nextId,
		hash
	});
	if (!source.ok || !target.ok) throw new Error('seed intake failed');
	editor.addPair({
		sourceCoordinates: { xPx: 1, yPx: 1 },
		targetCoordinates: { xPx: 2, yPx: 2 }
	});
	return { editor, src: SRC, tgt: TGT };
}

/** Serialized schema-v1 document of a freshly loaded editor (hashes match SRC/TGT). */
async function baseDoc(): Promise<Record<string, unknown>> {
	const { editor } = await loadedEditor();
	return JSON.parse(JSON.stringify(serializeProjectState(editor.state))) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// CHSPT-49 source-capture provenance fixtures
// ---------------------------------------------------------------------------

const SOURCE_CAPTURE_BYTES = new Uint8Array([21, 22, 23, 24, 25, 26, 27, 28]);

/** A minimal, coherent single-source provenance fixture whose sha256 defaults to `SOURCE_CAPTURE_BYTES`'s real hash. */
async function provenanceFixture(options: {
	finalRasterSha256: string;
	sourceId?: string;
	captureSha256?: string;
}): Promise<CompositeProvenance> {
	const sourceId = options.sourceId ?? 'capture-1';
	const captureSha256 = options.captureSha256 ?? (await sha256Hex(SOURCE_CAPTURE_BYTES));
	const transform = identitySourceTransform();
	const crop: SourceCropRect = { xPx: 0, yPx: 0, widthPx: 2, heightPx: 3 };
	const source: SourceCapture = {
		sourceId,
		fileName: `${sourceId}.jpg`,
		mimeType: 'image/jpeg',
		widthPx: 2,
		heightPx: 3,
		sha256: captureSha256,
		crop,
		transform,
		coveragePolygon: [
			{ xPx: crop.xPx, yPx: crop.yPx },
			{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx },
			{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx + crop.heightPx },
			{ xPx: crop.xPx, yPx: crop.yPx + crop.heightPx }
		].map((corner) => applySourceTransform(corner, transform)),
		paintOrder: 0
	};
	return {
		schemaVersion: 1,
		renderVersion: 'chainspot-stitch-v1',
		outputWidthPx: 2,
		outputHeightPx: 3,
		compositingPolicy: 'single-source-v1',
		resampling: 'none',
		sources: [source],
		overlaps: [],
		finalRasterSha256: options.finalRasterSha256
	};
}

/** A `loadedEditor`-shaped fixture whose source-overview image carries provenance referencing `capture-1`. */
async function loadedEditorWithProvenance(
	options: { attachCaptureBytes?: boolean } = {}
): Promise<{ editor: ProjectEditor; src: Uint8Array; tgt: Uint8Array; provenance: CompositeProvenance }> {
	const attachCaptureBytes = options.attachCaptureBytes ?? true;
	const editor = new ProjectEditor({
		state: createProjectState({ createId: () => 'project-1', now: NOW }),
		createId: nextId,
		now: NOW
	});
	const provenance = await provenanceFixture({ finalRasterSha256: await sha256Hex(SRC) });
	const source = await intakeImageFile({
		editor,
		role: 'source-overview',
		file: fileOf('udisc.png', 'image/png', SRC),
		decode: decodeOf(2, 3),
		createAssetId: nextId,
		hash: sha256Hex,
		provenance,
		sourceCaptures: attachCaptureBytes
			? new Map([[provenance.sources[0].sourceId, SOURCE_CAPTURE_BYTES]])
			: undefined
	});
	const target = await intakeImageFile({
		editor,
		role: 'target-basemap',
		file: fileOf('map.jpg', 'image/jpeg', TGT),
		decode: decodeOf(5, 4),
		createAssetId: nextId,
		hash: sha256Hex
	});
	if (!source.ok || !target.ok) throw new Error('seed intake failed');
	editor.addPair({
		sourceCoordinates: { xPx: 1, yPx: 1 },
		targetCoordinates: { xPx: 2, yPx: 2 }
	});
	return { editor, src: SRC, tgt: TGT, provenance };
}

/** Zips a project document with image bytes (default bytes when not supplied) and extras. */
function zipWith(
	doc: Record<string, unknown>,
	byPath: Record<string, Uint8Array> = {},
	extra: Record<string, Uint8Array> = {}
): Uint8Array {
	const files: Record<string, Uint8Array> = { 'project.json': strToU8(JSON.stringify(doc)) };
	for (const image of (doc as unknown as { images: ImageAsset[] }).images) {
		if (image.bundlePath && image.bundlePath !== 'project.json') {
			files[image.bundlePath] = byPath[image.bundlePath] ?? new Uint8Array([1, 2, 3, 4]);
		}
	}
	Object.assign(files, extra);
	return zipSync(files, { level: 6 });
}

function imagesOf(doc: Record<string, unknown>): Array<Record<string, unknown>> {
	return doc.images as Array<Record<string, unknown>>;
}

async function expectNonRepairFailure(
	file: File,
	decode: DecodeImageFile,
	expectedKind: PersistenceErrorKind
): Promise<void> {
	const { editor } = await loadedEditor();
	const stateBefore = JSON.stringify(editor.state);
	const historyBefore = { canUndo: editor.canUndo, canRedo: editor.canRedo, dirty: editor.isDirty };
	const decodedBefore = editor.state.images.map((image) => editor.getAssetResource(image.id)?.decoded);

	const result = await readProjectBundle(file, { decode, hash: sha256Hex });
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.kind).toBe('failure');
	if (result.kind !== 'failure') return;
	expect(result.error.kind).toBe(expectedKind);
	expect(result.error.message.length).toBeGreaterThan(0);

	expect(JSON.stringify(editor.state)).toBe(stateBefore);
	expect(editor.canUndo).toBe(historyBefore.canUndo);
	expect(editor.canRedo).toBe(historyBefore.canRedo);
	expect(editor.isDirty).toBe(historyBefore.dirty);
	editor.state.images.forEach((image, index) => {
		expect(editor.getAssetResource(image.id)?.decoded).toBe(decodedBefore[index]);
	});
}

function expectRepair(result: Awaited<ReturnType<typeof readProjectBundle>>): RepairCandidate {
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error('expected a repair result');
	expect(result.kind).toBe('repair');
	if (result.kind !== 'repair') throw new Error('expected repair');
	return result.candidate;
}

function expectResolutionOk(result: RepairResolutionResult): { state: ProjectState; assets: Map<string, AssetResource> } {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(`expected resolution success: ${result.kind === 'error' ? result.error.message : 'discard/incomplete'}`);
	return { state: result.state, assets: new Map(result.assets) };
}

describe('SHA-256 hashing (native Web Crypto)', () => {
	it('computes the known SHA-256 vector as lowercase 64-hex', async () => {
		expect(await sha256Hex(new Uint8Array([1, 2, 3]))).toBe(
			'039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81'
		);
		expect(await sha256Hex(new Uint8Array())).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		);
	});

	it('is sensitive to a single changed byte', async () => {
		const a = await sha256Hex(new Uint8Array([0, 0, 0]));
		const b = await sha256Hex(new Uint8Array([0, 0, 1]));
		expect(a).not.toBe(b);
	});

	it('validates lowercase 64-hex manifest hashes', () => {
		expect(isValidSha256Hex('a'.repeat(64))).toBe(true);
		expect(isValidSha256Hex('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81')).toBe(true);
		expect(isValidSha256Hex('A'.repeat(64))).toBe(false);
		expect(isValidSha256Hex('a'.repeat(63))).toBe(false);
		expect(isValidSha256Hex('g'.repeat(64))).toBe(false);
		expect(isValidSha256Hex(null)).toBe(false);
		expect(isValidSha256Hex(undefined)).toBe(false);
		expect(isValidSha256Hex(42)).toBe(false);
	});
});

describe('intake hashing and bundle path (A)', () => {
	it('sets the manifest sha256 and stable bundle path before any mutation', async () => {
		const { editor, src, tgt } = await loadedEditor();
		const state = editor.state;
		const source = state.images.find((image) => image.role === 'source-overview');
		const target = state.images.find((image) => image.role === 'target-basemap');
		expect(source?.sha256).toBe(await sha256Hex(src));
		expect(source?.bundlePath).toBe('images/source-original.png');
		expect(target?.sha256).toBe(await sha256Hex(tgt));
		expect(target?.bundlePath).toBe('images/target-original.jpg');
	});

	it('a same-dimension replacement sets a new hash and path for the new asset', async () => {
		const { editor } = await loadedEditor();
		const beforeSourceId = editor.state.images.find((image) => image.role === 'source-overview')?.id;
		const replacement = new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7]);
		const result = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('udisc-v2.png', 'image/png', replacement),
			decode: decodeOf(2, 3),
			createAssetId: nextId,
			hash: sha256Hex,
			// The replacement has an affected pair, so intake requires the explicit
			// discard confirmation before applying it.
			confirmDiscard: async () => true
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const now = editor.state.images.find((image) => image.role === 'source-overview');
		expect(now?.id).not.toBe(beforeSourceId);
		expect(now?.sha256).toBe(await sha256Hex(replacement));
		expect(now?.bundlePath).toBe('images/source-original.png');
	});

	it('a byte-read failure is specific and atomic (no mutation, nothing registered)', async () => {
		const editor = new ProjectEditor({
			state: createProjectState({ createId: () => 'project-1', now: NOW }),
			createId: nextId,
			now: NOW
		});
		const broken = fileOf('broken.png', 'image/png', SRC);
		broken.arrayBuffer = () => Promise.reject(new Error('disk read failed')) as never;
		const result = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: broken,
			decode: decodeOf(2, 3),
			createAssetId: nextId,
			hash: sha256Hex
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe('read-failure');
		expect(editor.state.images).toEqual([]);
		expect(editor.canUndo).toBe(false);
		expect(editor.getAssetResource('asset-1')).toBeUndefined();
	});

	it('a hash failure is specific and atomic', async () => {
		const editor = new ProjectEditor({
			state: createProjectState({ createId: () => 'project-1', now: NOW }),
			createId: nextId,
			now: NOW
		});
		const result = await intakeImageFile({
			editor,
			role: 'source-overview',
			file: fileOf('a.png', 'image/png', SRC),
			decode: decodeOf(2, 3),
			createAssetId: nextId,
			hash: async () => {
				throw new Error('crypto unavailable');
			}
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe('read-failure');
		expect(editor.state.images).toEqual([]);
		expect(editor.canUndo).toBe(false);
	});
});

describe('bundle writer (B)', () => {
	it('writes exactly three entries: project.json plus the two originals', async () => {
		const { editor } = await loadedEditor();
		const created = await createProjectBundle(editor);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const entries = unzipSync(created.bundle.zipBytes);
		expect(Object.keys(entries).sort()).toEqual([
			'images/source-original.png',
			'images/target-original.jpg',
			'project.json'
		]);
	});

	it('writes byte-identical originals whose manifest hashes equal the archived bytes', async () => {
		const { editor, src, tgt } = await loadedEditor();
		const created = await createProjectBundle(editor);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const entries = unzipSync(created.bundle.zipBytes);
		expect([...entries['images/source-original.png']]).toEqual([...src]);
		expect([...entries['images/target-original.jpg']]).toEqual([...tgt]);
		expect(await sha256Hex(entries['images/source-original.png'])).toBe(created.bundle.images[0].sha256);
		expect(await sha256Hex(entries['images/target-original.jpg'])).toBe(created.bundle.images[1].sha256);
		expect(created.bundle.images[0].path).toBe('images/source-original.png');
		expect(created.bundle.images[1].path).toBe('images/target-original.jpg');
	});

	it('writes a schema-v2 project.json that re-parses with matching hashes', async () => {
		const { editor } = await loadedEditor();
		const created = await createProjectBundle(editor);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(created.bundle.document.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		const parsed = parseProjectJson(created.bundle.text);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.state.images[0].sha256).toBe(created.bundle.images[0].sha256);
		expect(parsed.state.images[0].bundlePath).toBe('images/source-original.png');
		expect(parsed.state.images[1].bundlePath).toBe('images/target-original.jpg');
	});

	it('fails structured export when the project lacks both images', async () => {
		const editor = new ProjectEditor({
			state: createProjectState({ createId: () => 'project-1', now: NOW }),
			createId: nextId,
			now: NOW
		});
		const result = await createProjectBundle(editor);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe('export-failure');
		expect(result.error.schemaError?.category).toBe('image-manifest');
	});

	it('fails export when an image has no registered original bytes', async () => {
		const { editor } = await loadedEditor();
		const orphan = new ProjectEditor({ state: editor.state });
		const result = await createProjectBundle(orphan);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe('export-failure');
		expect(result.error.message).toMatch(/bytes/);
	});
});

describe('save snapshot consistency (correction round)', () => {
	it('snapshots the exact state at save start: edits during async hashing never leak into the archive or savedState', async () => {
		const { editor } = await loadedEditor();
		editor.renameProject('Before');
		let releaseFirstHash!: (hash: string) => void;
		const gate = new Promise<string>((resolve) => {
			releaseFirstHash = resolve;
		});
		let calls = 0;
		const hash = async (bytes: Uint8Array): Promise<string> => {
			calls += 1;
			if (calls === 1) return await gate;
			return sha256Hex(bytes);
		};

		const saving = saveProject(editor, {
			hash,
			download: () => undefined,
			createBlob: (zipBytes) => new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' })
		});
		// A live edit lands while the first image hash is still in flight.
		editor.renameProject('After');
		releaseFirstHash(await sha256Hex(SRC));
		const result = await saving;

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.fileName).toBe('Before.chainspot.zip');
		expect(result.savedState.project.name).toBe('Before');
		expect(editor.state.project.name).toBe('After');
		expect(JSON.stringify(editor.state)).not.toBe(JSON.stringify(result.savedState));
	});
});

describe('bundle file naming and path safety (B)', () => {
	it('sanitizes a conservative project filename with a lowercase suffix and fallback', () => {
		expect(projectFileName('Sample Round')).toBe('Sample Round.chainspot.zip');
		expect(projectFileName('')).toBe('chainspot-project.chainspot.zip');
		expect(projectFileName('   ')).toBe('chainspot-project.chainspot.zip');
		expect(projectFileName('My Map v2')).toBe('My Map v2.chainspot.zip');
		expect(projectFileName('../evil/name')).toBe('evil-name.chainspot.zip');
		expect(projectFileName('a<b>c|d')).toBe('a-b-c-d.chainspot.zip');
		expect(projectFileName('round')).toBe('round.chainspot.zip');
		expect(sanitizeFileNameBase('x')).toBe('x');
		expect(sanitizeFileNameBase('...')).toBe('chainspot-project');
	});

	it('accepts only safe non-empty paths directly under images/', () => {
		expect(isSafeBundlePath('images/source-original.png')).toBe(true);
		expect(isSafeBundlePath('images/target-original.jpg')).toBe(true);
		expect(isSafeBundlePath('images/simple-name')).toBe(true);
		for (const bad of [
			null,
			'',
			'source-original.png',
			'images/',
			'images/..',
			'images/../evil.png',
			'images/a/b.png',
			'images\\evil.png',
			'/images/evil.png',
			'project.json',
			'images/name\u0000.png'
		]) {
			expect(isSafeBundlePath(bad)).toBe(false);
		}
	});
});

describe('full round trip (C)', () => {
	function richState(srcSha: string, tgtSha: string): ProjectState {
		return {
			project: {
				id: 'project-1',
				name: 'My Round',
				createdAt: NOW().toISOString(),
				updatedAt: NOW().toISOString()
			},
			images: [
				{
					id: 'image-source',
					role: 'source-overview',
					fileName: 'udisc-overview.png',
					mimeType: 'image/png',
					widthPx: 1179,
					heightPx: 2556,
					sha256: srcSha,
					bundlePath: 'images/source-original.png'
				},
				{
					id: 'image-target',
					role: 'target-basemap',
					fileName: 'clean-map.jpg',
					mimeType: 'image/jpeg',
					widthPx: 1600,
					heightPx: 1200,
					sha256: tgtSha,
					bundlePath: 'images/target-original.jpg'
				}
			],
			controlPointPairs: [
				{
					id: 'cp-0001',
					ordinal: 1,
					label: 'Parking corner',
					enabled: true,
					source: { imageId: 'image-source', xPx: 748.25, yPx: 720.5 },
					target: { imageId: 'image-target', xPx: 788.0, yPx: 403.25 },
					createdAt: NOW().toISOString(),
					updatedAt: NOW().toISOString()
				},
				{
					id: 'cp-0003',
					ordinal: 3,
					label: null,
					enabled: false,
					source: { imageId: 'image-source', xPx: 0.5, yPx: 2555.5 },
					target: { imageId: 'image-target', xPx: 1599.25, yPx: 0.25 },
					createdAt: NOW().toISOString(),
					updatedAt: NOW().toISOString()
				},
				{
					id: 'cp-0007',
					ordinal: 7,
					label: 'Pond',
					enabled: true,
					source: { imageId: 'image-source', xPx: 300.125, yPx: 100.5 },
					target: { imageId: 'image-target', xPx: 600.75, yPx: 200.25 },
					createdAt: NOW().toISOString(),
					updatedAt: NOW().toISOString()
				}
			],
			holes: [
				{
					id: 'hole-1',
					number: 1,
					tee: { xPx: 120.5, yPx: 240.25 },
					basket: { xPx: 800.75, yPx: 1900.5 },
					shots: [
						{ id: 'shot-1', landing: { xPx: 300.25, yPx: 700.5 } },
						{ id: 'shot-2', landing: { xPx: 560, yPx: 1300.75 } }
					],
					corridorBends: [
						{ xPx: 400, yPx: 1000 },
						{ xPx: 700, yPx: 1500 }
					],
					corridorWidthPx: 75
				},
				// A partially-annotated hole: proves optional fields stay absent rather
				// than round-tripping as null.
				{
					id: 'hole-2',
					number: 2,
					tee: { xPx: 10.5, yPx: 20.5 },
					shots: [],
					corridorBends: [],
					corridorWidthPx: 60
				}
			],
			numberBadges: [
				{ number: 1, xPx: 118.25, yPx: 200.5, confidence: 0.92 },
				{ number: 2, xPx: 12.75, yPx: 18.25, confidence: 0.81 }
			],
			viewState: {
				source: { zoom: 1.4, panX: -92, panY: 17 },
				target: { zoom: 1.1, panX: 0, panY: -35 }
			}
		};
	}

	it('round-trips metadata, fractional pixels, labels, disabled/reordered pairs, holes, and view state without drift', async () => {
		const srcSha = await sha256Hex(SRC);
		const tgtSha = await sha256Hex(TGT);
		const original = richState(srcSha, tgtSha);
		const editor = new ProjectEditor({
			state: original,
			assets: new Map([
				['image-source', { bytes: SRC, decoded: null }],
				['image-target', { bytes: TGT, decoded: null }]
			]),
			now: NOW
		});

		const created = await createProjectBundle(editor);
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const opened = await readProjectBundle(fileFrom(created.bundle.zipBytes), {
			decode: decodeByDims({
				'udisc-overview.png': { widthPx: 1179, heightPx: 2556 },
				'clean-map.jpg': { widthPx: 1600, heightPx: 1200 }
			}),
			hash: sha256Hex
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;

		expect(opened.state).toEqual(original);
		expect(opened.state.controlPointPairs.map((pair) => pair.ordinal)).toEqual([1, 3, 7]);
		expect(opened.state.controlPointPairs[0].source.xPx).toBe(748.25);
		expect(opened.state.controlPointPairs[1].label).toBeNull();
		expect(opened.state.controlPointPairs[1].enabled).toBe(false);
		expect(opened.state.viewState).toEqual(original.viewState);
		expect(opened.state.images[0].sha256).toBe(srcSha);
		expect(opened.state.images[1].bundlePath).toBe('images/target-original.jpg');

		expect([...opened.assets.get('image-source')!.bytes]).toEqual([...SRC]);
		expect([...opened.assets.get('image-target')!.bytes]).toEqual([...TGT]);
		expect(opened.assets.get('image-source')?.decoded).toEqual({ from: 'udisc-overview.png' });
		expect(opened.assets.get('image-target')?.decoded).toEqual({ from: 'clean-map.jpg' });
	});

	it('a freshly opened project has empty undo/redo and a clean checkpoint', async () => {
		const srcSha = await sha256Hex(SRC);
		const tgtSha = await sha256Hex(TGT);
		const editor = new ProjectEditor({
			state: richState(srcSha, tgtSha),
			assets: new Map([
				['image-source', { bytes: SRC, decoded: null }],
				['image-target', { bytes: TGT, decoded: null }]
			]),
			now: NOW
		});
		const created = await createProjectBundle(editor);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const opened = await readProjectBundle(fileFrom(created.bundle.zipBytes), {
			decode: decodeByDims({
				'udisc-overview.png': { widthPx: 1179, heightPx: 2556 },
				'clean-map.jpg': { widthPx: 1600, heightPx: 1200 }
			}),
			hash: sha256Hex
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;

		const next = new ProjectEditor({ state: opened.state, assets: opened.assets, now: NOW });
		expect(next.canUndo).toBe(false);
		expect(next.canRedo).toBe(false);
		expect(next.isDirty).toBe(true);
		next.markSaved();
		expect(next.isDirty).toBe(false);
	});
});

describe('import failures (D)', () => {
	it('distinguishes a corrupt archive', async () => {
		await expectNonRepairFailure(fileFrom(new Uint8Array([1, 2, 3, 4, 5, 6])), decodeOf(2, 3), 'corrupt-archive');
		const doc = await baseDoc();
		const truncated = zipWith(doc).slice(0, 12);
		await expectNonRepairFailure(fileFrom(truncated), decodeOf(2, 3), 'corrupt-archive');
	});

	it('reports a missing project.json', async () => {
		const bytes = zipSync({ 'images/source-original.png': SRC }, { level: 6 });
		await expectNonRepairFailure(fileFrom(bytes), decodeOf(2, 3), 'missing-json');
	});

	it('surfaces malformed JSON through the P0-010 structured cause', async () => {
		const bytes = zipSync({ 'project.json': strToU8('{not json') }, { level: 6 });
		const { editor } = await loadedEditor();
		const before = JSON.stringify(editor.state);
		const result = await readProjectBundle(fileFrom(bytes), { decode: loadedDecode(), hash: sha256Hex });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('failure');
		if (result.kind !== 'failure') return;
		expect(result.error.kind).toBe('project-json');
		expect(result.error.schemaError?.category).toBe('malformed-json');
		expect(JSON.stringify(editor.state)).toBe(before);
	});

	it('classifies unsupported newer schema versions', async () => {
		const bytes = zipSync(
			{ 'project.json': strToU8(JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 })) },
			{ level: 6 }
		);
		const result = await readProjectBundle(fileFrom(bytes), { decode: loadedDecode(), hash: sha256Hex });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('failure');
		if (result.kind !== 'failure') return;
		expect(result.error.kind).toBe('project-json');
		expect(result.error.schemaError?.category).toBe('unsupported-version');
		expect(result.error.message).toMatch(/newer/);
	});

	it('surfaces schema, reference, and coordinate causes with P0-010 detail', async () => {
		const missingDoc = {
			schemaVersion: 1,
			project: {
				id: 'project-1',
				name: 'Sample',
				createdAt: NOW().toISOString(),
				updatedAt: NOW().toISOString()
			},
			images: [],
			controlPointPairs: [],
			viewState: null
		};
		const missingBytes = zipSync({ 'project.json': strToU8(JSON.stringify(missingDoc)) }, { level: 6 });
		const result = await readProjectBundle(fileFrom(missingBytes), { decode: loadedDecode(), hash: sha256Hex });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('failure');
		if (result.kind !== 'failure') return;
		expect(result.error.kind).toBe('project-json');
		expect(result.error.schemaError).toBeTruthy();
		expect(result.error.schemaError?.category).toBe('image-manifest');

		const badRef = await baseDoc();
		((badRef.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).source = {
			imageId: imagesOf(badRef)[1].id,
			xPx: 1,
			yPx: 1
		};
		const refResult = await readProjectBundle(fileFrom(zipWith(badRef)), { decode: loadedDecode(), hash: sha256Hex });
		expect(refResult.ok).toBe(false);
		if (refResult.ok) return;
		expect(refResult.kind).toBe('failure');
		if (refResult.kind !== 'failure') return;
		expect(refResult.error.schemaError?.category).toBe('reference');

		const badCoord = await baseDoc();
		((badCoord.controlPointPairs as Array<Record<string, unknown>>)[0] as Record<string, unknown>).source = {
			imageId: imagesOf(badCoord)[0].id,
			xPx: 9999,
			yPx: 9999
		};
		const coordResult = await readProjectBundle(fileFrom(zipWith(badCoord)), { decode: loadedDecode(), hash: sha256Hex });
		expect(coordResult.ok).toBe(false);
		if (coordResult.ok) return;
		expect(coordResult.kind).toBe('failure');
		if (coordResult.kind !== 'failure') return;
		expect(coordResult.error.schemaError?.category).toBe('coordinate');
	});

	it('rejects unsafe, duplicate, and colliding bundle paths', async () => {
		const traversal = await baseDoc();
		imagesOf(traversal)[0].bundlePath = '../evil.png';
		await expectNonRepairFailure(fileFrom(zipWith(traversal)), decodeOf(2, 3), 'path');

		const absolute = await baseDoc();
		imagesOf(absolute)[0].bundlePath = '/absolute.png';
		await expectNonRepairFailure(fileFrom(zipWith(absolute)), decodeOf(2, 3), 'path');

		const backslash = await baseDoc();
		imagesOf(backslash)[0].bundlePath = 'images\\evil.png';
		await expectNonRepairFailure(fileFrom(zipWith(backslash)), decodeOf(2, 3), 'path');

		const outsideImages = await baseDoc();
		imagesOf(outsideImages)[0].bundlePath = 'source-original.png';
		await expectNonRepairFailure(fileFrom(zipWith(outsideImages)), decodeOf(2, 3), 'path');

		const collidesJson = await baseDoc();
		imagesOf(collidesJson)[0].bundlePath = 'project.json';
		await expectNonRepairFailure(fileFrom(zipWith(collidesJson)), decodeOf(2, 3), 'path');

		const duplicate = await baseDoc();
		imagesOf(duplicate)[1].bundlePath = 'images/source-original.png';
		await expectNonRepairFailure(fileFrom(zipWith(duplicate)), decodeOf(2, 3), 'path');
	});

	it('rejects unexpected archive entries', async () => {
		const doc = await baseDoc();
		const bytes = zipWith(doc, {}, { 'notes.txt': strToU8('hello') });
		await expectNonRepairFailure(fileFrom(bytes), decodeOf(2, 3), 'extra-entries');
	});

	it('rejects missing or invalid manifest hashes', async () => {
		const nullHash = await baseDoc();
		imagesOf(nullHash)[0].sha256 = null;
		await expectNonRepairFailure(fileFrom(zipWith(nullHash)), decodeOf(2, 3), 'hash-metadata');

		const invalidHash = await baseDoc();
		imagesOf(invalidHash)[0].sha256 = 'not-a-hash';
		await expectNonRepairFailure(fileFrom(zipWith(invalidHash)), decodeOf(2, 3), 'hash-metadata');
	});

	it('rejects an unsupported bundled MIME type', async () => {
		const doc = await baseDoc();
		imagesOf(doc)[0].mimeType = 'image/webp';
		const bytes = zipWith(doc, {
			'images/source-original.png': SRC,
			'images/target-original.jpg': TGT
		});
		await expectNonRepairFailure(fileFrom(bytes), decodeOf(2, 3), 'unsupported-mime');
	});

	it('reports a decode failure for a hash-verified image', async () => {
		const doc = await baseDoc();
		const bytes = zipWith(doc, {
			'images/source-original.png': SRC,
			'images/target-original.jpg': TGT
		});
		await expectNonRepairFailure(fileFrom(bytes), decodeOf(2, 3, true), 'decode-failure');
	});

	it('reports a dimension mismatch between decode and manifest', async () => {
		const doc = await baseDoc();
		const bytes = zipWith(doc, {
			'images/source-original.png': SRC,
			'images/target-original.jpg': TGT
		});
		const wrongDims: DecodeImageFile = async () => ({
			image: { simulated: true } as unknown as HTMLImageElement,
			widthPx: 999,
			heightPx: 999
		});
		await expectNonRepairFailure(fileFrom(bytes), wrongDims, 'dimension-mismatch');
	});

	it('every non-repair failure leaves the live editor byte-for-byte unchanged', async () => {
		const { editor } = await loadedEditor();
		const stateBefore = JSON.stringify(editor.state);
		const dirtyBefore = editor.isDirty;
		const undoBefore = editor.canUndo;
		const redoBefore = editor.canRedo;

		const good = await createProjectBundle(editor);
		expect(good.ok).toBe(true);
		if (!good.ok) return;
		const opened = await readProjectBundle(fileFrom(good.bundle.zipBytes), {
			decode: loadedDecode(),
			hash: sha256Hex
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;

		expect(JSON.stringify(editor.state)).toBe(stateBefore);
		expect(editor.isDirty).toBe(dirtyBefore);
		expect(editor.canUndo).toBe(undoBefore);
		expect(editor.canRedo).toBe(redoBefore);
	});
});

describe('repair (E)', () => {
	async function missingSourceBundle(): Promise<{
		file: File;
		doc: Record<string, unknown>;
	}> {
		const doc = await baseDoc();
		const bytes = zipSync(
			{
				'project.json': strToU8(JSON.stringify(doc)),
				'images/target-original.jpg': TGT
			},
			{ level: 6 }
		);
		return { file: fileFrom(bytes), doc };
	}

	it('produces an inspectable repair candidate for a missing image (never a blank open)', async () => {
		const { file, doc } = await missingSourceBundle();
		const candidate = expectRepair(
			await readProjectBundle(file, { decode: loadedDecode(), hash: sha256Hex })
		);
		expect(candidate.state.project.name).toBe('Untitled Project');
		expect(candidate.state.controlPointPairs).toHaveLength(1);
		expect(candidate.issues).toHaveLength(1);
		const issue = candidate.issues[0];
		expect(issue.image.role).toBe('source-overview');
		expect(issue.reason).toBe('missing');
		expect(issue.path).toBe('images/source-original.png');
		expect(issue.expectedHash).toBe(imagesOf(doc)[0].sha256);
		const targetId = candidate.state.images.find((image) => image.role === 'target-basemap')?.id;
		expect(candidate.verified.has(targetId as string)).toBe(true);
		expect(candidate.verified.size).toBe(1);
	});

	it('resolves a missing image with an exact hash/type/dimension match, keeping the original metadata and coordinates', async () => {
		const { file } = await missingSourceBundle();
		const candidate = expectRepair(
			await readProjectBundle(file, { decode: loadedDecode(), hash: sha256Hex })
		);
		const manifestId = candidate.state.images.find((image) => image.role === 'source-overview')?.id;

		const resolved = await resolveRepairWithFile(candidate, fileOf('udisc.png', 'image/png', SRC), 'source-overview', {
			decode: decodeOf(2, 3),
			hash: sha256Hex,
			createAssetId: nextId
		});
		const opened = expectResolutionOk(resolved);
		expect(opened.state.images.find((image) => image.role === 'source-overview')?.id).toBe(manifestId);
		expect(opened.state.images.find((image) => image.role === 'source-overview')?.sha256).toBe(
			await sha256Hex(SRC)
		);
		expect(opened.state.controlPointPairs).toHaveLength(1);
		expect(opened.state.controlPointPairs[0].source.imageId).toBe(manifestId);
		expect(opened.state.controlPointPairs[0].source.xPx).toBe(1);
		expect(opened.state.controlPointPairs[0].target.xPx).toBe(2);
		expect([...(opened.assets.get(manifestId as string) as { bytes: Uint8Array }).bytes]).toEqual([...SRC]);
	});

	it('a changed same-dimension image is an explicit replacement that retains points with a new id via the domain boundary', async () => {
		const { file } = await missingSourceBundle();
		const candidate = expectRepair(
			await readProjectBundle(file, { decode: loadedDecode(), hash: sha256Hex })
		);
		const manifestId = candidate.state.images.find((image) => image.role === 'source-overview')?.id;
		const originalPair = candidate.state.controlPointPairs[0];
		const different = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);
		const FIXED_NOW = new Date('2026-08-03T12:00:00.000Z');

		const resolved = await resolveRepairWithFile(candidate, fileOf('new.png', 'image/png', different), 'source-overview', {
			decode: decodeOf(2, 3),
			hash: sha256Hex,
			createAssetId: nextId,
			now: () => FIXED_NOW
		});
		const opened = expectResolutionOk(resolved);
		const source = opened.state.images.find((image) => image.role === 'source-overview');
		expect(source?.id).not.toBe(manifestId);
		expect(source?.sha256).toBe(await sha256Hex(different));
		expect(source?.bundlePath).toBe('images/source-original.png');
		expect(opened.state.controlPointPairs).toHaveLength(1);
		// Domain `replaceImage(retainPoints: true)` semantics: the pair is re-targeted,
		// its coordinates are untouched, its `updatedAt` is refreshed, and its `createdAt`
		// is preserved.
		const pair = opened.state.controlPointPairs[0];
		expect(pair.id).toBe(originalPair.id);
		expect(pair.source.imageId).toBe(source?.id);
		expect(pair.source.xPx).toBe(originalPair.source.xPx);
		expect(pair.target.xPx).toBe(originalPair.target.xPx);
		expect(pair.updatedAt).toBe(FIXED_NOW.toISOString());
		expect(pair.createdAt).toBe(originalPair.createdAt);
		expect(opened.assets.get(source?.id as string)?.decoded).toEqual({ simulated: true });
	});

	it('a different-dimension replacement requires explicit discard confirmation and can cancel', async () => {
		const { file } = await missingSourceBundle();
		const candidate = expectRepair(
			await readProjectBundle(file, { decode: loadedDecode(), hash: sha256Hex })
		);
		const wide = new Uint8Array([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);

		const first = await resolveRepairWithFile(candidate, fileOf('wide.png', 'image/png', wide), 'source-overview', {
			decode: decodeOf(9, 9),
			hash: sha256Hex,
			createAssetId: nextId
		});
		expect(first.ok).toBe(false);
		if (first.ok) return;
		expect(first.kind).toBe('discard-confirm');
		if (first.kind !== 'discard-confirm') return;
		expect(first.affectedCount).toBe(1);

		const confirmed = await resolveRepairWithFile(candidate, fileOf('wide.png', 'image/png', wide), 'source-overview', {
			decode: decodeOf(9, 9),
			hash: sha256Hex,
			createAssetId: nextId,
			discard: true
		});
		const opened = expectResolutionOk(confirmed);
		expect(opened.state.controlPointPairs).toHaveLength(0);
		expect(opened.state.images.find((image) => image.role === 'source-overview')?.widthPx).toBe(9);
		expect(opened.state.images.find((image) => image.role === 'source-overview')?.id).not.toBe(
			candidate.state.images.find((image) => image.role === 'source-overview')?.id
		);
	});

	it('rejects a colliding injected replacement asset id atomically as a structured repair error', async () => {
		const { file } = await missingSourceBundle();
		const candidate = expectRepair(
			await readProjectBundle(file, { decode: loadedDecode(), hash: sha256Hex })
		);
		const collidingId = [...candidate.verified.keys()][0];
		const candidateBefore = JSON.stringify(candidate.state);
		const different = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);

		const result = await resolveRepairWithFile(candidate, fileOf('new.png', 'image/png', different), 'source-overview', {
			decode: decodeOf(2, 3),
			hash: sha256Hex,
			createAssetId: () => collidingId
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('error');
		if (result.kind !== 'error') return;
		expect(result.error.kind).toBe('path');
		expect(result.error.message).toMatch(/could not be applied/);
		// The candidate is untouched and no invalid open was produced.
		expect(JSON.stringify(candidate.state)).toBe(candidateBefore);
		expect(candidate.state.images.find((image) => image.role === 'source-overview')?.id).toBe(
			candidate.state.images.find((image) => image.role === 'source-overview')?.id
		);
	});

	it('a hash-mismatch is never auto-accepted and requires an explicit action', async () => {
		const doc = await baseDoc();
		const expectedHash = await sha256Hex(new Uint8Array([7, 7, 7, 7]));
		imagesOf(doc)[0].sha256 = expectedHash;
		const bytes = zipSync(
			{
				'project.json': strToU8(JSON.stringify(doc)),
				'images/source-original.png': SRC,
				'images/target-original.jpg': TGT
			},
			{ level: 6 }
		);
		const candidate = expectRepair(
			await readProjectBundle(fileFrom(bytes), { decode: loadedDecode(), hash: sha256Hex })
		);
		expect(candidate.issues).toHaveLength(1);
		expect(candidate.issues[0].reason).toBe('hash-mismatch');
		expect(candidate.issues[0].expectedHash).toBe(expectedHash);
		expect(candidate.issues[0].archivedBytes).toBeDefined();
	});

	it('explicitly using the archived bytes replaces the image with a new id and retained same-dimension points', async () => {
		const doc = await baseDoc();
		imagesOf(doc)[0].sha256 = 'b'.repeat(64);
		const bytes = zipSync(
			{
				'project.json': strToU8(JSON.stringify(doc)),
				'images/source-original.png': SRC,
				'images/target-original.jpg': TGT
			},
			{ level: 6 }
		);
		const candidate = expectRepair(
			await readProjectBundle(fileFrom(bytes), { decode: loadedDecode(), hash: sha256Hex })
		);
		const manifestId = candidate.state.images.find((image) => image.role === 'source-overview')?.id;

		const resolved = await resolveRepairWithArchivedBytes(candidate, 'source-overview', {
			decode: decodeOf(2, 3),
			hash: sha256Hex,
			createAssetId: nextId
		});
		const opened = expectResolutionOk(resolved);
		const source = opened.state.images.find((image) => image.role === 'source-overview');
		expect(source?.id).not.toBe(manifestId);
		expect(source?.sha256).toBe(await sha256Hex(SRC));
		expect(opened.state.controlPointPairs).toHaveLength(1);
		expect(opened.state.controlPointPairs[0].source.imageId).toBe(source?.id);
	});

	it('an exact local file also resolves a hash-mismatch to the original', async () => {
		const doc = await baseDoc();
		const exact = new Uint8Array([7, 7, 7, 7]);
		const expectedHash = await sha256Hex(exact);
		imagesOf(doc)[0].sha256 = expectedHash;
		const bytes = zipSync(
			{
				'project.json': strToU8(JSON.stringify(doc)),
				'images/source-original.png': SRC,
				'images/target-original.jpg': TGT
			},
			{ level: 6 }
		);
		const candidate = expectRepair(
			await readProjectBundle(fileFrom(bytes), { decode: loadedDecode(), hash: sha256Hex })
		);
		const manifestId = candidate.state.images.find((image) => image.role === 'source-overview')?.id;

		const resolved = await resolveRepairWithFile(candidate, fileOf('correct.png', 'image/png', exact), 'source-overview', {
			decode: decodeOf(2, 3),
			hash: sha256Hex,
			createAssetId: nextId
		});
		const opened = expectResolutionOk(resolved);
		expect(opened.state.images.find((image) => image.role === 'source-overview')?.id).toBe(manifestId);
		expect([...(opened.assets.get(manifestId as string) as { bytes: Uint8Array }).bytes]).toEqual([...exact]);
	});

	it('resolves multiple missing images one at a time through incomplete candidates', async () => {
		const doc = await baseDoc();
		const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(doc)) }, { level: 6 });
		const candidate = expectRepair(
			await readProjectBundle(fileFrom(bytes), { decode: loadedDecode(), hash: sha256Hex })
		);
		expect(candidate.issues).toHaveLength(2);

		const first = await resolveRepairWithFile(candidate, fileOf('udisc.png', 'image/png', SRC), 'source-overview', {
			decode: decodeOf(2, 3),
			hash: sha256Hex,
			createAssetId: nextId
		});
		expect(first.ok).toBe(false);
		if (first.ok) return;
		expect(first.kind).toBe('incomplete');
		if (first.kind !== 'incomplete') return;
		expect(first.candidate.issues).toHaveLength(1);
		expect(first.candidate.issues[0].image.role).toBe('target-basemap');

		const second = await resolveRepairWithFile(first.candidate, fileOf('map.jpg', 'image/jpeg', TGT), 'target-basemap', {
			decode: decodeOf(5, 4),
			hash: sha256Hex,
			createAssetId: nextId
		});
		const opened = expectResolutionOk(second);
		expect(opened.state.images).toHaveLength(2);
		expect(opened.state.controlPointPairs).toHaveLength(1);
	});

	it('both images missing: a changed same-dimension first replacement returns an incomplete candidate (not an error), then the second completes a valid open', async () => {
		const doc = await baseDoc();
		const bytes = zipSync({ 'project.json': strToU8(JSON.stringify(doc)) }, { level: 6 });
		const candidate = expectRepair(
			await readProjectBundle(fileFrom(bytes), { decode: loadedDecode(), hash: sha256Hex })
		);
		expect(candidate.issues).toHaveLength(2);
		const candidateBefore = JSON.stringify(candidate.state);
		const manifestSourceId = candidate.state.images.find(
			(image) => image.role === 'source-overview'
		)?.id as string;

		// Changed same-dimension (non-exact, point-retaining) replacement for the first
		// missing role. It succeeds in the domain editor and must return an incomplete
		// candidate with the replacement resource present and the other issue outstanding,
		// never a decode-failure error for the still-unresolved second image.
		const changedSrc = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);
		const first = await resolveRepairWithFile(candidate, fileOf('new-source.png', 'image/png', changedSrc), 'source-overview', {
			decode: decodeOf(2, 3),
			hash: sha256Hex,
			createAssetId: nextId
		});
		expect(first.ok).toBe(false);
		if (first.ok) return;
		expect(first.kind).toBe('incomplete');
		if (first.kind !== 'incomplete') return;
		expect(first.candidate.issues).toHaveLength(1);
		expect(first.candidate.issues[0].image.role).toBe('target-basemap');
		const newSource = first.candidate.state.images.find((image) => image.role === 'source-overview');
		expect(newSource?.id).not.toBe(manifestSourceId);
		expect(first.candidate.state.controlPointPairs[0].source.imageId).toBe(newSource?.id);
		expect(first.candidate.verified.has(newSource?.id as string)).toBe(true);
		expect(first.candidate.verified.has(manifestSourceId)).toBe(false);
		expect(first.candidate.verified.size).toBe(1);
		// The candidate input is immutable/atomic throughout.
		expect(JSON.stringify(candidate.state)).toBe(candidateBefore);

		// Resolve the remaining (target) role with a changed same-dimension file too.
		const changedTgt = new Uint8Array([8, 8, 8, 8]);
		const second = await resolveRepairWithFile(first.candidate, fileOf('new-target.jpg', 'image/jpeg', changedTgt), 'target-basemap', {
			decode: decodeOf(5, 4),
			hash: sha256Hex,
			createAssetId: nextId
		});
		const opened = expectResolutionOk(second);
		const finalSource = opened.state.images.find((image) => image.role === 'source-overview');
		const finalTarget = opened.state.images.find((image) => image.role === 'target-basemap');
		expect(finalSource?.id).toBe(newSource?.id);
		expect(finalTarget?.id).not.toBe(
			candidate.state.images.find((image) => image.role === 'target-basemap')?.id
		);
		expect(opened.state.controlPointPairs).toHaveLength(1);
		const pair = opened.state.controlPointPairs[0];
		expect(pair.source.imageId).toBe(finalSource?.id);
		expect(pair.target.imageId).toBe(finalTarget?.id);
		// Both final resources are present with the exact resolved bytes/decoded.
		expect([...(opened.assets.get(finalSource!.id) as AssetResource).bytes]).toEqual([...changedSrc]);
		expect([...(opened.assets.get(finalTarget!.id) as AssetResource).bytes]).toEqual([...changedTgt]);
		expect(opened.assets.get(finalSource!.id)?.decoded).toEqual({ simulated: true });
		expect(opened.assets.get(finalTarget!.id)?.decoded).toEqual({ simulated: true });
	});

	it('rejects an unsupported replacement file type during repair', async () => {
		const { file } = await missingSourceBundle();
		const candidate = expectRepair(
			await readProjectBundle(file, { decode: loadedDecode(), hash: sha256Hex })
		);
		const result = await resolveRepairWithFile(
			candidate,
			fileOf('notes.txt', 'text/plain', SRC),
			'source-overview',
			{ decode: decodeOf(2, 3), hash: sha256Hex, createAssetId: nextId }
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe('error');
		if (result.kind !== 'error') return;
		expect(result.error.kind).toBe('unsupported-mime');
	});
});

describe('writer/import hash metadata consistency (B/D)', () => {
	it('the writer recomputes the manifest hash from the archived bytes (self-consistent)', async () => {
		const { editor } = await loadedEditor();
		const created = await createProjectBundle(editor);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const opened = await readProjectBundle(fileFrom(created.bundle.zipBytes), {
			decode: loadedDecode(),
			hash: sha256Hex
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(opened.state.images[0].sha256).toBe(created.bundle.images[0].sha256);
		expect(opened.state.images[1].sha256).toBe(created.bundle.images[1].sha256);
	});

	it('import recomputes the archive hash and rejects a manifest that does not match', async () => {
		const doc = await baseDoc();
		imagesOf(doc)[0].sha256 = '0'.repeat(64);
		const bytes = zipWith(doc, {
			'images/source-original.png': SRC,
			'images/target-original.jpg': TGT
		});
		const candidate = expectRepair(
			await readProjectBundle(fileFrom(bytes), { decode: loadedDecode(), hash: sha256Hex })
		);
		expect(candidate.issues[0].reason).toBe('hash-mismatch');
	});
});

describe('CHSPT-49 source-capture provenance persistence (F)', () => {
	describe('save', () => {
		it('archives a registered source capture at images/sources/<sourceId>.<ext>, hash-verified', async () => {
			const { editor, provenance } = await loadedEditorWithProvenance();
			const created = await createProjectBundle(editor);
			expect(created.ok).toBe(true);
			if (!created.ok) return;

			expect(created.bundle.sourceCaptureIssues).toEqual([]);
			expect(created.bundle.sourceCaptures).toHaveLength(1);
			expect(created.bundle.sourceCaptures[0].path).toBe('images/sources/capture-1.jpg');
			expect(created.bundle.sourceCaptures[0].sha256).toBe(await sha256Hex(SOURCE_CAPTURE_BYTES));

			const entries = unzipSync(created.bundle.zipBytes);
			expect(Object.keys(entries).sort()).toEqual([
				'images/source-original.png',
				'images/sources/capture-1.jpg',
				'images/target-original.jpg',
				'project.json'
			]);
			expect([...entries['images/sources/capture-1.jpg']]).toEqual([...SOURCE_CAPTURE_BYTES]);

			const parsed = parseProjectJson(created.bundle.text);
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;
			expect(parsed.state.images[0].provenance).toEqual(provenance);
		});

		it('degrades gracefully (still succeeds) and reports a missing sourceCaptureIssue when capture bytes were never registered', async () => {
			const { editor } = await loadedEditorWithProvenance({ attachCaptureBytes: false });
			const created = await createProjectBundle(editor);
			expect(created.ok).toBe(true);
			if (!created.ok) return;

			expect(created.bundle.sourceCaptures).toEqual([]);
			expect(created.bundle.sourceCaptureIssues).toEqual([
				{ sourceId: 'capture-1', path: 'images/sources/capture-1.jpg', reason: 'missing', expectedHash: await sha256Hex(SOURCE_CAPTURE_BYTES) }
			]);
			// The two live images still save normally despite the degraded lineage signal.
			const entries = unzipSync(created.bundle.zipBytes);
			expect(Object.keys(entries).sort()).toEqual([
				'images/source-original.png',
				'images/target-original.jpg',
				'project.json'
			]);
		});

		it('fails the save loudly when registered capture bytes contradict the recorded hash', async () => {
			const { editor } = await loadedEditorWithProvenance();
			// Bytes ARE registered, but they no longer match what provenance claims about them.
			editor.setSourceCaptureBytes('capture-1', new Uint8Array([0, 0, 0]));
			const created = await createProjectBundle(editor);
			expect(created.ok).toBe(false);
			if (created.ok) return;
			expect(created.error.kind).toBe('export-failure');
			expect(created.error.message).toMatch(/capture-1/);
		});

		it('surfaces sourceCaptureIssues through saveProject as well', async () => {
			const { editor } = await loadedEditorWithProvenance({ attachCaptureBytes: false });
			const result = await saveProject(editor, { download: () => undefined });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.sourceCaptureIssues).toHaveLength(1);
			expect(result.sourceCaptureIssues[0].reason).toBe('missing');
		});
	});

	describe('open', () => {
		it('round-trips provenance and restores hash-verified source-capture bytes on a clean open', async () => {
			const { editor, provenance } = await loadedEditorWithProvenance();
			const created = await createProjectBundle(editor);
			expect(created.ok).toBe(true);
			if (!created.ok) return;

			const opened = await readProjectBundle(fileFrom(created.bundle.zipBytes), {
				decode: loadedDecode(),
				hash: sha256Hex
			});
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;

			expect(opened.state.images[0].provenance).toEqual(provenance);
			expect(opened.sourceCaptureIssues).toEqual([]);
			expect([...(opened.assets.get('capture-1') as AssetResource).bytes]).toEqual([...SOURCE_CAPTURE_BYTES]);
			expect(opened.assets.get('capture-1')?.decoded).toBeNull();

			// The restored bytes survive into a fresh editor and can be re-saved (never
			// discarded merely by opening and re-saving the project).
			const reopened = new ProjectEditor({ state: opened.state, assets: opened.assets, now: NOW });
			const resaved = await createProjectBundle(reopened);
			expect(resaved.ok).toBe(true);
			if (!resaved.ok) return;
			expect(resaved.bundle.sourceCaptureIssues).toEqual([]);
			expect(resaved.bundle.sourceCaptures).toHaveLength(1);
		});

		it('degrades gracefully (still opens) and reports a missing sourceCaptureIssue when the sources/ file is absent from the archive', async () => {
			const { editor } = await loadedEditorWithProvenance();
			const created = await createProjectBundle(editor);
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			const entries = unzipSync(created.bundle.zipBytes);
			delete entries['images/sources/capture-1.jpg'];
			const strippedBytes = zipSync(entries, { level: 6 });

			const opened = await readProjectBundle(fileFrom(strippedBytes), { decode: loadedDecode(), hash: sha256Hex });
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			expect(opened.state.images[0].provenance).toBeDefined();
			expect(opened.sourceCaptureIssues).toEqual([
				{
					sourceId: 'capture-1',
					path: 'images/sources/capture-1.jpg',
					reason: 'missing',
					expectedHash: await sha256Hex(SOURCE_CAPTURE_BYTES)
				}
			]);
			expect(opened.assets.has('capture-1')).toBe(false);
			// The two live images still open normally.
			expect([...(opened.assets.get(opened.state.images[0].id) as AssetResource).bytes]).toEqual([...SRC]);
		});

		it('degrades gracefully (still opens) and reports a hash-mismatch sourceCaptureIssue when the sources/ file bytes were altered', async () => {
			const { editor } = await loadedEditorWithProvenance();
			const created = await createProjectBundle(editor);
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			const entries = unzipSync(created.bundle.zipBytes);
			entries['images/sources/capture-1.jpg'] = new Uint8Array([1, 1, 1]);
			const tamperedBytes = zipSync(entries, { level: 6 });

			const opened = await readProjectBundle(fileFrom(tamperedBytes), { decode: loadedDecode(), hash: sha256Hex });
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			expect(opened.sourceCaptureIssues).toEqual([
				{
					sourceId: 'capture-1',
					path: 'images/sources/capture-1.jpg',
					reason: 'hash-mismatch',
					expectedHash: await sha256Hex(SOURCE_CAPTURE_BYTES)
				}
			]);
			expect(opened.assets.has('capture-1')).toBe(false);
		});

		it('still rejects a truly unexpected extra entry even though images/sources/ paths are otherwise allowed', async () => {
			const { editor } = await loadedEditorWithProvenance();
			const created = await createProjectBundle(editor);
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			const entries = unzipSync(created.bundle.zipBytes);
			entries['images/sources/not-a-real-capture.png'] = new Uint8Array([1, 2, 3]);
			const bytes = zipSync(entries, { level: 6 });

			const result = await readProjectBundle(fileFrom(bytes), { decode: loadedDecode(), hash: sha256Hex });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.kind).toBe('failure');
			if (result.kind !== 'failure') return;
			expect(result.error.kind).toBe('extra-entries');
		});

		it('a project with no provenance opens exactly as before, with an empty sourceCaptureIssues', async () => {
			const { editor } = await loadedEditor();
			const created = await createProjectBundle(editor);
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			expect(created.bundle.sourceCaptures).toEqual([]);
			expect(created.bundle.sourceCaptureIssues).toEqual([]);

			const opened = await readProjectBundle(fileFrom(created.bundle.zipBytes), {
				decode: loadedDecode(),
				hash: sha256Hex
			});
			expect(opened.ok).toBe(true);
			if (!opened.ok) return;
			expect(opened.sourceCaptureIssues).toEqual([]);
			expect(opened.state.images[0].provenance).toBeUndefined();
		});

		it('does not restore source captures when the same open also needs live-image repair (documented, bounded scope)', async () => {
			const { editor } = await loadedEditorWithProvenance();
			const created = await createProjectBundle(editor);
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			const entries = unzipSync(created.bundle.zipBytes);
			// Drop the source-overview live image itself so this open needs repair.
			delete entries['images/source-original.png'];
			const bytes = zipSync(entries, { level: 6 });

			const result = await readProjectBundle(fileFrom(bytes), { decode: loadedDecode(), hash: sha256Hex });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.kind).toBe('repair');
			if (result.kind !== 'repair') return;
			// The repair candidate is still produced correctly (provenance present on the
			// parsed state); source-capture restoration is simply out of scope for this path.
			expect(result.candidate.state.images.find((image) => image.role === 'source-overview')?.provenance).toBeDefined();
		});
	});
});
