import { describe, expect, it } from 'vitest';
import { annotatedSourceImageFromAsset, createAnnotatedRound } from '../../src/lib/domain/annotatedRound';
import type { AnnotatedSourceImage } from '../../src/lib/domain/annotatedRound';
import { createImageAsset } from '../../src/lib/domain/project';
import { applySourceTransform, AUTO_SOURCE_CAPTURE_ORIGIN, identitySourceTransform } from '../../src/lib/domain/provenance';
import type { CompositeProvenance, SourceCapture, SourceCropRect } from '../../src/lib/domain/provenance';

/** A minimal, coherent single-source provenance fixture. */
function provenanceFixture(overrides: Partial<CompositeProvenance> = {}): CompositeProvenance {
	const transform = identitySourceTransform();
	const crop: SourceCropRect = { xPx: 0, yPx: 0, widthPx: 100, heightPx: 100 };
	const source: SourceCapture = {
		sourceId: 'capture-1',
		fileName: 'udisc-1.png',
		mimeType: 'image/png',
		widthPx: 100,
		heightPx: 100,
		sha256: 'b'.repeat(64),
		crop,
		transform,
		origin: AUTO_SOURCE_CAPTURE_ORIGIN,
		coveragePolygon: [
			{ xPx: crop.xPx, yPx: crop.yPx },
			{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx },
			{ xPx: crop.xPx + crop.widthPx, yPx: crop.yPx + crop.heightPx },
			{ xPx: crop.xPx, yPx: crop.yPx + crop.heightPx }
		].map((corner) => applySourceTransform(corner, transform)),
		paintOrder: 0
	};
	return {
		schemaVersion: 1,
		renderVersion: 'chainspot-stitch-v1',
		outputWidthPx: 100,
		outputHeightPx: 100,
		compositingPolicy: 'single-source-v1',
		resampling: 'none',
		sources: [source],
		overlaps: [],
		finalRasterSha256: 'a'.repeat(64),
		...overrides
	};
}

function sourceImageOf(widthPx: number, heightPx: number): AnnotatedSourceImage {
	return {
		fileName: 'udisc-source.png',
		mimeType: 'image/png',
		widthPx,
		heightPx,
		blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })
	};
}

