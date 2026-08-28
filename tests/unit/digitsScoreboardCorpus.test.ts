// Corpus-dependent acceptance fixture for `lab digits`: on the real
// AlexClark canonical raster, the fast public detectBadges seam must keep
// reproducing its two known live GARBAGE-LABEL defects (badge-10 "1868",
// badge-16 "295"), and the scoreboard's classifyBadges must label them
// correctly. Truth-free throughout — Annotation truth is never loaded here,
// only the detector's own digit read, exactly like a blind `lab digits` run.
//
// Skips cleanly when the corpus isn't hydrated, matching the
// describe.skipIf(!existsSync(...)) pattern in
// tests/unit/straightTestAcceptance.test.ts.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { detectBadges } from '@chainspot/alg/detectors/threeFactor/measure';
import { decodeInput } from '../../scripts/chainspot-lab/sweep/inputShim';
import { classifyBadges } from '../../scripts/chainspot-lab/scoreboard/verdict';

const REPO_ROOT = resolve(__dirname, '../..');
const CORPUS_ROOT = resolve(REPO_ROOT, '../chainspot-corpus');
const ALEXCLARK_IMAGE = resolve(CORPUS_ROOT, 'dev/AlexClark/AlexClark-full.jpg');

describe.skipIf(!existsSync(ALEXCLARK_IMAGE))('lab digits — AlexClark live-defect fixture (corpus)', () => {
	test('detectBadges reproduces badge-10 "1868"@~0.028 and badge-16 "295"@~0.003, both classified GARBAGE-LABEL', async () => {
		const decoded = await decodeInput(ALEXCLARK_IMAGE);
		const badges = detectBadges(decoded.image);
		expect(badges).toHaveLength(18);

		const badge10 = badges.find((b) => b.detId === 'badge-10');
		const badge16 = badges.find((b) => b.detId === 'badge-16');
		expect(badge10?.label).toBe('1868');
		expect(badge10?.confidence).toBeCloseTo(0.028, 2);
		expect(badge16?.label).toBe('295');
		expect(badge16?.confidence).toBeCloseTo(0.003, 2);

		const readings = badges.map((badge) => ({
			detId: badge.detId,
			label: badge.label,
			confidence: badge.confidence,
			...(badge.labelCandidates[1] ? { runnerUp: badge.labelCandidates[1] } : {})
		}));
		const verdicts = classifyBadges(readings);
		const byId = new Map(verdicts.map((v) => [v.detId, v]));
		expect(byId.get('badge-10')?.verdict).toBe('GARBAGE-LABEL');
		expect(byId.get('badge-16')?.verdict).toBe('GARBAGE-LABEL');

		// Every other badge on AlexClark reads a valid, unique, confident label.
		const others = verdicts.filter((v) => v.detId !== 'badge-10' && v.detId !== 'badge-16');
		expect(others.every((v) => v.verdict === 'OK')).toBe(true);
	});
});
