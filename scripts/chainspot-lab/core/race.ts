import { hashCanonical } from './hashing';
import type { ApplicabilityResult } from './identity';

export interface ResolvedRaceSelection {
	readonly implementationKey: string;
	readonly parameters: unknown;
}

export interface ResolvedRaceAxis {
	/** Swappable decision boundary such as `chrome` or `teeRecovery`. */
	readonly slotId: string;
	readonly selections: readonly ResolvedRaceSelection[];
}

export interface ResolvedCombinationSlot extends ResolvedRaceSelection {
	readonly slotId: string;
}

export interface ResolvedImplementationCombination {
	readonly combinationHash: string;
	readonly slots: readonly ResolvedCombinationSlot[];
	readonly applicability: ApplicabilityResult;
}

export type CombinationCompatibilityCheck = (
	slots: readonly ResolvedCombinationSlot[]
) => ApplicabilityResult;

/**
 * Expand every manifest axis as a Cartesian product. No implementation is
 * privileged; incompatibility is recorded on a combination rather than
 * silently selecting or substituting a champion.
 */
export function expandCartesianRace(
	axes: readonly ResolvedRaceAxis[],
	compatibility: CombinationCompatibilityCheck = () => ({ status: 'applicable' })
): readonly ResolvedImplementationCombination[] {
	if (axes.length === 0) throw new TypeError('A Cartesian race needs at least one axis');
	if (new Set(axes.map((axis) => axis.slotId)).size !== axes.length) {
		throw new TypeError('Cartesian race slot IDs must be unique');
	}
	for (const axis of axes) {
		if (axis.slotId.length === 0 || axis.selections.length === 0) {
			throw new TypeError('Every Cartesian race axis needs a slot ID and at least one selection');
		}
	}

	const expanded: ResolvedImplementationCombination[] = [];
	const visit = (axisIndex: number, slots: ResolvedCombinationSlot[]): void => {
		if (axisIndex === axes.length) {
			const frozenSlots = slots.map((slot) => ({ ...slot }));
			expanded.push({
				combinationHash: hashCanonical({ combinationHashSchemaVersion: 1, slots: frozenSlots }),
				slots: frozenSlots,
				applicability: compatibility(frozenSlots)
			});
			return;
		}
		const axis = axes[axisIndex];
		for (const selection of axis.selections) {
			visit(axisIndex + 1, [...slots, { slotId: axis.slotId, ...selection }]);
		}
	};
	visit(0, []);
	return expanded;
}
