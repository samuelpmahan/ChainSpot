import { describe, expect, it } from 'vitest';
import { evaluateTruth, parseArgs } from '../../scripts/detect-baskets';

describe('basket detection CLI', () => {
	it('parses the diagnostic scale override and output options', () => {
		expect(parseArgs([
			'GoldenBasketSet.chainspot.zip',
			'--out',
			'out',
			'--basket-scale',
			'2',
			'--map-top',
			'100',
			'--map-bottom',
			'900',
			'--max-candidates',
			'18',
			'--min-score',
			'0.5'
		])).toMatchObject({
			inputPath: 'GoldenBasketSet.chainspot.zip',
			outputDir: 'out',
			basketScale: 2,
			mapTopPx: 100,
			mapBottomPx: 900,
			maxCandidates: 18,
			minScore: 0.5
		});
	});

	it('scores one-to-one truth matches and reports false positives', () => {
		const result = evaluateTruth(
			[
				{ number: 1, xPx: 10, yPx: 10 },
				{ number: 2, xPx: 30, yPx: 30 }
			],
			[
				{ xPx: 10, yPx: 10, score: 0.9, widthPx: 27, heightPx: 41, scale: 1 },
				{ xPx: 30, yPx: 30, score: 0.8, widthPx: 27, heightPx: 41, scale: 1 },
				{ xPx: 100, yPx: 100, score: 0.7, widthPx: 27, heightPx: 41, scale: 1 }
			],
			2
		);
		expect(result).toMatchObject({
			tolerancePx: 2,
			truthCount: 2,
			matchedNumbers: [1, 2],
			missedNumbers: [],
			falsePositiveCount: 1
		});
	});

	it('requires paired map bounds', () => {
		expect(() => parseArgs([
			'image.png',
			'--out',
			'out',
			'--map-top',
			'100'
		])).toThrow('--map-top and --map-bottom must be provided together');
	});
});
