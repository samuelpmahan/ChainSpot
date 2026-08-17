import { describe, expect, test } from 'vitest';
import {
	clampFloatingRect,
	deriveBadgeAlignmentWitnesses,
	imagePointPercent,
	screenDeltaToImageDelta,
	translateDraftSource
} from '../../src/lib/stitch/alignmentReview';
import {
	applySourceTransform,
	buildSourceTransform,
	CURRENT_PROVENANCE_SCHEMA_VERSION,
	CURRENT_RENDER_VERSION
} from '../../src/lib/domain/provenance';
import type { DraftComposite, SourceCapture, SourceTransform } from '../../src/lib/domain/provenance';

function source(
	sourceId: string,
	transform: SourceTransform,
	paintOrder: number,
	widthPx = 100,
	heightPx = 100
): SourceCapture {
	const crop = { xPx: 0, yPx: 0, widthPx, heightPx };
	const corners = [
		{ xPx: 0, yPx: 0 },
		{ xPx: widthPx, yPx: 0 },
		{ xPx: widthPx, yPx: heightPx },
		{ xPx: 0, yPx: heightPx }
	] as const;
	return {
		sourceId,
		fileName: `${sourceId}.png`,
		mimeType: 'image/png',
		widthPx,
		heightPx,
		sha256: sourceId.padEnd(64, '0').slice(0, 64),
		crop,
		transform,
		origin: { crop: 'auto', transform: 'auto' },
		coveragePolygon: corners.map((point) => applySourceTransform(point, transform)),
		paintOrder
	};
}

function draft(sources: readonly SourceCapture[], widthPx = 200, heightPx = 100): DraftComposite {
	return {
		schemaVersion: CURRENT_PROVENANCE_SCHEMA_VERSION,
		renderVersion: CURRENT_RENDER_VERSION,
		outputWidthPx: widthPx,
		outputHeightPx: heightPx,
		compositingPolicy: sources.length === 1 ? 'single-source-v1' : 'stitch-ascending-bottom-right-v1',
		resampling: sources.every((item) => item.transform.model === 'translation') ? 'none' : 'nearest',
		sources,
		overlaps: []
	};
}

describe('alignment review image plane', () => {
	test('uses HoleNumberCandidate xPx/yPx as the physical badge center without adding half the box again', () => {
		expect(imagePointPercent({ xPx: 100, yPx: 200 }, 1000, 500)).toEqual({
			leftPct: 10,
			topPct: 40
		});
	});

	test('maps pointer Y through the full rendered plane even when an outer viewport would be shorter', () => {
		// 1000x3000 raster rendered 500x1500; an outer 600px-high viewport may clip it,
		// but a 300px pointer delta still corresponds to 600 image pixels.
		expect(screenDeltaToImageDelta({ xPx: 0, yPx: 300 }, { widthPx: 500, heightPx: 1500 }, 1000, 3000)).toEqual({
			xPx: 0,
			yPx: 600
		});
	});

	test('stays registered after responsive plane resizing', () => {
		const before = screenDeltaToImageDelta({ xPx: 150, yPx: 450 }, { widthPx: 500, heightPx: 1500 }, 1000, 3000);
		const after = screenDeltaToImageDelta({ xPx: 90, yPx: 270 }, { widthPx: 300, heightPx: 900 }, 1000, 3000);
		expect(before).toEqual({ xPx: 300, yPx: 900 });
		expect(after).toEqual(before);
	});
});

