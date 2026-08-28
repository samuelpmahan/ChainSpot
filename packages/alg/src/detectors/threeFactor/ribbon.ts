import type { BadgeEvidence, CorridorParams, SupportFieldEvidence } from './types';
import type { RgbaImage } from './types';

/**
 * g5.ribbon knobs, threaded down as plain parameters from the resolving
 * unit(s). fieldScale/supportTau are NOT here: they already flow as
 * ThreeFactorParams -> CorridorParams (measure.ts's makeParameters), so the
 * engine bridges the resolved knob values in at that existing site (see
 * engine.ts's ribbonState handling) instead of re-plumbing them through
 * ribbon.ts's functions. They're still registered on g5RibbonFeature so
 * config deviations and the resolved-config hash see them.
 */
export interface RibbonKnobs {
	readonly gaussianSigma: number;
	readonly blurRadiusSigmas: number;
	readonly gradientDeltaMultiplier: number;
	readonly normalizationPercentile: number;
	readonly supportGamma: number;
	readonly costMultiplier: number;
	readonly haloSupportThreshold: number;
	readonly patchReachMargin: number;
	readonly sampleOffsetPx: number;
	readonly patchOrientations: number;
	readonly centerOuterGrayMargin: number;
	readonly liftThreshold: number;
	readonly patchAcceptanceThreshold: number;
	readonly patchedCellSupportCap: number;
	readonly haloBboxMargin: number;
	readonly insideBadgeMargin: number;
}

export const DEFAULT_RIBBON_KNOBS: RibbonKnobs = {
	gaussianSigma: 0.8,
	blurRadiusSigmas: 4,
	gradientDeltaMultiplier: 4,
	normalizationPercentile: 0.995,
	supportGamma: 0.7,
	costMultiplier: 4,
	haloSupportThreshold: 0.5,
	patchReachMargin: 6,
	sampleOffsetPx: 2.5,
	patchOrientations: 24,
	centerOuterGrayMargin: 8,
	liftThreshold: 45,
	patchAcceptanceThreshold: 0.5,
	patchedCellSupportCap: 0.85,
	haloBboxMargin: 3,
	insideBadgeMargin: 2
};

function reflect(index: number, size: number): number {
	if (size <= 1) return 0;
	if (index < 0) return -index;
	if (index >= size) return 2 * size - 2 - index;
	return index;
}

function areaResizeRgb(image: RgbaImage, width: number, height: number): Float32Array {
	const out = new Float32Array(width * height * 3);
	const sx = image.width / width;
	const sy = image.height / height;
	for (let y = 0; y < height; y++) {
		const y0 = y * sy;
		const y1 = y0 + sy;
		for (let x = 0; x < width; x++) {
			const x0 = x * sx;
			const x1 = x0 + sx;
			let r = 0;
			let g = 0;
			let b = 0;
			let total = 0;
			for (let yy = Math.floor(y0); yy < Math.min(image.height, Math.ceil(y1)); yy++) {
				const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
				for (let xx = Math.floor(x0); xx < Math.min(image.width, Math.ceil(x1)); xx++) {
					const weight = wy * (Math.min(x1, xx + 1) - Math.max(x0, xx));
					const p = (yy * image.width + xx) * 4;
					r += image.data[p] * weight;
					g += image.data[p + 1] * weight;
					b += image.data[p + 2] * weight;
					total += weight;
				}
			}
			const o = (y * width + x) * 3;
			out[o] = r / total;
			out[o + 1] = g / total;
			out[o + 2] = b / total;
		}
	}
	return out;
}

function blurRgb(
	image: Float32Array,
	width: number,
	height: number,
	knobs: RibbonKnobs
): Float32Array {
	const radius = Math.max(1, Math.round(knobs.blurRadiusSigmas * knobs.gaussianSigma));
	const kernel: number[] = [];
	let total = 0;
	for (let i = -radius; i <= radius; i++) {
		const value = Math.exp(-(i * i) / (2 * knobs.gaussianSigma * knobs.gaussianSigma));
		kernel.push(value);
		total += value;
	}
	for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
	const horizontal = new Float32Array(image.length);
	const output = new Float32Array(image.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 3;
			for (let k = -radius; k <= radius; k++) {
				const p = (y * width + reflect(x + k, width)) * 3;
				const weight = kernel[k + radius];
				horizontal[o] += image[p] * weight;
				horizontal[o + 1] += image[p + 1] * weight;
				horizontal[o + 2] += image[p + 2] * weight;
			}
		}
	}
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 3;
			for (let k = -radius; k <= radius; k++) {
				const p = (reflect(y + k, height) * width + x) * 3;
				const weight = kernel[k + radius];
				output[o] += horizontal[p] * weight;
				output[o + 1] += horizontal[p + 1] * weight;
				output[o + 2] += horizontal[p + 2] * weight;
			}
		}
	}
	return output;
}

