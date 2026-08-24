import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';
import type { PointTuple, RasterImage, Rect, ScopePanelMeta, ScopePinOverlay, ScopeRenderMeta, ScopeResolvedRequest } from './types';
import { getScopeTemplate } from './templates';

const BG = [24, 26, 30, 255] as const;
const FRAME = [210, 214, 220, 255] as const;
const INNER = [70, 76, 84, 255] as const;
const CLAIM = [255, 235, 90, 255] as const;
const TEMP_PIN = [105, 235, 215, 255] as const;
const PATH_COLORS = [
	[255, 90, 90, 255],
	[90, 180, 255, 255],
	[120, 230, 130, 255],
	[225, 130, 255, 255],
	[255, 175, 80, 255],
	[110, 225, 215, 255]
] as const;

function rgbaIndex(width: number, x: number, y: number): number {
	return (y * width + x) * 4;
}

function setPixel(data: Uint8Array, width: number, height: number, x: number, y: number, rgba: readonly number[]): void {
	if (x < 0 || y < 0 || x >= width || y >= height) return;
	const i = rgbaIndex(width, x, y);
	data[i] = rgba[0]; data[i + 1] = rgba[1]; data[i + 2] = rgba[2]; data[i + 3] = rgba[3];
}

function fill(data: Uint8Array, width: number, height: number, rgba: readonly number[]): void {
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) setPixel(data, width, height, x, y, rgba);
}

function fillRect(data: Uint8Array, width: number, height: number, x: number, y: number, w: number, h: number, rgba: readonly number[]): void {
	for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) setPixel(data, width, height, xx, yy, rgba);
}

function drawLine(data: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number, rgba: readonly number[], thickness = 2): void {
	let x = Math.round(x0), y = Math.round(y0);
	const tx = Math.round(x1), ty = Math.round(y1);
	const dx = Math.abs(tx - x), sx = x < tx ? 1 : -1;
	const dy = -Math.abs(ty - y), sy = y < ty ? 1 : -1;
	let err = dx + dy;
	for (;;) {
		const r = Math.max(0, Math.floor(thickness / 2));
		fillRect(data, width, height, x - r, y - r, Math.max(1, thickness), Math.max(1, thickness), rgba);
		if (x === tx && y === ty) break;
		const e2 = 2 * err;
		if (e2 >= dy) { err += dy; x += sx; }
		if (e2 <= dx) { err += dx; y += sy; }
	}
}

function drawRect(data: Uint8Array, width: number, height: number, x: number, y: number, w: number, h: number, rgba: readonly number[], thickness = 2): void {
	for (let t = 0; t < thickness; t++) {
		drawLine(data, width, height, x - t, y - t, x + w + t, y - t, rgba, 1);
		drawLine(data, width, height, x - t, y + h + t, x + w + t, y + h + t, rgba, 1);
		drawLine(data, width, height, x - t, y - t, x - t, y + h + t, rgba, 1);
		drawLine(data, width, height, x + w + t, y - t, x + w + t, y + h + t, rgba, 1);
	}
}

function drawCircle(data: Uint8Array, width: number, height: number, cx: number, cy: number, radius: number, rgba: readonly number[]): void {
	const r2 = radius * radius;
	for (let y = -radius; y <= radius; y++) {
		for (let x = -radius; x <= radius; x++) {
			if (x * x + y * y <= r2) setPixel(data, width, height, Math.round(cx + x), Math.round(cy + y), rgba);
		}
	}
}

const DIGITS: Record<string, readonly string[]> = {
	'0': ['111','101','101','101','111'], '1': ['010','110','010','010','111'],
	'2': ['111','001','111','100','111'], '3': ['111','001','111','001','111'],
	'4': ['101','101','111','001','001'], '5': ['111','100','111','001','111'],
	'6': ['111','100','111','101','111'], '7': ['111','001','010','010','010'],
	'8': ['111','101','111','101','111'], '9': ['111','101','111','001','111']
};

