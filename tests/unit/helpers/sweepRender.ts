// Evidence-image renderer for the gate sweeps — pure function of run
// results (a raster + truth + detected points in), a PNG buffer out. No
// dependency beyond pngjs (already a devDependency for the PNG-course
// decode path). Never mutates its inputs; always draws on a cloned buffer.
//
// LEGEND (documented here AND in the final report, since the legend block
// itself is drawn as plain color swatches — no font glyphs in it):
//   - solid GREEN square  = truth tee position
//   - solid BLUE square   = truth basket position
//   - hollow GREEN diamond (+ thin green line to its truth square when not
//     coincident) = a detected tee matched to that truth within tolerance
//   - hollow BLUE diamond (+ thin blue line)  = a detected basket matched
//     to that truth within tolerance
//   - hollow ORANGE diamond = an extra/unmatched detected tee (false
//     positive — no truth tee within tolerance)
//   - hollow MAGENTA diamond = an extra/unmatched detected basket
//   - thick RED ring around a truth square = that hole's truth was MISSED
//     (no detection within tolerance); the hole number is stamped next to
//     it in a small hardcoded bitmap digit font (white on black box, no
//     external font file/dependency)
//
// The on-image legend block (top-left corner, drawn by drawLegendBlock) is
// six stacked solid-color swatches in exactly the order listed above.

import { PNG } from 'pngjs';

export type RGB = readonly [number, number, number];

export const COLORS = {
	truthTee: [40, 200, 40] as RGB,
	truthBasket: [40, 120, 240] as RGB,
	matchedTee: [40, 200, 40] as RGB,
	matchedBasket: [40, 120, 240] as RGB,
	extraTee: [255, 140, 0] as RGB,
	extraBasket: [230, 40, 230] as RGB,
	miss: [230, 20, 20] as RGB,
	digitFg: [255, 255, 255] as RGB,
	digitBg: [0, 0, 0] as RGB
};

export interface Point {
	readonly xPx: number;
	readonly yPx: number;
}

export interface EvidenceHole {
	readonly number: number;
	readonly truthTee: Point;
	readonly truthBasket: Point;
	/** nearest detected tee within tolerance, or null if this hole's tee was missed */
	readonly matchedTee: Point | null;
	/** nearest detected basket within tolerance, or null if this hole's basket was missed */
	readonly matchedBasket: Point | null;
}

export interface EvidenceInput {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly rgba: Uint8ClampedArray;
	readonly holes: readonly EvidenceHole[];
	/** detected tees with no truth hole matched to them within tolerance */
	readonly extraTees: readonly Point[];
	/** detected baskets with no truth hole matched to them within tolerance */
	readonly extraBaskets: readonly Point[];
}

function setPx(buf: Uint8ClampedArray, w: number, h: number, x: number, y: number, [r, g, b]: RGB) {
	const xi = Math.round(x);
	const yi = Math.round(y);
	if (xi < 0 || yi < 0 || xi >= w || yi >= h) return;
	const i = (yi * w + xi) * 4;
	buf[i] = r;
	buf[i + 1] = g;
	buf[i + 2] = b;
	buf[i + 3] = 255;
}

function drawFilledSquare(buf: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, half: number, color: RGB) {
	for (let dy = -half; dy <= half; dy++) {
		for (let dx = -half; dx <= half; dx++) {
			setPx(buf, w, h, cx + dx, cy + dy, color);
		}
	}
}

function drawHollowDiamond(buf: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, r: number, color: RGB) {
	for (let dy = -r; dy <= r; dy++) {
		const span = r - Math.abs(dy);
		setPx(buf, w, h, cx - span, cy + dy, color);
		setPx(buf, w, h, cx + span, cy + dy, color);
	}
	for (let dx = -r; dx <= r; dx++) {
		const span = r - Math.abs(dx);
		setPx(buf, w, h, cx + dx, cy - span, color);
		setPx(buf, w, h, cx + dx, cy + span, color);
	}
}

function drawThickSquareRing(buf: Uint8ClampedArray, w: number, h: number, cx: number, cy: number, r: number, thickness: number, color: RGB) {
	for (let t = 0; t < thickness; t++) {
		const rr = r + t;
		for (let dx = -rr; dx <= rr; dx++) {
			setPx(buf, w, h, cx + dx, cy - rr, color);
			setPx(buf, w, h, cx + dx, cy + rr, color);
		}
		for (let dy = -rr; dy <= rr; dy++) {
			setPx(buf, w, h, cx - rr, cy + dy, color);
			setPx(buf, w, h, cx + rr, cy + dy, color);
		}
	}
}

function drawLine(buf: Uint8ClampedArray, w: number, h: number, x0: number, y0: number, x1: number, y1: number, color: RGB) {
	let cx = Math.round(x0);
	let cy = Math.round(y0);
	const ex = Math.round(x1);
	const ey = Math.round(y1);
	const dx = Math.abs(ex - cx);
	const dy = -Math.abs(ey - cy);
	const sx = cx < ex ? 1 : -1;
	const sy = cy < ey ? 1 : -1;
	let err = dx + dy;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		setPx(buf, w, h, cx, cy, color);
		if (cx === ex && cy === ey) break;
		const e2 = 2 * err;
		if (e2 >= dy) {
			err += dy;
			cx += sx;
		}
		if (e2 <= dx) {
			err += dx;
			cy += sy;
		}
	}
}

