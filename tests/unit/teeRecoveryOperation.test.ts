import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
	RawPairEvidence,
	ThreeFactorAssignment,
	ThreeFactorMeasurement
} from '../../packages/alg/src/detectors/threeFactor/types';
import { nullFeatureContext } from '../../packages/alg/src/detectors/threeFactor/features/types';
import { createExecBoard } from '../../packages/alg/src/exec/board';
import { operationImpls } from '../../packages/alg/src/exec/operations';
import { teeRecoveryUnit } from '../../packages/alg/src/detectors/threeFactor/features/g3.teeRecovery';

describe('teeRecovery operation adapter', () => {
	afterEach(() => vi.restoreAllMocks());

	test('publishes the final recovered inventory and routes without mutating measurement', () => {
		const measurement = { tees: [{ detId: 'tee-visible' }] } as unknown as ThreeFactorMeasurement;
		const recoveredRaw = {
			pairId: 'badge-3:tee-recovered-0:basket-3',
			badgeId: 'badge-3',
			teeId: 'tee-recovered-0',
			basketId: 'basket-3'
		} as RawPairEvidence;
		const finalAssignment = {
			measurement,
			tees: [{ detId: 'tee-visible' }, { detId: 'tee-recovered-0' }],
			scoredPairs: [{ raw: recoveredRaw }],
			assignments: [
				{
					badgeId: 'badge-3',
					teeId: 'tee-recovered-0',
					basketId: 'basket-3'
				}
			]
		} as unknown as ThreeFactorAssignment;
		vi.spyOn(teeRecoveryUnit, 'run').mockImplementation((board) => {
			board.set('assignment', finalAssignment);
		});
		const board = createExecBoard();
		board.set('measurement', measurement);
		board.set('assignment.tees', measurement.tees);
		board.set('assignment.rawPairs', []);

		operationImpls.get('teeRecovery')!(board, nullFeatureContext);

		const finalTees = board.get<ThreeFactorAssignment['tees']>('assignment.tees');
		const finalRawPairs = board.get<readonly RawPairEvidence[]>('assignment.rawPairs');
		const finalTeeIds = new Set(finalTees.map((tee) => tee.detId));
		expect(finalTees).toBe(finalAssignment.tees);
		expect(finalRawPairs).toEqual([recoveredRaw]);
		expect(finalAssignment.assignments.every((row) => finalTeeIds.has(row.teeId))).toBe(true);
		expect(finalRawPairs.every((raw) => finalTeeIds.has(raw.teeId))).toBe(true);
		expect(finalRawPairs.some((raw) => raw.teeId.startsWith('tee-recovered-'))).toBe(true);
		expect(board.get('measurement')).toBe(measurement);
	});
});
