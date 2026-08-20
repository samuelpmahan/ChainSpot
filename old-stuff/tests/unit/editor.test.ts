import { describe, expect, it } from 'vitest';
import { createImageAsset, createProjectState } from '../../src/lib/domain/project';
import { ProjectEditor } from '../../src/lib/domain/editor';
import type { AssetResource, AddPairOptions } from '../../src/lib/domain/editor';
import type { ProjectState } from '../../src/lib/domain/project';
import { applySourceTransform, AUTO_SOURCE_CAPTURE_ORIGIN, identitySourceTransform } from '../../src/lib/domain/provenance';
import type { CompositeProvenance, SourceCapture, SourceCropRect } from '../../src/lib/domain/provenance';

const NOW = () => new Date('2026-08-02T00:00:00.000Z');

function sourceAsset(id = 'image-source'): ReturnType<typeof createImageAsset> {
	return createImageAsset({
		id,
		role: 'source-overview',
		fileName: 'udisc-overview.png',
		mimeType: 'image/png',
		widthPx: 100,
		heightPx: 200
	});
}

function targetAsset(id = 'image-target'): ReturnType<typeof createImageAsset> {
	return createImageAsset({
		id,
		role: 'target-basemap',
		fileName: 'clean-map.png',
		mimeType: 'image/png',
		widthPx: 300,
		heightPx: 400
	});
}

function makeEditor(): ProjectEditor {
	const state = createProjectState({ createId: () => 'project-1', now: NOW });
	state.images.push(sourceAsset(), targetAsset());
	const assets = new Map<string, AssetResource>([
		['image-source', { bytes: new Uint8Array([1, 2, 3]), decoded: null }],
		['image-target', { bytes: new Uint8Array([4, 5, 6]), decoded: null }]
	]);
	return new ProjectEditor({
		state,
		assets,
		createId: nextId,
		now: NOW
	});
}

function makeEmptyEditor(): ProjectEditor {
	const state = createProjectState({ createId: () => 'project-1', now: NOW });
	return new ProjectEditor({ state, createId: nextId, now: NOW });
}

let counter = 0;
function nextId(): string {
	return `editor-id-${++counter}`;
}

function addPairOptions(
	overrides: Partial<AddPairOptions> = {}
): AddPairOptions {
	return {
		sourceCoordinates: { xPx: 12.5, yPx: 33.75 },
		targetCoordinates: { xPx: 200.125, yPx: 90.5 },
		...overrides
	};
}

function pairIds(state: ProjectState): string[] {
	return state.controlPointPairs.map((pair) => pair.id);
}

describe('editor construction', () => {
	it('starts from an injected state and asset registry without history', () => {
		const editor = makeEditor();
		expect(editor.state.images.map((image) => image.id)).toEqual([
			'image-source',
			'image-target'
		]);
		expect(editor.canUndo).toBe(false);
		expect(editor.canRedo).toBe(false);
		expect(editor.getAssetResource('image-source')?.bytes).toEqual(new Uint8Array([1, 2, 3]));
	});

	it('creates a fresh project when no state is provided and reports it dirty', () => {
		const editor = new ProjectEditor({ createId: () => 'fresh', now: NOW });
		expect(editor.state.images).toEqual([]);
		expect(editor.state.controlPointPairs).toEqual([]);
		expect(editor.isDirty).toBe(true);
	});

	it('contains no Konva, component, or decoded-image instances in durable data', () => {
		const editor = makeEditor();
		expect(() => JSON.parse(JSON.stringify(editor.state))).not.toThrow();
		expect(editor.state.images.every((image) => image.sha256 === null)).toBe(true);
		for (const resource of [editor.getAssetResource('image-source'), editor.getAssetResource('image-target')]) {
			expect(resource?.bytes).toBeInstanceOf(Uint8Array);
			expect(resource?.decoded).toBeNull();
		}
	});
});

describe('project rename', () => {
	it('renames the project and restores the exact name through undo/redo', () => {
		const editor = makeEditor();
		editor.renameProject('Sample Round');
		expect(editor.state.project.name).toBe('Sample Round');

		editor.undo();
		expect(editor.state.project.name).toBe('Untitled Project');
		editor.redo();
		expect(editor.state.project.name).toBe('Sample Round');
	});

	it('rejects invalid names without changing state', () => {
		const editor = makeEditor();
		const before = JSON.stringify(editor.state);
		expect(() => editor.renameProject('')).toThrow(/non-empty/);
		expect(() => editor.renameProject('' as string)).toThrow(/non-empty/);
		expect(JSON.stringify(editor.state)).toBe(before);
		expect(editor.canUndo).toBe(false);
	});

	it('is a no-op when renaming to the current name', () => {
		const editor = makeEditor();
		editor.renameProject('Untitled Project');
		expect(editor.canUndo).toBe(false);
	});
});