function drawNumber(data: Uint8Array, width: number, height: number, cx: number, cy: number, n: number): void {
	const text = String(n);
	const scale = 2;
	const charW = 3 * scale;
	const gap = scale;
	const totalW = text.length * charW + Math.max(0, text.length - 1) * gap;
	let ox = Math.round(cx - totalW / 2);
	const oy = Math.round(cy - (5 * scale) / 2);
	for (const ch of text) {
		const glyph = DIGITS[ch];
		if (glyph) {
			for (let gy = 0; gy < glyph.length; gy++) for (let gx = 0; gx < glyph[gy].length; gx++) {
				if (glyph[gy][gx] === '1') fillRect(data, width, height, ox + gx * scale, oy + gy * scale, scale, scale, [15, 15, 15, 255]);
			}
		}
		ox += charW + gap;
	}
}

function copyNearest(src: RasterImage, rect: Rect, out: Uint8Array, outWidth: number, outHeight: number, dx: number, dy: number, size: number): void {
	for (let oy = 0; oy < size; oy++) {
		const sy = Math.min(src.height - 1, Math.max(0, Math.floor(rect.y + ((oy + 0.5) / size) * rect.h)));
		for (let ox = 0; ox < size; ox++) {
			const sx = Math.min(src.width - 1, Math.max(0, Math.floor(rect.x + ((ox + 0.5) / size) * rect.w)));
			const si = rgbaIndex(src.width, sx, sy);
			const di = rgbaIndex(outWidth, dx + ox, dy + oy);
			out[di] = src.data[si]; out[di + 1] = src.data[si + 1]; out[di + 2] = src.data[si + 2]; out[di + 3] = src.data[si + 3];
		}
	}
}

function imageToPanel(rect: Rect, x: number, y: number, panelSize: number, p: PointTuple): PointTuple {
	return [x + ((p[0] - rect.x) / rect.w) * panelSize, y + ((p[1] - rect.y) / rect.h) * panelSize];
}

function isForensic(panel: ScopePanelMeta): boolean {
	return panel.name.startsWith('forensic-');
}

function overlayRequest(data: Uint8Array, width: number, height: number, panel: ScopePanelMeta, px: number, py: number, request: ScopeResolvedRequest): void {
	if (isForensic(panel)) return;
	const panelSize = panel.outputPx;
	const r = panel.source;
	const color = PATH_COLORS[((request.color % PATH_COLORS.length) + PATH_COLORS.length) % PATH_COLORS.length];
	if (request.kind === 'box' || request.kind === 'hole') {
		const a = imageToPanel(r, px, py, panelSize, [request.focus.x, request.focus.y]);
		const b = imageToPanel(r, px, py, panelSize, [request.focus.x + request.focus.w, request.focus.y + request.focus.h]);
		drawRect(data, width, height, Math.round(a[0]), Math.round(a[1]), Math.round(b[0] - a[0]), Math.round(b[1] - a[1]), CLAIM, 2);
	}
	if (request.kind === 'point' || request.kind === 'mark') {
		const p = imageToPanel(r, px, py, panelSize, request.points[0]);
		drawCircle(data, width, height, p[0], p[1], 6, CLAIM);
		drawCircle(data, width, height, p[0], p[1], 2, [20, 20, 20, 255]);
	}
	if (request.kind === 'dots' || request.kind === 'path' || request.kind === 'hole') {
		for (let i = 1; i < request.points.length; i++) {
			const a = imageToPanel(r, px, py, panelSize, request.points[i - 1]);
			const b = imageToPanel(r, px, py, panelSize, request.points[i]);
			drawLine(data, width, height, a[0], a[1], b[0], b[1], color, request.kind === 'path' ? 2 : 3);
		}
		for (let i = 0; i < request.points.length; i++) {
			const p = imageToPanel(r, px, py, panelSize, request.points[i]);
			drawCircle(data, width, height, p[0], p[1], 10, color);
			drawNumber(data, width, height, p[0], p[1], request.pointLabels?.[i] ?? i + 1);
		}
	}
}

function pointInside(rect: Rect, point: PointTuple): boolean {
	return point[0] >= rect.x && point[1] >= rect.y && point[0] <= rect.x + rect.w && point[1] <= rect.y + rect.h;
}

function overlayPins(data: Uint8Array, width: number, height: number, panel: ScopePanelMeta, px: number, py: number, pins: readonly ScopePinOverlay[]): void {
	if (isForensic(panel)) return;
	for (const pin of pins) {
		if (!pointInside(panel.source, pin.point)) continue;
		const p = imageToPanel(panel.source, px, py, panel.outputPx, pin.point);
		const color = pin.kind === 'kept' ? CLAIM : TEMP_PIN;
		drawCircle(data, width, height, p[0], p[1], pin.kind === 'kept' ? 9 : 8, color);
		if (pin.kind === 'kept') {
			drawLine(data, width, height, p[0] - 10, p[1], p[0] + 10, p[1], [20, 20, 20, 255], 2);
			drawLine(data, width, height, p[0], p[1] - 10, p[0], p[1] + 10, [20, 20, 20, 255], 2);
		} else if (pin.ttlRemaining !== undefined) {
			drawNumber(data, width, height, p[0], p[1], pin.ttlRemaining);
		}
	}
}

