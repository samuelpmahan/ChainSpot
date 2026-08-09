import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	deriveTeePadUiScalePx,
	filterSizeConsistentCandidates
} from '../../src/lib/autoAnnotation/teePadDetection';
import { asNumberTemplateScale, deriveUDiscCalibration } from '../../src/lib/autoAnnotation/cvCalibration';
import type { TeePadCandidate } from '../../src/lib/autoAnnotation/teePadDetection';

function pad(xPx: number, yPx: number, heightPx: number, widthPx = 24): TeePadCandidate {
	return {
		xPx,
		yPx,
		orientationDeg: 0,
		widthPx,
		heightPx,
		score: 0.9,
		support: ['edge-loop']
	};
}

describe('deriveUDiscCalibration', () => {
	it('converts a 53x41 number anchor to the canonical UDisc UI scale', () => {
		const anchor = { widthPx: 53, heightPx: 41, scale: asNumberTemplateScale(1) };
		expect(deriveUDiscCalibration(anchor).uiScalePx).toBeCloseTo(1.7746, 4);
	});

	it('preserves the low-level fallback when no number anchor exists', () => {
		expect(deriveTeePadUiScalePx(null, 1.85)).toBe(1.85);
		expect(deriveTeePadUiScalePx(undefined)).toBeUndefined();
	});

	it('ignores the number detector anchor scale', () => {
		const atOneAnchor = { widthPx: 53, heightPx: 41, scale: asNumberTemplateScale(1) };
		const atAnotherResizeAnchor = { widthPx: 53, heightPx: 41, scale: asNumberTemplateScale(9.5) };
		const atOne = deriveUDiscCalibration(atOneAnchor).uiScalePx;
		const atAnotherResize = deriveUDiscCalibration(atAnotherResizeAnchor).uiScalePx;
		expect(atAnotherResize).toBe(atOne);
	});

	it('routes every tee scale entry path through the shared helper', () => {
		const root = resolve(process.cwd());
		const entryPaths = [
			'src/lib/autoAnnotation/basketDetection.worker.ts',
			'scripts/detect-tees.ts',
			'src/routes/annotate-round/+page.svelte'
		];
		for (const entryPath of entryPaths) {
			const source = readFileSync(resolve(root, entryPath), 'utf8');
			expect(source, entryPath).toContain('deriveUDiscCalibration');
		}
		const workerSource = readFileSync(
			resolve(root, 'src/lib/autoAnnotation/basketDetection.worker.ts'),
			'utf8'
		);
		const cliSource = readFileSync(resolve(root, 'scripts/detect-tees.ts'), 'utf8');
		expect(workerSource).toMatch(
			/const calibration = deriveUDiscCalibration\(\s*\{/
		);
		expect(cliSource).not.toContain('detection.anchor?.scale');
	});
});

describe('filterSizeConsistentCandidates', () => {
	it('drops candidates about half the width of the rest of the set (C2 dash artifacts)', () => {
		// Real-fixture measurement: true pads cluster around heightPx ~15.5;
		// C2 putting-circle dash segments land around heightPx ~6-8, roughly
		// half that, despite otherwise passing the rectangle/aspect filters.
		const realPads = [
			pad(100, 100, 15.9),
			pad(200, 200, 15.6),
			pad(300, 300, 15.8),
			pad(400, 400, 15.5),
			pad(500, 500, 15.4)
		];
		const c2Dashes = [pad(150, 150, 6.4), pad(250, 250, 6.0), pad(350, 350, 7.8)];

		const filtered = filterSizeConsistentCandidates([...realPads, ...c2Dashes]);

		expect(filtered).toHaveLength(realPads.length);
		expect(filtered.every((candidate) => candidate.heightPx >= 10)).toBe(true);
	});

	it('leaves a too-small sample alone rather than guessing at a typical size', () => {
		const tooFewToJudge = [pad(0, 0, 15.5), pad(10, 10, 6)];
		expect(filterSizeConsistentCandidates(tooFewToJudge)).toHaveLength(2);
	});

	it('keeps consistently-sized candidates untouched', () => {
		const consistent = [pad(0, 0, 15.5), pad(10, 10, 15.4), pad(20, 20, 15.9), pad(30, 30, 15.6)];
		expect(filterSizeConsistentCandidates(consistent)).toHaveLength(4);
	});
});