describe('pair creation', () => {
	it('adds a complete pair with the next ordinal and correct image references', () => {
		const editor = makeEditor();
		const first = editor.addPair(addPairOptions());
		const second = editor.addPair(
			addPairOptions({
				sourceCoordinates: { xPx: 1, yPx: 2 },
				targetCoordinates: { xPx: 3, yPx: 4 },
				label: 'Pond edge',
				enabled: false
			})
		);

		expect(first.ordinal).toBe(1);
		expect(second.ordinal).toBe(2);
		expect(first.source).toEqual({ imageId: 'image-source', xPx: 12.5, yPx: 33.75 });
		expect(first.target).toEqual({ imageId: 'image-target', xPx: 200.125, yPx: 90.5 });
		expect(second.label).toBe('Pond edge');
		expect(second.enabled).toBe(false);
		expect(editor.state.controlPointPairs).toHaveLength(2);
	});

	it('enters history exactly once per completed pair and restores exactly', () => {
		const editor = makeEditor();
		editor.addPair(addPairOptions());
		expect(editor.canUndo).toBe(true);

		const saved = JSON.stringify(editor.state);
		editor.undo();
		expect(editor.state.controlPointPairs).toEqual([]);
		editor.redo();
		expect(JSON.stringify(editor.state)).toBe(saved);
	});

	it('rejects adding when an image role is missing', () => {
		const state = createProjectState({ createId: () => 'p', now: NOW });
		state.images.push(sourceAsset());
		const editor = new ProjectEditor({ state, now: NOW, createId: () => 'id' });
		expect(() => editor.addPair(addPairOptions())).toThrow(/target-basemap/);
		expect(editor.state.controlPointPairs).toEqual([]);
	});

	it('rejects non-finite or out-of-bounds coordinates without partial state', () => {
		const editor = makeEditor();
		expect(() =>
			editor.addPair(addPairOptions({ sourceCoordinates: { xPx: NaN, yPx: 1 } }))
		).toThrow(/finite/);
		expect(() =>
			editor.addPair(addPairOptions({ targetCoordinates: { xPx: 300, yPx: 1 } }))
		).toThrow(/outside/);
		expect(() => editor.addPair(addPairOptions({ label: 42 as unknown as string }))).toThrow(
			/label/
		);
		expect(editor.state.controlPointPairs).toEqual([]);
		expect(editor.canUndo).toBe(false);
	});
});

describe('point movement', () => {
	it('moves either side and restores both coordinates through undo/redo', () => {
		const editor = makeEditor();
		const pair = editor.addPair(addPairOptions());

		editor.movePoint(pair.id, 'source', { xPx: 88.5, yPx: 99.25 });
		editor.movePoint(pair.id, 'target', { xPx: 111, yPx: 222 });
		expect(editor.state.controlPointPairs[0].source).toEqual({
			imageId: 'image-source',
			xPx: 88.5,
			yPx: 99.25
		});

		editor.undo();
		editor.undo();
		expect(editor.state.controlPointPairs[0]).toEqual(pair);
		editor.redo();
		editor.redo();
		expect(editor.state.controlPointPairs[0].target.xPx).toBe(111);
	});

	it('rejects unknown pairs, non-finite coordinates, and out-of-bounds moves', () => {
		const editor = makeEditor();
		const pair = editor.addPair(addPairOptions());
		expect(() => editor.movePoint('missing', 'source', { xPx: 1, yPx: 1 })).toThrow(/unknown/);
		expect(() => editor.movePoint(pair.id, 'source', { xPx: Infinity, yPx: 1 })).toThrow(
			/finite/
		);
		expect(() => editor.movePoint(pair.id, 'source', { xPx: 100, yPx: 1 })).toThrow(/outside/);
		expect(() => editor.movePoint(pair.id, 'bogus' as never, { xPx: 1, yPx: 1 })).toThrow(/side/);
		expect(editor.state.controlPointPairs[0]).toEqual(pair);
		editor.undo();
		expect(editor.state.controlPointPairs).toEqual([]);
		expect(editor.canUndo).toBe(false);
	});

	it('is a no-op when moving to the same coordinates', () => {
		const editor = makeEditor();
		const pair = editor.addPair(addPairOptions());
		editor.movePoint(pair.id, 'source', { xPx: 12.5, yPx: 33.75 });
		expect(editor.state.controlPointPairs[0]).toEqual(pair);
		expect(editor.canUndo).toBe(true);
		editor.undo();
		expect(editor.canUndo).toBe(false);
		expect(editor.state.controlPointPairs).toEqual([]);
	});
});

describe('label and enabled edits', () => {
	it('edits labels and restores them through undo/redo', () => {
		const editor = makeEditor();
		const pair = editor.addPair(addPairOptions());
		editor.setLabel(pair.id, 'Parking corner');
		expect(editor.state.controlPointPairs[0].label).toBe('Parking corner');
		editor.setLabel(pair.id, null);
		expect(editor.state.controlPointPairs[0].label).toBeNull();

		editor.undo();
		expect(editor.state.controlPointPairs[0].label).toBe('Parking corner');
		editor.undo();
		expect(editor.state.controlPointPairs[0].label).toBeNull();
		editor.redo();
		expect(editor.state.controlPointPairs[0].label).toBe('Parking corner');
	});

	it('toggles enabled state and restores it through undo/redo', () => {
		const editor = makeEditor();
		const pair = editor.addPair(addPairOptions());
		editor.setEnabled(pair.id, false);
		expect(editor.state.controlPointPairs[0].enabled).toBe(false);
		editor.undo();
		expect(editor.state.controlPointPairs[0].enabled).toBe(true);
		editor.redo();
		expect(editor.state.controlPointPairs[0].enabled).toBe(false);
	});

	it('rejects invalid inputs and is a no-op for unchanged values', () => {
		const editor = makeEditor();
		const pair = editor.addPair(addPairOptions());
		expect(() => editor.setLabel(pair.id, 7 as unknown as string)).toThrow(/label/);
		expect(() => editor.setEnabled(pair.id, 'yes' as unknown as boolean)).toThrow(/boolean/);
		expect(() => editor.setLabel('missing', null)).toThrow(/unknown/);
		expect(() => editor.setEnabled('missing', true)).toThrow(/unknown/);

		const before = JSON.stringify(editor.state);
		editor.setLabel(pair.id, null);
		editor.setEnabled(pair.id, true);
		expect(JSON.stringify(editor.state)).toBe(before);
		expect(editor.canUndo).toBe(true);
		editor.undo();
		expect(editor.state.controlPointPairs).toEqual([]);
	});
});

