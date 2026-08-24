import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';
import { resolveScopeView } from './viewOptions';
import type {
	PointTuple,
	RasterImage,
	Rect,
	ScopeCanonicalMeta,
	ScopePanelMeta,
	ScopePinOverlay,
	ScopeRenderMeta,
	ScopeResolvedRequest
} from './types';
import { getScopeTemplate, inspectionAnchor } from './templates';

const BG = [24, 26, 30, 255] as const;
const FRAME = [210, 214, 220, 255] as const;
const INNER = [70, 76, 84, 255] as const;
const CLAIM = [255, 235, 90, 255] as const;
const TEMP_PIN = [105, 235, 215, 255] as const;
const GRID = [182, 188, 194, 255] as const;
const TEXT = [238, 240, 244, 255] as const;
const LABEL_BG = [38, 42, 48, 255] as const;
const PATH_COLORS = [
	[255, 90, 90, 255],
	[90, 180, 255, 255],
	[120, 230, 130, 255],
	[225, 130, 255, 255],
	[255, 175, 80, 255],
	[110, 225, 215, 255]
] as const;
const CHROME = 8;
const LABEL_H = 24;

type Rgba = readonly number[];

function rgbaIndex(width: number, x: number, y: number): number {
	return (y * width + x) * 4;
}

function setPixel(data: Uint8Array, width: number, height: number, x: number, y: number, rgba: Rgba): void {
	if (x < 0 || y < 0 || x >= width || y >= height) return;
	const i = rgbaIndex(width, x, y);
	data[i] = rgba[0];
	data[i + 1] = rgba[1];
	data[i + 2] = rgba[2];
	data[i + 3] = rgba[3];
}

function fill(data: Uint8Array, width: number, height: number, rgba: Rgba): void {
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) setPixel(data, width, height, x, y, rgba);
}

function fillRect(data: Uint8Array, width: number, height: number, x: number, y: number, w: number, h: number, rgba: Rgba): void {
	for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) setPixel(data, width, height, xx, yy, rgba);
}

function drawLine(data: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number, rgba: Rgba, thickness = 1): void {
	let x = Math.round(x0);
	let y = Math.round(y0);
	const tx = Math.round(x1);
	const ty = Math.round(y1);
	const dx = Math.abs(tx - x);
	const sx = x < tx ? 1 : -1;
	const dy = -Math.abs(ty - y);
	const sy = y < ty ? 1 : -1;
	let err = dx + dy;
	for (;;) {
		const radius = Math.max(0, Math.floor((thickness - 1) / 2));
		fillRect(data, width, height, x - radius, y - radius, Math.max(1, thickness), Math.max(1, thickness), rgba);
		if (x === tx && y === ty) break;
		const e2 = 2 * err;
		if (e2 >= dy) { err += dy; x += sx; }
		if (e2 <= dx) { err += dx; y += sy; }
	}
}

function drawDashedLine(data: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number, rgba: Rgba): void {
	const dx = x1 - x0;
	const dy = y1 - y0;
	const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
	for (let i = 0; i <= steps; i++) {
		if (Math.floor(i / 4) % 2 === 1) continue;
		setPixel(data, width, height, Math.round(x0 + dx * i / steps), Math.round(y0 + dy * i / steps), rgba);
	}
}

function drawRect(data: Uint8Array, width: number, height: number, x: number, y: number, w: number, h: number, rgba: Rgba, thickness = 1): void {
	for (let t = 0; t < thickness; t++) {
		drawLine(data, width, height, x - t, y - t, x + w + t, y - t, rgba);
		drawLine(data, width, height, x - t, y + h + t, x + w + t, y + h + t, rgba);
		drawLine(data, width, height, x - t, y - t, x - t, y + h + t, rgba);
		drawLine(data, width, height, x + w + t, y - t, x + w + t, y + h + t, rgba);
	}
}

function drawCircle(data: Uint8Array, width: number, height: number, cx: number, cy: number, radius: number, rgba: Rgba): void {
	const r2 = radius * radius;
	for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
		if (x * x + y * y <= r2) setPixel(data, width, height, Math.round(cx + x), Math.round(cy + y), rgba);
	}
}

