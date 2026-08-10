import { describe, expect, it } from 'vitest';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { AnnotatedHole, ImageAsset, ProjectState } from '../../src/lib/domain/project';
import { DEFAULT_CORRIDOR_WIDTH_PX } from '../../src/lib/corridor';
import {
	CURRENT_SCHEMA_VERSION,
	parseProjectDocument,
	serializeProjectState
} from '../../src/lib/projectSchema';

const FIXED_TIMESTAMP = '2026-08-02T00:00:00.000Z';
const NOW = () => new Date(FIXED_TIMESTAMP);

function sourceAsset(overrides: Partial<ImageAsset> = {}): ImageAsset {
	return {
		id: 'image-source',
		role: 'source-overview',
		fileName: 'udisc.png',
		mimeType: 'image/png',
		widthPx: 1000,
		heightPx: 800,
		sha256: null,
		bundlePath: null,
		...overrides
	};
}

function targetAsset(overrides: Partial<ImageAsset> = {}): ImageAsset {
	return {
		id: 'image-target',
		role: 'target-basemap',
		fileName: 'clean.png',
		mimeType: 'image/png',
		widthPx: 1200,
		heightPx: 900,
		sha256: null,
		bundlePath: null,
		...overrides
	};
}

const RICH_HOLE: AnnotatedHole = {
	id: 'hole-a',
	number: 1,
	tee: { xPx: 10.5, yPx: 20.25 },
	basket: { xPx: 900.75, yPx: 700.5 },
	shots: [
		{ id: 'shot-1', landing: { xPx: 300, yPx: 250.5 } },
		{ id: 'shot-2', landing: { xPx: 600.25, yPx: 500 } }
	],
	corridorBends: [
		{ xPx: 400, yPx: 300 },
		{ xPx: 600, yPx: 600 }
	],
	corridorWidthPx: 90
};

function stateWithHoles(holes: AnnotatedHole[]): ProjectState {
	return {
		project: {
			id: 'project-1',
			name: 'Round',
			createdAt: FIXED_TIMESTAMP,
			updatedAt: FIXED_TIMESTAMP
		},
		images: [sourceAsset(), targetAsset()],
		controlPointPairs: [],
		holes,
		numberBadges: [],
		viewState: null
	};
}

describe('hole serialization round trip', () => {
	it('round-trips a fully-featured hole without coordinate drift', () => {
		const state = stateWithHoles([RICH_HOLE]);
		const doc = serializeProjectState(state);
		expect(doc.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

		const result = parseProjectDocument(JSON.parse(JSON.stringify(doc)));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.holes).toEqual([RICH_HOLE]);
	});

	it('emits corridorBends and corridorWidthPx on every hole, omitting only genuinely optional fields', () => {
		const sparse: AnnotatedHole = {
			id: 'hole-b',
			number: 2,
			shots: [],
			corridorBends: [],
			corridorWidthPx: 60
		};
		const doc = serializeProjectState(stateWithHoles([sparse]));

		expect(Object.keys(doc.holes[0]).sort()).toEqual([
			'corridorBends',
			'corridorWidthPx',
			'id',
			'number',
			'shots'
		]);

		const result = parseProjectDocument(JSON.parse(JSON.stringify(doc)));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.holes[0]).toEqual(sparse);
	});

	it('preserves shot order exactly', () => {
		const parsed = parseProjectDocument(
			JSON.parse(JSON.stringify(serializeProjectState(stateWithHoles([RICH_HOLE]))))
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.state.holes[0].shots.map((shot) => shot.id)).toEqual(['shot-1', 'shot-2']);
	});

	it('round-trips a present par and omits it when absent', () => {
		const withPar: AnnotatedHole = { ...RICH_HOLE, par: 4 };
		const parsedWithPar = parseProjectDocument(
			JSON.parse(JSON.stringify(serializeProjectState(stateWithHoles([withPar]))))
		);
		expect(parsedWithPar.ok).toBe(true);
		if (parsedWithPar.ok) expect(parsedWithPar.state.holes[0].par).toBe(4);

		const doc = serializeProjectState(stateWithHoles([RICH_HOLE]));
		expect(Object.keys(doc.holes[0])).not.toContain('par');
		const parsedWithoutPar = parseProjectDocument(JSON.parse(JSON.stringify(doc)));
		expect(parsedWithoutPar.ok).toBe(true);
		if (parsedWithoutPar.ok) expect(parsedWithoutPar.state.holes[0].par).toBeUndefined();
	});
});