describe('pair deletion and reorder', () => {
	it('deletes a pair and restores the exact pair through undo/redo', () => {
		const editor = makeEditor();
		const first = editor.addPair(addPairOptions());
		const second = editor.addPair(
			addPairOptions({ sourceCoordinates: { xPx: 1, yPx: 2 }, targetCoordinates: { xPx: 3, yPx: 4 } })
		);
		const deleted = editor.deletePair(first.id);

		expect(deleted.id).toBe(first.id);
		expect(pairIds(editor.state)).toEqual([second.id]);

		editor.undo();
		expect(JSON.stringify(editor.state.controlPointPairs[0])).toBe(JSON.stringify(first));
		editor.redo();
		expect(pairIds(editor.state)).toEqual([second.id]);
	});

	it('rejects deleting an unknown pair', () => {
		const editor = makeEditor();
		expect(() => editor.deletePair('missing')).toThrow(/unknown/);
	});

	it('reorders pairs to contiguous ordinals and restores the original order through undo', () => {
		const editor = makeEditor();
		const first = editor.addPair(addPairOptions());
		const second = editor.addPair(
			addPairOptions({ sourceCoordinates: { xPx: 1, yPx: 2 }, targetCoordinates: { xPx: 3, yPx: 4 } })
		);
		const third = editor.addPair(
			addPairOptions({ sourceCoordinates: { xPx: 5, yPx: 6 }, targetCoordinates: { xPx: 7, yPx: 8 } })
		);

		editor.reorderPairs([third.id, first.id, second.id]);
		expect(editor.state.controlPointPairs.map((pair) => pair.id)).toEqual([
			third.id,
			first.id,
			second.id
		]);
		expect(editor.state.controlPointPairs.map((pair) => pair.ordinal)).toEqual([1, 2, 3]);

		editor.undo();
		expect(editor.state.controlPointPairs.map((pair) => pair.id)).toEqual([
			first.id,
			second.id,
			third.id
		]);
		expect(editor.state.controlPointPairs.map((pair) => pair.ordinal)).toEqual([1, 2, 3]);
	});

	it('rejects invalid reorder sets and is a no-op for the current order', () => {
		const editor = makeEditor();
		const first = editor.addPair(addPairOptions());
		const second = editor.addPair(
			addPairOptions({ sourceCoordinates: { xPx: 1, yPx: 2 }, targetCoordinates: { xPx: 3, yPx: 4 } })
		);

		expect(() => editor.reorderPairs([first.id])).toThrow(/exactly/);
		expect(() => editor.reorderPairs([first.id, 'missing'])).toThrow(/exactly/);
		expect(() => editor.reorderPairs([first.id, first.id])).toThrow(/exactly/);
		expect(() => editor.reorderPairs([second.id, first.id, 'extra'])).toThrow(/exactly/);

		const before = JSON.stringify(editor.state);
		editor.reorderPairs([first.id, second.id]);
		expect(JSON.stringify(editor.state)).toBe(before);
		expect(editor.canUndo).toBe(true);
	});
});

