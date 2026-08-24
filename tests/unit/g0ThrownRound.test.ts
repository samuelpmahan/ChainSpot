import { describe, expect, test } from 'vitest';
import { decideThrownRound } from '@chainspot/alg/g0/thrownRound';

describe('decideThrownRound', () => {
	test('no images -> none', () => {
		expect(decideThrownRound([])).toEqual({ status: 'none' });
	});

	test('any score still pending -> waiting, even if another already clears the threshold', () => {
		expect(decideThrownRound([0.5, undefined])).toEqual({ status: 'waiting' });
	});

	test('all scores at or below threshold -> none', () => {
		expect(decideThrownRound([0, 0, 0])).toEqual({ status: 'none' });
	});

	test('exactly one candidate above threshold -> auto-selects it', () => {
		expect(decideThrownRound([0, 0.3, 0])).toEqual({ status: 'auto', index: 1, score: 0.3 });
	});

	test('more than one candidate above threshold -> ambiguous, lists all candidates, does not pick', () => {
		expect(decideThrownRound([0.1, 0, 0.4])).toEqual({
			status: 'ambiguous',
			candidates: [
				{ index: 0, score: 0.1 },
				{ index: 2, score: 0.4 }
			]
		});
	});

	test('custom threshold is respected', () => {
		expect(decideThrownRound([0.2, 0.05], 0.1)).toEqual({ status: 'auto', index: 0, score: 0.2 });
	});
});