describe('v1/v2 migration', () => {
	it('reads a v1 document (written before holes existed) as a project with no holes', () => {
		const v3 = serializeProjectState(stateWithHoles([]));
		const v1 = JSON.parse(JSON.stringify(v3)) as Record<string, unknown>;
		v1.schemaVersion = 1;
		delete v1.holes;

		const result = parseProjectDocument(v1);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.holes).toEqual([]);
	});

	it('re-serializing a migrated v1 document writes it forward as the current version', () => {
		const v1 = JSON.parse(JSON.stringify(serializeProjectState(stateWithHoles([])))) as Record<
			string,
			unknown
		>;
		v1.schemaVersion = 1;
		delete v1.holes;

		const parsed = parseProjectDocument(v1);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(serializeProjectState(parsed.state).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
	});

	it('drops a v2 legacy corridor polygon, initializing empty bends and the default width', () => {
		const v3 = serializeProjectState(stateWithHoles([]));
		const v2 = JSON.parse(JSON.stringify(v3)) as Record<string, unknown>;
		v2.schemaVersion = 2;
		(v2.holes as unknown[]).push({
			id: 'legacy-hole',
			number: 1,
			tee: { xPx: 10, yPx: 10 },
			basket: { xPx: 900, yPx: 700 },
			shots: [],
			corridor: [
				{ xPx: 0, yPx: 0 },
				{ xPx: 999, yPx: 0 },
				{ xPx: 999, yPx: 799 }
			]
		});

		const result = parseProjectDocument(v2);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const migrated = result.state.holes[0];
		expect(migrated.corridorBends).toEqual([]);
		expect(migrated.corridorWidthPx).toBe(DEFAULT_CORRIDOR_WIDTH_PX);
		expect(migrated.tee).toEqual({ xPx: 10, yPx: 10 });
		expect(migrated.basket).toEqual({ xPx: 900, yPx: 700 });
		expect('corridor' in migrated).toBe(false);

		const reSerialized = serializeProjectState(result.state);
		expect(reSerialized.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect('corridor' in reSerialized.holes[0]).toBe(false);
	});
});

describe('hole validation on parse', () => {
	function parseWithHoles(holes: unknown) {
		const doc = JSON.parse(JSON.stringify(serializeProjectState(stateWithHoles([])))) as Record<
			string,
			unknown
		>;
		doc.holes = holes;
		return parseProjectDocument(doc);
	}

	it('rejects a hole point outside the source image bounds', () => {
		const result = parseWithHoles([{ id: 'h', number: 1, shots: [], tee: { xPx: 5000, yPx: 10 } }]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.category).toBe('coordinate');
		expect(result.error.code).toBe('coordinate.out-of-bounds');
	});

	it('rejects a non-finite hole coordinate rather than coercing it', () => {
		const result = parseWithHoles([{ id: 'h', number: 1, shots: [], tee: { xPx: null, yPx: 10 } }]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.category).toBe('coordinate');
	});

	it('rejects a corridor bend outside the source image bounds', () => {
		const result = parseWithHoles([
			{
				id: 'h',
				number: 1,
				shots: [],
				corridorBends: [
					{ xPx: 1, yPx: 1 },
					{ xPx: 5000, yPx: 2 }
				],
				corridorWidthPx: 60
			}
		]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.category).toBe('coordinate');
		expect(result.error.code).toBe('coordinate.out-of-bounds');
	});

	it('rejects a non-positive corridor width', () => {
		const result = parseWithHoles([
			{ id: 'h', number: 1, shots: [], corridorBends: [], corridorWidthPx: 0 }
		]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.category).toBe('hole');
		expect(result.error.code).toBe('hole.width.invalid');
	});

	it('rejects a non-numeric corridor width', () => {
		const result = parseWithHoles([
			{ id: 'h', number: 1, shots: [], corridorBends: [], corridorWidthPx: 'wide' }
		]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.category).toBe('hole');
		expect(result.error.code).toBe('hole.width.type');
	});

	it('rejects a non-positive or non-integer par', () => {
		for (const par of [0, -3, 3.5]) {
			const result = parseWithHoles([{ id: 'h', number: 1, shots: [], par }]);
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.error.category).toBe('hole');
			expect(result.error.code).toBe('hole.par.invalid');
		}
	});

	it('rejects a non-numeric par', () => {
		const result = parseWithHoles([{ id: 'h', number: 1, shots: [], par: 'four' }]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.category).toBe('hole');
		expect(result.error.code).toBe('hole.par.type');
	});

	it('rejects duplicate hole numbers', () => {
		const result = parseWithHoles([
			{ id: 'h1', number: 1, shots: [] },
			{ id: 'h2', number: 1, shots: [] }
		]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe('hole.number-duplicate');
	});

	it('rejects a non-positive or non-integer hole number', () => {
		for (const number of [0, -1, 1.5]) {
			const result = parseWithHoles([{ id: 'h', number, shots: [] }]);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.error.code).toBe('hole.number.invalid');
		}
	});

	it('drops unknown fields on a hole so they cannot survive a round trip', () => {
		const result = parseWithHoles([
			{ id: 'h', number: 1, shots: [], corridorBends: [], corridorWidthPx: 60, sneaky: 'value' }
		]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.keys(result.state.holes[0]).sort()).toEqual([
			'corridorBends',
			'corridorWidthPx',
			'id',
			'number',
			'shots'
		]);
	});
});

