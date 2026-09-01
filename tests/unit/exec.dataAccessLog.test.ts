import { describe, expect, test } from 'vitest';
import {
	LoggedExecBoard,
	dataAccessLog,
	resetDataAccessLog,
	withBoardAccessScope
} from '@chainspot/alg/exec';

describe('temporary E pass-through data-access log', () => {
	test('observes G0-G3 across boards without changing object identity or values', async () => {
		resetDataAccessLog();
		const value = { width: 3, height: 2, data: new Uint8Array([0, 1, 0, 1, 0, 1]) };

		const g0 = new LoggedExecBoard();
		const returned = await g0.withScope('G0:intake', async () => {
			g0.set('g0.image', value);
			await Promise.resolve();
			return g0.get<typeof value>('g0.image');
		});
		expect(returned).toBe(value);

		const detector = new LoggedExecBoard();
		withBoardAccessScope(detector, 'G1:badgeStage.masks', () => {
			detector.set('badgeStage.masks', value);
			expect(detector.has('badgeStage.masks')).toBe(true);
			expect(detector.get('badgeStage.masks')).toBe(value);
		});
		withBoardAccessScope(detector, 'G3:tees.exclusion', () => {
			detector.set('tees', [{ detId: 'tee-1' }]);
			detector.get('tees');
		});

		const beforeG4 = dataAccessLog().length;
		withBoardAccessScope(detector, 'G4:teeRecovery', () => {
			detector.set('recoveredTees', []);
			detector.get('recoveredTees');
		});

		const log = dataAccessLog();
		expect(log.length).toBe(beforeG4);
		expect(log.map((event) => event.scope)).toEqual([
			'G0:intake',
			'G0:intake',
			'G1:badgeStage.masks',
			'G1:badgeStage.masks',
			'G1:badgeStage.masks',
			'G3:tees.exclusion',
			'G3:tees.exclusion'
		]);
		expect(log.map((event) => event.kind)).toEqual(['set', 'get', 'set', 'has', 'get', 'set', 'get']);
		expect(log.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(log[0]?.value).toMatchObject({ type: 'object', width: 3, height: 2 });
	});
});
