import { describe, expect, it } from 'vitest';
import {
	createControlPointPair,
	createImageAsset,
	createProjectState,
	findImageByRole,
	IMAGE_ROLES,
	isImageRole
} from '../../src/lib/domain/project';
import type { ImageAsset, ProjectState } from '../../src/lib/domain/project';

const FIXED_NOW = () => new Date('2026-08-02T00:00:00.000Z');

function sourceAsset(id = 'image-source'): ImageAsset {
	return createImageAsset({
		createId: () => id,
		role: 'source-overview',
		fileName: 'udisc-overview.png',
		mimeType: 'image/png',
		widthPx: 1179,
		heightPx: 2556
	});
}

function targetAsset(id = 'image-target'): ImageAsset {
	return createImageAsset({
		createId: () => id,
		role: 'target-basemap',
		fileName: 'clean-map.png',
		mimeType: 'image/png',
		widthPx: 1600,
		heightPx: 1200
	});
}

describe('project state construction', () => {
	it('creates a new project as a plain object with metadata and empty collections', () => {
		const state = createProjectState({
			createId: () => 'project-1',
			now: FIXED_NOW
		});

		expect(state).toEqual({
			project: {
				id: 'project-1',
				name: 'Untitled Project',
				createdAt: '2026-08-02T00:00:00.000Z',
				updatedAt: '2026-08-02T00:00:00.000Z'
			},
			images: [],
			controlPointPairs: [],
			holes: [],
			viewState: null
		});
	});

	it('accepts an explicit project name', () => {
		const state = createProjectState({ name: 'Sample Round', createId: () => 'project-1' });
		expect(state.project.name).toBe('Sample Round');
	});

	it('honors injected ids and generates unique ids by default', () => {
		let counter = 0;
		const sequential = () => `id-${++counter}`;

		const first = createProjectState({ createId: sequential });
		const second = createProjectState({ createId: sequential });
		expect(first.project.id).toBe('id-1');
		expect(second.project.id).toBe('id-2');

		const generated = Array.from({ length: 1000 }, () => createProjectState().project.id);
		expect(new Set(generated).size).toBe(1000);
	});
});

describe('image assets', () => {
	it('creates source and target assets with required intake metadata', () => {
		const source = sourceAsset();
		const target = targetAsset();

		expect(source).toEqual({
			id: 'image-source',
			role: 'source-overview',
			fileName: 'udisc-overview.png',
			mimeType: 'image/png',
			widthPx: 1179,
			heightPx: 2556,
			sha256: null,
			bundlePath: null
		});
		expect(target).toEqual({
			id: 'image-target',
			role: 'target-basemap',
			fileName: 'clean-map.png',
			mimeType: 'image/png',
			widthPx: 1600,
			heightPx: 1200,
			sha256: null,
			bundlePath: null
		});
		expect(source.role).not.toBe(target.role);
	});

	it('accepts optional sha256 and bundlePath for complete construction', () => {
		const asset = createImageAsset({
			createId: () => 'image-source',
			role: 'source-overview',
			fileName: 'udisc-overview.png',
			mimeType: 'image/png',
			widthPx: 1179,
			heightPx: 2556,
			sha256: 'abc123def456',
			bundlePath: 'images/source-original.png'
		});

		expect(asset.sha256).toBe('abc123def456');
		expect(asset.bundlePath).toBe('images/source-original.png');
	});

	it('recognizes exactly the two image roles', () => {
		for (const role of IMAGE_ROLES) {
			expect(isImageRole(role)).toBe(true);
		}
		expect(isImageRole('source-overview')).toBe(true);
		expect(isImageRole('target-basemap')).toBe(true);
		expect(isImageRole('registration-preview')).toBe(false);
		expect(isImageRole(null)).toBe(false);
		expect(isImageRole(undefined)).toBe(false);
	});

	it('finds an asset by role regardless of array order', () => {
		const source = sourceAsset();
		const target = targetAsset();

		expect(findImageByRole([target, source], 'source-overview')).toBe(source);
		expect(findImageByRole([target, source], 'target-basemap')).toBe(target);
		expect(findImageByRole([source], 'target-basemap')).toBeUndefined();
	});
});

