import type { BadgeEvidence, CorridorParams, SupportFieldEvidence } from './types';
import type { RgbaImage } from './types';

const GAUSSIAN_SIGMA = 0.8;

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

function blurRgb(image: Float32Array, width: number, height: number): Float32Array {
	const radius = Math.max(1, Math.round(4 * GAUSSIAN_SIGMA));
	const kernel: number[] = [];
	let total = 0;
	for (let i = -radius; i <= radius; i++) {
		const value = Math.exp(-(i * i) / (2 * GAUSSIAN_SIGMA * GAUSSIAN_SIGMA));
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

function sampleRgb(image: Float32Array, width: number, height: number, x: number, y: number, channel: number): number {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const ax = x - x0;
	const ay = y - y0;
	const p00 = (reflect(y0, height) * width + reflect(x0, width)) * 3 + channel;
	const p10 = (reflect(y0, height) * width + reflect(x0 + 1, width)) * 3 + channel;
	const p01 = (reflect(y0 + 1, height) * width + reflect(x0, width)) * 3 + channel;
	const p11 = (reflect(y0 + 1, height) * width + reflect(x0 + 1, width)) * 3 + channel;
	return image[p00] * (1 - ax) * (1 - ay) + image[p10] * ax * (1 - ay) + image[p01] * (1 - ax) * ay + image[p11] * ax * ay;
}

function percentile(values: number[], fraction: number): number {
	if (!values.length) return 1;
	values.sort((a, b) => a - b);
	return values[Math.min(values.length - 1, Math.floor(fraction * (values.length - 1)))];
}

export function computeRibbonSupport(image: RgbaImage, parameters: CorridorParams): SupportFieldEvidence {
	const scale = parameters.fieldScale;
	const width = Math.max(1, Math.floor(image.width / scale));
	const height = Math.max(1, Math.floor(image.height / scale));
	const blurred = blurRgb(areaResizeRgb(image, width, height), width, height);
	const raw = new Float32Array(width * height);
	const bestTheta = new Float32Array(width * height);
	const delta = Math.max(1, 4 / scale);
	for (let orientation = 0; orientation < parameters.orientations; orientation++) {
		const theta = (Math.PI * orientation) / parameters.orientations;
		const nx = -Math.sin(theta);
		const ny = Math.cos(theta);
		for (const widthSrc of parameters.widthsSrc) {
			const radius = widthSrc / (2 * scale);
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const sample = (distance: number): [number, number, number] => {
						const sx = x + nx * distance;
						const sy = y + ny * distance;
						return [
							sampleRgb(blurred, width, height, sx, sy, 0),
							sampleRgb(blurred, width, height, sx, sy, 1),
							sampleRgb(blurred, width, height, sx, sy, 2)
						];
					};
					const a = sample(-(radius - delta));
					const b = sample(-(radius + delta));
					const c = sample(radius - delta);
					const d = sample(radius + delta);
					const d1 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
					const d2 = [c[0] - d[0], c[1] - d[1], c[2] - d[2]];
					const n1 = Math.hypot(...d1);
					const n2 = Math.hypot(...d2);
					const dot = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
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
	const norm = Math.max(percentile(Array.from(raw).filter((value) => value > 0), 0.995), 1e-6);
	const support = new Float32Array(raw.length);
	for (let i = 0; i < raw.length; i++) support[i] = Math.pow(Math.min(1, raw[i] / norm), 0.7);
	return {
		width,
		height,
		scale,
		support,
		bestTheta,
		parameters: {
			orientations: parameters.orientations,
			widthsSrc: [...parameters.widthsSrc],
			gaussianSigma: GAUSSIAN_SIGMA,
			normalizationPercentile: 0.995,
			gamma: 0.7
		}
	};
}

export function buildSupportCost(field: SupportFieldEvidence): Float32Array {
	const cost = new Float32Array(field.support.length);
	for (let i = 0; i < cost.length; i++) {
		const support = field.support[i];
		cost[i] = support < 0.12 ? 10 : 1 + 4 * (1 - support) ** 2;
	}
	return cost;
}

export function patchBadgeOcclusion(
	field: SupportFieldEvidence,
	image: RgbaImage,
	badges: readonly BadgeEvidence[],
	widthPx: number
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
	const inside = (x: number, y: number): boolean => badges.some((badge) => {
		const [bx, by, bw, bh] = badge.bbox;
		return x >= bx - 2 && x <= bx + bw + 2 && y >= by - 2 && y <= by + bh + 2;
	});
	for (const badge of badges) {
		const [bx, by, bw, bh] = badge.bbox;
		const x0 = Math.max(0, Math.floor((bx - 3) / field.scale));
		const x1 = Math.min(field.width - 1, Math.ceil((bx + bw + 3) / field.scale));
		const y0 = Math.max(0, Math.floor((by - 3) / field.scale));
		const y1 = Math.min(field.height - 1, Math.ceil((by + bh + 3) / field.scale));
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
			const cell = y * field.width + x;
			if (field.support[cell] > 0.5) {
				field.support[cell] = 0.5;
				haloCells++;
			}
		}
		if (!widthPx) continue;
		const reach = half + 6;
		for (let y = Math.max(0, Math.floor((by - reach) / field.scale)); y <= Math.min(field.height - 1, Math.ceil((by + bh + reach) / field.scale)); y++) {
			for (let x = Math.max(0, Math.floor((bx - reach) / field.scale)); x <= Math.min(field.width - 1, Math.ceil((bx + bw + reach) / field.scale)); x++) {
				const sx = x * field.scale + field.scale / 2;
				const sy = y * field.scale + field.scale / 2;
				let best = 0;
				for (let orientation = 0; orientation < 24; orientation++) {
					const theta = (orientation * Math.PI) / 24;
					const nx = -Math.sin(theta);
					const ny = Math.cos(theta);
					const points = [[sx - nx * (half - 2.5), sy - ny * (half - 2.5)], [sx - nx * (half + 2.5), sy - ny * (half + 2.5)], [sx + nx * (half - 2.5), sy + ny * (half - 2.5)], [sx + nx * (half + 2.5), sy + ny * (half + 2.5)]];
					const leftBlocked = inside(points[0][0], points[0][1]) || inside(points[1][0], points[1][1]);
					const rightBlocked = inside(points[2][0], points[2][1]) || inside(points[3][0], points[3][1]);
					if (leftBlocked === rightBlocked) continue;
					const side = leftBlocked ? [2, 3] : [0, 1];
					const inner = gray(points[side[0]][0], points[side[0]][1]);
					const outer = gray(points[side[1]][0], points[side[1]][1]);
					if (inner === null || outer === null || inside(points[side[0]][0], points[side[0]][1]) || inside(points[side[1]][0], points[side[1]][1])) continue;
					const lift = inner - outer;
					if (lift > 0) best = Math.max(best, Math.min(1, lift / 45));
				}
				if (best >= 0.5) {
					const cell = y * field.width + x;
					const next = Math.min(0.85, best);
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
