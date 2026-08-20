import { describe, expect, test } from 'vitest';
import { renderStitchedPng, stitchedFileName } from '../../src/lib/stitch/render';
import type { StitchRenderEnv, StitchRenderTile } from '../../src/lib/stitch/render';
import { defaultSlotOrder, initialPlacements } from '../../src/lib/stitch/geometry';
import type { TilePlacement, TileSlot } from '../../src/lib/stitch/geometry';

describe('stitch render (P05-002)', () => {
	test('native renderer: union-sized canvas, translated integer draw rects, bottom-right-on-top draw order, no resampling', async () => {
		const drawCalls: Array<{
			sx: number;
			sy: number;
			sWidth: number;
			sHeight: number;
			dx: number;
			dy: number;
			dWidth: number;
			dHeight: number;
		}> = [];
		const context = {
			drawImage(
				_image: HTMLImageElement,
				sx: number,
				sy: number,
				sWidth: number,
				sHeight: number,
				dx: number,
				dy: number,
				dWidth: number,
				dHeight: number
			): void {
				drawCalls.push({ sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight });
			}
		};
		const canvas = {
			width: 0,
			height: 0,
			getContext: () => context
		} as unknown as HTMLCanvasElement;
		const env: StitchRenderEnv = {
			createCanvas: () => canvas,
			toBlob: async () => new Blob(['stitched'])
		};

		// 50 x 40 source screenshots cropped by 5px on every side -> 40 x 30 crops.
		// Offsets: round(40 * 3 / 4) = 30, round(30 * 3 / 4) = 23.
		// Four slots, in the default grid order (upper-left, upper-right,
		// lower-left, lower-right equivalent); tiles[0] is always the anchor.
		const slots = defaultSlotOrder(4);
		const placements = initialPlacements(slots, 40, 30) as Record<TileSlot, TilePlacement>;
		const tiles: StitchRenderTile[] = slots.map((slot) => ({
			slot,
			image: {} as HTMLImageElement,
			widthPx: 50,
			heightPx: 40,
			placement: placements[slot]
		}));
		const crop = { topPx: 5, rightPx: 5, bottomPx: 5, leftPx: 5 };

		const blob = await renderStitchedPng(tiles, crop, env);

		// Union of UL(0,0), UR(30,0), LL(0,23), LR(30,23), each 40 x 30 -> 70 x 53.
		expect(canvas.width).toBe(70);
		expect(canvas.height).toBe(53);
		expect(drawCalls).toHaveLength(4);

		// Draw order is position-derived, not the caller's array order: ascending
		// by placement xPx + yPx, so upper-left (sum 0) paints first, then
		// lower-left (sum 23), then upper-right (sum 30), ending with
		// lower-right (sum 53) on top — whichever tile is bottom-right-most
		// paints last, covering any fixed on-screen control (e.g. a map app's
		// own map/satellite toggle) baked into its neighbors' corners.
		expect(drawCalls.map((call) => call.sx)).toEqual([5, 5, 5, 5]);
		expect(drawCalls.map((call) => call.sy)).toEqual([5, 5, 5, 5]);
		expect(drawCalls.map((call) => call.sWidth)).toEqual([40, 40, 40, 40]);
		expect(drawCalls.map((call) => call.sHeight)).toEqual([30, 30, 30, 30]);

		// Identical source/destination crop sizes: no resampling.
		expect(drawCalls.map((call) => call.dWidth)).toEqual([40, 40, 40, 40]);
		expect(drawCalls.map((call) => call.dHeight)).toEqual([30, 30, 30, 30]);

		// Integer destinations translated to the output origin, in
		// upper-left, lower-left, upper-right, lower-right paint order.
		expect(drawCalls.map((call) => call.dx)).toEqual([0, 0, 30, 30]);
		expect(drawCalls.map((call) => call.dy)).toEqual([0, 23, 0, 23]);

		expect(blob).toBeInstanceOf(Blob);
		expect(blob.size).toBeGreaterThan(0);

		// Default filename derives from the first tile name.
		expect(stitchedFileName([{ fileName: 'capture-ul.png' }])).toBe('capture-ul-stitched.png');
		expect(stitchedFileName([{ fileName: 'capture-ul.JPG' }])).toBe('capture-ul-stitched.png');
	});
});
