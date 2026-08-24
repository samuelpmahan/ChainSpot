// Strip-chart PNG renderer for the cleanBasketFamily knob-tuning
// investigation. Pure function of its inputs (a list of values tagged TRUE
// or PHANTOM, plus optional threshold lines) -> PNG bytes. No dependency
// beyond pngjs. Same "no fonts, hardcoded bitmap digits" approach as
// tests/unit/helpers/sweepRender.ts.
//
// Layout: a plain white canvas. Two rows of tick marks — TRUE points in
// green on the upper row, PHANTOM points in red on the lower row — each
// point plotted at its x position within [domainMin, domainMax]. Vertical
// black lines mark each named threshold at its knob value. A axis line
// with min/max value labels (bitmap digits) runs along the bottom.

import { PNG } from 'pngjs';

const WIDTH = 900;
const MARGIN = 40;
const ROW_HEIGHT = 60;
const TRUE_ROW_Y = 40;
const PHANTOM_ROW_Y = 100;
const AXIS_Y = 140;
const HEIGHT = 190;

const GREEN: readonly [number, number, number] = [30, 160, 30];
const RED: readonly [number, number, number] = [210, 30, 30];
const BLACK: readonly [number, number, number] = [20, 20, 20];
const GRAY: readonly [number, number, number] = [140, 140, 140];
const WHITE: readonly [number, number, number] = [255, 255, 255];

const DIGIT_FONT: Record<string, readonly string[]> = {
	'-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
	'.': ['00000', '00000', '00000', '00000', '00000', '00110', '00110'],
	'0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
	'1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
	'2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
	'3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
	'4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
	'5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
	'6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
	'7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
	'8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
	'9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100']
};

function setPx(buf: Uint8ClampedArray, w: number, h: number, x: number, y: number, [r, g, b]: readonly [number, number, number]) {
	const xi = Math.round(x);
	const yi = Math.round(y);
	if (xi < 0 || yi < 0 || xi >= w || yi >= h) return;
	const i = (yi * w + xi) * 4;
	buf[i] = r;
	buf[i + 1] = g;
	buf[i + 2] = b;
	buf[i + 3] = 255;
}

function drawVLine(buf: Uint8ClampedArray, w: number, h: number, x: number, y0: number, y1: number, color: readonly [number, number, number], thickness = 1) {
	for (let t = 0; t < thickness; t++) {
		for (let y = y0; y <= y1; y++) setPx(buf, w, h, x + t, y, color);
	}
}

function drawHLine(buf: Uint8ClampedArray, w: number, h: number, y: number, x0: number, x1: number, color: readonly [number, number, number]) {
	for (let x = x0; x <= x1; x++) setPx(buf, w, h, x, y, color);
}

function drawTick(buf: Uint8ClampedArray, w: number, h: number, x: number, y: number, color: readonly [number, number, number]) {
	for (let dy = -6; dy <= 6; dy++) setPx(buf, w, h, x, y + dy, color);
}

function drawText(buf: Uint8ClampedArray, w: number, h: number, x: number, y: number, text: string, color: readonly [number, number, number], scale = 2) {
	const glyphW = 5 * scale;
	const gap = scale;
	text.split('').forEach((ch, index) => {
		const glyph = DIGIT_FONT[ch];
		if (!glyph) return;
		const ox = x + index * (glyphW + gap);
		for (let row = 0; row < 7; row++) {
			for (let col = 0; col < 5; col++) {
				if (glyph[row][col] !== '1') continue;
				for (let sy = 0; sy < scale; sy++) {
					for (let sx = 0; sx < scale; sx++) {
						setPx(buf, w, h, ox + col * scale + sx, y + row * scale + sy, color);
					}
				}
			}
		}
	});
}

export interface HistogramInput {
	readonly metricName: string;
	readonly trueValues: readonly number[];
	readonly phantomValues: readonly number[];
	readonly domainMin: number;
	readonly domainMax: number;
	/** named threshold lines drawn as vertical black bars, e.g. { whiteCoverageMin: 0.96 } */
	readonly thresholds?: Readonly<Record<string, number>>;
}

/** Pure: renders one metric's TRUE-vs-PHANTOM strip chart as PNG bytes. */
export function renderHistogramPng(input: HistogramInput): Buffer {
	const buf = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
	for (let i = 0; i < buf.length; i += 4) {
		buf[i] = WHITE[0];
		buf[i + 1] = WHITE[1];
		buf[i + 2] = WHITE[2];
		buf[i + 3] = 255;
	}

	const plotX0 = MARGIN;
	const plotX1 = WIDTH - MARGIN;
	const span = input.domainMax - input.domainMin || 1;
	const toX = (v: number) => plotX0 + ((v - input.domainMin) / span) * (plotX1 - plotX0);

	drawHLine(buf, WIDTH, HEIGHT, AXIS_Y, plotX0, plotX1, BLACK);
	drawText(buf, WIDTH, HEIGHT, plotX0, AXIS_Y + 8, input.domainMin.toFixed(2), GRAY);
	drawText(buf, WIDTH, HEIGHT, plotX1 - 40, AXIS_Y + 8, input.domainMax.toFixed(2), GRAY);
	drawText(buf, WIDTH, HEIGHT, 4, 4, input.metricName.slice(0, 20), BLACK);

	for (const v of input.trueValues) if (Number.isFinite(v)) drawTick(buf, WIDTH, HEIGHT, toX(v), TRUE_ROW_Y, GREEN);
	for (const v of input.phantomValues) if (Number.isFinite(v)) drawTick(buf, WIDTH, HEIGHT, toX(v), PHANTOM_ROW_Y, RED);

	if (input.thresholds) {
		for (const value of Object.values(input.thresholds)) {
			if (!Number.isFinite(value) || value < input.domainMin || value > input.domainMax) continue;
			drawVLine(buf, WIDTH, HEIGHT, toX(value), 20, AXIS_Y, BLACK, 2);
		}
	}

	const png = new PNG({ width: WIDTH, height: HEIGHT });
	png.data = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
	return PNG.sync.write(png);
}
