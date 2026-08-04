import type { ImageRole, PointCoordinates } from './domain/project';

export type CorrespondenceMode = 'neutral' | 'add-source' | 'add-target';

export interface PendingSourcePlacement {
	readonly imageId: string;
	readonly coordinates: PointCoordinates;
	readonly ordinal: number;
}

export interface CorrespondenceState {
	readonly mode: CorrespondenceMode;
	readonly pendingSource: PendingSourcePlacement | null;
}

export interface PanePlacement {
	readonly role: ImageRole;
	readonly coordinates: PointCoordinates;
}

export interface CompletionIntent {
	readonly source: PendingSourcePlacement;
	readonly target: PointCoordinates;
}

export interface PlacementTransition {
	readonly state: CorrespondenceState;
	readonly accepted: boolean;
	readonly completion: CompletionIntent | null;
}

export function createCorrespondenceState(): CorrespondenceState {
	return { mode: 'neutral', pendingSource: null };
}

export function activateCorrespondence(
	state: CorrespondenceState,
	canAdd: boolean,
	nextOrdinal: number
): CorrespondenceState {
	if (!canAdd || state.mode !== 'neutral') return state;
	if (!Number.isInteger(nextOrdinal) || nextOrdinal < 1) {
		throw new Error(`activateCorrespondence: nextOrdinal must be a positive integer, got ${nextOrdinal}`);
	}
	return { mode: 'add-source', pendingSource: null };
}

export function cancelCorrespondence(state: CorrespondenceState): CorrespondenceState {
	if (state.mode === 'neutral' && state.pendingSource === null) return state;
	return createCorrespondenceState();
}

/**
 * Accepts a target only as a successful domain-operation follow-up. The state remains
 * add-target until `completeCorrespondence` is called, making completion failure atomic.
 */
export function completeCorrespondence(state: CorrespondenceState): CorrespondenceState {
	if (state.mode !== 'add-target' || state.pendingSource === null) return state;
	return createCorrespondenceState();
}

export function placeCorrespondence(
	state: CorrespondenceState,
	placement: PanePlacement,
	imageId: string,
	nextOrdinal: number
): PlacementTransition {
	if (state.mode === 'add-source') {
		if (placement.role !== 'source-overview') {
			return { state, accepted: false, completion: null };
		}
		if (!imageId) throw new Error('placeCorrespondence: source imageId is required');
		if (!Number.isInteger(nextOrdinal) || nextOrdinal < 1) {
			throw new Error(`placeCorrespondence: nextOrdinal must be a positive integer, got ${nextOrdinal}`);
		}
		return {
			state: {
				mode: 'add-target',
				pendingSource: { imageId, coordinates: placement.coordinates, ordinal: nextOrdinal }
			},
			accepted: true,
			completion: null
		};
	}

	if (state.mode === 'add-target' && state.pendingSource !== null) {
		if (placement.role !== 'target-basemap') {
			return { state, accepted: false, completion: null };
		}
		return {
			state,
			accepted: true,
			completion: { source: state.pendingSource, target: placement.coordinates }
		};
	}

	return { state, accepted: false, completion: null };
}

export function nextPairOrdinal(
	pairs: ReadonlyArray<{ readonly ordinal: number }>
): number {
	return pairs.reduce((max, pair) => Math.max(max, pair.ordinal), 0) + 1;
}
