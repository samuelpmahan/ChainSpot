import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import type { HoleLabeledAssignment } from '@chainspot/alg/exec';
import type { Drawable, RunTrace } from '@chainspot/alg/detectors/threeFactor/features/types';

export interface EndpointNumberLabel {
	readonly kind: 'tee' | 'basket';
	readonly hole: number;
	readonly text: string;
	readonly endpointId: string;
	readonly xPx: number;
	readonly yPx: number;
}

function pointCenter(drawable: Drawable): readonly [number, number] | undefined {
	if (drawable.type === 'point') return [drawable.xPx, drawable.yPx];
	if (drawable.type !== 'polyline' || drawable.path.length === 0) return undefined;
	const points = drawable.path.length > 4 ? drawable.path.slice(0, 4) : drawable.path;
	return [
		points.reduce((sum, point) => sum + point[0], 0) / points.length,
		points.reduce((sum, point) => sum + point[1], 0) / points.length
	];
}

function refObjectId(ref: string | undefined, suffix: string): string | undefined {
	if (!ref) return undefined;
	return ref.endsWith(suffix) ? ref.slice(0, -suffix.length) : ref;
}

function exactHole(value: HoleLabeledAssignment['hole']): number | undefined {
	if (value === 'UNREAD') return undefined;
	const hole = typeof value === 'number' ? value : Number(value);
	return Number.isSafeInteger(hole) && hole > 0 ? hole : undefined;
}

/**
 * Resolve only final selected endpoints. Detector ordinals are never labels:
 * row.hole is the G1-read hole number attached by withHoleLabels().
 */
export function endpointNumberLabels(
	run: RunTrace,
	assignments: readonly HoleLabeledAssignment[]
): readonly EndpointNumberLabel[] {
	const teeCenters = new Map<string, readonly [number, number]>();
	const teeFamily = run.units.find((unit) => unit.id === 'teeFamily');
	for (const drawable of teeFamily?.drawables ?? []) {
		if (drawable.verdict !== 'accepted' || drawable.visualRole !== 'tee-border') continue;
		const center = pointCenter(drawable);
		if (drawable.ref && center) teeCenters.set(drawable.ref, center);
	}

	// assignThreeFactor names recovered inputs after sorting by y, then x.
	// teeRecovery only emits accepted tee-shard drawables after duplicate
	// suppression, and phantomTee centers are the same RecoveredTeeInput class.
	const recoveredCenters: Array<readonly [number, number]> = [];
	for (const unitId of ['teeRecovery', 'phantomTee']) {
		const unit = run.units.find((candidate) => candidate.id === unitId);
		for (const drawable of unit?.drawables ?? []) {
			if (drawable.verdict !== 'accepted') continue;
			if (drawable.visualRole === 'tee-shard') {
				const x = drawable.values?.localizedCenterXPx;
				const y = drawable.values?.localizedCenterYPx;
				if (Number.isFinite(x) && Number.isFinite(y)) recoveredCenters.push([x!, y!]);
			} else if (drawable.type === 'point' && drawable.visualRole === 'phantom-center') {
				recoveredCenters.push([drawable.xPx, drawable.yPx]);
			}
		}
	}
	const uniqueRecovered = [...new Map(recoveredCenters.map(([x, y]) => [`${x},${y}`, [x, y] as const])).values()]
		.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
	uniqueRecovered.forEach((center, index) => teeCenters.set(`tee-recovered-${index}`, center));

	const basketCenters = new Map<string, readonly [number, number]>();
	const baskets = run.units.find((unit) => unit.id === 'baskets');
	for (const drawable of baskets?.drawables ?? []) {
		if (drawable.type !== 'point') continue;
		if (drawable.visualRole !== 'basket-tip' && !drawable.ref?.endsWith(':semantic-tip')) continue;
		const id = refObjectId(drawable.ref, ':semantic-tip');
		if (id) basketCenters.set(id, [drawable.xPx, drawable.yPx]);
	}

	const labels: EndpointNumberLabel[] = [];
	for (const row of assignments) {
		const hole = exactHole(row.hole);
		if (hole === undefined) continue;
		const tee = teeCenters.get(row.teeId);
		if (tee) labels.push({ kind: 'tee', hole, text: `T${hole}`, endpointId: row.teeId, xPx: tee[0], yPx: tee[1] });
		const basket = basketCenters.get(row.basketId);
		if (basket) labels.push({ kind: 'basket', hole, text: `B${hole}`, endpointId: row.basketId, xPx: basket[0], yPx: basket[1] });
	}
	return labels;
}

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
	T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
	B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
	0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
	1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
	2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
	3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
	4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
	5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
	6: ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
	7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
	8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
	9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110']
};

function pixel(data: Uint8Array, width: number, height: number, x: number, y: number, color: readonly [number, number, number]): void {
	if (x < 0 || y < 0 || x >= width || y >= height) return;
	const i = (y * width + x) * 4;
	data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2]; data[i + 3] = 255;
}

function glyphPixels(text: string, scale = 2): readonly (readonly [number, number])[] {
	const out: Array<readonly [number, number]> = [];
	let cursor = 0;
	for (const char of text) {
		const glyph = GLYPHS[char];
		if (!glyph) continue;
		for (let gy = 0; gy < glyph.length; gy++) for (let gx = 0; gx < glyph[gy]!.length; gx++) {
			if (glyph[gy]![gx] !== '1') continue;
			for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) out.push([cursor + gx * scale + sx, gy * scale + sy]);
		}
		cursor += 6 * scale;
	}
	return out;
}

function drawLabel(png: PNG, label: EndpointNumberLabel): void {
	const pixels = glyphPixels(label.text);
	const glyphWidth = Math.max(1, ...pixels.map(([x]) => x + 1));
	const glyphHeight = Math.max(1, ...pixels.map(([, y]) => y + 1));
	let x0 = Math.round(label.xPx + 7);
	let y0 = Math.round(label.yPx - glyphHeight / 2);
	if (x0 + glyphWidth + 1 >= png.width) x0 = Math.round(label.xPx - glyphWidth - 7);
	y0 = Math.max(1, Math.min(png.height - glyphHeight - 2, y0));
	const black = [0, 0, 0] as const;
	const color = label.kind === 'tee' ? [30, 255, 95] as const : [255, 40, 220] as const;
	const occupied = new Set(pixels.map(([x, y]) => `${x},${y}`));
	for (const [x, y] of pixels) {
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (occupied.has(`${x + dx},${y + dy}`)) continue;
			pixel(png.data, png.width, png.height, x0 + x + dx, y0 + y + dy, black);
		}
	}
	for (const [x, y] of pixels) pixel(png.data, png.width, png.height, x0 + x, y0 + y, color);
}

/** Number the already-written unified VisualRender in place. */
export function numberRunVisualEndpoints(input: {
	readonly run: RunTrace;
	readonly assignments: readonly HoleLabeledAssignment[];
	readonly outDir: string;
}): readonly EndpointNumberLabel[] {
	const labels = endpointNumberLabels(input.run, input.assignments);
	const path = resolve(input.outDir, 'renders', 'run', 'run.visual.png');
	const png = PNG.sync.read(readFileSync(path));
	for (const label of labels) drawLabel(png, label);
	writeFileSync(path, PNG.sync.write(png));
	return labels;
}