function sampleRgbInto(
	image: Float32Array,
	width: number,
	height: number,
	x: number,
	y: number,
	out: Float64Array,
	offset: number
): void {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const ax = x - x0;
	const ay = y - y0;
	const rx0 = reflect(x0, width);
	const rx1 = reflect(x0 + 1, width);
	const ry0 = reflect(y0, height);
	const ry1 = reflect(y0 + 1, height);
	const p00 = (ry0 * width + rx0) * 3;
	const p10 = (ry0 * width + rx1) * 3;
	const p01 = (ry1 * width + rx0) * 3;
	const p11 = (ry1 * width + rx1) * 3;
	for (let channel = 0; channel < 3; channel++) {
		out[offset + channel] =
			image[p00 + channel] * (1 - ax) * (1 - ay) +
			image[p10 + channel] * ax * (1 - ay) +
			image[p01 + channel] * (1 - ax) * ay +
			image[p11 + channel] * ax * ay;
	}
}

function percentile(values: number[], fraction: number): number {
	if (!values.length) return 1;
	values.sort((a, b) => a - b);
	return values[Math.min(values.length - 1, Math.floor(fraction * (values.length - 1)))];
}

export function computeRibbonSupport(
	image: RgbaImage,
	parameters: CorridorParams,
	knobs: RibbonKnobs = DEFAULT_RIBBON_KNOBS
): SupportFieldEvidence {
	const scale = parameters.fieldScale;
	const width = Math.max(1, Math.floor(image.width / scale));
	const height = Math.max(1, Math.floor(image.height / scale));
	const blurred = blurRgb(areaResizeRgb(image, width, height), width, height, knobs);
	const raw = new Float32Array(width * height);
	const bestTheta = new Float32Array(width * height);
	const delta = Math.max(1, knobs.gradientDeltaMultiplier / scale);
	const samples = new Float64Array(12);
	for (let orientation = 0; orientation < parameters.orientations; orientation++) {
		const theta = (Math.PI * orientation) / parameters.orientations;
		const nx = -Math.sin(theta);
		const ny = Math.cos(theta);
		for (const widthSrc of parameters.widthsSrc) {
			const radius = widthSrc / (2 * scale);
			const distance0 = -(radius - delta);
			const distance1 = -(radius + delta);
			const distance2 = radius - delta;
			const distance3 = radius + delta;
			const ox0 = nx * distance0,
				oy0 = ny * distance0;
			const ox1 = nx * distance1,
				oy1 = ny * distance1;
			const ox2 = nx * distance2,
				oy2 = ny * distance2;
			const ox3 = nx * distance3,
				oy3 = ny * distance3;
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					sampleRgbInto(blurred, width, height, x + ox0, y + oy0, samples, 0);
					sampleRgbInto(blurred, width, height, x + ox1, y + oy1, samples, 3);
					sampleRgbInto(blurred, width, height, x + ox2, y + oy2, samples, 6);
					sampleRgbInto(blurred, width, height, x + ox3, y + oy3, samples, 9);
					const d1r = samples[0] - samples[3];
					const d1g = samples[1] - samples[4];
					const d1b = samples[2] - samples[5];
					const d2r = samples[6] - samples[9];
					const d2g = samples[7] - samples[10];
					const d2b = samples[8] - samples[11];
					const n1 = Math.hypot(d1r, d1g, d1b);
					const n2 = Math.hypot(d2r, d2g, d2b);
					const dot = d1r * d2r + d1g * d2g + d1b * d2b;
					if (dot <= 0) continue;
					const score = Math.min(n1, n2) * Math.min(1, dot / (n1 * n2 + 1e-6));
					const cell = y * width + x;
					if (score > raw[cell]) {
						raw[cell] = score;
						bestTheta[cell] = theta;
					}
				}
			}
		}
	}
	const norm = Math.max(
		percentile(
			Array.from(raw).filter((value) => value > 0),
			knobs.normalizationPercentile
		),
		1e-6
	);
	const support = new Float32Array(raw.length);
	for (let i = 0; i < raw.length; i++)
		support[i] = Math.pow(Math.min(1, raw[i] / norm), knobs.supportGamma);
	return {
		width,
		height,
		scale,
		support,
		bestTheta,
		parameters: {
			orientations: parameters.orientations,
			widthsSrc: [...parameters.widthsSrc],
			gaussianSigma: knobs.gaussianSigma,
			normalizationPercentile: knobs.normalizationPercentile,
			gamma: knobs.supportGamma
		}
	};
}

export function buildSupportCost(
	field: SupportFieldEvidence,
	knobs: RibbonKnobs = DEFAULT_RIBBON_KNOBS
): Float32Array {
	const cost = new Float32Array(field.support.length);
	for (let i = 0; i < cost.length; i++) {
		const support = field.support[i];
		cost[i] = 1 + knobs.costMultiplier * (1 - support) ** 2;
	}
	return cost;
}

