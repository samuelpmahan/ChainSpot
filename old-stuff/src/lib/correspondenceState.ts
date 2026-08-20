import type { ImageRole, PointCoordinates } from './domain/project';

/**
 * `add-source` is the historical name for the first-click phase; either pane
 * is now accepted there. `add-target` is the second-click phase.
 */
export type CorrespondenceMode = 'neutral' | 'add-source' | 'add-target';

/**
 * The first endpoint placed while creating a correspondence. The role is
 * deliberately carried with the placement so either pane can be clicked first.
 */
export interface PendingPlacement {
	readonly role: ImageRole;
	readonly imageId: string;
	readonly coordinates: PointCoordinates;
	readonly ordinal: number;
}

export interface CorrespondenceState {
	readonly mode: CorrespondenceMode;
	readonly pendingPlacement: PendingPlacement | null;
}

export interface PanePlacement {
	readonly role: ImageRole;
	readonly coordinates: PointCoordinates;
}

export interface CompletionIntent {
	readonly source: PendingPlacement;
	readonly target: PendingPlacement;
}

export interface PlacementTransition {
	readonly state: CorrespondenceState;
	readonly accepted: boolean;
	readonly completion: CompletionIntent | null;
}

export function createCorrespondenceState(): CorrespondenceState {
	return { mode: 'neutral', pendingPlacement: null };
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
	return { mode: 'add-source', pendingPlacement: null };
}

export function cancelCorrespondence(state: CorrespondenceState): CorrespondenceState {
	if (state.mode === 'neutral' && state.pendingPlacement === null) return state;
	return createCorrespondenceState();
}

/**
 * Accepts the second endpoint only as a successful domain-operation follow-up. The
 * state remains add-target until `completeCorrespondence` is called, making
 * completion failure atomic.
 */
export function completeCorrespondence(state: CorrespondenceState): CorrespondenceState {
	if (state.mode !== 'add-target' || state.pendingPlacement === null) return state;
	return createCorrespondenceState();
}

export function placeCorrespondence(
	state: CorrespondenceState,
	placement: PanePlacement,
	imageId: string,
	nextOrdinal: number
): PlacementTransition {
	if (state.mode === 'add-source') {
		if (!imageId) throw new Error('placeCorrespondence: imageId is required');
		if (!Number.isInteger(nextOrdinal) || nextOrdinal < 1) {
			throw new Error(`placeCorrespondence: nextOrdinal must be a positive integer, got ${nextOrdinal}`);
		}
		return {
			state: {
				mode: 'add-target',
				pendingPlacement: {
					role: placement.role,
					imageId,
					coordinates: placement.coordinates,
					ordinal: nextOrdinal
				}
			},
			accepted: true,
			completion: null
		};
	}

	if (state.mode === 'add-target' && state.pendingPlacement !== null) {
		if (placement.role === state.pendingPlacement.role) {
			return { state, accepted: false, completion: null };
		}
		if (!imageId) throw new Error('placeCorrespondence: imageId is required');
		const secondPlacement: PendingPlacement = {
			role: placement.role,
			imageId,
			coordinates: placement.coordinates,
			ordinal: state.pendingPlacement.ordinal
		};
		const source =
			state.pendingPlacement.role === 'source-overview'
				? state.pendingPlacement
				: secondPlacement;
		const target =
			state.pendingPlacement.role === 'target-basemap'
				? state.pendingPlacement
				: secondPlacement;
		return {
			state,
			accepted: true,
			completion: { source, target }
		};
	}

	return { state, accepted: false, completion: null };
}

export function nextPairOrdinal(
	pairs: ReadonlyArray<{ readonly ordinal: number }>
): number {
	return pairs.reduce((max, pair) => Math.max(max, pair.ordinal), 0) + 1;
}
