// Pure verdict-classification tests for `lab digits` (scripts/chainspot-lab/scoreboard/verdict.ts).
// Fabricated readings only — no corpus, no detector, no filesystem. See
// digitsScoreboardCorpus.test.ts for the corpus-dependent acceptance fixture.

import { describe, expect, test } from 'vitest';
import {
	classifyBadges,
	countVerdicts,
	DEFAULT_CONFIDENCE_FLOOR,
	type BadgeReadingInput
} from '../../scripts/chainspot-lab/scoreboard/verdict';

function reading(overrides: Partial<BadgeReadingInput> & { detId: string }): BadgeReadingInput {
	return { label: '1', confidence: 0.99, ...overrides };
}

describe('classifyBadges', () => {
	test('a confident, unique, in-range integer read is OK', () => {
		const [v] = classifyBadges([reading({ detId: 'badge-0', label: '7', confidence: 0.994 })]);
		expect(v.verdict).toBe('OK');
	});

	test('a null label is UNREAD', () => {
		const [v] = classifyBadges([reading({ detId: 'badge-0', label: null, confidence: 0 })]);
		expect(v.verdict).toBe('UNREAD');
	});

	test('a non-integer or out-of-range label is GARBAGE-LABEL', () => {
		const [garbageMulti, garbageZero, garbageNegative, garbageOver] = classifyBadges([
			reading({ detId: 'badge-0', label: '1868', confidence: 0.028 }),
			reading({ detId: 'badge-1', label: '0', confidence: 0.5 }),
			reading({ detId: 'badge-2', label: '-3', confidence: 0.5 }),
			reading({ detId: 'badge-3', label: '19', confidence: 0.5 })
		]);
		for (const v of [garbageMulti, garbageZero, garbageNegative, garbageOver]) {
			expect(v.verdict).toBe('GARBAGE-LABEL');
		}
	});

	test('the AlexClark fixture shape: two garbage-label badges reproduce exactly', () => {
		const verdicts = classifyBadges([
			reading({ detId: 'badge-10', label: '1868', confidence: 0.028 }),
			reading({ detId: 'badge-16', label: '295', confidence: 0.003 }),
			reading({ detId: 'badge-0', label: '13', confidence: 0.987 })
		]);
		expect(verdicts.find((v) => v.detId === 'badge-10')?.verdict).toBe('GARBAGE-LABEL');
		expect(verdicts.find((v) => v.detId === 'badge-16')?.verdict).toBe('GARBAGE-LABEL');
		expect(verdicts.find((v) => v.detId === 'badge-0')?.verdict).toBe('OK');
	});

	test('a valid label below the floor is LOW-CONFIDENCE', () => {
		const [v] = classifyBadges([reading({ detId: 'badge-0', label: '13', confidence: 0.076 })]);
		expect(v.verdict).toBe('LOW-CONFIDENCE');
	});

	test('a valid label at or above the floor is OK, just below it is LOW-CONFIDENCE', () => {
		const [atFloor, justBelow] = classifyBadges([
			reading({ detId: 'badge-0', label: '5', confidence: DEFAULT_CONFIDENCE_FLOOR }),
			reading({ detId: 'badge-1', label: '6', confidence: DEFAULT_CONFIDENCE_FLOOR - 0.001 })
		]);
		expect(atFloor.verdict).toBe('OK');
		expect(justBelow.verdict).toBe('LOW-CONFIDENCE');
	});

	test('two or more badges sharing a valid label are all COLLISION and list every other party', () => {
		const verdicts = classifyBadges([
			reading({ detId: 'badge-7', label: '12', confidence: 0.026 }),
			reading({ detId: 'badge-9', label: '12', confidence: 0.025 }),
			reading({ detId: 'badge-12', label: '17', confidence: 0.004 }),
			reading({ detId: 'badge-17', label: '17', confidence: 0.993 })
		]);
		const [b7, b9, b12, b17] = verdicts;
		expect(b7.verdict).toBe('COLLISION');
		expect(b7.collisionParties).toEqual(['badge-9']);
		expect(b9.verdict).toBe('COLLISION');
		expect(b9.collisionParties).toEqual(['badge-7']);
		expect(b12.verdict).toBe('COLLISION');
		expect(b12.collisionParties).toEqual(['badge-17']);
		expect(b17.verdict).toBe('COLLISION');
		expect(b17.collisionParties).toEqual(['badge-12']);
	});

	test('COLLISION outranks LOW-CONFIDENCE: a low-confidence duplicate is still reported as COLLISION', () => {
		const verdicts = classifyBadges([
			reading({ detId: 'badge-12', label: '17', confidence: 0.004 }),
			reading({ detId: 'badge-17', label: '17', confidence: 0.993 })
		]);
		expect(verdicts.every((v) => v.verdict === 'COLLISION')).toBe(true);
		expect(verdicts.some((v) => v.verdict === 'LOW-CONFIDENCE')).toBe(false);
	});

	test('the HeritagePark fixture shape: dup 17 (0.993/0.004) and dup 12 (both low-conf) are both COLLISION', () => {
		const verdicts = classifyBadges([
			reading({ detId: 'badge-7', label: '12', confidence: 0.026 }),
			reading({ detId: 'badge-9', label: '12', confidence: 0.025 }),
			reading({ detId: 'badge-12', label: '17', confidence: 0.004 }),
			reading({ detId: 'badge-17', label: '17', confidence: 0.993 }),
			reading({ detId: 'badge-14', label: '13', confidence: 0.076 })
		]);
		const byId = new Map(verdicts.map((v) => [v.detId, v]));
		expect(byId.get('badge-7')?.verdict).toBe('COLLISION');
		expect(byId.get('badge-9')?.verdict).toBe('COLLISION');
		expect(byId.get('badge-12')?.verdict).toBe('COLLISION');
		expect(byId.get('badge-17')?.verdict).toBe('COLLISION');
		expect(byId.get('badge-14')?.verdict).toBe('LOW-CONFIDENCE');
	});

	test('an out-of-range garbage label never joins a collision group even if numerically repeated', () => {
		const verdicts = classifyBadges([
			reading({ detId: 'badge-0', label: '1868', confidence: 0.028 }),
			reading({ detId: 'badge-1', label: '1868', confidence: 0.02 })
		]);
		expect(verdicts.every((v) => v.verdict === 'GARBAGE-LABEL')).toBe(true);
		expect(verdicts.every((v) => v.collisionParties === undefined)).toBe(true);
	});

	test('an invalid floor throws rather than silently clamping', () => {
		expect(() => classifyBadges([reading({ detId: 'badge-0' })], -0.1)).toThrow();
		expect(() => classifyBadges([reading({ detId: 'badge-0' })], 1.1)).toThrow();
	});
});

describe('countVerdicts', () => {
	test('tallies every verdict class, matching a course summary line', () => {
		const verdicts = classifyBadges([
			reading({ detId: 'badge-0', label: '7', confidence: 0.99 }),
			reading({ detId: 'badge-1', label: '1868', confidence: 0.028 }),
			reading({ detId: 'badge-2', label: '13', confidence: 0.076 }),
			reading({ detId: 'badge-3', label: '17', confidence: 0.004 }),
			reading({ detId: 'badge-4', label: '17', confidence: 0.993 }),
			reading({ detId: 'badge-5', label: null, confidence: 0 })
		]);
		expect(countVerdicts(verdicts)).toEqual({
			total: 6,
			ok: 1,
			garbageLabel: 1,
			lowConfidence: 1,
			collision: 2,
			unread: 1
		});
	});
});
