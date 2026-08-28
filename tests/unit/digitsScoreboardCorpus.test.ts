// Corpus-dependent acceptance fixture for `lab digits`: on the real
// AlexClark canonical raster. Originally pinned the pre-fix live
// GARBAGE-LABEL defects (badge-10 "1868"@~0.028, badge-16 "295"@~0.003).
// The G1 OCR fix contract (docs/seven-whys/g1-badge-digit-garbage.md,
// C1-C6) repairs both — badge-10 now reads "18"@~0.981, badge-16 reads
// "5"@~0.989, matching the fix's own repro (docs/CLAIMS-LEDGER.md row 25) —
// so this fixture is CONSCIOUSLY updated to assert the fixed, all-OK
// behavior rather than the defect it used to reproduce. Truth-free
// throughout — Annotation truth is never loaded here, only the detector's
// own digit read, exactly like a blind `lab digits` run.
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
	test('post-fix: detectBadges repairs badge-10 to "18"@~0.981 and badge-16 to "5"@~0.989, all 18 badges OK', async () => {
		const decoded = await decodeInput(ALEXCLARK_IMAGE);
		const badges = detectBadges(decoded.image);
		expect(badges).toHaveLength(18);

		const badge10 = badges.find((b) => b.detId === 'badge-10');
		const badge16 = badges.find((b) => b.detId === 'badge-16');
		expect(badge10?.label).toBe('18');
		expect(badge10?.confidence).toBeCloseTo(0.981, 2);
		expect(badge16?.label).toBe('5');
		expect(badge16?.confidence).toBeCloseTo(0.989, 2);

		const readings = badges.map((badge) => ({
			detId: badge.detId,
			label: badge.label,
			confidence: badge.confidence,
			...(badge.labelCandidates[1] ? { runnerUp: badge.labelCandidates[1] } : {})
		}));
		const verdicts = classifyBadges(readings);

		// Every badge on AlexClark now reads a valid, unique, confident label.
		expect(verdicts.every((v) => v.verdict === 'OK')).toBe(true);
	});
});