describe('image replacement', () => {
	function replacementSource(): ReturnType<typeof createImageAsset> {
		return createImageAsset({
			id: 'image-source-2',
			role: 'source-overview',
			fileName: 'udisc-overview-v2.png',
			mimeType: 'image/png',
			widthPx: 100,
			heightPx: 200,
			sha256: 'sha-new',
			bundlePath: 'images/source-original-v2.png'
		});
	}

	it('replaces an image and restores metadata and runtime bytes through undo/redo', () => {
		const editor = makeEditor();
		const newAsset = replacementSource();
		const bytes = new Uint8Array([9, 8, 7]);

		editor.replaceImage({ role: 'source-overview', asset: newAsset, bytes });
		expect(editor.state.images.map((image) => image.id)).toEqual([
			'image-source-2',
			'image-target'
		]);
		expect(editor.getAssetResource('image-source-2')?.bytes).toEqual(bytes);

		editor.undo();
		expect(editor.state.images.map((image) => image.id)).toEqual([
			'image-source',
			'image-target'
		]);
		expect(editor.state.images[0].fileName).toBe('udisc-overview.png');
		expect(editor.getAssetResource('image-source')?.bytes).toEqual(new Uint8Array([1, 2, 3]));
		expect(editor.getAssetResource('image-source-2')).toBeDefined();

		editor.redo();
		expect(editor.state.images[0].id).toBe('image-source-2');
		expect(editor.getAssetResource('image-source-2')?.bytes).toEqual(bytes);
	});

	it('retains points with their coordinates when replacing with same dimensions', () => {
		const editor = makeEditor();
		const pair = editor.addPair(addPairOptions());

		editor.replaceImage({
			role: 'source-overview',
			asset: replacementSource(),
			bytes: new Uint8Array([9]),
			retainPoints: true
		});

		expect(editor.state.controlPointPairs[0].source).toEqual({
			imageId: 'image-source-2',
			xPx: 12.5,
			yPx: 33.75
		});
		expect(editor.state.controlPointPairs[0].target.imageId).toBe('image-target');

		editor.undo();
		expect(editor.state.controlPointPairs[0].source.imageId).toBe('image-source');
	});

	it('rejects retaining points when the replacement dimensions differ', () => {
		const editor = makeEditor();
		const pair = editor.addPair(addPairOptions());
		const different = createImageAsset({
			id: 'image-source-3',
			role: 'source-overview',
			fileName: 'bigger.png',
			mimeType: 'image/png',
			widthPx: 500,
			heightPx: 600
		});

		expect(() =>
			editor.replaceImage({
				role: 'source-overview',
				asset: different,
				bytes: new Uint8Array([9]),
				retainPoints: true
			})
		).toThrow(/same dimensions/);

		expect(editor.state.images[0].id).toBe('image-source');
		expect(editor.state.controlPointPairs[0]).toEqual(pair);
		editor.undo();
		expect(editor.state.controlPointPairs).toEqual([]);
		expect(editor.canUndo).toBe(false);
	});

	it('discards that role points by default when replacing', () => {
		const editor = makeEditor();
		editor.addPair(addPairOptions());

		editor.replaceImage({
			role: 'source-overview',
			asset: replacementSource(),
			bytes: new Uint8Array([9])
		});

		expect(editor.state.controlPointPairs).toEqual([]);

		editor.undo();
		expect(editor.state.controlPointPairs).toHaveLength(1);
		expect(editor.state.controlPointPairs[0].source.imageId).toBe('image-source');
	});

	it('rejects role mismatches, existing ids, and empty bytes', () => {
		const editor = makeEditor();
		const misrole = createImageAsset({
			id: 'image-misrole',
			role: 'target-basemap',
			fileName: 'x.png',
			mimeType: 'image/png',
			widthPx: 100,
			heightPx: 100
		});
		expect(() =>
			editor.replaceImage({ role: 'source-overview', asset: misrole, bytes: new Uint8Array([1]) })
		).toThrow(/role/);
		expect(() =>
			editor.replaceImage({
				role: 'source-overview',
				asset: sourceAsset('image-source'),
				bytes: new Uint8Array([1])
			})
		).toThrow(/already in use/);
		expect(() =>
			editor.replaceImage({ role: 'source-overview', asset: replacementSource(), bytes: new Uint8Array() })
		).toThrow(/non-empty/);
		expect(() =>
			editor.replaceImage({ role: 'target-basemap', asset: replacementSource(), bytes: new Uint8Array([1]) })
		).toThrow(/role/);
		expect(editor.state.images[0].id).toBe('image-source');
		expect(editor.canUndo).toBe(false);
	});
});

describe('target rotation (CHSPT-44)', () => {
	it('sets and reads back the target image rotation', () => {
		const editor = makeEditor();
		editor.setTargetRotation(30);
		const target = editor.state.images.find((image) => image.role === 'target-basemap');
		expect(target?.rotationDeg).toBe(30);
	});

	it('normalizes an out-of-range angle into (-180, 180]', () => {
		const editor = makeEditor();
		editor.setTargetRotation(400);
		const target = editor.state.images.find((image) => image.role === 'target-basemap');
		expect(target?.rotationDeg).toBeCloseTo(40, 9);
	});

	it('omits rotationDeg entirely (rather than storing 0) when rotation returns to north', () => {
		const editor = makeEditor();
		editor.setTargetRotation(30);
		editor.setTargetRotation(0);
		const target = editor.state.images.find((image) => image.role === 'target-basemap');
		expect(target?.rotationDeg).toBeUndefined();
		expect('rotationDeg' in target!).toBe(false);
	});

	it('is undoable, one history step per call, exactly like any other durable mutation', () => {
		const editor = makeEditor();
		editor.setTargetRotation(15);
		editor.setTargetRotation(30);
		expect(editor.canUndo).toBe(true);
		editor.undo();
		expect(editor.state.images.find((image) => image.role === 'target-basemap')?.rotationDeg).toBe(15);
		editor.undo();
		expect(editor.state.images.find((image) => image.role === 'target-basemap')?.rotationDeg).toBeUndefined();
	});

	it('is a no-op (no history entry) when set to the value it already has', () => {
		const editor = makeEditor();
		editor.setTargetRotation(20);
		expect(editor.canUndo).toBe(true);
		editor.undo();
		expect(editor.canUndo).toBe(false);
		editor.setTargetRotation(0);
		expect(editor.canUndo).toBe(false);
	});

	it('rejects a non-finite angle', () => {
		const editor = makeEditor();
		expect(() => editor.setTargetRotation(Number.NaN)).toThrow(/finite/);
	});

	it('requires the target-basemap image to be loaded first', () => {
		const editor = makeEmptyEditor();
		expect(() => editor.setTargetRotation(10)).toThrow(/target-basemap/);
	});

	it('resets to unrotated when the target image is replaced, the same "fresh asset" reset provenance already gets', () => {
		const editor = makeEditor();
		editor.setTargetRotation(30);
		editor.replaceImage({
			role: 'target-basemap',
			asset: targetAsset('image-target-2'),
			bytes: new Uint8Array([7])
		});
		const target = editor.state.images.find((image) => image.role === 'target-basemap');
		expect(target?.rotationDeg).toBeUndefined();
	});
});

