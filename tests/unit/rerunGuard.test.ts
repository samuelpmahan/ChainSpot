import { describe, expect, test } from 'vitest';
import { placementsEqual, requiresReplaceDecision } from '../../src/lib/stitch/rerunGuard';
import type { PlacementMap } from '../../src/lib/stitch/rerunGuard';

function placements(
	moves: Record<string, Partial<{ xPx: number; yPx: number }>> = {}
): PlacementMap {
	const base = {
		'upper-left': { xPx: 0, yPx: 0, visible: true },
		'upper-right': { xPx: 150, yPx: 0, visible: true },
		'lower-left': { xPx: 0, yPx: 150, visible: true },
		'lower-right': { xPx: 150, yPx: 150, visible: true }
	} as unknown as PlacementMap;
	for (const [slot, move] of Object.entries(moves)) {
		base[slot as keyof PlacementMap] = { ...base[slot as keyof PlacementMap], ...move };
	}
	return base;
}

describe('P1-002 re-run/manual-state protection (case 2)', () => {
	test('placementsEqual compares only the committed x/y on every slot', () => {
		const a = placements();
		const b = placements();
		expect(placementsEqual(a, b)).toBe(true);

		const moved = placements({ 'upper-right': { xPx: 151, yPx: 0 } });
		expect(placementsEqual(a, moved)).toBe(false);

		// Null or undefined maps never compare equal (defensive default).
		expect(placementsEqual(null, a)).toBe(false);
		expect(placementsEqual(undefined, null)).toBe(false);
	});

	test('a re-run over manual edits requires an explicit replace decision', () => {
		const lastAuto = placements();
		const current = placements({ 'upper-right': { xPx: 151, yPx: 0 } });
		expect(requiresReplaceDecision(current, lastAuto)).toBe(true);
	});

	test('an unchanged arrangement or an empty session needs no confirmation', () => {
		const lastAuto = placements();
		const unchanged = placements();
		expect(requiresReplaceDecision(unchanged, lastAuto)).toBe(false);
		expect(requiresReplaceDecision(null, lastAuto)).toBe(false);
		expect(requiresReplaceDecision(null, null)).toBe(false);
	});

	test('the guard is deterministic and non-destructive', () => {
		const lastAuto = placements();
		const current = placements({ 'lower-left': { yPx: 152 } });
		const before = JSON.stringify({ lastAuto, current });
		const result = requiresReplaceDecision(current, lastAuto);
		expect(result).toBe(true);
		// No input is ever mutated, so a cancelled re-run preserves all state.
		expect(JSON.stringify({ lastAuto, current })).toBe(before);
	});
});