export function patchBadgeOcclusion(
	field: SupportFieldEvidence,
	image: RgbaImage,
	badges: readonly BadgeEvidence[],
	widthPx: number,
	knobs: RibbonKnobs = DEFAULT_RIBBON_KNOBS
): { haloCells: number; patchedCells: number } {
	let haloCells = 0;
	let patchedCells = 0;
	const half = widthPx / 2;
	const gray = (x: number, y: number): number | null => {
		const ix = Math.round(x);
		const iy = Math.round(y);
		if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) return null;
		const p = (iy * image.width + ix) * 4;
		return (image.data[p] + image.data[p + 1] + image.data[p + 2]) / 3;
	};
	const inside = (x: number, y: number): boolean =>
		badges.some((badge) => {
			const [bx, by, bw, bh] = badge.bbox;
			return (
				x >= bx - knobs.insideBadgeMargin &&
				x <= bx + bw + knobs.insideBadgeMargin &&
				y >= by - knobs.insideBadgeMargin &&
				y <= by + bh + knobs.insideBadgeMargin
			);
		});
	for (const badge of badges) {
		const [bx, by, bw, bh] = badge.bbox;
		const x0 = Math.max(0, Math.floor((bx - knobs.haloBboxMargin) / field.scale));
		const x1 = Math.min(field.width - 1, Math.ceil((bx + bw + knobs.haloBboxMargin) / field.scale));
		const y0 = Math.max(0, Math.floor((by - knobs.haloBboxMargin) / field.scale));
		const y1 = Math.min(
			field.height - 1,
			Math.ceil((by + bh + knobs.haloBboxMargin) / field.scale)
		);
		for (let y = y0; y <= y1; y++)
			for (let x = x0; x <= x1; x++) {
				const cell = y * field.width + x;
				if (field.support[cell] > knobs.haloSupportThreshold) {
					field.support[cell] = knobs.haloSupportThreshold;
					haloCells++;
				}
			}
		if (!widthPx) continue;
		const reach = half + knobs.patchReachMargin;
		for (
			let y = Math.max(0, Math.floor((by - reach) / field.scale));
			y <= Math.min(field.height - 1, Math.ceil((by + bh + reach) / field.scale));
			y++
		) {
			for (
				let x = Math.max(0, Math.floor((bx - reach) / field.scale));
				x <= Math.min(field.width - 1, Math.ceil((bx + bw + reach) / field.scale));
				x++
			) {
				const sx = x * field.scale + field.scale / 2;
				const sy = y * field.scale + field.scale / 2;
				let best = 0;
				for (let orientation = 0; orientation < knobs.patchOrientations; orientation++) {
					const theta = (orientation * Math.PI) / knobs.patchOrientations;
					const nx = -Math.sin(theta);
					const ny = Math.cos(theta);
					const points = [
						[sx - nx * (half - knobs.sampleOffsetPx), sy - ny * (half - knobs.sampleOffsetPx)],
						[sx - nx * (half + knobs.sampleOffsetPx), sy - ny * (half + knobs.sampleOffsetPx)],
						[sx + nx * (half - knobs.sampleOffsetPx), sy + ny * (half - knobs.sampleOffsetPx)],
						[sx + nx * (half + knobs.sampleOffsetPx), sy + ny * (half + knobs.sampleOffsetPx)]
					];
					const leftBlocked =
						inside(points[0][0], points[0][1]) || inside(points[1][0], points[1][1]);
					const rightBlocked =
						inside(points[2][0], points[2][1]) || inside(points[3][0], points[3][1]);
					if (leftBlocked === rightBlocked) continue;
					const side = leftBlocked ? [2, 3] : [0, 1];
					const inner = gray(points[side[0]][0], points[side[0]][1]);
					const outer = gray(points[side[1]][0], points[side[1]][1]);
					if (
						inner === null ||
						outer === null ||
						inside(points[side[0]][0], points[side[0]][1]) ||
						inside(points[side[1]][0], points[side[1]][1])
					)
						continue;
					const lift = inner - outer;
					if (lift <= 0) continue;
					const center = gray(sx, sy);
					if (center !== null && !inside(sx, sy) && center - outer < -knobs.centerOuterGrayMargin)
						continue;
					best = Math.max(best, Math.min(1, lift / knobs.liftThreshold));
				}
				if (best >= knobs.patchAcceptanceThreshold) {
					const cell = y * field.width + x;
					const next = Math.min(knobs.patchedCellSupportCap, best);
					if (next > field.support[cell]) {
						field.support[cell] = next;
						patchedCells++;
					}
				}
			}
		}
	}
	return { haloCells, patchedCells };
}
