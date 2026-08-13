import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('worker and diagnostic CLI course-pipeline parity', () => {
	const root = process.cwd();
	const worker = readFileSync(resolve(root, 'src/lib/autoAnnotation/basketDetection.worker.ts'), 'utf8');
	const cli = readFileSync(resolve(root, 'scripts/detect-course.ts'), 'utf8');

	it('keeps the stitched badge surplus pool in both entry points', () => {
		expect(worker).toContain('{ maxCandidates: 24 }');
		expect(cli).toContain('{ maxCandidates: 24 }');
	});

	it('derives map bounds from labeled badges only', () => {
		expect(worker).toContain('const labeled = candidates.filter((candidate) => candidate.label !== undefined)');
		expect(cli).toContain('deriveMapBounds(numberDetection.candidates.filter((candidate) => candidate.label !== undefined)');
	});

	it('uses world-normalized tee bootstrap and the same scaled basket grading in both paths', () => {
		expect(worker).toContain('detectWorldNormalizedTeeBootstrap(');
		expect(cli).toContain('detectWorldNormalizedTeeBootstrap(');
		expect(worker).toContain('deriveBasketPolarityPenaltyPx(numberBadges, primaryBaskets)');
		expect(cli).toContain('deriveBasketPolarityPenaltyPx(numberBadges, primaryBasketCandidates)');
	});
});
