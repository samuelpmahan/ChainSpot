/**
 * ChainSpot domain mutations, history, and dirty state.
 *
 * `ProjectEditor` is the only place that changes durable `ProjectState`. It is a plain
 * TypeScript module: no Konva node, Svelte component, decoded image, or file object ever
 * participates in mutation or history data.
 *
 * History: immutable snapshots. Every mutation builds a new `ProjectState` from the
 * current one and pushes the previous snapshot onto the undo stack, exactly like a
 * command. Undo/redo swap snapshots, so every durable value (project name, pair IDs,
 * coordinates, labels, enabled states, order, timestamps, image metadata) is restored
 * exactly. A new edit after an undo clears the redo stack (divergent edit).
 *
 * Drag commit: one completed pointer gesture translates into one mutation call (for
 * example one `movePoint` at drag end), so one drag is one history step. Transient
 * preview during a drag is a canvas/view concern and must never touch durable state.
 *
 * Outside history: pending half-pair cancellation, selection, hover, marker visibility,
 * and pan/zoom/fit are not editor concepts and never enter durable history or dirty
 * state. This module exposes no API for them.
 *
 * Dirty state: `isDirty` is true whenever the current snapshot is not the exact snapshot
 * recorded by the last successful save/open checkpoint (`markSaved`). Undo/redo that
 * returns to the exact saved snapshot clears dirty state; any other position leaves it
 * dirty. A failed save never calls `markSaved`, so dirty state is preserved. A project
 * that has never been checkpointed is dirty.
 *
 * Isolation: internal snapshots are never shared with callers. Constructor input state
 * is cloned, `state` returns an isolated snapshot clone, mutation methods return clones
 * of created/deleted entities, and registry bytes are copied on intake and on retrieval.
 * Mutating a constructor-supplied object, a returned value, or a retrieved byte array
 * can therefore never corrupt current or history state.
 *
 * Initial image assignment: `assignImage` is the undoable action for loading the first
 * source or target image into a fresh project; `replaceImage` covers replacing an
 * already-loaded role. Both register bytes, enter history once, and set dirty state.
 * Replacing or assigning an asset whose id is still referenced by current, undo, or
 * redo state (verified against the live asset registry) is rejected atomically.
 *
 * Asset registry: a minimal transient map from image id to original bytes (and an
 * optional decoded resource slot) retains renderable content for every asset still
 * referenced by the current state, the undo stack, or the redo stack. Unreferenced
 * entries are released after every history-affecting change. This is not a media
 * repository or cache framework.
 */

import { pointInBounds } from '../coords';
import {
	createControlPointPair,
	createProjectState,
	findImageByRole,
	isImageRole,
	MIN_CORRIDOR_POINTS
} from './project';
import type {
	AnnotatedHole,
	ControlPointPair,
	ImageAsset,
	ImagePoint,
	ImageRole,
	OrderedShot,
	PointCoordinates,
	ProjectState,
	SourcePoint
} from './project';

export type PointSide = 'source' | 'target';

export interface AssetResource {
	bytes: Uint8Array;
	decoded: unknown | null;
}

export interface ProjectEditorOptions {
	state?: ProjectState;
	assets?: ReadonlyMap<string, AssetResource>;
	createId?: () => string;
	now?: () => Date;
}

export interface AddPairOptions {
	sourceCoordinates: PointCoordinates;
	targetCoordinates: PointCoordinates;
	label?: string | null;
	enabled?: boolean;
}

export interface AssignImageOptions {
	role: ImageRole;
	asset: ImageAsset;
	bytes: Uint8Array;
}

export interface ReplaceImageOptions {
	role: ImageRole;
	asset: ImageAsset;
	bytes: Uint8Array;
	/**
	 * When true, existing pairs keep their coordinates but their image references are
	 * moved to the replacement asset. Only valid when the replacement has the exact same
	 * dimensions; otherwise the caller must confirm discarding that role's points
	 * (retainPoints: false).
	 */
	retainPoints?: boolean;
}

/**
 * Deep clone of plain serializable domain data. Domain state contains only plain
 * objects, so the JSON round trip is exact and works in any environment.
 */