describe('history semantics', () => {
	it('clears redo after a divergent edit', () => {
		const editor = makeEditor();
		editor.renameProject('A');
		editor.renameProject('B');
		editor.undo();
		expect(editor.canRedo).toBe(true);

		editor.renameProject('C');
		expect(editor.canRedo).toBe(false);
		expect(editor.state.project.name).toBe('C');
		editor.undo();
		expect(editor.state.project.name).toBe('A');
		editor.undo();
		expect(editor.state.project.name).toBe('Untitled Project');
		expect(editor.canUndo).toBe(false);
	});

	it('commits one completed drag as exactly one history step', () => {
		const editor = makeEditor();
		const pair = editor.addPair(addPairOptions());

		editor.movePoint(pair.id, 'source', { xPx: 1, yPx: 1 });

		editor.undo();
		expect(editor.state.controlPointPairs[0].source).toEqual({
			imageId: 'image-source',
			xPx: 12.5,
			yPx: 33.75
		});
		editor.redo();
		expect(editor.state.controlPointPairs[0].source.xPx).toBe(1);
		expect(editor.canRedo).toBe(false);
	});

	it('keeps separate gestures as separate history entries', () => {
		const editor = makeEditor();
		const pair = editor.addPair(addPairOptions());
		editor.movePoint(pair.id, 'source', { xPx: 1, yPx: 1 });
		editor.movePoint(pair.id, 'source', { xPx: 2, yPx: 2 });
		editor.undo();
		expect(editor.state.controlPointPairs[0].source.xPx).toBe(1);
		editor.undo();
		expect(editor.state.controlPointPairs[0].source.xPx).toBe(12.5);
	});

	it('exposes no pending-pair or view-operation mutations', () => {
		const editor = makeEditor();
		const surface = editor as unknown as Record<string, unknown>;
		expect(surface.pendingPair).toBeUndefined();
		expect(surface.cancelPending).toBeUndefined();
		expect(surface.pan).toBeUndefined();
		expect(surface.zoom).toBeUndefined();
		expect(surface.fit).toBeUndefined();
	});

	it('never alters view state through durable mutations', () => {
		const state = createProjectState({ createId: () => 'p', now: NOW });
		state.images.push(sourceAsset(), targetAsset());
		state.viewState = {
			source: { zoom: 1.4, panX: -92, panY: 17 },
			target: { zoom: 1.1, panX: 0, panY: -35 }
		};
		const editor = new ProjectEditor({ state, assets: new Map(), now: NOW, createId: () => 'id' });

		editor.renameProject('X');
		editor.addPair(addPairOptions());
		expect(editor.state.viewState).toEqual(state.viewState);
		expect(JSON.stringify(editor.state.viewState)).toBe(
			JSON.stringify(state.viewState)
		);
	});
});

describe('dirty state', () => {
	it('is dirty for an unsaved project and clears only at the saved checkpoint', () => {
		const editor = makeEditor();
		expect(editor.isDirty).toBe(true);

		editor.renameProject('Round 1');
		expect(editor.isDirty).toBe(true);

		editor.markSaved();
		expect(editor.isDirty).toBe(false);

		editor.renameProject('Round 2');
		expect(editor.isDirty).toBe(true);

		editor.undo();
		expect(editor.state.project.name).toBe('Round 1');
		expect(editor.isDirty).toBe(false);

		editor.redo();
		expect(editor.state.project.name).toBe('Round 2');
		expect(editor.isDirty).toBe(true);
	});

	it('clears only via a successful checkpoint, never automatically', () => {
		const editor = makeEditor();
		editor.renameProject('A');
		editor.renameProject('B');
		editor.markSaved();
		expect(editor.isDirty).toBe(false);

		editor.renameProject('C');
		editor.undo();
		expect(editor.state.project.name).toBe('B');
		expect(editor.isDirty).toBe(false);

		editor.undo();
		expect(editor.state.project.name).toBe('A');
		expect(editor.isDirty).toBe(true);

		editor.redo();
		expect(editor.state.project.name).toBe('B');
		expect(editor.isDirty).toBe(false);

		editor.redo();
		expect(editor.state.project.name).toBe('C');
		expect(editor.isDirty).toBe(true);

		editor.renameProject('D');
		editor.undo();
		editor.renameProject('D2');
		expect(editor.isDirty).toBe(true);
	});

	it('stays dirty across a failed save and through undo/redo without a checkpoint', () => {
		const editor = makeEditor();
		editor.renameProject('A');
		editor.addPair(addPairOptions());
		editor.undo();
		editor.redo();
		expect(editor.isDirty).toBe(true);
	});
});