function drawRing(data: Uint8Array, width: number, height: number, cx: number, cy: number, radius: number, rgba: Rgba): void {
	const inner2 = (radius - 1) * (radius - 1);
	const outer2 = (radius + 1) * (radius + 1);
	for (let y = -radius - 1; y <= radius + 1; y++) for (let x = -radius - 1; x <= radius + 1; x++) {
		const d2 = x * x + y * y;
		if (d2 >= inner2 && d2 <= outer2) setPixel(data, width, height, Math.round(cx + x), Math.round(cy + y), rgba);
	}
}

function drawDiamond(data: Uint8Array, width: number, height: number, cx: number, cy: number, radius: number, rgba: Rgba): void {
	drawLine(data, width, height, cx, cy - radius, cx + radius, cy, rgba);
	drawLine(data, width, height, cx + radius, cy, cx, cy + radius, rgba);
	drawLine(data, width, height, cx, cy + radius, cx - radius, cy, rgba);
	drawLine(data, width, height, cx - radius, cy, cx, cy - radius, rgba);
	drawCircle(data, width, height, cx, cy, 1, rgba);
}

const GLYPHS: Record<string, readonly string[]> = {
	'0':['111','101','101','101','111'],'1':['010','110','010','010','111'],'2':['111','001','111','100','111'],'3':['111','001','111','001','111'],
	'4':['101','101','111','001','001'],'5':['111','100','111','001','111'],'6':['111','100','111','101','111'],'7':['111','001','010','010','010'],
	'8':['111','101','111','101','111'],'9':['111','101','111','001','111'],
	'A':['010','101','111','101','101'],'B':['110','101','110','101','110'],'C':['011','100','100','100','011'],'D':['110','101','101','101','110'],
	'E':['111','100','110','100','111'],'F':['111','100','110','100','100'],'G':['011','100','101','101','011'],'H':['101','101','111','101','101'],
	'I':['111','010','010','010','111'],'J':['001','001','001','101','010'],'K':['101','101','110','101','101'],'L':['100','100','100','100','111'],
	'M':['101','111','111','101','101'],'N':['101','111','111','111','101'],'O':['010','101','101','101','010'],'P':['110','101','110','100','100'],
	'Q':['010','101','101','111','011'],'R':['110','101','110','101','101'],'S':['011','100','010','001','110'],'T':['111','010','010','010','010'],
	'U':['101','101','101','101','111'],'V':['101','101','101','101','010'],'W':['101','101','111','111','101'],'X':['101','101','010','101','101'],
	'Y':['101','101','010','010','010'],'Z':['111','001','010','100','111'],
	'+':['010','010','111','010','010'],'-':['000','000','111','000','000'],':':['000','010','000','010','000'],'/':['001','001','010','100','100'],' ':['000','000','000','000','000']
};

function drawText(data: Uint8Array, width: number, height: number, x: number, y: number, text: string, scale = 1, rgba: Rgba = TEXT): void {
	let ox = x;
	for (const raw of text.toUpperCase()) {
		const glyph = GLYPHS[raw] ?? GLYPHS[' '];
		for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) {
			if (glyph[gy][gx] === '1') fillRect(data, width, height, ox + gx * scale, y + gy * scale, scale, scale, rgba);
		}
		ox += 4 * scale;
	}
}

function drawNumber(data: Uint8Array, width: number, height: number, cx: number, cy: number, n: number): void {
	const text = String(n);
	const scale = 2;
	const totalW = text.length * 8 - 2;
	drawText(data, width, height, Math.round(cx - totalW / 2), Math.round(cy - 5), text, scale, [15, 15, 15, 255]);
}

interface DestRect { readonly x: number; readonly y: number; readonly w: number; readonly h: number; }

function contentRect(panel: ScopePanelMeta, px: number, py: number): DestRect {
	const scale = Math.min(panel.outputPx / panel.source.w, panel.outputPx / panel.source.h);
	const w = Math.max(1, Math.round(panel.source.w * scale));
	const h = Math.max(1, Math.round(panel.source.h * scale));
	return { x: px + Math.floor((panel.outputPx - w) / 2), y: py + Math.floor((panel.outputPx - h) / 2), w, h };
}

function sampleNearest(src: RasterImage, sx: number, sy: number): Rgba {
	const x = Math.max(0, Math.min(src.width - 1, Math.round(sx)));
	const y = Math.max(0, Math.min(src.height - 1, Math.round(sy)));
	const i = rgbaIndex(src.width, x, y);
	return [src.data[i], src.data[i + 1], src.data[i + 2], src.data[i + 3]];
}

