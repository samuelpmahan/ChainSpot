/**
 * Coverage for `renderComposite.ts` (CHSPT-50/55): the pure per-pixel
 * compositor is deterministic given the same inputs (same `DraftComposite`
 * rendered twice produces byte-identical output), the pure-integer-
 * translation path is an exact copy (no resampling), and the nearest-
 * neighbour resampled path places rotated content where the transform says
 * it belongs.
 */
import { describe, expect, test } from 'vitest';
import { compositeDraftPixels, integerTranslationOf } from '../../src/lib/stitch/renderComposite';
import type { RgbaBuffer } from '../../src/lib/stitch/renderComposite';
import {
	buildSourceTransform,
	translationSourceTransform,
	AUTO_SOURCE_CAPTURE_ORIGIN
} from '../../src/lib/domain/provenance';
import type { DraftComposite, SourceCapture } from '../../src/lib/domain/provenance';

function solidBuffer(widthPx: number, heightPx: number, r: number, g: number, b: number): RgbaBuffer {
	const data = new Uint8ClampedArray(widthPx * heightPx * 4);
	for (let i = 0; i < widthPx * heightPx; i += 1) {
		data[i * 4] = r;
		data[i * 4 + 1] = g;
		data[i * 4 + 2] = b;
		data[i * 4 + 3] = 255;
	}
	return { widthPx, heightPx, data };
}

/** A buffer whose pixel value encodes its own (x, y) coordinate, so a resampled placement's exact source pixel can be checked directly. */
function coordinateBuffer(widthPx: number, heightPx: number): RgbaBuffer {
	const data = new Uint8ClampedArray(widthPx * heightPx * 4);
	for (let y = 0; y < heightPx; y += 1) {
		for (let x = 0; x < widthPx; x += 1) {
			const i = (y * widthPx + x) * 4;
			data[i] = x % 256;
			data[i + 1] = y % 256;
			data[i + 2] = 128;
			data[i + 3] = 255;
		}
	}
	return { widthPx, heightPx, data };
}

function makeSource(overrides: Partial<SourceCapture>): SourceCapture {
	return {
		sourceId: 's0',
		fileName: 'a.png',
		mimeType: 'image/png',
		widthPx: 40,
		heightPx: 30,
		sha256: '0'.repeat(64),
		crop: { xPx: 0, yPx: 0, widthPx: 40, heightPx: 30 },
		transform: translationSourceTransform(0, 0),
		origin: AUTO_SOURCE_CAPTURE_ORIGIN,
		coveragePolygon: [
			{ xPx: 0, yPx: 0 },
			{ xPx: 40, yPx: 0 },
			{ xPx: 40, yPx: 30 },
			{ xPx: 0, yPx: 30 }
		],
		paintOrder: 0,
		...overrides
	};
}

describe('compositeDraftPixels: determinism', () => {
	test('the same DraftComposite rendered twice produces byte-identical output', () => {
		const sourceA = makeSource({
			sourceId: 'a',
			transform: translationSourceTransform(0, 0),
			paintOrder: 0
		});
		const sourceB = makeSource({
			sourceId: 'b',
			crop: { xPx: 5, yPx: 5, widthPx: 30, heightPx: 20 },
			transform: buildSourceTransform('similarity', [
				Math.cos(0.4),
				Math.sin(0.4),
				-Math.sin(0.4),
				Math.cos(0.4),
				15,
				10
			]),
			coveragePolygon: [
				{ xPx: 15, yPx: 10 },
				{ xPx: 45, yPx: 10 },
				{ xPx: 45, yPx: 40 },
				{ xPx: 15, yPx: 40 }
			],
			paintOrder: 1
		});
		const draft: DraftComposite = {
			schemaVersion: 1,
			renderVersion: 'chainspot-stitch-v1',
			outputWidthPx: 60,
			outputHeightPx: 50,
			compositingPolicy: 'stitch-ascending-bottom-right-v1',
			resampling: 'nearest',
			sources: [sourceA, sourceB],
			overlaps: []
		};
		const pixels = new Map<string, RgbaBuffer>([
			['a', coordinateBuffer(40, 30)],
			['b', coordinateBuffer(40, 30)]
		]);

		const first = compositeDraftPixels(draft, pixels);
		const second = compositeDraftPixels(draft, pixels);

		expect(first.widthPx).toBe(60);
		expect(first.heightPx).toBe(50);
		expect(Array.from(first.data)).toEqual(Array.from(second.data));
	});
});

