import { describe, expect, it } from 'vitest';
import { createAnnotatedRound } from '../../src/lib/domain/annotatedRound';
import type { AnnotatedSourceImage } from '../../src/lib/domain/annotatedRound';

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
						shots: []
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
						shots: [{ id: 'shot-1', landing: { xPx: 150, yPx: 50 } }]
					}
				]
			})
		).toThrow();
	});
});