describe('initial image assignment', () => {
	it('assigns the source image as exactly one undoable history entry', () => {
		const editor = makeEmptyEditor();
		editor.assignImage({
			role: 'source-overview',
			asset: sourceAsset(),
			bytes: new Uint8Array([10])
		});

		expect(editor.state.images).toHaveLength(1);
		expect(editor.state.images[0].id).toBe('image-source');
		expect(editor.isDirty).toBe(true);

		editor.undo();
		expect(editor.state.images).toEqual([]);
		expect(editor.canRedo).toBe(true);

		editor.redo();
		expect(editor.state.images[0].id).toBe('image-source');
		expect(editor.getAssetResource('image-source')?.bytes).toEqual(new Uint8Array([10]));
	});

	it('assigns source and target as separate history entries', () => {
		const editor = makeEmptyEditor();
		editor.assignImage({
			role: 'source-overview',
			asset: sourceAsset(),
			bytes: new Uint8Array([10])
		});
		editor.assignImage({
			role: 'target-basemap',
			asset: targetAsset(),
			bytes: new Uint8Array([20])
		});

		expect(editor.state.images).toHaveLength(2);
		editor.undo();
		expect(editor.state.images.map((image) => image.id)).toEqual(['image-source']);
		editor.undo();
		expect(editor.state.images).toEqual([]);
		editor.redo();
		editor.redo();
		expect(editor.state.images.map((image) => image.id)).toEqual([
			'image-source',
			'image-target'
		]);
		expect(editor.getAssetResource('image-target')?.bytes).toEqual(new Uint8Array([20]));
	});

	it('rejects assigning to an already-loaded role', () => {
		const editor = makeEditor();
		expect(() =>
			editor.assignImage({
				role: 'source-overview',
				asset: sourceAsset('image-extra'),
				bytes: new Uint8Array([1])
			})
		).toThrow(/replaceImage/);
		expect(editor.state.images.map((image) => image.id)).toEqual([
			'image-source',
			'image-target'
		]);
		expect(editor.canUndo).toBe(false);
	});

	it('rejects invalid assignments atomically', () => {
		const editor = makeEmptyEditor();
		expect(() =>
			editor.assignImage({ role: 'source-overview', asset: targetAsset(), bytes: new Uint8Array([1]) })
		).toThrow(/role/);
		expect(() =>
			editor.assignImage({ role: 'source-overview', asset: sourceAsset(), bytes: new Uint8Array() })
		).toThrow(/non-empty/);
		expect(() =>
			editor.assignImage({ role: 'bogus' as never, asset: sourceAsset(), bytes: new Uint8Array([1]) })
		).toThrow(/role/);
		expect(editor.state.images).toEqual([]);
		expect(editor.canUndo).toBe(false);
	});
});

describe('asset id reuse protection', () => {
	function newSource(id: string): ReturnType<typeof createImageAsset> {
		return createImageAsset({
			id,
			role: 'source-overview',
			fileName: `${id}.png`,
			mimeType: 'image/png',
			widthPx: 100,
			heightPx: 200
		});
	}

	it('rejects reusing an id held by undo history without any state change', () => {
		const editor = makeEditor();
		editor.replaceImage({
			role: 'source-overview',
			asset: newSource('image-source-b'),
			bytes: new Uint8Array([9])
		});
		expect(editor.state.images[0].id).toBe('image-source-b');

		// 'image-source' is now referenced only by the undo snapshot; reusing it as
		// the replacement id must be rejected so the retained bytes cannot be overwritten.
		expect(() =>
			editor.replaceImage({
				role: 'source-overview',
				asset: newSource('image-source'),
				bytes: new Uint8Array([8])
			})
		).toThrow(/already in use/);

		expect(editor.state.images[0].id).toBe('image-source-b');
		expect(editor.getAssetResource('image-source')?.bytes).toEqual(new Uint8Array([1, 2, 3]));
		expect(editor.canUndo).toBe(true);
	});

	it('rejects reusing an id held by redo history atomically', () => {
		const editor = makeEditor();
		editor.replaceImage({
			role: 'source-overview',
			asset: newSource('image-source-b'),
			bytes: new Uint8Array([9])
		});
		editor.undo();
		expect(editor.state.images[0].id).toBe('image-source');

		expect(() =>
			editor.replaceImage({
				role: 'source-overview',
				asset: newSource('image-source-b'),
				bytes: new Uint8Array([8])
			})
		).toThrow(/already in use/);

		expect(editor.state.images.map((image) => image.id)).toEqual([
			'image-source',
			'image-target'
		]);
		expect(editor.getAssetResource('image-source-b')?.bytes).toEqual(new Uint8Array([9]));
		expect(editor.canRedo).toBe(true);
	});
});