describe('createAnnotatedRound', () => {
	it('produces empty holes and undefined walkingPath, carrying the source image verbatim, when no features are supplied', () => {
		const sourceImage = sourceImageOf(1200, 800);
		const round = createAnnotatedRound({ sourceImage });

		expect(round.holes).toEqual([]);
		expect(round.walkingPath).toBeUndefined();
		expect(round.sourceImage).toBe(sourceImage);
		expect(round.sourceImage.fileName).toBe('udisc-source.png');
		expect(round.sourceImage.mimeType).toBe('image/png');
		expect(round.sourceImage.widthPx).toBe(1200);
		expect(round.sourceImage.heightPx).toBe(800);
		expect(round.sourceImage.blob).toBeInstanceOf(Blob);
	});

	it('throws for a non-finite feature coordinate and for a feature point outside the source image bounds', () => {
		const sourceImage = sourceImageOf(100, 100);

		expect(() =>
			createAnnotatedRound({
				sourceImage,
				holes: [
					{
						id: 'hole-1',
						number: 1,
						tee: { xPx: Number.NaN, yPx: 10 },
						shots: [],
						corridorBends: [],
						corridorWidthPx: 60
					}
				]
			})
		).toThrow();

		expect(() =>
			createAnnotatedRound({
				sourceImage,
				holes: [
					{
						id: 'hole-1',
						number: 1,
						basket: { xPx: 50, yPx: 50 },
						shots: [{ id: 'shot-1', landing: { xPx: 150, yPx: 50 } }],
						corridorBends: [],
						corridorWidthPx: 60
					}
				]
			})
		).toThrow();
	});

	it('accepts a straight hole with zero corridor bends and a positive width', () => {
		const sourceImage = sourceImageOf(200, 200);

		const round = createAnnotatedRound({
			sourceImage,
			holes: [
				{
					id: 'hole-1',
					number: 1,
					shots: [],
					corridorBends: [],
					corridorWidthPx: 60
				}
			]
		});

		expect(round.holes[0].corridorBends).toEqual([]);
		expect(round.holes[0].corridorWidthPx).toBe(60);
	});

	it('accepts a dogleg with in-bounds corridor bends', () => {
		const sourceImage = sourceImageOf(200, 200);
		const corridorBends = [
			{ xPx: 10, yPx: 10 },
			{ xPx: 60, yPx: 60 }
		];

		const round = createAnnotatedRound({
			sourceImage,
			holes: [{ id: 'hole-1', number: 1, shots: [], corridorBends, corridorWidthPx: 40 }]
		});

		expect(round.holes[0].corridorBends).toEqual(corridorBends);
	});

	it('throws for a corridor bend outside the source image bounds', () => {
		const sourceImage = sourceImageOf(100, 100);

		expect(() =>
			createAnnotatedRound({
				sourceImage,
				holes: [
					{
						id: 'hole-1',
						number: 1,
						shots: [],
						corridorBends: [
							{ xPx: 10, yPx: 10 },
							{ xPx: 60, yPx: 999 }
						],
						corridorWidthPx: 40
					}
				]
			})
		).toThrow();
	});

	it('throws for a non-positive or non-finite corridor width', () => {
		const sourceImage = sourceImageOf(100, 100);

		expect(() =>
			createAnnotatedRound({
				sourceImage,
				holes: [{ id: 'hole-1', number: 1, shots: [], corridorBends: [], corridorWidthPx: 0 }]
			})
		).toThrow(/corridorWidthPx/);

		expect(() =>
			createAnnotatedRound({
				sourceImage,
				holes: [{ id: 'hole-1', number: 1, shots: [], corridorBends: [], corridorWidthPx: Number.NaN }]
			})
		).toThrow(/corridorWidthPx/);
	});

	it('carries a coherent provenance across the Done boundary verbatim', () => {
		const provenance = provenanceFixture();
		const round = createAnnotatedRound({ sourceImage: { ...sourceImageOf(100, 100), provenance } });
		expect(round.sourceImage.provenance).toBe(provenance);
	});

	it('produces no provenance key when the source image carries none', () => {
		const round = createAnnotatedRound({ sourceImage: sourceImageOf(100, 100) });
		expect(round.sourceImage.provenance).toBeUndefined();
	});

	it('throws (fails loudly) at the Done boundary for structurally incoherent provenance', () => {
		const incoherent = provenanceFixture({
			overlaps: [{ a: 'capture-1', b: 'unknown-source', kind: 'placement-edge', score: 0.5 }]
		});
		expect(() =>
			createAnnotatedRound({ sourceImage: { ...sourceImageOf(100, 100), provenance: incoherent } })
		).toThrow(/unknown source/);
	});
});

describe('annotatedSourceImageFromAsset', () => {
	function sourceAsset(overrides: Partial<Parameters<typeof createImageAsset>[0]> = {}) {
		return createImageAsset({
			role: 'source-overview',
			fileName: 'udisc-overview.png',
			mimeType: 'image/png',
			widthPx: 100,
			heightPx: 100,
			id: 'asset-1',
			...overrides
		});
	}

	it('carries provenance through when the asset has it', () => {
		const provenance = provenanceFixture();
		const asset = sourceAsset({ provenance });
		const image = annotatedSourceImageFromAsset(asset, new Uint8Array([1, 2, 3]));
		expect(image.provenance).toEqual(provenance);
	});

	it('produces no provenance key when the asset has none, or has it explicitly null', () => {
		const withoutProvenance = annotatedSourceImageFromAsset(sourceAsset(), new Uint8Array([1]));
		expect('provenance' in withoutProvenance).toBe(false);

		const withNullProvenance = annotatedSourceImageFromAsset(
			sourceAsset({ provenance: null }),
			new Uint8Array([1])
		);
		expect('provenance' in withNullProvenance).toBe(false);
	});
});