describe('ProjectEditor.setHoles', () => {
	function loadedEditor(): ProjectEditor {
		const editor = new ProjectEditor({
			state: {
				...createProjectState({ createId: () => 'project-1', now: NOW }),
				images: [sourceAsset(), targetAsset()]
			},
			now: NOW
		});
		return editor;
	}

	it('enters history as one step and is undoable/redoable', () => {
		const editor = loadedEditor();
		expect(editor.state.holes).toEqual([]);

		editor.setHoles([RICH_HOLE]);
		expect(editor.state.holes).toEqual([RICH_HOLE]);
		expect(editor.canUndo).toBe(true);

		editor.undo();
		expect(editor.state.holes).toEqual([]);
		editor.redo();
		expect(editor.state.holes).toEqual([RICH_HOLE]);
	});

	it('isolates stored holes from the caller\'s array', () => {
		const editor = loadedEditor();
		const holes: AnnotatedHole[] = [
			{ id: 'h', number: 1, shots: [], tee: { xPx: 5, yPx: 5 }, corridorBends: [], corridorWidthPx: 60 }
		];
		editor.setHoles(holes);
		holes.push({ id: 'other', number: 2, shots: [], corridorBends: [], corridorWidthPx: 60 });
		expect(editor.state.holes).toHaveLength(1);
	});

	it('rejects an out-of-bounds hole point before it can reach serialization', () => {
		const editor = loadedEditor();
		expect(() =>
			editor.setHoles([
				{ id: 'h', number: 1, shots: [], tee: { xPx: 5000, yPx: 5 }, corridorBends: [], corridorWidthPx: 60 }
			])
		).toThrow(/outside the source image bounds/);
		expect(editor.state.holes).toEqual([]);
	});

	it('rejects an out-of-bounds bend and a non-positive width', () => {
		const editor = loadedEditor();
		expect(() =>
			editor.setHoles([
				{
					id: 'h',
					number: 1,
					shots: [],
					corridorBends: [{ xPx: 1, yPx: 1 }, { xPx: 5000, yPx: 2 }],
					corridorWidthPx: 60
				}
			])
		).toThrow(/outside the source image bounds/);
		expect(() =>
			editor.setHoles([
				{ id: 'h', number: 1, shots: [], corridorBends: [], corridorWidthPx: 0 }
			])
		).toThrow(/corridorWidthPx must be a finite number greater than zero/);
		expect(() =>
			editor.setHoles([
				{ id: 'h1', number: 1, shots: [], corridorBends: [], corridorWidthPx: 60 },
				{ id: 'h2', number: 1, shots: [], corridorBends: [], corridorWidthPx: 60 }
			])
		).toThrow(/duplicate hole number/);
		expect(editor.state.holes).toEqual([]);
	});

	it('setting an identical list is a no-op that does not grow history', () => {
		const editor = loadedEditor();
		editor.setHoles([RICH_HOLE]);
		const undoDepthProbe = editor.canUndo;
		editor.setHoles([RICH_HOLE]);
		editor.undo();
		// A second identical set must not have pushed another snapshot, so one undo
		// returns all the way to the empty list.
		expect(undoDepthProbe).toBe(true);
		expect(editor.state.holes).toEqual([]);
	});
});