function sampleBilinear(src: RasterImage, sx: number, sy: number): Rgba {
	const x0 = Math.max(0, Math.min(src.width - 1, Math.floor(sx)));
	const y0 = Math.max(0, Math.min(src.height - 1, Math.floor(sy)));
	const x1 = Math.min(src.width - 1, x0 + 1);
	const y1 = Math.min(src.height - 1, y0 + 1);
	const fx = Math.max(0, Math.min(1, sx - x0));
	const fy = Math.max(0, Math.min(1, sy - y0));
	const out = [0, 0, 0, 0];
	for (let c = 0; c < 4; c++) {
		const a = src.data[rgbaIndex(src.width, x0, y0) + c] * (1 - fx) + src.data[rgbaIndex(src.width, x1, y0) + c] * fx;
		const b = src.data[rgbaIndex(src.width, x0, y1) + c] * (1 - fx) + src.data[rgbaIndex(src.width, x1, y1) + c] * fx;
		out[c] = Math.round(a * (1 - fy) + b * fy);
	}
	return out;
}

function copyPanel(src: RasterImage, panel: ScopePanelMeta, out: Uint8Array, outWidth: number, outHeight: number, px: number, py: number): DestRect {
	const dest = contentRect(panel, px, py);
	for (let oy = 0; oy < dest.h; oy++) for (let ox = 0; ox < dest.w; ox++) {
		const sx = panel.source.x + ((ox + 0.5) / dest.w) * panel.source.w - 0.5;
		const sy = panel.source.y + ((oy + 0.5) / dest.h) * panel.source.h - 0.5;
		setPixel(out, outWidth, outHeight, dest.x + ox, dest.y + oy, panel.resampling === 'nearest' ? sampleNearest(src, sx, sy) : sampleBilinear(src, sx, sy));
	}
	return dest;
}

function imageToPanel(panel: ScopePanelMeta, dest: DestRect, p: PointTuple): PointTuple {
	return [
		dest.x + ((p[0] - panel.source.x) / panel.source.w) * dest.w,
		dest.y + ((p[1] - panel.source.y) / panel.source.h) * dest.h
	];
}

function isForensic(panel: ScopePanelMeta): boolean {
	return panel.name.startsWith('forensic-');
}

function niceGridStep(span: number): number {
	const raw = Math.max(1, span / 8);
	const power = 10 ** Math.floor(Math.log10(raw));
	const n = raw / power;
	const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
	return nice * power;
}

function drawGrid(data: Uint8Array, width: number, height: number, panel: ScopePanelMeta, dest: DestRect): void {
	if (!panel.grid || isForensic(panel)) return;
	const step = niceGridStep(Math.max(panel.source.w, panel.source.h));
	const firstX = Math.ceil(panel.source.x / step) * step;
	const firstY = Math.ceil(panel.source.y / step) * step;
	for (let x = firstX; x <= panel.source.x + panel.source.w; x += step) {
		const p = imageToPanel(panel, dest, [x, panel.source.y]);
		drawDashedLine(data, width, height, p[0], dest.y, p[0], dest.y + dest.h, GRID);
		const label = String(Math.round(x));
		fillRect(data, width, height, Math.round(p[0]) + 2, dest.y + 2, label.length * 4 + 4, 9, LABEL_BG);
		drawText(data, width, height, Math.round(p[0]) + 4, dest.y + 4, label, 1, TEXT);
	}
	for (let y = firstY; y <= panel.source.y + panel.source.h; y += step) {
		const p = imageToPanel(panel, dest, [panel.source.x, y]);
		drawDashedLine(data, width, height, dest.x, p[1], dest.x + dest.w, p[1], GRID);
		const label = String(Math.round(y));
		fillRect(data, width, height, dest.x + 2, Math.round(p[1]) + 2, label.length * 4 + 4, 9, LABEL_BG);
		drawText(data, width, height, dest.x + 4, Math.round(p[1]) + 4, label, 1, TEXT);
	}
}

function overlayForensicTarget(data: Uint8Array, width: number, height: number, panel: ScopePanelMeta, dest: DestRect, request: ScopeResolvedRequest): void {
	const p = imageToPanel(panel, dest, inspectionAnchor(request));
	const cx = Math.round(p[0]);
	const cy = Math.round(p[1]);
	const gap = 3;
	const arm = 9;
	drawLine(data, width, height, cx - arm, cy, cx - gap, cy, CLAIM);
	drawLine(data, width, height, cx + gap, cy, cx + arm, cy, CLAIM);
	drawLine(data, width, height, cx, cy - arm, cx, cy - gap, CLAIM);
	drawLine(data, width, height, cx, cy + gap, cx, cy + arm, CLAIM);
}