function cloneValue<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function statesEqual(a: ProjectState, b: ProjectState): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function assertFiniteCoordinates(coordinates: PointCoordinates, context: string): void {
	if (!Number.isFinite(coordinates.xPx) || !Number.isFinite(coordinates.yPx)) {
		throw new Error(
			`${context}: coordinates must be finite, got ${JSON.stringify(coordinates)}`
		);
	}
}

function assertLabel(label: unknown, context: string): void {
	if (label !== null && typeof label !== 'string') {
		throw new Error(`${context}: label must be a string or null, got ${typeof label}`);
	}
}

function assertBoolean(value: unknown, context: string): void {
	if (typeof value !== 'boolean') {
		throw new Error(`${context}: expected a boolean, got ${typeof value}`);
	}
}

function assertBytes(bytes: unknown, context: string): void {
	if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
		throw new Error(`${context}: bytes must be a non-empty Uint8Array`);
	}
}

export class ProjectEditor {
	#state: ProjectState;
	#undoStack: ProjectState[] = [];
	#redoStack: ProjectState[] = [];
	#saved: ProjectState | null = null;
	#assets = new Map<string, AssetResource>();
	#createId: () => string;
	#now: () => Date;

	constructor(options: ProjectEditorOptions = {}) {
		const { state, assets, createId, now } = options;
		this.#state = state ? cloneValue(state) : createProjectState({ createId, now });
		this.#createId = createId ?? (() => globalThis.crypto.randomUUID());
		this.#now = now ?? (() => new Date());
		if (assets) {
			for (const [id, resource] of assets) {
				this.#assets.set(id, {
					bytes: Uint8Array.from(resource.bytes),
					decoded: resource.decoded ?? null
				});
			}
		}
		this.reconcileAssets();
	}

	get state(): ProjectState {
		return cloneValue(this.#state);
	}

	get canUndo(): boolean {
		return this.#undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.#redoStack.length > 0;
	}

	get isDirty(): boolean {
		return this.#saved !== this.#state;
	}

	undo(): boolean {
		const previous = this.#undoStack.pop();
		if (!previous) return false;
		this.#redoStack.push(this.#state);
		this.#state = previous;
		this.reconcileAssets();
		return true;
	}

	redo(): boolean {
		const next = this.#redoStack.pop();
		if (!next) return false;
		this.#undoStack.push(this.#state);
		this.#state = next;
		this.reconcileAssets();
		return true;
	}

	/** Records the current snapshot as the saved/opened checkpoint after a successful save or open. */
	markSaved(): void {
		this.#saved = this.#state;
	}

	getAssetResource(imageId: string): AssetResource | undefined {
		const resource = this.#assets.get(imageId);
		if (!resource) return undefined;
		return { bytes: Uint8Array.from(resource.bytes), decoded: resource.decoded };
	}

	setDecodedResource(imageId: string, decoded: unknown): void {
		const resource = this.#assets.get(imageId);
		if (!resource) {
			throw new Error(`setDecodedResource: no asset registered for '${imageId}'`);
		}
		resource.decoded = decoded;
	}

	renameProject(name: string): void {
		if (typeof name !== 'string' || name.length === 0) {
			throw new Error(
				`renameProject: name must be a non-empty string, got ${JSON.stringify(name)}`
			);
		}
		if (name === this.#state.project.name) return;
		const before = this.#state;
		const after = {
			...before,
			project: { ...before.project, name, updatedAt: this.#now().toISOString() }
		};
		this.commit(before, after);
	}

	/**
	 * Replaces the whole hole-annotation list in one history step. Whole-list rather
	 * than per-feature mutations because hole editing is authored elsewhere as pure
	 * transformations over an immutable array (`src/lib/holeAnnotation.ts`); the caller
	 * composes those and commits the result once, exactly like one drag becomes one
	 * `movePoint`.
	 *
	 * Hole points are always source-image pixels, so every one is bounds-checked
	 * against the loaded `source-overview` image — the same guarantee `addPair`
	 * enforces, so an out-of-bounds hole can never reach serialization.
	 */
	setHoles(holes: readonly AnnotatedHole[]): void {
		if (!Array.isArray(holes)) {
			throw new Error('setHoles: holes must be an array');
		}
		const sourceImage = findImageByRole(this.#state.images, 'source-overview');
		if (!sourceImage && holes.length > 0) {
			throw new Error('setHoles: the source-overview image must be loaded before setting holes');
		}
		const numbers = new Set<number>();
		for (const hole of holes) {
			if (typeof hole.id !== 'string' || hole.id.length === 0) {
				throw new Error('setHoles: every hole must have a non-empty id');
			}
			if (!Number.isInteger(hole.number) || hole.number <= 0) {
				throw new Error(`setHoles: hole '${hole.id}' number must be a positive integer`);
			}
			if (numbers.has(hole.number)) {
				throw new Error(`setHoles: duplicate hole number ${hole.number}`);
			}
			numbers.add(hole.number);
			const image = sourceImage as ImageAsset;
			const checkPoint = (point: { xPx: number; yPx: number }, label: string): void => {
				assertFiniteCoordinates(point, `setHoles (hole ${hole.number} ${label})`);
				if (!pointInBounds(point, image.widthPx, image.heightPx)) {
					throw new Error(
						`setHoles: hole ${hole.number} ${label} is outside the source image bounds`
					);
				}
			};
			if (hole.tee) checkPoint(hole.tee, 'tee');
			if (hole.basket) checkPoint(hole.basket, 'basket');
			if (!Array.isArray(hole.shots)) {
				throw new Error(`setHoles: hole ${hole.number} shots must be an array`);
			}
			hole.shots.forEach((shot: OrderedShot, index: number) =>
				checkPoint(shot.landing, `shot ${index + 1}`)
			);
			if (hole.corridor) {
				if (hole.corridor.length < MIN_CORRIDOR_POINTS) {
					throw new Error(
						`setHoles: hole ${hole.number} corridor must have at least ${MIN_CORRIDOR_POINTS} vertices, got ${hole.corridor.length}`
					);
				}
				hole.corridor.forEach((point: SourcePoint, index: number) =>
					checkPoint(point, `corridor point ${index + 1}`)
				);
			}
		}

		const before = this.#state;
		const after = { ...before, holes: cloneValue(holes as AnnotatedHole[]) };
		this.commit(before, after);
	}

	addPair(options: AddPairOptions): ControlPointPair {
		const { sourceCoordinates, targetCoordinates, label = null, enabled = true } = options;
		const sourceImage = findImageByRole(this.#state.images, 'source-overview');
		const targetImage = findImageByRole(this.#state.images, 'target-basemap');
		if (!sourceImage) {
			throw new Error('addPair: the source-overview image must be loaded before adding a pair');
		}
		if (!targetImage) {
			throw new Error('addPair: the target-basemap image must be loaded before adding a pair');
		}
		assertLabel(label, 'addPair');
		assertBoolean(enabled, 'addPair');
		assertFiniteCoordinates(sourceCoordinates, 'addPair');
		assertFiniteCoordinates(targetCoordinates, 'addPair');
		if (!pointInBounds(sourceCoordinates, sourceImage.widthPx, sourceImage.heightPx)) {
			throw new Error('addPair: source coordinates are outside the source image bounds');
		}
		if (!pointInBounds(targetCoordinates, targetImage.widthPx, targetImage.heightPx)) {
			throw new Error('addPair: target coordinates are outside the target image bounds');
		}

		const ordinal =
			this.#state.controlPointPairs.reduce((max, pair) => Math.max(max, pair.ordinal), 0) + 1;
		const pair = createControlPointPair({
			createId: this.#createId,
			now: this.#now,
			sourceImage,
			targetImage,
			sourceCoordinates,
			targetCoordinates,
			ordinal,
			label,
			enabled
		});

		const before = this.#state;
		const after = { ...before, controlPointPairs: [...before.controlPointPairs, pair] };
		this.commit(before, after);
		return cloneValue(pair);
	}

	movePoint(pairId: string, side: PointSide, coordinates: PointCoordinates): void {
		if (side !== 'source' && side !== 'target') {
			throw new Error(`movePoint: side must be 'source' or 'target', got ${JSON.stringify(side)}`);
		}
		const before = this.#state;
		const pair = before.controlPointPairs.find((candidate) => candidate.id === pairId);
		if (!pair) {
			throw new Error(`movePoint: unknown pair '${pairId}'`);
		}
		const current: ImagePoint = pair[side];
		const image = before.images.find((candidate) => candidate.id === current.imageId);
		if (!image) {
			throw new Error(
				`movePoint: pair '${pairId}' references missing image '${current.imageId}'`
			);
		}
		assertFiniteCoordinates(coordinates, 'movePoint');
		if (!pointInBounds(coordinates, image.widthPx, image.heightPx)) {
			throw new Error(
				`movePoint: coordinates ${JSON.stringify(coordinates)} are outside the bounds of image '${image.id}'`
			);
		}
		if (current.xPx === coordinates.xPx && current.yPx === coordinates.yPx) return;

		const timestamp = this.#now().toISOString();
		const after = {
			...before,
			controlPointPairs: before.controlPointPairs.map((candidate) =>
				candidate.id === pairId
					? { ...candidate, [side]: { ...current, ...coordinates }, updatedAt: timestamp }
					: candidate
			)
		};
		this.commit(before, after);
	}

	setLabel(pairId: string, label: string | null): void {
		assertLabel(label, 'setLabel');
		const before = this.#state;
		const pair = before.controlPointPairs.find((candidate) => candidate.id === pairId);
		if (!pair) {
			throw new Error(`setLabel: unknown pair '${pairId}'`);
		}
		if (pair.label === label) return;
		const timestamp = this.#now().toISOString();
		const after = {
			...before,
			controlPointPairs: before.controlPointPairs.map((candidate) =>
				candidate.id === pairId ? { ...candidate, label, updatedAt: timestamp } : candidate
			)
		};
		this.commit(before, after);
	}

	setEnabled(pairId: string, enabled: boolean): void {
		assertBoolean(enabled, 'setEnabled');
		const before = this.#state;
		const pair = before.controlPointPairs.find((candidate) => candidate.id === pairId);
		if (!pair) {
			throw new Error(`setEnabled: unknown pair '${pairId}'`);
		}
		if (pair.enabled === enabled) return;
		const timestamp = this.#now().toISOString();
		const after = {
			...before,
			controlPointPairs: before.controlPointPairs.map((candidate) =>
				candidate.id === pairId ? { ...candidate, enabled, updatedAt: timestamp } : candidate
			)
		};
		this.commit(before, after);
	}

	deletePair(pairId: string): ControlPointPair {
		const before = this.#state;
		const pair = before.controlPointPairs.find((candidate) => candidate.id === pairId);
		if (!pair) {
			throw new Error(`deletePair: unknown pair '${pairId}'`);
		}
		const after = {
			...before,
			controlPointPairs: before.controlPointPairs.filter((candidate) => candidate.id !== pairId)
		};
		this.commit(before, after);
		return cloneValue(pair);
	}

	reorderPairs(orderedIds: readonly string[]): void {
		const before = this.#state;
		const ids = before.controlPointPairs.map((pair) => pair.id);
		const ordered = [...orderedIds];
		if (
			ordered.length !== ids.length ||
			new Set(ordered).size !== ids.length ||
			ids.some((id) => !ordered.includes(id))
		) {
			throw new Error(
				'reorderPairs: orderedIds must contain exactly the current pair ids without duplicates'
			);
		}
		if (ordered.every((id, index) => id === ids[index])) return;

		const byId = new Map(before.controlPointPairs.map((pair) => [pair.id, pair]));
		const timestamp = this.#now().toISOString();
		const after = {
			...before,
			controlPointPairs: ordered.map((id, index) => ({
				...byId.get(id)!,
				ordinal: index + 1,
				updatedAt: timestamp
			}))
		};
		this.commit(before, after);
	}

	/**
	 * Assigns the first image for a role in a fresh project (the role must currently be
	 * unset). Registers bytes, enters history once, sets dirty state, and supports
	 * undo/redo exactly like any other durable mutation.
	 */
	assignImage(options: AssignImageOptions): ImageAsset {
		const { role, asset, bytes } = options;
		if (!isImageRole(role)) {
			throw new Error(`assignImage: unknown image role ${JSON.stringify(role)}`);
		}
		if (asset.role !== role) {
			throw new Error(
				`assignImage: asset has role '${asset.role}' but assignment requested role '${role}'`
			);
		}
		assertBytes(bytes, 'assignImage');
		if (findImageByRole(this.#state.images, role)) {
			throw new Error(`assignImage: a ${role} image is already loaded; use replaceImage`);
		}
		this.assertAssetIdAvailable(asset.id, 'assignImage');

		const stored = cloneValue(asset);
		this.#assets.set(stored.id, { bytes: Uint8Array.from(bytes), decoded: null });
		const before = this.#state;
		const after = { ...before, images: [...before.images, stored] };
		this.commit(before, after);
		return cloneValue(stored);
	}

	replaceImage(options: ReplaceImageOptions): ImageAsset {
		const { role, asset, bytes, retainPoints = false } = options;
		if (!isImageRole(role)) {
			throw new Error(`replaceImage: unknown image role ${JSON.stringify(role)}`);
		}
		if (asset.role !== role) {
			throw new Error(
				`replaceImage: asset has role '${asset.role}' but replacement requested role '${role}'`
			);
		}
		assertBytes(bytes, 'replaceImage');
		this.assertAssetIdAvailable(asset.id, 'replaceImage');

		const current = findImageByRole(this.#state.images, role);
		if (!current) {
			throw new Error(`replaceImage: no ${role} image is loaded; use assignImage`);
		}
		if (
			retainPoints &&
			(current.widthPx !== asset.widthPx || current.heightPx !== asset.heightPx)
		) {
			throw new Error(
				'replaceImage: points can be retained only when the replacement image has the exact same dimensions'
			);
		}

		const stored = cloneValue(asset);
		const before = this.#state;
		let pairs = before.controlPointPairs;
		if (retainPoints) {
			const timestamp = this.#now().toISOString();
			pairs = pairs.map((pair) => {
				const source =
					pair.source.imageId === current.id ? { ...pair.source, imageId: stored.id } : pair.source;
				const target =
					pair.target.imageId === current.id ? { ...pair.target, imageId: stored.id } : pair.target;
				return { ...pair, source, target, updatedAt: timestamp };
			});
		} else {
			pairs = pairs.filter(
				(pair) => pair.source.imageId !== current.id && pair.target.imageId !== current.id
			);
		}

		// Holes are source-image pixel coordinates with no imageId to remap, so they
		// follow the same rule as points: retained when the replacement has identical
		// dimensions (the coordinates still mean the same thing), discarded otherwise.
		// Replacing the target image never affects them.
		const holes =
			current.role === 'source-overview' && !retainPoints ? [] : before.holes;

		const after = {
			...before,
			images: before.images.map((candidate) => (candidate.id === current.id ? stored : candidate)),
			controlPointPairs: pairs,
			holes
		};
		this.#assets.set(stored.id, { bytes: Uint8Array.from(bytes), decoded: null });
		this.commit(before, after);
		return cloneValue(stored);
	}

	private commit(before: ProjectState, after: ProjectState): void {
		if (statesEqual(before, after)) return;
		this.#undoStack.push(before);
		this.#redoStack.length = 0;
		this.#state = after;
		this.reconcileAssets();
	}

	/**
	 * Rejects asset ids still referenced by current, undo, or redo state. The live
	 * registry mirrors exactly the ids referenced by current state plus both history
	 * stacks (entries are added on assignment/replacement and released only when no
	 * snapshot references the id), and the current-state check covers projects whose
	 * images were never registered.
	 */
	private assertAssetIdAvailable(id: string, context: string): void {
		if (this.#assets.has(id) || this.#state.images.some((image) => image.id === id)) {
			throw new Error(
				`${context}: asset id '${id}' is already in use by current or history state`
			);
		}
	}

	private reconcileAssets(): void {
		const reachable = new Set<string>();
		for (const image of this.#state.images) reachable.add(image.id);
		for (const snapshot of this.#undoStack) {
			for (const image of snapshot.images) reachable.add(image.id);
		}
		for (const snapshot of this.#redoStack) {
			for (const image of snapshot.images) reachable.add(image.id);
		}
		for (const id of this.#assets.keys()) {
			if (!reachable.has(id)) this.#assets.delete(id);
		}
	}
}
