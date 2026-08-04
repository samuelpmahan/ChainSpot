import { describe, expect, it } from 'vitest';
import {
	MAGNIFIER_GAP_PX,
	MAGNIFIER_MIN_IMAGE_SCALE,
	MAGNIFIER_SIZE,
	MAGNIFIER_VIEW_ZOOM_FACTOR,
	CROSSHAIR_DARK,
	CROSSHAIR_LIGHT,
	drawMagnifier,
	magnifierBoxPosition,
	magnifierDisplayScale,
	magnifierSampling
} from '../../src/lib/magnifier';
import type { Canvas2DLike } from '../../src/lib/magnifier';

class RecordingContext implements Canvas2DLike {
	strokeStyle: string | CanvasGradient | CanvasPattern = '';
	lineWidth = 1;
	calls: Array<Record<string, unknown>> = [];

	setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
		this.calls.push({ type: 'setTransform', args: [a, b, c, d, e, f] });
	}

	clearRect(x: number, y: number, width: number, height: number): void {
		this.calls.push({ type: 'clearRect', args: [x, y, width, height] });
	}

	drawImage(
		image: CanvasImageSource,
		sx: number,
		sy: number,
		sw: number,
		sh: number,
		dx: number,
		dy: number,
		dw: number,
		dh: number
	): void {
		this.calls.push({ type: 'drawImage', image, args: [sx, sy, sw, sh, dx, dy, dw, dh] });
	}

	beginPath(): void {
		this.calls.push({ type: 'beginPath' });
	}

	moveTo(x: number, y: number): void {
		this.calls.push({ type: 'moveTo', args: [x, y] });
	}

	lineTo(x: number, y: number): void {
		this.calls.push({ type: 'lineTo', args: [x, y] });
	}

	stroke(): void {
		this.calls.push({ type: 'stroke', style: this.strokeStyle, width: this.lineWidth });
	}
}

describe('P0-012 magnifier display scale', () => {
	it('keeps at least the documented minimum and at least twice the view detail', () => {
		expect(MAGNIFIER_MIN_IMAGE_SCALE).toBe(4);
		expect(MAGNIFIER_VIEW_ZOOM_FACTOR).toBe(2);
		expect(magnifierDisplayScale(0.5)).toBe(4);
		expect(magnifierDisplayScale(1)).toBe(4);
		expect(magnifierDisplayScale(2)).toBe(4);
		expect(magnifierDisplayScale(3)).toBe(6);
		expect(magnifierDisplayScale(10)).toBe(20);
		expect(() => magnifierDisplayScale(0)).toThrow();
		expect(() => magnifierDisplayScale(NaN)).toThrow();
	});
});

describe('P0-012 magnifier sampling against known fixtures', () => {
	it('pins the tiny.png fixture (2x3) to the whole image with the exact anchor offset', () => {
		// tiny.png is the repository's documented 2x3 solid fixture.
		const sampling = magnifierSampling({ xPx: 1, yPx: 1.5 }, 2, 3, MAGNIFIER_SIZE, 0.5);
		expect(sampling.displayScale).toBe(4);
		expect(sampling.sourceWidth).toBe(2);
		expect(sampling.sourceHeight).toBe(3);
		expect(sampling.sourceX).toBe(0);
		expect(sampling.sourceY).toBe(0);
		expect(sampling.anchorX).toBe(4);
		expect(sampling.anchorY).toBe(6);
	});

	it('centers the source region on an interior anchor with the anchor at canvas center', () => {
		const sampling = magnifierSampling({ xPx: 500, yPx: 400 }, 1000, 800, MAGNIFIER_SIZE, 0.5);
		expect(sampling.sourceWidth).toBe(MAGNIFIER_SIZE / 4);
		expect(sampling.sourceHeight).toBe(MAGNIFIER_SIZE / 4);
		expect(sampling.sourceX).toBe(500 - sampling.sourceWidth / 2);
		expect(sampling.sourceY).toBe(400 - sampling.sourceHeight / 2);
		expect(sampling.anchorX).toBe(MAGNIFIER_SIZE / 2);
		expect(sampling.anchorY).toBe(MAGNIFIER_SIZE / 2);
	});

	it('clamps to image edges while preserving the exact anchor coordinate', () => {
		const topLeft = magnifierSampling({ xPx: 0, yPx: 0 }, 1000, 800, MAGNIFIER_SIZE, 0.5);
		expect(topLeft.sourceX).toBe(0);
		expect(topLeft.sourceY).toBe(0);
		expect(topLeft.anchorX).toBe(0);
		expect(topLeft.anchorY).toBe(0);

		const bottomRight = magnifierSampling({ xPx: 999, yPx: 799 }, 1000, 800, MAGNIFIER_SIZE, 0.5);
		expect(bottomRight.sourceX).toBe(1000 - bottomRight.sourceWidth);
		expect(bottomRight.sourceY).toBe(800 - bottomRight.sourceHeight);
		expect(bottomRight.anchorX).toBe((999 - bottomRight.sourceX) * bottomRight.displayScale);
		expect(bottomRight.anchorY).toBe((799 - bottomRight.sourceY) * bottomRight.displayScale);
	});

	it('is deterministic across identical inputs', () => {
		const a = magnifierSampling({ xPx: 123.25, yPx: 67.5 }, 500, 400, MAGNIFIER_SIZE, 1.7);
		const b = magnifierSampling({ xPx: 123.25, yPx: 67.5 }, 500, 400, MAGNIFIER_SIZE, 1.7);
		expect(a).toEqual(b);
	});
});