describe('ProjectEditor.setNumberBadges', () => {
	function loadedEditor(): ProjectEditor {
		return new ProjectEditor({
			state: {
				...createProjectState({ createId: () => 'project-1', now: NOW }),
				images: [sourceAsset(), targetAsset()]
			},
			now: NOW
		});
	}

	const RICH_BADGE = { number: 1, xPx: 118.25, yPx: 200.5, confidence: 0.92 };

	it('enters history as one step and is undoable/redoable', () => {
		const editor = loadedEditor();
		expect(editor.state.numberBadges).toEqual([]);

		editor.setNumberBadges([RICH_BADGE]);
		expect(editor.state.numberBadges).toEqual([RICH_BADGE]);
		expect(editor.canUndo).toBe(true);

		editor.undo();
		expect(editor.state.numberBadges).toEqual([]);
		editor.redo();
		expect(editor.state.numberBadges).toEqual([RICH_BADGE]);
	});

	it("isolates stored badges from the caller's array", () => {
		const editor = loadedEditor();
		const badges = [RICH_BADGE];
		editor.setNumberBadges(badges);
		badges.push({ number: 2, xPx: 10, yPx: 10, confidence: 0.5 });
		expect(editor.state.numberBadges).toHaveLength(1);
	});

	it('rejects an out-of-bounds badge point before it can reach serialization', () => {
		const editor = loadedEditor();
		expect(() => editor.setNumberBadges([{ number: 1, xPx: 5000, yPx: 5, confidence: 0.9 }])).toThrow(
			/outside the source image bounds/
		);
		expect(editor.state.numberBadges).toEqual([]);
	});

	it('rejects a duplicate badge number and a confidence outside [0, 1]', () => {
		const editor = loadedEditor();
		expect(() =>
			editor.setNumberBadges([
				{ number: 1, xPx: 10, yPx: 10, confidence: 0.9 },
				{ number: 1, xPx: 20, yPx: 20, confidence: 0.8 }
			])
		).toThrow(/duplicate badge number/);
		expect(() => editor.setNumberBadges([{ number: 1, xPx: 10, yPx: 10, confidence: 1.5 }])).toThrow(
			/confidence must be a finite number in \[0, 1\]/
		);
		expect(editor.state.numberBadges).toEqual([]);
	});

	it('rejects setting badges before a source image is loaded', () => {
		const editor = new ProjectEditor({ state: createProjectState({ createId: () => 'project-1', now: NOW }) });
		expect(() => editor.setNumberBadges([RICH_BADGE])).toThrow(
			/the source-overview image must be loaded/
		);
	});

	it('setting an identical list is a no-op that does not grow history', () => {
		const editor = loadedEditor();
		editor.setNumberBadges([RICH_BADGE]);
		const undoDepthProbe = editor.canUndo;
		editor.setNumberBadges([RICH_BADGE]);
		editor.undo();
		expect(undoDepthProbe).toBe(true);
		expect(editor.state.numberBadges).toEqual([]);
	});
});