// Hardcoded 5x7 dot-matrix digit font, 0-9. Rows top-to-bottom, '1' = lit.
const DIGIT_FONT: Record<string, readonly string[]> = {
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

/** Stamps `n` as bitmap digits (scaled up, with a solid background box) at (x, y) = top-left. */
function drawNumber(buf: Uint8ClampedArray, w: number, h: number, x: number, y: number, n: number, scale = 3) {
	const digits = String(Math.abs(Math.round(n))).split('');
	const glyphW = 5 * scale;
	const glyphH = 7 * scale;
	const gap = scale;
	const totalW = digits.length * (glyphW + gap) - gap;
	for (let py = -scale; py < glyphH + scale; py++) {
		for (let px = -scale; px < totalW + scale; px++) {
			setPx(buf, w, h, x + px, y + py, COLORS.digitBg);
		}
	}
	digits.forEach((d, index) => {
		const glyph = DIGIT_FONT[d] ?? DIGIT_FONT['0'];
		const ox = x + index * (glyphW + gap);
		for (let row = 0; row < 7; row++) {
			for (let col = 0; col < 5; col++) {
				if (glyph[row][col] !== '1') continue;
				for (let sy = 0; sy < scale; sy++) {
					for (let sx = 0; sx < scale; sx++) {
						setPx(buf, w, h, ox + col * scale + sx, y + row * scale + sy, COLORS.digitFg);
					}
				}
			}
		}
	});
}

function drawLegendBlock(buf: Uint8ClampedArray, w: number, h: number) {
	const swatches: RGB[] = [
		COLORS.truthTee,
		COLORS.truthBasket,
		COLORS.matchedTee,
		COLORS.extraTee,
		COLORS.extraBasket,
		COLORS.miss
	];
	const swW = 24;
	const swH = 10;
	const gap = 2;
	const x0 = 4;
	let y = 4;
	for (const color of swatches) {
		for (let dy = 0; dy < swH; dy++) {
			for (let dx = 0; dx < swW; dx++) {
				setPx(buf, w, h, x0 + dx, y + dy, color);
			}
		}
		y += swH + gap;
	}
}

/** Pure: returns a new PNG buffer; never mutates `input.rgba`. */
export function renderSweepEvidencePng(input: EvidenceInput): Buffer {
	const { widthPx: w, heightPx: h } = input;
	const buf = new Uint8ClampedArray(input.rgba); // clone — never mutate the source raster

	for (const hole of input.holes) {
		// tee
		if (hole.matchedTee) {
			const coincident = Math.hypot(hole.matchedTee.xPx - hole.truthTee.xPx, hole.matchedTee.yPx - hole.truthTee.yPx) < 3;
			if (!coincident) drawLine(buf, w, h, hole.truthTee.xPx, hole.truthTee.yPx, hole.matchedTee.xPx, hole.matchedTee.yPx, COLORS.matchedTee);
			drawHollowDiamond(buf, w, h, hole.matchedTee.xPx, hole.matchedTee.yPx, 7, COLORS.matchedTee);
			drawFilledSquare(buf, w, h, hole.truthTee.xPx, hole.truthTee.yPx, 3, COLORS.truthTee);
		} else {
			drawFilledSquare(buf, w, h, hole.truthTee.xPx, hole.truthTee.yPx, 3, COLORS.truthTee);
			drawThickSquareRing(buf, w, h, hole.truthTee.xPx, hole.truthTee.yPx, 9, 2, COLORS.miss);
			drawNumber(buf, w, h, hole.truthTee.xPx + 12, hole.truthTee.yPx - 10, hole.number);
		}
		// basket
		if (hole.matchedBasket) {
			const coincident =
				Math.hypot(hole.matchedBasket.xPx - hole.truthBasket.xPx, hole.matchedBasket.yPx - hole.truthBasket.yPx) < 3;
			if (!coincident)
				drawLine(buf, w, h, hole.truthBasket.xPx, hole.truthBasket.yPx, hole.matchedBasket.xPx, hole.matchedBasket.yPx, COLORS.matchedBasket);
			drawHollowDiamond(buf, w, h, hole.matchedBasket.xPx, hole.matchedBasket.yPx, 7, COLORS.matchedBasket);
			drawFilledSquare(buf, w, h, hole.truthBasket.xPx, hole.truthBasket.yPx, 3, COLORS.truthBasket);
		} else {
			drawFilledSquare(buf, w, h, hole.truthBasket.xPx, hole.truthBasket.yPx, 3, COLORS.truthBasket);
			drawThickSquareRing(buf, w, h, hole.truthBasket.xPx, hole.truthBasket.yPx, 9, 2, COLORS.miss);
			drawNumber(buf, w, h, hole.truthBasket.xPx + 12, hole.truthBasket.yPx + 12, hole.number);
		}
	}

	for (const p of input.extraTees) drawHollowDiamond(buf, w, h, p.xPx, p.yPx, 7, COLORS.extraTee);
	for (const p of input.extraBaskets) drawHollowDiamond(buf, w, h, p.xPx, p.yPx, 7, COLORS.extraBasket);

	drawLegendBlock(buf, w, h);

	const png = new PNG({ width: w, height: h });
	png.data = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
	return PNG.sync.write(png);
}
