import { describe, expect, test } from 'vitest';
import { appendEntries, appendEntry, createLedger } from '@chainspot/alg/g0/ledger';

describe('CoordinateTransformLedger', () => {
	test('starts empty', () => {
		expect(createLedger()).toEqual({ entries: [] });
	});

	test('appendEntry returns a NEW ledger, never mutates the original', () => {
		const original = createLedger();
		const entry = { kind: 'crop' as const, insets: { top: 1, right: 2, bottom: 3, left: 4 } };

		const next = appendEntry(original, entry);

		expect(original.entries).toEqual([]);
		expect(next.entries).toEqual([entry]);
		expect(next).not.toBe(original);
	});

	test('appendEntries appends several in order', () => {
		const ledger = appendEntries(createLedger(), [
			{ kind: 'crop', insets: { top: 1, right: 0, bottom: 0, left: 0 } },
			{ kind: 'placement', tileIndex: 0, placement: { x: 0, y: 0 }, source: 'spread' },
			{ kind: 'placement', tileIndex: 1, placement: { x: 100, y: 0 }, source: 'semantic' }
		]);

		expect(ledger.entries.map((e) => e.kind)).toEqual(['crop', 'placement', 'placement']);
	});
});