describe('ProjectEditor.setWalkingPath', () => {
	function loadedEditor(): ProjectEditor {
		return new ProjectEditor({
			state: {
				...createProjectState({ createId: () => 'project-1', now: NOW }),
				images: [sourceAsset(), targetAsset()]
			},
			now: NOW
		});
	}

	const PATH = [
		{ xPx: 12.5, yPx: 18.25 },
		{ xPx: 400, yPx: 512.75 }
	];

	it('enters history as one step and is undoable/redoable', () => {
		const editor = loadedEditor();
		expect(editor.state.walkingPath).toBeUndefined();

		editor.setWalkingPath(PATH);
		expect(editor.state.walkingPath).toEqual(PATH);
		expect(editor.canUndo).toBe(true);

		editor.undo();
		expect(editor.state.walkingPath).toBeUndefined();
		editor.redo();
		expect(editor.state.walkingPath).toEqual(PATH);
	});

	it("isolates the stored path from the caller's array", () => {
		const editor = loadedEditor();
		const path = [{ xPx: 5, yPx: 5 }];
		editor.setWalkingPath(path);
		path.push({ xPx: 10, yPx: 10 });
		expect(editor.state.walkingPath).toEqual([{ xPx: 5, yPx: 5 }]);
	});

	it('normalizes an empty array to undefined, same representation as never having set one', () => {
		const editor = loadedEditor();
		editor.setWalkingPath(PATH);
		editor.setWalkingPath([]);
		expect(editor.state.walkingPath).toBeUndefined();
	});

	it('setting undefined when already undefined is a no-op that does not grow history', () => {
		const editor = loadedEditor();
		editor.setWalkingPath(undefined);
		expect(editor.canUndo).toBe(false);
	});

	it('rejects an out-of-bounds point before it can reach serialization', () => {
		const editor = loadedEditor();
		expect(() => editor.setWalkingPath([{ xPx: 5000, yPx: 5 }])).toThrow(
			/outside the source image bounds/
		);
		expect(editor.state.walkingPath).toBeUndefined();
	});

	it('rejects a non-finite point', () => {
		const editor = loadedEditor();
		expect(() => editor.setWalkingPath([{ xPx: Number.NaN, yPx: 5 }])).toThrow(/must be finite/);
		expect(editor.state.walkingPath).toBeUndefined();
	});

	it('rejects setting a non-empty path before a source image is loaded', () => {
		const editor = new ProjectEditor({ state: createProjectState({ createId: () => 'project-1', now: NOW }) });
		expect(() => editor.setWalkingPath(PATH)).toThrow(/the source-overview image must be loaded/);
	});

	it('setting an identical path is a no-op that does not grow history', () => {
		const editor = loadedEditor();
		editor.setWalkingPath(PATH);
		const undoDepthProbe = editor.canUndo;
		editor.setWalkingPath(PATH);
		editor.undo();
		expect(undoDepthProbe).toBe(true);
		expect(editor.state.walkingPath).toBeUndefined();
	});
});

describe('replacing the source image and holes', () => {
	function editorWithHoles(): ProjectEditor {
		const editor = new ProjectEditor({
			state: {
				...createProjectState({ createId: () => 'project-1', now: NOW }),
				images: [sourceAsset(), targetAsset()]
			},
			assets: new Map([
				['image-source', { bytes: new Uint8Array([1, 2, 3]), decoded: null }],
				['image-target', { bytes: new Uint8Array([4, 5, 6]), decoded: null }]
			]),
			now: NOW
		});
		editor.setHoles([RICH_HOLE]);
		editor.setWalkingPath([{ xPx: 12.5, yPx: 18.25 }]);
		return editor;
	}

	it('discards holes and the walking path when the source image is replaced at different dimensions', () => {
		const editor = editorWithHoles();
		editor.replaceImage({
			role: 'source-overview',
			asset: sourceAsset({ id: 'image-source-2', widthPx: 500, heightPx: 400 }),
			bytes: new Uint8Array([9, 9, 9]),
			retainPoints: false
		});
		expect(editor.state.holes).toEqual([]);
		expect(editor.state.walkingPath).toBeUndefined();
	});

	it('keeps holes and the walking path when the source image is replaced at identical dimensions with points retained', () => {
		const editor = editorWithHoles();
		editor.replaceImage({
			role: 'source-overview',
			asset: sourceAsset({ id: 'image-source-2' }),
			bytes: new Uint8Array([9, 9, 9]),
			retainPoints: true
		});
		expect(editor.state.holes).toEqual([RICH_HOLE]);
		expect(editor.state.walkingPath).toEqual([{ xPx: 12.5, yPx: 18.25 }]);
	});

	it('never touches holes or the walking path when the target image is replaced', () => {
		const editor = editorWithHoles();
		editor.replaceImage({
			role: 'target-basemap',
			asset: targetAsset({ id: 'image-target-2', widthPx: 640, heightPx: 480 }),
			bytes: new Uint8Array([7, 7, 7]),
			retainPoints: false
		});
		expect(editor.state.holes).toEqual([RICH_HOLE]);
		expect(editor.state.walkingPath).toEqual([{ xPx: 12.5, yPx: 18.25 }]);
	});
});