describe('P0-012 magnifier box placement', () => {
	it('prefers the upper-left of the anchor and flips at the pane edges', () => {
		const interior = magnifierBoxPosition({ x: 200, y: 200 }, { width: 500, height: 500 });
		expect(interior).toEqual({ x: 200 - MAGNIFIER_SIZE - MAGNIFIER_GAP_PX, y: 200 - MAGNIFIER_SIZE - MAGNIFIER_GAP_PX });

		const topLeft = magnifierBoxPosition({ x: 10, y: 10 }, { width: 500, height: 500 });
		expect(topLeft.x).toBe(10 + MAGNIFIER_GAP_PX);
		expect(topLeft.y).toBe(10 + MAGNIFIER_GAP_PX);

		const bottomRight = magnifierBoxPosition({ x: 480, y: 480 }, { width: 500, height: 500 });
		expect(bottomRight.x).toBe(480 - MAGNIFIER_SIZE - MAGNIFIER_GAP_PX);
		expect(bottomRight.y).toBe(480 - MAGNIFIER_SIZE - MAGNIFIER_GAP_PX);
	});

	it('always stays fully inside the pane', () => {
		const near = magnifierBoxPosition({ x: 490, y: 490 }, { width: 500, height: 500 });
		expect(near.x + MAGNIFIER_SIZE).toBeLessThanOrEqual(500);
		expect(near.y + MAGNIFIER_SIZE).toBeLessThanOrEqual(500);
		expect(near.x).toBeGreaterThanOrEqual(0);
		expect(near.y).toBeGreaterThanOrEqual(0);
	});
});

describe('P0-012 magnifier drawing contract', () => {
	it('samples the exact computed source region from the decoded original and draws an exact crosshair', () => {
		const context = new RecordingContext();
		const image = {} as CanvasImageSource;
		const sampling = magnifierSampling({ xPx: 500, yPx: 400 }, 1000, 800, MAGNIFIER_SIZE, 0.5);

		drawMagnifier(context, image, sampling, MAGNIFIER_SIZE);

		const clear = context.calls.find((call) => call.type === 'clearRect');
		expect(clear?.args).toEqual([0, 0, MAGNIFIER_SIZE, MAGNIFIER_SIZE]);

		const draws = context.calls.filter((call) => call.type === 'drawImage');
		expect(draws).toHaveLength(1);
		expect(draws[0].image).toBe(image);
		expect(draws[0].args).toEqual([
			sampling.sourceX,
			sampling.sourceY,
			sampling.sourceWidth,
			sampling.sourceHeight,
			0,
			0,
			MAGNIFIER_SIZE,
			MAGNIFIER_SIZE
		]);

		const strokes = context.calls.filter((call) => call.type === 'stroke');
		expect(strokes).toHaveLength(2);
		expect(strokes[0].style).toBe(CROSSHAIR_DARK);
		expect(strokes[0].width).toBe(3);
		expect(strokes[1].style).toBe(CROSSHAIR_LIGHT);
		expect(strokes[1].width).toBe(1);

		// The crosshair passes exactly through the anchor in CSS pixels (snapped to
		// half-pixel boundaries for crisp 1px rows/columns).
		const cx = Math.round(sampling.anchorX) + 0.5;
		const cy = Math.round(sampling.anchorY) + 0.5;
		const horizontal = context.calls.filter(
			(call) =>
				call.type === 'lineTo' &&
				Array.isArray(call.args) &&
				call.args[0] === MAGNIFIER_SIZE &&
				call.args[1] === cy
		);
		const vertical = context.calls.filter(
			(call) =>
				call.type === 'lineTo' &&
				Array.isArray(call.args) &&
				call.args[0] === cx &&
				call.args[1] === MAGNIFIER_SIZE
		);
		expect(horizontal.length).toBe(2);
		expect(vertical.length).toBe(2);
	});

	it('pins the crosshair at the exact anchor for the tiny.png fixture', () => {
		const context = new RecordingContext();
		const sampling = magnifierSampling({ xPx: 1, yPx: 1.5 }, 2, 3, MAGNIFIER_SIZE, 0.5);
		drawMagnifier(context, {} as CanvasImageSource, sampling, MAGNIFIER_SIZE);
		const cx = Math.round(sampling.anchorX) + 0.5;
		const cy = Math.round(sampling.anchorY) + 0.5;
		const horizontal = context.calls.filter(
			(call) => call.type === 'lineTo' && Array.isArray(call.args) && call.args[1] === cy
		);
		const vertical = context.calls.filter(
			(call) => call.type === 'lineTo' && Array.isArray(call.args) && call.args[0] === cx
		);
		expect(horizontal.length).toBe(2);
		expect(vertical.length).toBe(2);
		expect(sampling.anchorX).toBe(4);
		expect(sampling.anchorY).toBe(6);
	});
});