describe('state isolation', () => {
	it('is unaffected by mutating the originally supplied state', () => {
		const state = createProjectState({ createId: () => 'p', now: NOW });
		state.images.push(sourceAsset(), targetAsset());
		const editor = new ProjectEditor({ state, now: NOW, createId: nextId });
		editor.markSaved();

		state.project.name = 'HACK';
		state.images[0].fileName = 'HACK.png';
		state.images.push(sourceAsset('image-hack'));

		expect(editor.state.project.name).toBe('Untitled Project');
		expect(editor.state.images.map((image) => image.id)).toEqual([
			'image-source',
			'image-target'
		]);
		expect(editor.state.images[0].fileName).toBe('udisc-overview.png');
		expect(editor.isDirty).toBe(false);
	});

	it('is unaffected by mutating the value returned from the state getter', () => {
		const editor = makeEditor();
		editor.addPair(addPairOptions());

		const leaked = editor.state;
		leaked.project.name = 'HACK';
		leaked.controlPointPairs[0].label = 'HACK';
		leaked.controlPointPairs[0].source.xPx = 999;
		leaked.images.push(sourceAsset('image-hack'));

		const current = editor.state;
		expect(current.project.name).toBe('Untitled Project');
		expect(current.controlPointPairs[0].label).toBeNull();
		expect(current.controlPointPairs[0].source.xPx).toBe(12.5);
		expect(current.images).toHaveLength(2);
	});

	it('is unaffected by mutating values returned from mutation methods', () => {
		const editor = makeEmptyEditor();

		const assignedSource = editor.assignImage({
			role: 'source-overview',
			asset: sourceAsset(),
			bytes: new Uint8Array([7])
		});
		assignedSource.fileName = 'HACK-ASSIGNED';
		expect(editor.state.images[0].fileName).toBe('udisc-overview.png');

		const assignedTarget = editor.assignImage({
			role: 'target-basemap',
			asset: targetAsset(),
			bytes: new Uint8Array([7])
		});
		assignedTarget.fileName = 'HACK-TARGET';
		expect(editor.state.images[1].fileName).toBe('clean-map.png');

		const pair = editor.addPair(addPairOptions());
		pair.label = 'HACK';
		pair.source.xPx = 999;
		expect(editor.state.controlPointPairs[0].label).toBeNull();
		expect(editor.state.controlPointPairs[0].source.xPx).toBe(12.5);

		const deleted = editor.deletePair(pair.id);
		deleted.label = 'HACK-DELETED';
		editor.undo();
		expect(editor.state.controlPointPairs[0].label).toBeNull();

		const replaced = editor.replaceImage({
			role: 'source-overview',
			asset: sourceAsset('image-source-2'),
			bytes: new Uint8Array([8])
		});
		replaced.fileName = 'HACK-REPLACED';
		expect(editor.state.images[0].fileName).toBe('udisc-overview.png');
	});

	it('copies caller-owned and retrieved bytes so neither side can corrupt the registry', () => {
		const state = createProjectState({ createId: () => 'p', now: NOW });
		state.images.push(sourceAsset());
		const callerBytes = new Uint8Array([1, 2, 3]);
		const assets = new Map<string, AssetResource>([
			['image-source', { bytes: callerBytes, decoded: null }]
		]);
		const editor = new ProjectEditor({ state, assets, now: NOW, createId: nextId });

		callerBytes[0] = 99;
		expect(editor.getAssetResource('image-source')?.bytes).toEqual(new Uint8Array([1, 2, 3]));

		const retrieved = editor.getAssetResource('image-source')!;
		retrieved.bytes[1] = 77;
		expect(editor.getAssetResource('image-source')?.bytes).toEqual(new Uint8Array([1, 2, 3]));

		const assignBytes = new Uint8Array([10, 20, 30]);
		editor.assignImage({
			role: 'target-basemap',
			asset: targetAsset(),
			bytes: assignBytes
		});
		assignBytes[2] = 99;
		expect(editor.getAssetResource('image-target')?.bytes).toEqual(new Uint8Array([10, 20, 30]));
	});
});

describe('runtime asset reachability', () => {
	function newSource(id: string): ReturnType<typeof createImageAsset> {
		return createImageAsset({
			id,
			role: 'source-overview',
			fileName: `${id}.png`,
			mimeType: 'image/png',
			widthPx: 100,
			heightPx: 200
		});
	}

	it('retains replaced assets while reachable from undo/redo and releases after divergence', () => {
		const editor = makeEditor();
		editor.replaceImage({ role: 'source-overview', asset: newSource('image-source-b'), bytes: new Uint8Array([9]) });

		editor.undo();
		expect(editor.getAssetResource('image-source-b')).toBeDefined();

		editor.renameProject('Divergent');
		expect(editor.getAssetResource('image-source-b')).toBeUndefined();
		expect(editor.getAssetResource('image-source')).toBeDefined();
		expect(editor.getAssetResource('image-target')).toBeDefined();
	});

	it('retains every asset in a replacement chain until snapshots are dropped', () => {
		const editor = makeEditor();
		editor.replaceImage({ role: 'source-overview', asset: newSource('image-source-b'), bytes: new Uint8Array([1]) });
		editor.replaceImage({ role: 'source-overview', asset: newSource('image-source-c'), bytes: new Uint8Array([2]) });

		expect(editor.getAssetResource('image-source')).toBeDefined();
		expect(editor.getAssetResource('image-source-b')).toBeDefined();
		expect(editor.getAssetResource('image-source-c')).toBeDefined();

		editor.undo();
		editor.undo();
		expect(editor.state.images[0].id).toBe('image-source');
		expect(editor.getAssetResource('image-source-c')).toBeDefined();

		editor.renameProject('Divergent');
		expect(editor.getAssetResource('image-source-b')).toBeUndefined();
		expect(editor.getAssetResource('image-source-c')).toBeUndefined();
		expect(editor.getAssetResource('image-source')).toBeDefined();
	});

	it('restores renderable bytes through redo as well as undo', () => {
		const editor = makeEditor();
		const bytes = new Uint8Array([42]);
		editor.replaceImage({ role: 'source-overview', asset: newSource('image-source-b'), bytes });
		editor.undo();
		editor.redo();
		expect(editor.getAssetResource('image-source-b')?.bytes).toEqual(bytes);
	});

	it('is unaffected by pair edits and supports decoded-resource registration', () => {
		const editor = makeEditor();
		const pair = editor.addPair(addPairOptions());
		editor.movePoint(pair.id, 'source', { xPx: 1, yPx: 1 });
		editor.deletePair(pair.id);
		expect(editor.getAssetResource('image-source')).toBeDefined();

		const decoded = { kind: 'html-image' };
		editor.setDecodedResource('image-source', decoded);
		expect(editor.getAssetResource('image-source')?.decoded).toBe(decoded);
		expect(() => editor.setDecodedResource('missing', decoded)).toThrow(/registered/);
	});
});