export interface RenderScopeInput {
	readonly raster: RasterImage;
	readonly imagePath: string;
	readonly annotationPath?: string;
	readonly request: ScopeResolvedRequest;
	readonly pins?: readonly ScopePinOverlay[];
	readonly outputPath: string;
}

function panelGapAfter(panels: readonly ScopePanelMeta[], index: number): number {
	if (index >= panels.length - 1) return 0;
	return isForensic(panels[index]) && isForensic(panels[index + 1]) ? 6 : 18;
}

export function renderScope(input: RenderScopeInput): ScopeRenderMeta {
	const template = getScopeTemplate(input.request.template);
	const panels = template.panels({ imageWidth: input.raster.width, imageHeight: input.raster.height, request: input.request });
	const chrome = 10;
	const maxPanel = Math.max(...panels.map((p) => p.outputPx));
	const width = panels.reduce((sum, panel, i) => sum + panel.outputPx + chrome * 2 + panelGapAfter(panels, i), 0);
	const height = maxPanel + chrome * 2;
	const png = new PNG({ width, height });
	const out = png.data as Uint8Array;
	fill(out, width, height, BG);
	let x = 0;
	for (let i = 0; i < panels.length; i++) {
		const panel = panels[i];
		const frameSize = panel.outputPx + chrome * 2;
		const y = Math.floor((height - frameSize) / 2);
		fillRect(out, width, height, x, y, frameSize, frameSize, FRAME);
		fillRect(out, width, height, x + chrome - 3, y + chrome - 3, panel.outputPx + 6, panel.outputPx + 6, INNER);
		copyNearest(input.raster, panel.source, out, width, height, x + chrome, y + chrome, panel.outputPx);
		overlayRequest(out, width, height, panel, x + chrome, y + chrome, input.request);
		overlayPins(out, width, height, panel, x + chrome, y + chrome, input.pins ?? []);
		x += frameSize + panelGapAfter(panels, i);
	}
	mkdirSync(dirname(input.outputPath), { recursive: true });
	writeFileSync(input.outputPath, PNG.sync.write(png));
	const meta: ScopeRenderMeta = {
		schemaVersion: 1,
		mode: input.annotationPath ? 'TRUTH_AVAILABLE' : 'BLIND',
		image: input.imagePath,
		annotation: input.annotationPath,
		request: input.request,
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
	const tileW = Math.max(...images.map((i) => i.png.width));
	const tileH = Math.max(...images.map((i) => i.png.height));
	const cols = Math.max(1, Math.ceil(Math.sqrt(images.length)));
	const rows = Math.ceil(images.length / cols);
	const gap = 14;
	const width = cols * tileW + (cols - 1) * gap;
	const height = rows * tileH + (rows - 1) * gap;
	const sheet = new PNG({ width, height });
	const out = sheet.data as Uint8Array;
	fill(out, width, height, BG);
	for (let i = 0; i < images.length; i++) {
		const col = i % cols, row = Math.floor(i / cols);
		const dx = col * (tileW + gap), dy = row * (tileH + gap);
		const src = images[i].png;
		for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
			const si = rgbaIndex(src.width, x, y), di = rgbaIndex(width, dx + x, dy + y);
			out[di] = src.data[si]; out[di + 1] = src.data[si + 1]; out[di + 2] = src.data[si + 2]; out[di + 3] = src.data[si + 3];
		}
		drawCircle(out, width, height, dx + 18, dy + 18, 14, FRAME);
		drawNumber(out, width, height, dx + 18, dy + 18, i + 1);
	}
	mkdirSync(dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, PNG.sync.write(sheet));
	writeFileSync(`${outputPath}.json`, JSON.stringify({
		schemaVersion: 1,
		scopes: renderedPaths.map((path, i) => ({ index: i + 1, path })),
		output: outputPath
	}, null, 2) + '\n');
}