function overlayRequest(data: Uint8Array, width: number, height: number, panel: ScopePanelMeta, dest: DestRect, request: ScopeResolvedRequest): void {
	if (isForensic(panel)) {
		overlayForensicTarget(data, width, height, panel, dest, request);
		return;
	}
	const color = PATH_COLORS[((request.color % PATH_COLORS.length) + PATH_COLORS.length) % PATH_COLORS.length];
	if (request.kind === 'box' || request.kind === 'hole') {
		const a = imageToPanel(panel, dest, [request.focus.x, request.focus.y]);
		const b = imageToPanel(panel, dest, [request.focus.x + request.focus.w, request.focus.y + request.focus.h]);
		drawRect(data, width, height, Math.round(a[0]), Math.round(a[1]), Math.round(b[0] - a[0]), Math.round(b[1] - a[1]), CLAIM, 2);
	}
	if (request.kind === 'point' || request.kind === 'mark') {
		const p = imageToPanel(panel, dest, request.points[0]);
		drawRing(data, width, height, p[0], p[1], 6, CLAIM);
		drawCircle(data, width, height, p[0], p[1], 1, CLAIM);
	}
	if (request.kind === 'dots' || request.kind === 'path' || request.kind === 'hole') {
		for (let i = 1; i < request.points.length; i++) {
			const a = imageToPanel(panel, dest, request.points[i - 1]);
			const b = imageToPanel(panel, dest, request.points[i]);
			drawLine(data, width, height, a[0], a[1], b[0], b[1], color, request.kind === 'path' ? 2 : 3);
		}
		for (let i = 0; i < request.points.length; i++) {
			const p = imageToPanel(panel, dest, request.points[i]);
			drawCircle(data, width, height, p[0], p[1], 9, color);
			drawNumber(data, width, height, p[0], p[1], request.pointLabels?.[i] ?? i + 1);
		}
	}
}

function pointInside(rect: Rect, point: PointTuple): boolean {
	return point[0] >= rect.x && point[1] >= rect.y && point[0] <= rect.x + rect.w && point[1] <= rect.y + rect.h;
}

function drawPin(data: Uint8Array, width: number, height: number, x: number, y: number, pin: ScopePinOverlay): void {
	const color = pin.kind === 'kept' ? CLAIM : TEMP_PIN;
	const radius = pin.kind === 'kept' ? 9 : 8;
	if (pin.style === 'crosshair') {
		const gap = 3;
		drawLine(data, width, height, x - radius, y, x - gap, y, color);
		drawLine(data, width, height, x + gap, y, x + radius, y, color);
		drawLine(data, width, height, x, y - radius, x, y - gap, color);
		drawLine(data, width, height, x, y + gap, x, y + radius, color);
		drawCircle(data, width, height, x, y, 1, color);
	} else if (pin.style === 'diamond') {
		drawDiamond(data, width, height, x, y, radius, color);
	} else {
		// Default: reacquirable on busy map texture, but the evidence beneath the
		// center remains visible except for a single reference pixel.
		drawRing(data, width, height, x, y, radius, color);
		drawCircle(data, width, height, x, y, 1, color);
	}
	if (pin.kind === 'temp' && pin.ttlRemaining !== undefined) {
		const labelX = Math.round(x + radius + 4);
		const labelY = Math.round(y - 4);
		fillRect(data, width, height, labelX - 1, labelY - 1, String(pin.ttlRemaining).length * 8 + 3, 12, LABEL_BG);
		drawText(data, width, height, labelX, labelY, String(pin.ttlRemaining), 2, color);
	}
}

function overlayPins(data: Uint8Array, width: number, height: number, panel: ScopePanelMeta, dest: DestRect, pins: readonly ScopePinOverlay[]): void {
	if (isForensic(panel)) return;
	for (const pin of pins) {
		if (!pointInside(panel.source, pin.point)) continue;
		const p = imageToPanel(panel, dest, pin.point);
		drawPin(data, width, height, p[0], p[1], pin);
	}
}

export interface RenderScopeInput {
	readonly raster: RasterImage;
	readonly imagePath: string;
	readonly annotationPath?: string;
	readonly canonical: ScopeCanonicalMeta;
	readonly request: ScopeResolvedRequest;
	readonly pins?: readonly ScopePinOverlay[];
	readonly outputPath: string;
}