describe('control-point pairs', () => {
	it('creates a complete pair referencing the correct source and target assets', () => {
		const source = sourceAsset();
		const target = targetAsset();

		const pair = createControlPointPair({
			createId: () => 'cp-0001',
			now: () => new Date('2026-08-02T12:00:00.000Z'),
			sourceImage: source,
			targetImage: target,
			sourceCoordinates: { xPx: 12.5, yPx: 33.75 },
			targetCoordinates: { xPx: 200.125, yPx: 90.5 },
			ordinal: 1
		});

		expect(pair).toEqual({
			id: 'cp-0001',
			ordinal: 1,
			label: null,
			enabled: true,
			source: { imageId: 'image-source', xPx: 12.5, yPx: 33.75 },
			target: { imageId: 'image-target', xPx: 200.125, yPx: 90.5 },
			createdAt: '2026-08-02T12:00:00.000Z',
			updatedAt: '2026-08-02T12:00:00.000Z'
		});
	});

	it('preserves fractional pixel coordinates exactly', () => {
		const pair = createControlPointPair({
			sourceImage: sourceAsset(),
			targetImage: targetAsset(),
			sourceCoordinates: { xPx: 0.1, yPx: 123.456789 },
			targetCoordinates: { xPx: 999.999, yPx: 0.000001 },
			ordinal: 1
		});

		expect(pair.source.xPx).toBe(0.1);
		expect(pair.source.yPx).toBe(123.456789);
		expect(pair.target.xPx).toBe(999.999);
		expect(pair.target.yPx).toBe(0.000001);
	});

	it('supports optional labels, disabled pairs, and explicit enabled state', () => {
		const labeled = createControlPointPair({
			sourceImage: sourceAsset(),
			targetImage: targetAsset(),
			sourceCoordinates: { xPx: 1, yPx: 1 },
			targetCoordinates: { xPx: 2, yPx: 2 },
			ordinal: 1,
			label: 'Parking lot northeast corner'
		});
		const disabled = createControlPointPair({
			sourceImage: sourceAsset(),
			targetImage: targetAsset(),
			sourceCoordinates: { xPx: 1, yPx: 1 },
			targetCoordinates: { xPx: 2, yPx: 2 },
			ordinal: 2,
			enabled: false
		});

		expect(labeled.label).toBe('Parking lot northeast corner');
		expect(labeled.enabled).toBe(true);
		expect(disabled.label).toBeNull();
		expect(disabled.enabled).toBe(false);
	});

	it('derives imageIds from the assets even when coordinate objects carry a bogus imageId', () => {
		const source = sourceAsset();
		const target = targetAsset();

		const sourceCoordinates = { xPx: 12.5, yPx: 33.75, imageId: 'bogus-source' };
		const targetCoordinates = { xPx: 200.125, yPx: 90.5, imageId: 'bogus-target' };

		const pair = createControlPointPair({
			sourceImage: source,
			targetImage: target,
			sourceCoordinates,
			targetCoordinates,
			ordinal: 1
		});

		expect(pair.source).toEqual({ imageId: 'image-source', xPx: 12.5, yPx: 33.75 });
		expect(pair.target).toEqual({ imageId: 'image-target', xPx: 200.125, yPx: 90.5 });
	});

	it('rejects swapped or wrong image roles', () => {
		const source = sourceAsset();
		const target = targetAsset();

		expect(() =>
			createControlPointPair({
				sourceImage: target,
				targetImage: source,
				sourceCoordinates: { xPx: 1, yPx: 1 },
				targetCoordinates: { xPx: 2, yPx: 2 },
				ordinal: 1
			})
		).toThrow(/source-overview/);

		expect(() =>
			createControlPointPair({
				sourceImage: source,
				targetImage: source,
				sourceCoordinates: { xPx: 1, yPx: 1 },
				targetCoordinates: { xPx: 2, yPx: 2 },
				ordinal: 1
			})
		).toThrow(/target-basemap/);
	});

	it('keeps ids stable while ordinals may be regenerated after reorder', () => {
		const pair = createControlPointPair({
			createId: () => 'cp-0001',
			sourceImage: sourceAsset(),
			targetImage: targetAsset(),
			sourceCoordinates: { xPx: 1, yPx: 1 },
			targetCoordinates: { xPx: 2, yPx: 2 },
			ordinal: 1
		});

		const reordered = { ...pair, ordinal: 3 };
		expect(reordered.id).toBe('cp-0001');
		expect(reordered.ordinal).toBe(3);
		expect(pair.ordinal).toBe(1);
	});
});

describe('durable state serialization', () => {
	it('JSON round-trips a representative project state unchanged', () => {
		const state = createProjectState({ createId: () => 'project-1', now: FIXED_NOW });
		state.images.push(sourceAsset(), targetAsset());
		state.controlPointPairs.push(
			createControlPointPair({
				createId: () => 'cp-0001',
				now: () => new Date('2026-08-02T12:00:00.000Z'),
				sourceImage: state.images[0],
				targetImage: state.images[1],
				sourceCoordinates: { xPx: 748.25, yPx: 720.5 },
				targetCoordinates: { xPx: 788.0, yPx: 403.25 },
				ordinal: 1,
				label: 'Parking corner'
			})
		);

		const parsed = JSON.parse(JSON.stringify(state)) as ProjectState;
		expect(parsed).toEqual(state);
	});

	it('contains only durable fields and excludes transient editor state', () => {
		const state = createProjectState({ createId: () => 'project-1', now: FIXED_NOW });
		state.images.push(sourceAsset(), targetAsset());
		state.controlPointPairs.push(
			createControlPointPair({
				createId: () => 'cp-0001',
				sourceImage: state.images[0],
				targetImage: state.images[1],
				sourceCoordinates: { xPx: 1.5, yPx: 2.5 },
				targetCoordinates: { xPx: 3.5, yPx: 4.5 },
				ordinal: 1
			})
		);

		const parsed = JSON.parse(JSON.stringify(state)) as ProjectState;

		expect(Object.keys(parsed).sort()).toEqual([
			'controlPointPairs',
			'holes',
			'images',
			'project',
			'viewState'
		]);
		expect(Object.keys(parsed.project).sort()).toEqual([
			'createdAt',
			'id',
			'name',
			'updatedAt'
		]);
		expect(Object.keys(parsed.images[0]).sort()).toEqual([
			'bundlePath',
			'fileName',
			'heightPx',
			'id',
			'mimeType',
			'role',
			'sha256',
			'widthPx'
		]);
		expect(Object.keys(parsed.controlPointPairs[0]).sort()).toEqual([
			'createdAt',
			'enabled',
			'id',
			'label',
			'ordinal',
			'source',
			'target',
			'updatedAt'
		]);

		const transientNames = [
			'activeTool',
			'selection',
			'pendingPair',
			'pointer',
			'hover',
			'drag',
			'historyCursor',
			'decodedImage',
			'file',
			'blob'
		];
		for (const name of transientNames) {
			expect(name in parsed).toBe(false);
			expect(name in parsed.images[0]).toBe(false);
			expect(name in parsed.controlPointPairs[0]).toBe(false);
		}
	});
});