describe('translateDraftSource', () => {
	test('moves the first source and preserves rotation/scale/shear coefficients', () => {
		const firstTransform = buildSourceTransform('affine', [1.1, 0.08, -0.04, 0.95, 0, 0]);
		const secondTransform = buildSourceTransform('translation', [1, 0, 0, 1, 120, 0]);
		const initial = draft([source('source-0', firstTransform, 0), source('source-1', secondTransform, 1)], 220, 104);

		const moved = translateDraftSource(initial, 'source-0', { xPx: 17, yPx: 9 });
		const movedFirst = moved.sources.find((item) => item.sourceId === 'source-0')!;
		const movedSecond = moved.sources.find((item) => item.sourceId === 'source-1')!;

		expect(movedFirst.transform.coefficients.slice(0, 4)).toEqual(firstTransform.coefficients.slice(0, 4));
		expect(movedFirst.transform.model).toBe('affine');
		expect(movedFirst.origin.transform).toBe('manual');
		expect(movedSecond.origin.transform).toBe('auto');
		// Normalization may translate every source together, but relative placement must change by the requested delta.
		const beforeRelativeX = secondTransform.coefficients[4] - firstTransform.coefficients[4];
		const afterRelativeX = movedSecond.transform.coefficients[4] - movedFirst.transform.coefficients[4];
		expect(afterRelativeX).toBeCloseTo(beforeRelativeX - 17, 8);
	});

	test('moving either source changes the normalized manual composite geometry', () => {
		const a = source('a', buildSourceTransform('translation', [1, 0, 0, 1, 0, 0]), 0);
		const b = source('b', buildSourceTransform('translation', [1, 0, 0, 1, 80, 0]), 1);
		const initial = draft([a, b], 180, 100);
		const movedA = translateDraftSource(initial, 'a', { xPx: 20, yPx: 0 });
		const movedB = translateDraftSource(initial, 'b', { xPx: 20, yPx: 0 });
		expect(movedA.sources.map((item) => item.transform.coefficients[4])).not.toEqual(
			initial.sources.map((item) => item.transform.coefficients[4])
		);
		expect(movedB.outputWidthPx).toBe(200);
	});
});

describe('badge alignment witnesses', () => {
	test('uses exact stitch source transforms and keeps only shared numbered badges', () => {
		const leftTransform = buildSourceTransform('translation', [1, 0, 0, 1, 0, 0]);
		const rightTransform = buildSourceTransform('similarity', [0.999, 0.01, -0.01, 0.999, 530, -15]);
		const current = draft([
			source('left', leftTransform, 0, 1179, 2556),
			source('right', rightTransform, 1, 1179, 2556)
		], 1709, 2571);
		const witnesses = deriveBadgeAlignmentWitnesses(current, [
			{ sourceId: 'left', holeNumber: 5, xPx: 894, yPx: 1200, widthPx: 91, heightPx: 53, confidence: 0.98 },
			{ sourceId: 'right', holeNumber: 5, xPx: 364, yPx: 1215, widthPx: 93, heightPx: 54, confidence: 0.96 },
			{ sourceId: 'left', holeNumber: 8, xPx: 893, yPx: 1609, widthPx: 92, heightPx: 53, confidence: 0.97 },
			{ sourceId: 'right', holeNumber: 8, xPx: 365, yPx: 1625, widthPx: 91, heightPx: 52, confidence: 0.95 },
			{ sourceId: 'left', holeNumber: 9, xPx: 400, yPx: 1800, widthPx: 90, heightPx: 52, confidence: 0.99 }
		]);

		expect(witnesses.map((witness) => witness.holeNumber)).toEqual([5, 8]);
		expect(witnesses[0].layers[0].sourceTransform).toBe(leftTransform);
		expect(witnesses[0].layers[1].sourceTransform).toBe(rightTransform);
		expect(witnesses[0].layers.every((layer) => layer.opacity === 0.5)).toBe(true);
	});

	test('limits larger capture sets to the strongest requested witness count', () => {
		const transforms = [0, 1, 2].map((index) => buildSourceTransform('translation', [1, 0, 0, 1, index * 10, 0]));
		const current = draft(transforms.map((transform, index) => source(`s${index}`, transform, index)), 120, 100);
		const observations = [1, 2, 3].flatMap((holeNumber) => [0, 1].map((sourceIndex) => ({
			sourceId: `s${sourceIndex}`,
			holeNumber,
			xPx: holeNumber * 10,
			yPx: 20,
			widthPx: 20,
			heightPx: 12,
			confidence: 1 - holeNumber * 0.01
		})));
		expect(deriveBadgeAlignmentWitnesses(current, observations, 2)).toHaveLength(2);
	});
});

describe('floating HUD', () => {
	test('clamps transient HUD position inside the usable viewport', () => {
		expect(
			clampFloatingRect({ xPx: 900, yPx: -30 }, { widthPx: 180, heightPx: 90 }, { widthPx: 1000, heightPx: 700 })
		).toEqual({ xPx: 812, yPx: 8 });
	});
});