describe('compositeDraftPixels: pure-integer-translation path is an exact copy', () => {
	test('copies source pixels verbatim at the translated position, no resampling', () => {
		const source = makeSource({
			sourceId: 'only',
			crop: { xPx: 2, yPx: 3, widthPx: 10, heightPx: 8 },
			transform: translationSourceTransform(5, 7),
			coveragePolygon: [
				{ xPx: 7, yPx: 10 },
				{ xPx: 17, yPx: 10 },
				{ xPx: 17, yPx: 18 },
				{ xPx: 7, yPx: 18 }
			],
			paintOrder: 0
		});
		const draft: DraftComposite = {
			schemaVersion: 1,
			renderVersion: 'chainspot-stitch-v1',
			outputWidthPx: 20,
			outputHeightPx: 20,
			compositingPolicy: 'single-source-v1',
			resampling: 'none',
			sources: [source],
			overlaps: []
		};
		const pixels = new Map([['only', coordinateBuffer(40, 30)]]);
		const composite = compositeDraftPixels(draft, pixels);

		// Composite (7+dx=... ) -> source (2,3): crop top-left (2,3) lands at
		// (2+5, 3+7) = (7, 10).
		const destIndex = (10 * 20 + 7) * 4;
		expect(composite.data[destIndex]).toBe(2 % 256);
		expect(composite.data[destIndex + 1]).toBe(3 % 256);

		// A pixel outside the source's crop/placement stays untouched (fully transparent).
		const untouchedIndex = (0 * 20 + 0) * 4;
		expect(composite.data[untouchedIndex + 3]).toBe(0);
	});
});

describe('compositeDraftPixels: resampled (rotated) path places content correctly', () => {
	test('a source rotated 90deg lands its pixels where the transform predicts, nearest-neighbour', () => {
		// A 90-degree rotation about (0,0): xOut = -yIn, yOut = xIn, shifted so
		// nothing goes negative for a 40x30 source: xOut = -yIn + 30, yOut = xIn.
		const transform = buildSourceTransform('similarity', [0, 1, -1, 0, 30, 0]);
		const source = makeSource({
			sourceId: 'rot',
			crop: { xPx: 0, yPx: 0, widthPx: 40, heightPx: 30 },
			transform,
			coveragePolygon: [
				{ xPx: 30, yPx: 0 },
				{ xPx: 30, yPx: 40 },
				{ xPx: 0, yPx: 40 },
				{ xPx: 0, yPx: 0 }
			],
			paintOrder: 0
		});
		const draft: DraftComposite = {
			schemaVersion: 1,
			renderVersion: 'chainspot-stitch-v1',
			outputWidthPx: 30,
			outputHeightPx: 40,
			compositingPolicy: 'stitch-ascending-bottom-right-v1',
			resampling: 'nearest',
			sources: [source],
			overlaps: []
		};
		const pixels = new Map([['rot', coordinateBuffer(40, 30)]]);
		const composite = compositeDraftPixels(draft, pixels);

		// Forward: source point (10, 5) maps to composite (30 - 5, 10) = (25, 10).
		// The sampler sam ples at the DESTINATION pixel's own center via the
		// inverse transform (xIn = yOut, yIn = 30 - xOut for this rotation), so
		// composite pixel (25, 10)'s center (25.5, 10.5) maps back to source
		// (10.5, 4.5), which floors to (10, 4) -- one row up from the naive
		// forward-mapped (10, 5), exactly the expected pixel-center convention.
		const destIndex = (10 * 30 + 25) * 4;
		expect(composite.data[destIndex]).toBe(10);
		expect(composite.data[destIndex + 1]).toBe(4);
	});
});

describe('integerTranslationOf', () => {
	test('identifies exact integer pure translations and rejects everything else', () => {
		expect(integerTranslationOf(translationSourceTransform(3, -4))).toEqual({ dxPx: 3, dyPx: -4 });
		expect(integerTranslationOf(translationSourceTransform(3.5, 0))).toBeNull();
		expect(integerTranslationOf(buildSourceTransform('similarity', [0, 1, -1, 0, 0, 0]))).toBeNull();
	});
});