describe('source-capture bytes (CHSPT-49 provenance)', () => {
	/** A minimal, coherent single-source provenance referencing `sourceId`. */
	function provenanceOf(sourceId: string, finalRasterSha256 = 'a'.repeat(64)): CompositeProvenance {
		const transform = identitySourceTransform();
		const crop: SourceCropRect = { xPx: 0, yPx: 0, widthPx: 100, heightPx: 200 };
		const source: SourceCapture = {
			sourceId,
			fileName: `${sourceId}.png`,
			mimeType: 'image/png',
			widthPx: 100,
			heightPx: 200,
			sha256: 'b'.repeat(64),
			crop,
			transform,
			origin: AUTO_SOURCE_CAPTURE_ORIGIN,
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
			outputWidthPx: 100,
			outputHeightPx: 200,
			compositingPolicy: 'single-source-v1',
			resampling: 'none',
			sources: [source],
			overlaps: [],
			finalRasterSha256
		};
	}

	function sourceAssetWithProvenance(id: string, sourceId: string): ReturnType<typeof createImageAsset> {
		return createImageAsset({
			id,
			role: 'source-overview',
			fileName: `${id}.png`,
			mimeType: 'image/png',
			widthPx: 100,
			heightPx: 200,
			provenance: provenanceOf(sourceId)
		});
	}

	it('registers source-capture bytes reachable through getAssetResource once the referencing image is live', () => {
		const editor = makeEditor();
		editor.replaceImage({
			role: 'source-overview',
			asset: sourceAssetWithProvenance('image-source-with-provenance', 'capture-1'),
			bytes: new Uint8Array([9])
		});
		const captureBytes = new Uint8Array([1, 2, 3, 4]);
		editor.setSourceCaptureBytes('capture-1', captureBytes);
		expect(editor.getAssetResource('capture-1')?.bytes).toEqual(captureBytes);
		expect(editor.getAssetResource('capture-1')?.decoded).toBeNull();
	});

	it('is immediately dropped when registered for a sourceId no current/undo/redo image provenance references', () => {
		const editor = makeEditor();
		editor.setSourceCaptureBytes('orphan-capture', new Uint8Array([1]));
		expect(editor.getAssetResource('orphan-capture')).toBeUndefined();
	});

	it('stays reachable across undo/redo alongside the image whose provenance references it, and releases on divergence', () => {
		const editor = makeEditor();
		editor.replaceImage({
			role: 'source-overview',
			asset: sourceAssetWithProvenance('image-source-with-provenance', 'capture-1'),
			bytes: new Uint8Array([9])
		});
		editor.setSourceCaptureBytes('capture-1', new Uint8Array([1, 2, 3]));
		expect(editor.getAssetResource('capture-1')).toBeDefined();

		editor.undo();
		// The provenance-carrying image is gone from current state, but still reachable
		// from the redo stack, so its source capture must still be retained too.
		expect(editor.getAssetResource('capture-1')).toBeDefined();

		editor.redo();
		expect(editor.getAssetResource('capture-1')).toBeDefined();

		editor.undo();
		editor.renameProject('Divergent'); // clears the redo stack that still referenced capture-1
		expect(editor.getAssetResource('capture-1')).toBeUndefined();
	});

	it('releases source-capture bytes once a differently-provenanced replacement makes them unreachable', () => {
		const editor = makeEditor();
		editor.replaceImage({
			role: 'source-overview',
			asset: sourceAssetWithProvenance('image-source-a', 'capture-a'),
			bytes: new Uint8Array([1])
		});
		editor.setSourceCaptureBytes('capture-a', new Uint8Array([1, 1, 1]));
		expect(editor.getAssetResource('capture-a')).toBeDefined();

		editor.replaceImage({
			role: 'source-overview',
			asset: sourceAssetWithProvenance('image-source-b', 'capture-b'),
			bytes: new Uint8Array([2])
		});
		editor.setSourceCaptureBytes('capture-b', new Uint8Array([2, 2, 2]));
		// capture-a is still reachable: image-source-a is still on the undo stack.
		expect(editor.getAssetResource('capture-a')).toBeDefined();
		expect(editor.getAssetResource('capture-b')).toBeDefined();

		editor.undo();
		editor.undo();
		editor.renameProject('Divergent'); // drops both replacements from history
		expect(editor.getAssetResource('capture-a')).toBeUndefined();
		expect(editor.getAssetResource('capture-b')).toBeUndefined();
	});

	it('rejects empty bytes the same way image asset registration does', () => {
		const editor = makeEditor();
		expect(() => editor.setSourceCaptureBytes('capture-1', new Uint8Array())).toThrow(/non-empty/);
	});
});
