import { describe, expect, it } from 'vitest';
import {
	applyTunedScorer,
	buildLocalNeighborhoods,
	computeAuc,
	greedySearchCombination,
	scoreMetricDiscrimination
} from '../../src/lib/autoAnnotation/teeMetricSearch';
import type { MetricSample } from '../../src/lib/autoAnnotation/teeMetricSearch';

function sample(
	label: MetricSample['label'],
	xPx: number,
	yPx: number,
	metrics: Record<string, number>,
	holeNumber?: number
): MetricSample {
	return { label, xPx, yPx, metrics, holeNumber };
}

describe('computeAuc', () => {
	it('is 1 for perfectly separated populations and 0.5 for chance', () => {
		expect(computeAuc([3, 4, 5], [0, 1, 2])).toBe(1);
		expect(computeAuc([0, 1, 2], [3, 4, 5])).toBe(0);
		expect(computeAuc([1, 2], [1, 2])).toBe(0.5);
	});

	it('counts ties as half wins', () => {
		expect(computeAuc([1], [1])).toBe(0.5);
	});
});

describe('buildLocalNeighborhoods', () => {
	it('collects only non-truth samples within the radius of each truth sample', () => {
		const samples = [
			sample('truth', 0, 0, {}, 1),
			sample('distractor', 5, 0, {}),
			sample('distractor', 100, 0, {}),
			sample('hard-negative', 0, 8, {}),
			sample('truth', 200, 200, {}, 2)
		];
		const neighborhoods = buildLocalNeighborhoods(samples, 10);
		expect(neighborhoods).toHaveLength(2);
		expect(neighborhoods[0].truthIndex).toBe(0);
		expect(neighborhoods[0].distractorIndices).toEqual([1, 3]);
		expect(neighborhoods[1].distractorIndices).toEqual([]);
	});
});

describe('scoreMetricDiscrimination', () => {
	it('reports a separating metric with AUC 1 and all local ranks 1', () => {
		const samples = [
			sample('truth', 0, 0, { good: 10, noise: 0.4 }, 1),
			sample('truth', 50, 0, { good: 11, noise: 0.6 }, 2),
			sample('distractor', 4, 0, { good: 2, noise: 0.5 }),
			sample('hard-negative', 52, 0, { good: 1, noise: 0.5 })
		];
		const neighborhoods = buildLocalNeighborhoods(samples, 10);
		const reports = scoreMetricDiscrimination(['good', 'noise'], samples, neighborhoods);
		expect(reports[0].name).toBe('good');
		expect(reports[0].aucAll).toBe(1);
		expect(reports[0].aucHardNegatives).toBe(1);
		expect(reports[0].higherIsTruth).toBe(true);
		expect(reports[0].localRanks.map((entry) => entry.rank)).toEqual([1, 1]);
	});

	it('orientation-corrects metrics where truth scores lower', () => {
		const samples = [
			sample('truth', 0, 0, { inverted: 1 }, 1),
			sample('truth', 50, 0, { inverted: 2 }, 2),
			sample('distractor', 4, 0, { inverted: 9 }),
			sample('distractor', 54, 0, { inverted: 8 })
		];
		const neighborhoods = buildLocalNeighborhoods(samples, 10);
		const reports = scoreMetricDiscrimination(['inverted'], samples, neighborhoods);
		expect(reports[0].higherIsTruth).toBe(false);
		expect(reports[0].aucAll).toBe(1);
		expect(reports[0].localRanks.map((entry) => entry.rank)).toEqual([1, 1]);
	});
});

describe('greedySearchCombination', () => {
	it('finds a single separating metric and a threshold between the classes', () => {
		const samples = [
			sample('truth', 0, 0, { good: 10, junk: 5 }, 1),
			sample('truth', 50, 0, { good: 12, junk: -3 }, 2),
			sample('distractor', 4, 0, { good: 2, junk: 4 }),
			sample('distractor', 54, 0, { good: 3, junk: -2 }),
			sample('hard-negative', 6, 2, { good: 1, junk: 5 })
		];
		const neighborhoods = buildLocalNeighborhoods(samples, 10);
		const scorer = greedySearchCombination(['good', 'junk'], samples, neighborhoods);
		expect(scorer.metrics.length).toBeGreaterThan(0);
		expect(scorer.metrics[0].name).toBe('good');
		expect(scorer.minLocalMargin).toBeGreaterThan(0);
		for (const truth of samples.filter((entry) => entry.label === 'truth')) {
			expect(applyTunedScorer(scorer, truth.metrics)).toBeGreaterThanOrEqual(scorer.threshold);
		}
		for (const other of samples.filter((entry) => entry.label !== 'truth')) {
			expect(applyTunedScorer(scorer, other.metrics)).toBeLessThan(scorer.threshold);
		}
	});

	it('prioritizes the margin of required holes', () => {
		// "special" separates hole 5 cleanly but is noisy elsewhere; "general"
		// separates every hole except 5. Requiring hole 5 must select "special".
		const samples = [
			sample('truth', 0, 0, { general: 10, special: 1 }, 1),
			sample('truth', 100, 0, { general: 0, special: 10 }, 5),
			sample('distractor', 5, 0, { general: 5, special: 0.5 }),
			sample('distractor', 103, 0, { general: 5, special: 2 })
		];
		const neighborhoods = buildLocalNeighborhoods(samples, 10);
		const scorer = greedySearchCombination(['general', 'special'], samples, neighborhoods, {
			requiredHoleNumbers: [5],
			maxMetrics: 1
		});
		expect(scorer.metrics[0].name).toBe('special');
	});

	it('returns negative-infinity score for samples with missing metrics', () => {
		const scorer = {
			metrics: [{ name: 'good', weight: 1, mean: 0, std: 1 }],
			threshold: 0,
			minLocalMargin: 0
		};
		expect(applyTunedScorer(scorer, {})).toBe(Number.NEGATIVE_INFINITY);
	});
});
