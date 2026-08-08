import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../scripts/detect-tees';
import {
	detectOccludedEdgeLoopCandidates
} from '../../src/lib/autoAnnotation/teePadDetection';
import type { TeePadCv } from '../../src/lib/autoAnnotation/teePadDetection';

describe('tee detection CLI arguments', () => {
	it('accepts all staged modes and repeatable ignore circles', () => {
		expect(
			parseArgs([
				'GoldenTeeSet.chainspot.zip',
				'--mode',
				'occluded-edge-loop',
				'--out',
				'out',
				'--ignore-circle',
				'100,200,50',
				'--ignore-circle',
				'300,400,50'
			])
		).toMatchObject({
			inputPath: 'GoldenTeeSet.chainspot.zip',
			mode: 'occluded-edge-loop',
			outputDir: 'out',
			ignoreCirclesPx: [
				{ xPx: 100, yPx: 200, radiusPx: 50 },
				{ xPx: 300, yPx: 400, radiusPx: 50 }
			]
		});
	});

	it('rejects a mask on normal detector modes', () => {
		expect(() =>
			parseArgs(['image.png', '--mode', 'edge-loop', '--out', 'out', '--ignore-circle', '1,2,3'])
		).toThrow('--ignore-circle is only valid');
	});

	it('requires explicit map bounds as a pair', () => {
		expect(() =>
			parseArgs(['image.png', '--mode', 'occluded-edge-loop', '--out', 'out', '--map-top', '100'])
		).toThrow('--map-top and --map-bottom must be provided together');
	});
});

describe('occluded edge loop detector', () => {
	it('accepts two open parallel rails without requiring a closed contour', () => {
		class FakeMat {
			readonly rows: number;
			readonly cols: number;
			readonly data: Uint8Array;
			data32S?: Int32Array;

			constructor(rows = 0, cols = 0) {
				this.rows = rows;
				this.cols = cols;
				this.data = new Uint8Array(Math.max(0, rows * cols));
			}

			delete(): void {}
		}

		const cv = {
			Mat: FakeMat,
			MatVector: class {},
			Size: class {
				constructor(readonly width: number, readonly height: number) {}
			},
			CV_8UC1: 0,
			RETR_LIST: 0,
			CHAIN_APPROX_SIMPLE: 0,
			BORDER_DEFAULT: 0,
			GaussianBlur: () => {},
			Canny: () => {},
			HoughLinesP: (_edges: unknown, lines: FakeMat) => {
				lines.data32S = new Int32Array([20, 20, 38, 20, 20, 26, 38, 26]);
			}
		} as unknown as TeePadCv;

		const raster = {
			rgba: new Uint8Array(80 * 80 * 4).fill(255),
			widthPx: 80,
			heightPx: 80,
			sourceScale: 1
		};
		const result = detectOccludedEdgeLoopCandidates(cv, raster, { uiScalePx: 1 });

		expect(result.variant).toBe('occluded-edge-loop');
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0]).toMatchObject({
			xPx: 29,
			yPx: 23,
			widthPx: 18,
			heightPx: 6,
			support: ['occluded-edge-loop']
		});
		expect(result.stageCounts.geometry).toBe(1);
	});
});
