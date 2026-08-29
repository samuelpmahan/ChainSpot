import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
	RecoveredTeeInput,
	ThreeFactorMeasurement
} from '../../packages/alg/src/detectors/threeFactor/types';
import { nullFeatureContext } from '../../packages/alg/src/detectors/threeFactor/features/types';
import { createExecBoard } from '../../packages/alg/src/exec/board';
import { operationImpls } from '../../packages/alg/src/exec/operations';
import { teeRecoveryUnit } from '../../packages/alg/src/detectors/threeFactor/features/g3.teeRecovery';

describe('teeRecovery operation adapter', () => {
	afterEach(() => vi.restoreAllMocks());

	// 2026-08-29: teeRecovery moved before assignment (gate reorg;
	// owner-measured ray work, cd77412 lineage), removing its G5/G6
	// dependency on 'assignment' entirely. The operation used to rerun
	// assignment internally and republish its final tee/rawPairs inventory
	// into the downstream 'assignment.tees'/'assignment.rawPairs' slots (PR
	// #61); that republish is now GONE -- teeRecoveryUnit only produces
	// 'recoveredTees' (a seeded slot merged in later by 'assignment.pairs',
	// the G6 operation), and the adapter is a pure passthrough to
	// teeRecoveryUnit.run with no post-processing of its own.
	test('is a pure passthrough to teeRecoveryUnit.run, touching no slot of its own', () => {
		const measurement = { tees: [{ detId: 'tee-visible' }] } as unknown as ThreeFactorMeasurement;
		const recovered: RecoveredTeeInput[] = [
			{
				xPx: 12,
				yPx: 34,
				provenance: { note: 'recovered-0' }
			} as unknown as RecoveredTeeInput
		];
		const runSpy = vi.spyOn(teeRecoveryUnit, 'run').mockImplementation((board) => {
			board.set('recoveredTees', recovered);
		});
		const board = createExecBoard();
		board.set('measurement', measurement);
		board.set('recoveredTees', []);

		operationImpls.get('teeRecovery')!(board, nullFeatureContext);

		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(board.get('measurement')).toBe(measurement);
		expect(board.get<readonly RecoveredTeeInput[]>('recoveredTees')).toBe(recovered);
		// No republish: the adapter never sets or reads 'assignment' or its
		// dotted slots -- that merge is 'assignment.pairs' (G6) reading
		// 'recoveredTees', now downstream of this operation, never the reverse.
		expect(board.has('assignment')).toBe(false);
		expect(board.has('assignment.tees')).toBe(false);
		expect(board.has('assignment.rawPairs')).toBe(false);
	});
});
