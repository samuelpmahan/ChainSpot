import { describe, expect, it } from 'vitest';
import {
	formatDisplayNumber,
	formatNormalized,
	formatPixel,
	sideDisplay
} from '../../src/lib/pointListFormat';
import { createImageAsset } from '../../src/lib/domain/project';

describe('P0-009 point list formatting', () => {
	it('formats pixel and normalized display values consistently without rounding the source', () => {
		expect(formatPixel(748.25)).toBe('748.25');
		expect(formatPixel(20)).toBe('20');
		expect(formatPixel(0.5)).toBe('0.5');
		expect(formatPixel(1.5)).toBe('1.5');
		expect(formatPixel(2.0)).toBe('2');
		expect(formatNormalized(0.634648)).toBe('0.6346');
		expect(formatNormalized(0.5)).toBe('0.5');
		expect(formatNormalized(1)).toBe('1');
		expect(formatDisplayNumber(Infinity, 2)).toBe('–');
		expect(formatDisplayNumber(NaN, 2)).toBe('–');
	});

	it('derives normalized values from each referenced image intrinsic dimensions', () => {
		const source = createImageAsset({
			id: 'src',
			role: 'source-overview',
			fileName: 's.png',
			mimeType: 'image/png',
			widthPx: 200,
			heightPx: 100
		});
		const target = createImageAsset({
			id: 'tgt',
			role: 'target-basemap',
			fileName: 't.jpg',
			mimeType: 'image/jpeg',
			widthPx: 400,
			heightPx: 50
		});
		const display = sideDisplay({ imageId: 'src', xPx: 50, yPx: 25 }, source);
		expect(display.xPx).toBe('50');
		expect(display.yPx).toBe('25');
		expect(display.xNorm).toBe('0.25');
		expect(display.yNorm).toBe('0.25');

		const targetDisplay = sideDisplay({ imageId: 'tgt', xPx: 100, yPx: 25 }, target);
		expect(targetDisplay.xNorm).toBe('0.25');
		expect(targetDisplay.yNorm).toBe('0.5');
	});

	it('derives correct normalized values for fractional pixels across different dimensions', () => {
		const a = createImageAsset({
			id: 'a',
			role: 'source-overview',
			fileName: 'a.png',
			mimeType: 'image/png',
			widthPx: 1000,
			heightPx: 500
		});
		const b = createImageAsset({
			id: 'b',
			role: 'target-basemap',
			fileName: 'b.png',
			mimeType: 'image/png',
			widthPx: 750,
			heightPx: 300
		});
		const da = sideDisplay({ imageId: 'a', xPx: 250.5, yPx: 125.25 }, a);
		const db = sideDisplay({ imageId: 'b', xPx: 375.25, yPx: 149.5 }, b);
		expect(da.xNorm).toBe('0.2505');
		expect(da.yNorm).toBe('0.2505');
		expect(db.xNorm).toBe('0.5003');
		expect(db.yNorm).toBe('0.4983');
	});

	it('renders a placeholder when the referenced image is missing', () => {
		const display = sideDisplay({ imageId: 'missing', xPx: 1, yPx: 2 }, undefined);
		expect(display).toEqual({ xPx: '–', yPx: '–', xNorm: '–', yNorm: '–' });
	});
});
