import { describe, expect, test } from 'vitest';
import { createExecBoard } from '@chainspot/alg/exec';
import type { CanonicalTruth } from '@chainspot/alg/g0/truth';
import type {
	ThreeFactorAssignment,
	ThreeFactorMeasurement
} from '@chainspot/alg/detectors/threeFactor/types';
import { scoreTruth } from '../../scripts/chainspot-lab/sweep/truthScoring';

describe('Sweep G6 truth scoring', () => {
	test('resolves Dashs recovered H3/H5/H12 IDs from the final assignment inventory', () => {
		const recovered = [
			{ number: 3, tee: { xPx: 20, yPx: 30 }, basket: { xPx: 80, yPx: 90 } },
			{ number: 5, tee: { xPx: 40, yPx: 50 }, basket: { xPx: 100, yPx: 110 } },
			{ number: 12, tee: { xPx: 60, yPx: 70 }, basket: { xPx: 120, yPx: 130 } }
		] as const;
		const measurement = {
			badges: recovered.map(({ number }) => ({ detId: `badge-${number}`, label: `${number}` })),
			baskets: recovered.map(({ number, basket }) => ({
				detId: `basket-${number}`,
				tipXPx: basket.xPx,
				tipYPx: basket.yPx
			})),
			tees: []
		} as unknown as ThreeFactorMeasurement;
		const assignment = {
			measurement,
			tees: recovered.map(({ number, tee }, index) => ({
				detId: `tee-recovered-${index}`,
				xPx: tee.xPx,
				yPx: tee.yPx,
				number
			})),
			scoredPairs: [],
			assignments: recovered.map(({ number }, index) => ({
				badgeId: `badge-${number}`,
				teeId: `tee-recovered-${index}`,
				basketId: `basket-${number}`,
				score: 1,
				rank: 1,
				ownership: 'selected',
				alternatives: []
			}))
		} as unknown as ThreeFactorAssignment;
		const truth: CanonicalTruth = {
			schemaVersion: 1,
			sourceImage: {
				fileName: 'synthetic.png',
				mimeType: 'image/png',
				widthPx: 100,
				heightPx: 100,
				sha256: 'synthetic',
				bundlePath: 'synthetic.png'
			},
			holes: recovered.map(({ number, tee, basket }) => ({
				id: `h${number}`,
				number,
				shots: [],
				corridorBends: [],
				corridorWidthPx: 30,
				tee,
				basket
			}))
		};
		const board = createExecBoard();
		board.set('measurement', measurement);
		board.set('assignment', assignment);

		const g6 = scoreTruth(board, truth).scores.find((score) => score.gate === 'G6');

		expect(g6).toMatchObject({ matched: 3, expected: 3, misses: [] });
	});
});
