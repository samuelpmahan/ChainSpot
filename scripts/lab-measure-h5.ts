/**
 * One-off, crop-local H5 endpoint measurement. This does not alter detectors.
 * It combines their raw tee/basket measurements with independent raster fits:
 * a consensus badge-plate translation and two basket-circle center fits.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

type Point = { xPx: number; yPx: number };
type RGB = readonly [number, number, number];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = join(repoRoot, 'lab-artifacts', 'AlexClark');
const outputRoot = join(artifactRoot, 'oracle-v1', 'H05-point-fit');
const image = PNG.sync.read(readFileSync(join(artifactRoot, 'AlexClark-cropped.png')));

function pixel(x: number, y: number): RGB {
	const ix = Math.max(0, Math.min(image.width - 1, Math.round(x)));
	const iy = Math.max(0, Math.min(image.height - 1, Math.round(y)));
	const i = (iy * image.width + ix) * 4;
	return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

function bilinear(x: number, y: number): RGB {
	const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
	const p00 = pixel(x0, y0), p10 = pixel(x0 + 1, y0), p01 = pixel(x0, y0 + 1), p11 = pixel(x0 + 1, y0 + 1);
	return [0, 1, 2].map((c) =>
		p00[c] * (1 - tx) * (1 - ty) + p10[c] * tx * (1 - ty) + p01[c] * (1 - tx) * ty + p11[c] * tx * ty,
	) as unknown as RGB;
}

function luma(p: RGB): number { return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]; }
function greenExcess(p: RGB): number { return p[1] - (p[0] + p[2]) / 2; }
function round(v: number, n = 3): number { return Number(v.toFixed(n)); }

const badgeEvidence = JSON.parse(readFileSync(join(artifactRoot, 'sol-assisted-v1-evidence', 'badges.measurements.json'), 'utf8')) as {
	candidates: Array<{ decodedLabel: string; plate: { bbox: { x: number; y: number; width: number; height: number } } }>;
};
const teeEvidence = JSON.parse(readFileSync(join(artifactRoot, 'sol-assisted-v1-evidence', 'tees.measurements.json'), 'utf8')) as {
	rings: Array<{ cx: number; cy: number; holeArea: number; bboxX: number; bboxY: number; bboxW: number; bboxH: number; elongation: number; angle: number; ringFrac: number }>;
};
const basketEvidence = JSON.parse(readFileSync(join(artifactRoot, 'sol-assisted-v1-evidence', 'baskets.measurements.json'), 'utf8')) as {
	candidates: Array<{ x: number; y: number; cx: number; cy: number; tipX: number; tipY: number; onFrac: number; offFrac: number; score: number }>;
};

const tee = teeEvidence.rings.reduce((best, r) =>
	Math.hypot(r.cx - 472, r.cy - 1889) < Math.hypot(best.cx - 472, best.cy - 1889) ? r : best,
);
const basket = basketEvidence.candidates.reduce((best, c) =>
	Math.hypot(c.tipX - 760, c.tipY - 1905) < Math.hypot(best.tipX - 760, best.tipY - 1905) ? c : best,
);

// Build a renderer-specific badge-border consensus from clean, detected Alex plates.
// The middle is omitted so different numerals cannot pull the fitted center.
const plateWidth = 54, plateHeight = 42;
const training = badgeEvidence.candidates.filter((c) => c.plate.bbox.width >= 54 && c.plate.bbox.height === 42);
const expected: Array<'white' | 'black' | null> = [];
for (let y = 0; y < plateHeight; y++) {
	for (let x = 0; x < plateWidth; x++) {
		if (x > 8 && x < 45 && y > 6 && y < 34) { expected.push(null); continue; }
		let white = 0, black = 0;
		for (const candidate of training) {
			const p = pixel(candidate.plate.bbox.x + x, candidate.plate.bbox.y + y);
			const spread = Math.max(...p) - Math.min(...p);
			if (Math.min(...p) > 190 && spread < 45) white++;
			if (Math.max(...p) < 55) black++;
		}
		const needed = Math.ceil(training.length * 0.7);
		expected.push(white >= needed ? 'white' : black >= needed ? 'black' : null);
	}
}

function plateScore(x0: number, y0: number): { score: number; used: number; agreements: number; disagreements: number } {
	let agreements = 0, disagreements = 0, used = 0;
	for (let y = 0; y < plateHeight; y++) {
		for (let x = 0; x < plateWidth; x++) {
			const e = expected[y * plateWidth + x];
			if (!e) continue;
			const p = pixel(x0 + x, y0 + y);
			const spread = Math.max(...p) - Math.min(...p);
			const observed = Math.min(...p) > 175 && spread < 60 ? 'white' : Math.max(...p) < 75 ? 'black' : 'other';
			used++;
			if (observed === e) agreements++; else if (observed !== 'other') disagreements++;
		}
	}
	return { score: (agreements - disagreements) / used, used, agreements, disagreements };
}

const plateFits: Array<{ x: number; y: number; score: number; used: number; agreements: number; disagreements: number }> = [];
// H5's plate is directly above and partially merged with the H4 basket sprite.
// Search the visible plate, not the earlier blind point that landed in the sprite.
for (let y = 1870; y <= 1888; y++) for (let x = 589; x <= 602; x++) plateFits.push({ x, y, ...plateScore(x, y) });
plateFits.sort((a, b) => b.score - a.score);
const plateFit = plateFits[0];
const badgeCenter: Point = { xPx: plateFit.x + (plateWidth - 1) / 2, yPx: plateFit.y + (plateHeight - 1) / 2 };

// Inner translucent-circle boundary: maximize the green step from just inside
// to just outside the unobstructed lower semicircle.
function innerCircleScore(cx: number, cy: number, radius: number): number {
	const samples: number[] = [];
	for (let deg = 12; deg <= 168; deg += 2) {
		const a = deg * Math.PI / 180;
		const inside = bilinear(cx + (radius - 3) * Math.cos(a), cy + (radius - 3) * Math.sin(a));
		const outside = bilinear(cx + (radius + 3) * Math.cos(a), cy + (radius + 3) * Math.sin(a));
		samples.push(greenExcess(inside) - greenExcess(outside));
	}
	samples.sort((a, b) => a - b);
	const kept = samples.slice(Math.floor(samples.length * 0.15), Math.ceil(samples.length * 0.85));
	return kept.reduce((a, b) => a + b, 0) / kept.length;
}

let innerFit = { cx: 0, cy: 0, radius: 0, score: -Infinity };
for (let cy = 1899; cy <= 1911; cy += 0.5) for (let cx = 754; cx <= 766; cx += 0.5) for (let r = 38; r <= 50; r += 0.5) {
	const score = innerCircleScore(cx, cy, r);
	if (score > innerFit.score) innerFit = { cx, cy, radius: r, score };
}

// Outer dashed circle: maximize bright, neutral pixels on the circumference
// relative to samples 5 px inward/outward. Use the lower and side arcs; the
// upper arc is heavily occluded by the basket sprite.
function outerCircleScore(cx: number, cy: number, radius: number): number {
	const contrasts: number[] = [];
	for (let deg = -15; deg <= 195; deg += 2) {
		const a = deg * Math.PI / 180;
		const at = bilinear(cx + radius * Math.cos(a), cy + radius * Math.sin(a));
		const inner = bilinear(cx + (radius - 5) * Math.cos(a), cy + (radius - 5) * Math.sin(a));
		const outer = bilinear(cx + (radius + 5) * Math.cos(a), cy + (radius + 5) * Math.sin(a));
		const neutral = Math.max(...at) - Math.min(...at) < 55 ? 1 : 0.35;
		contrasts.push(neutral * Math.max(0, luma(at) - (luma(inner) + luma(outer)) / 2));
	}
	contrasts.sort((a, b) => b - a);
	const dashedArc = contrasts.slice(0, Math.ceil(contrasts.length * 0.42));
	return dashedArc.reduce((a, b) => a + b, 0) / dashedArc.length;
}

let outerFit = { cx: 0, cy: 0, radius: 0, score: -Infinity };
for (let cy = innerFit.cy - 5; cy <= innerFit.cy + 5; cy += 0.5) for (let cx = innerFit.cx - 5; cx <= innerFit.cx + 5; cx += 0.5) for (let r = 74; r <= 94; r += 0.5) {
	const score = outerCircleScore(cx, cy, r);
	if (score > outerFit.score) outerFit = { cx, cy, radius: r, score };
}

type EdgeSample = Point & { score: number };
function radialSamples(
	cx: number,
	cy: number,
	angles: number[],
	rMin: number,
	rMax: number,
	scoreAt: (cx: number, cy: number, radius: number, angle: number) => number,
	keepFraction: number,
): EdgeSample[] {
	const samples: EdgeSample[] = [];
	for (const degrees of angles) {
		const angle = degrees * Math.PI / 180;
		let best = { radius: rMin, score: -Infinity };
		for (let radius = rMin; radius <= rMax; radius += 0.25) {
			const score = scoreAt(cx, cy, radius, angle);
			if (score > best.score) best = { radius, score };
		}
		samples.push({ xPx: cx + best.radius * Math.cos(angle), yPx: cy + best.radius * Math.sin(angle), score: best.score });
	}
	const threshold = [...samples].sort((a, b) => b.score - a.score)[Math.max(0, Math.ceil(samples.length * keepFraction) - 1)]?.score ?? -Infinity;
	return samples.filter((sample) => sample.score >= threshold);
}

function solve3(matrix: number[][], vector: number[]): number[] {
	const a = matrix.map((row, i) => [...row, vector[i]]);
	for (let col = 0; col < 3; col++) {
		let pivot = col;
		for (let row = col + 1; row < 3; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
		[a[col], a[pivot]] = [a[pivot], a[col]];
		const divisor = a[col][col];
		for (let k = col; k < 4; k++) a[col][k] /= divisor;
		for (let row = 0; row < 3; row++) if (row !== col) {
			const factor = a[row][col];
			for (let k = col; k < 4; k++) a[row][k] -= factor * a[col][k];
		}
	}
	return [a[0][3], a[1][3], a[2][3]];
}

function algebraicCircle(points: Point[]): { cx: number; cy: number; radius: number } {
	const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
	for (const p of points) {
		const row = [p.xPx, p.yPx, 1], rhs = -(p.xPx * p.xPx + p.yPx * p.yPx);
		for (let i = 0; i < 3; i++) {
			v[i] += row[i] * rhs;
			for (let j = 0; j < 3; j++) m[i][j] += row[i] * row[j];
		}
	}
	const [d, e, f] = solve3(m, v), cx = -d / 2, cy = -e / 2;
	return { cx, cy, radius: Math.sqrt(Math.max(0, cx * cx + cy * cy - f)) };
}

function robustCircle(samples: EdgeSample[]): { fit: { cx: number; cy: number; radius: number }; inliers: EdgeSample[]; rmsePx: number } {
	let inliers = [...samples], fit = algebraicCircle(inliers);
	for (let iteration = 0; iteration < 4; iteration++) {
		const residuals = inliers.map((p) => Math.abs(Math.hypot(p.xPx - fit.cx, p.yPx - fit.cy) - fit.radius));
		const sorted = [...residuals].sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)] ?? 0;
		const cutoff = Math.max(1.25, median * 2.5);
		const next = inliers.filter((_, i) => residuals[i] <= cutoff);
		if (next.length < 8 || next.length === inliers.length) break;
		inliers = next; fit = algebraicCircle(inliers);
	}
	const rmsePx = Math.sqrt(inliers.reduce((sum, p) => {
		const residual = Math.hypot(p.xPx - fit.cx, p.yPx - fit.cy) - fit.radius;
		return sum + residual * residual;
	}, 0) / inliers.length);
	return { fit, inliers, rmsePx };
}

const innerRawSamples = radialSamples(
	innerFit.cx,
	innerFit.cy,
	Array.from({ length: 80 }, (_, i) => 10 + i * 2),
	30,
	52,
	(cx, cy, radius, angle) => greenExcess(bilinear(cx + (radius - 3) * Math.cos(angle), cy + (radius - 3) * Math.sin(angle)))
		- greenExcess(bilinear(cx + (radius + 3) * Math.cos(angle), cy + (radius + 3) * Math.sin(angle))),
	0.7,
);
const innerMeasured = robustCircle(innerRawSamples);
innerFit = { ...innerMeasured.fit, score: innerFit.score };

const outerRawSamples = radialSamples(
	outerFit.cx,
	outerFit.cy,
	Array.from({ length: 106 }, (_, i) => -15 + i * 2),
	66,
	100,
	(cx, cy, radius, angle) => {
		const at = bilinear(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
		const inside = bilinear(cx + (radius - 5) * Math.cos(angle), cy + (radius - 5) * Math.sin(angle));
		const outside = bilinear(cx + (radius + 5) * Math.cos(angle), cy + (radius + 5) * Math.sin(angle));
		const neutral = Math.max(...at) - Math.min(...at) < 55 ? 1 : 0.25;
		return neutral * Math.max(0, luma(at) - (luma(inside) + luma(outside)) / 2);
	},
	0.5,
);
const outerMeasured = robustCircle(outerRawSamples);
outerFit = { ...outerMeasured.fit, score: outerFit.score };

function distance(a: Point, b: Point): number { return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx); }
const circleConsensus: Point = {
	xPx: (innerFit.cx + outerFit.cx) / 2,
	yPx: (innerFit.cy + outerFit.cy) / 2,
};
const spriteTip: Point = { xPx: basket.tipX, yPx: basket.tipY };

const result = {
	schemaVersion: 1,
	course: 'AlexClark',
	hole: 5,
	coordinateFrame: 'canonical crop-local 1290x2082 raster',
	badge: {
		method: 'translation fit of consensus renderer plate border from 16 detected Alex plates; numeral interior excluded',
		bbox: { x: plateFit.x, y: plateFit.y, width: plateWidth, height: plateHeight },
		center: { xPx: round(badgeCenter.xPx), yPx: round(badgeCenter.yPx) },
		score: round(plateFit.score, 5),
		agreements: plateFit.agreements,
		disagreements: plateFit.disagreements,
		secondBest: plateFits[1],
	},
	tee: {
		method: 'existing detectTeeRings enclosed-hole centroid',
		center: { xPx: round(tee.cx), yPx: round(tee.cy) },
		holeAreaPx: tee.holeArea,
		interiorBbox: { x: tee.bboxX, y: tee.bboxY, width: tee.bboxW, height: tee.bboxH },
		elongation: round(tee.elongation),
		ringFraction: round(tee.ringFrac),
	},
	basket: {
		fixedSprite: {
			bbox: { x: basket.x, y: basket.y, width: 42, height: 66 },
			center: { xPx: basket.cx, yPx: basket.cy },
			poleTip: spriteTip,
			score: round(basket.score, 6),
		},
		innerCircleFit: { center: { xPx: innerFit.cx, yPx: innerFit.cy }, radiusPx: innerFit.radius, score: round(innerFit.score) },
		innerCircleSupport: { sampledPoints: innerRawSamples.length, inliers: innerMeasured.inliers.length, radialRmsePx: round(innerMeasured.rmsePx) },
		outerDashedCircleFit: { center: { xPx: outerFit.cx, yPx: outerFit.cy }, radiusPx: outerFit.radius, score: round(outerFit.score) },
		outerCircleSupport: { sampledPoints: outerRawSamples.length, inliers: outerMeasured.inliers.length, radialRmsePx: round(outerMeasured.rmsePx) },
		circleCenterConsensus: { xPx: round(circleConsensus.xPx), yPx: round(circleConsensus.yPx) },
		circleCentersSeparationPx: round(Math.hypot(innerFit.cx - outerFit.cx, innerFit.cy - outerFit.cy)),
		circleConsensusVsSpriteTipPx: round(distance(circleConsensus, spriteTip)),
	},
};

// Render a faithful nearest-neighbor crop. The underlying pixels are unchanged;
// only vectors are drawn over the enlarged copy.
const x0 = 420, y0 = 1810, width = 390, height = 230, scale = 3;
const out = new PNG({ width: width * scale, height: height * scale });
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
	const src = ((y0 + y) * image.width + x0 + x) * 4;
	for (let yy = 0; yy < scale; yy++) for (let xx = 0; xx < scale; xx++) {
		const dst = (((y * scale + yy) * out.width) + x * scale + xx) * 4;
		out.data[dst] = image.data[src]; out.data[dst + 1] = image.data[src + 1]; out.data[dst + 2] = image.data[src + 2]; out.data[dst + 3] = 255;
	}
}

function set(x: number, y: number, color: RGB): void {
	if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
	const i = (Math.round(y) * out.width + Math.round(x)) * 4;
	out.data[i] = color[0]; out.data[i + 1] = color[1]; out.data[i + 2] = color[2]; out.data[i + 3] = 255;
}
function local(p: Point): Point { return { xPx: (p.xPx - x0) * scale, yPx: (p.yPx - y0) * scale }; }
function line(a: Point, b: Point, color: RGB, thick = 2): void {
	const n = Math.ceil(Math.hypot(b.xPx - a.xPx, b.yPx - a.yPx));
	for (let i = 0; i <= n; i++) {
		const t = i / Math.max(1, n), x = a.xPx + (b.xPx - a.xPx) * t, y = a.yPx + (b.yPx - a.yPx) * t;
		for (let dy = -thick; dy <= thick; dy++) for (let dx = -thick; dx <= thick; dx++) if (dx * dx + dy * dy <= thick * thick) set(x + dx, y + dy, color);
	}
}
function cross(p: Point, color: RGB, radius = 10): void {
	const q = local(p);
	line({ xPx: q.xPx - radius, yPx: q.yPx - radius }, { xPx: q.xPx + radius, yPx: q.yPx + radius }, color, 2);
	line({ xPx: q.xPx - radius, yPx: q.yPx + radius }, { xPx: q.xPx + radius, yPx: q.yPx - radius }, color, 2);
}
function circle(p: Point, radiusPx: number, color: RGB): void {
	const q = local(p), r = radiusPx * scale;
	for (let deg = 0; deg < 360; deg += 0.2) {
		const a = deg * Math.PI / 180;
		for (let w = -1; w <= 1; w++) set(q.xPx + (r + w) * Math.cos(a), q.yPx + (r + w) * Math.sin(a), color);
	}
}
function dot(p: Point, color: RGB, radius = 2): void {
	const q = local(p);
	for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) if (dx * dx + dy * dy <= radius * radius) set(q.xPx + dx, q.yPx + dy, color);
}
function box(x: number, y: number, w: number, h: number, color: RGB): void {
	const a = local({ xPx: x, yPx: y }), b = local({ xPx: x + w - 1, yPx: y + h - 1 });
	line(a, { xPx: b.xPx, yPx: a.yPx }, color); line({ xPx: b.xPx, yPx: a.yPx }, b, color);
	line(b, { xPx: a.xPx, yPx: b.yPx }, color); line({ xPx: a.xPx, yPx: b.yPx }, a, color);
}

const badgeColor: RGB = [0, 235, 255], teeColor: RGB = [255, 55, 70], basketColor: RGB = [255, 220, 0];
box(plateFit.x, plateFit.y, plateWidth, plateHeight, badgeColor);
box(tee.bboxX, tee.bboxY, tee.bboxW, tee.bboxH, teeColor);
for (const point of innerMeasured.inliers) dot(point, [50, 255, 120], 3);
for (const point of outerMeasured.inliers) dot(point, [180, 100, 255], 3);
circle({ xPx: innerFit.cx, yPx: innerFit.cy }, innerFit.radius, [20, 160, 70]);
circle({ xPx: outerFit.cx, yPx: outerFit.cy }, outerFit.radius, [110, 45, 180]);
cross(badgeCenter, badgeColor, 12); cross({ xPx: tee.cx, yPx: tee.cy }, teeColor, 12); cross(circleConsensus, basketColor, 12);
line(local({ xPx: tee.cx, yPx: tee.cy }), local(badgeCenter), [255, 255, 255], 1);
line(local(badgeCenter), local(circleConsensus), [255, 255, 255], 1);

mkdirSync(outputRoot, { recursive: true });
writeFileSync(join(outputRoot, 'H05-points-overlay.png'), PNG.sync.write(out));
writeFileSync(join(outputRoot, 'H05-point-measurements.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