function panelGapAfter(panels: readonly ScopePanelMeta[], index: number): number {
	if (index >= panels.length - 1) return 0;
	return isForensic(panels[index]) && isForensic(panels[index + 1]) ? 6 : 18;
}

export function renderScope(input: RenderScopeInput): ScopeRenderMeta {
	const view = resolveScopeView(input.request.view);
	const request: ScopeResolvedRequest = { ...input.request, view };
	const template = getScopeTemplate(request.template);
	const panels = template.panels({ imageWidth: input.raster.width, imageHeight: input.raster.height, request });
	const cardWidths = panels.map((panel) => panel.outputPx + CHROME * 2);
	const width = cardWidths.reduce((sum, cardWidth, index) => sum + cardWidth + panelGapAfter(panels, index), 0);
	const height = LABEL_H + Math.max(...panels.map((panel) => panel.outputPx)) + CHROME * 2;
	const png = new PNG({ width, height });
	const out = png.data as Uint8Array;
	fill(out, width, height, BG);

	let x = 0;
	for (let i = 0; i < panels.length; i++) {
		const panel = panels[i];
		const cardWidth = cardWidths[i];
		const imageY = LABEL_H + CHROME;
		fillRect(out, width, height, x, 0, cardWidth, LABEL_H, LABEL_BG);
		drawText(out, width, height, x + 6, 7, panel.label, 1, TEXT);
		fillRect(out, width, height, x, LABEL_H, cardWidth, panel.outputPx + CHROME * 2, FRAME);
		fillRect(out, width, height, x + CHROME, imageY, panel.outputPx, panel.outputPx, INNER);
		const dest = copyPanel(input.raster, panel, out, width, height, x + CHROME, imageY);
		drawGrid(out, width, height, panel, dest);
		overlayRequest(out, width, height, panel, dest, request);
		overlayPins(out, width, height, panel, dest, input.pins ?? []);
		x += cardWidth + panelGapAfter(panels, i);
	}

	mkdirSync(dirname(input.outputPath), { recursive: true });
	writeFileSync(input.outputPath, PNG.sync.write(png));
	const meta: ScopeRenderMeta = {
		schemaVersion: 1,
		mode: input.annotationPath ? 'TRUTH_AVAILABLE' : 'BLIND',
		image: input.imagePath,
		annotation: input.annotationPath,
		canonical: input.canonical,
		request,
		view,
		pins: input.pins,
		panels,
		output: input.outputPath
	};
	writeFileSync(`${input.outputPath}.json`, JSON.stringify(meta, null, 2) + '\n');
	return meta;
}

export function makeContactSheet(renderedPaths: readonly string[], outputPath: string): void {
	if (renderedPaths.length === 0) throw new Error('lab scope: contact-sheet has no rendered scopes.');
	const images = renderedPaths.map((path) => ({ path, png: PNG.sync.read(readFileSync(path)) }));
	const tileW = Math.max(...images.map((item) => item.png.width));
	const tileH = Math.max(...images.map((item) => item.png.height));
	const cols = Math.max(1, Math.ceil(Math.sqrt(images.length)));
	const rows = Math.ceil(images.length / cols);
	const gap = 14;
	const width = cols * tileW + (cols - 1) * gap;
	const height = rows * tileH + (rows - 1) * gap;
	const sheet = new PNG({ width, height });
	const out = sheet.data as Uint8Array;
	fill(out, width, height, BG);
	for (let i = 0; i < images.length; i++) {
		const col = i % cols;
		const row = Math.floor(i / cols);
		const dx = col * (tileW + gap);
		const dy = row * (tileH + gap);
		const src = images[i].png;
		for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
			const si = rgbaIndex(src.width, x, y);
			const di = rgbaIndex(width, dx + x, dy + y);
			out[di] = src.data[si];
			out[di + 1] = src.data[si + 1];
			out[di + 2] = src.data[si + 2];
			out[di + 3] = src.data[si + 3];
		}
		drawRing(out, width, height, dx + 18, dy + 18, 14, FRAME);
		drawNumber(out, width, height, dx + 18, dy + 18, i + 1);
	}
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, PNG.sync.write(sheet));
	writeFileSync(`${outputPath}.json`, JSON.stringify({
		schemaVersion: 1,
		scopes: renderedPaths.map((path, index) => ({ index: index + 1, path })),
		output: outputPath
	}, null, 2) + '\n');
}
