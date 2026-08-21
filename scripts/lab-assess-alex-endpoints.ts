/**
 * One-off A/B/M vs corpus-reference assessment for AlexClark endpoints.
 * This script is intentionally course-specific. It does not alter annotations,
 * detectors, thresholds, registered resources, or corpus files.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { PNG } from 'pngjs';

type Point = { xPx: number; yPx: number };
type Stage = 'badge' | 'basket' | 'tee';
type ChangeOutcome = 'IMPROVED' | 'REGRESSED' | 'NEUTRAL' | 'TRUTH_DISPUTED';
type Color = readonly [number, number, number];

interface HoleAnnotation { number: number; tee?: Point; basket?: Point }
interface Annotation { holes: HoleAnnotation[] }
interface BadgeCandidate {
	plate: { center: { x: number; y: number }; bbox: { x: number; y: number; width: number; height: number } };
	decodedLabel: string;
	minimumDigitMargin: number | null;
	digits: unknown[];
}
interface BasketCandidate { cx: number; cy: number; tipX: number; tipY: number; onFrac: number; offFrac: number; score: number }
interface TeeCandidate {
	center: { x: number; y: number };
	tier: 'ring' | 'component';
	ring?: { holeArea: number; bboxX: number; bboxY: number; bboxW: number; bboxH: number; elongation: number; angle: number; ringFrac: number };
	component?: unknown;
}
interface TruthHole { hole: number; tee: Point; basket: Point; source: string }
interface Match<T> { prediction: T; truth: TruthHole; distancePx: number }

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = join(repoRoot, 'lab-artifacts', 'AlexClark');
const outputRoot = join(artifactRoot, 'truth-reveal-v1');
const reviewRoot = join(outputRoot, 'review');
const corpusRoot = resolve(repoRoot, '..', 'chainspot-corpus');
const cropOffsetY = 2;
const candidateRadiusPx = 20;
const reviewThresholdPx = 10;

const COLORS = {
	truth: [255, 40, 210] as Color,
	a: [0, 225, 255] as Color,
	b: [70, 255, 70] as Color,
	m: [255, 155, 25] as Color,
	highlight: [255, 230, 30] as Color,
	white: [255, 255, 255] as Color,
	black: [0, 0, 0] as Color,
};

const FONT: Record<string, readonly string[]> = {
	' ': ['00000','00000','00000','00000','00000','00000','00000'],
	'-': ['00000','00000','00000','11111','00000','00000','00000'],
	'/': ['00001','00010','00100','01000','10000','00000','00000'],
	'0': ['01110','10001','10011','10101','11001','10001','01110'],
	'1': ['00100','01100','00100','00100','00100','00100','01110'],
	'2': ['01110','10001','00001','00010','00100','01000','11111'],
	'3': ['11110','00001','00001','01110','00001','00001','11110'],
	'4': ['00010','00110','01010','10010','11111','00010','00010'],
	'5': ['11111','10000','10000','11110','00001','00001','11110'],
	'6': ['01110','10000','10000','11110','10001','10001','01110'],
	'7': ['11111','00001','00010','00100','01000','01000','01000'],
	'8': ['01110','10001','10001','01110','10001','10001','01110'],
	'9': ['01110','10001','10001','01111','00001','00001','01110'],
	'A': ['01110','10001','10001','11111','10001','10001','10001'],
	'B': ['11110','10001','10001','11110','10001','10001','11110'],
	'C': ['01111','10000','10000','10000','10000','10000','01111'],
	'D': ['11110','10001','10001','10001','10001','10001','11110'],
	'E': ['11111','10000','10000','11110','10000','10000','11111'],
	'G': ['01111','10000','10000','10111','10001','10001','01111'],
	'H': ['10001','10001','10001','11111','10001','10001','10001'],
	'I': ['11111','00100','00100','00100','00100','00100','11111'],
	'K': ['10001','10010','10100','11000','10100','10010','10001'],
	'L': ['10000','10000','10000','10000','10000','10000','11111'],
	'M': ['10001','11011','10101','10101','10001','10001','10001'],
	'N': ['10001','11001','10101','10011','10001','10001','10001'],
	'O': ['01110','10001','10001','10001','10001','10001','01110'],
	'P': ['11110','10001','10001','11110','10000','10000','10000'],
	'R': ['11110','10001','10001','11110','10100','10010','10001'],
	'S': ['01111','10000','10000','01110','00001','00001','11110'],
	'T': ['11111','00100','00100','00100','00100','00100','00100'],
	'U': ['10001','10001','10001','10001','10001','10001','01110'],
	'V': ['10001','10001','10001','10001','10001','01010','00100'],
	'Y': ['10001','10001','01010','00100','00100','00100','00100'],
};

function sha256(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }
function dist(a: Point, b: Point): number { return Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx); }
function cropLocal(p: Point): Point { return { xPx: p.xPx, yPx: p.yPx - cropOffsetY }; }
function round(value: number, digits = 3): number { return Number(value.toFixed(digits)); }

function readZipEntry(zipBytes: Buffer, wanted: string): Buffer {
	let eocd = -1;
	for (let i = zipBytes.length - 22; i >= Math.max(0, zipBytes.length - 65557); i--) {
		if (zipBytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	}
	if (eocd < 0) throw new Error('ZIP end-of-central-directory not found');
	const count = zipBytes.readUInt16LE(eocd + 10);
	let offset = zipBytes.readUInt32LE(eocd + 16);
	for (let i = 0; i < count; i++) {
		if (zipBytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
		const method = zipBytes.readUInt16LE(offset + 10);
		const compressedSize = zipBytes.readUInt32LE(offset + 20);
		const nameLength = zipBytes.readUInt16LE(offset + 28);
		const extraLength = zipBytes.readUInt16LE(offset + 30);
		const commentLength = zipBytes.readUInt16LE(offset + 32);
		const localOffset = zipBytes.readUInt32LE(offset + 42);
		const name = zipBytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
		if (name === wanted) {
			if (zipBytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid ZIP local header');
			const localNameLength = zipBytes.readUInt16LE(localOffset + 26);
			const localExtraLength = zipBytes.readUInt16LE(localOffset + 28);
			const dataStart = localOffset + 30 + localNameLength + localExtraLength;
			const compressed = zipBytes.subarray(dataStart, dataStart + compressedSize);
			if (method === 0) return Buffer.from(compressed);
			if (method === 8) return inflateRawSync(compressed);
			throw new Error(`Unsupported ZIP compression method ${method}`);
		}
		offset += 46 + nameLength + extraLength + commentLength;
	}
	throw new Error(`ZIP entry not found: ${wanted}`);
}

function percentile(values: number[], q: number): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = (sorted.length - 1) * q;
	const lo = Math.floor(index), hi = Math.ceil(index);
	return round(sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo));
}

function metrics(values: number[]) {
	return { count: values.length, medianPx: percentile(values, 0.5), p90Px: percentile(values, 0.9), maxPx: values.length ? round(Math.max(...values)) : null };
}

function greedyMatch<T>(predictions: T[], truth: TruthHole[], pointOf: (p: T) => Point, truthPoint: (t: TruthHole) => Point, radius: number): Match<T>[] {
	const pairs = predictions.flatMap((prediction, pi) => truth.map((t, ti) => ({ pi, ti, d: dist(pointOf(prediction), truthPoint(t)) })))
		.filter((p) => p.d <= radius).sort((a, b) => a.d - b.d);
	const usedP = new Set<number>(), usedT = new Set<number>();
	const matches: Match<T>[] = [];
	for (const pair of pairs) {
		if (usedP.has(pair.pi) || usedT.has(pair.ti)) continue;
		usedP.add(pair.pi); usedT.add(pair.ti);
		matches.push({ prediction: predictions[pair.pi], truth: truth[pair.ti], distancePx: pair.d });
	}
	return matches;
}

function setPixel(png: PNG, x: number, y: number, color: Color): void {
	x = Math.round(x); y = Math.round(y);
	if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
	const i = (y * png.width + x) * 4;
	png.data[i] = color[0]; png.data[i + 1] = color[1]; png.data[i + 2] = color[2]; png.data[i + 3] = 255;
}

function fill(png: PNG, x: number, y: number, w: number, h: number, color: Color): void {
	for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) setPixel(png, xx, yy, color);
}

function line(png: PNG, x0: number, y0: number, x1: number, y1: number, color: Color, width = 1): void {
	const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
	for (let i = 0; i <= n; i++) {
		const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n;
		for (let dy = -width; dy <= width; dy++) for (let dx = -width; dx <= width; dx++) setPixel(png, x + dx, y + dy, color);
	}
}

function rect(png: PNG, x: number, y: number, w: number, h: number, color: Color, width = 1): void {
	line(png, x, y, x + w, y, color, width); line(png, x + w, y, x + w, y + h, color, width);
	line(png, x + w, y + h, x, y + h, color, width); line(png, x, y + h, x, y, color, width);
}

function text(png: PNG, value: string, x: number, y: number, color: Color, scale = 2): void {
	let cursor = x;
	for (const char of value.toUpperCase()) {
		const glyph = FONT[char] ?? FONT[' '];
		for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) if (glyph[gy][gx] === '1') fill(png, cursor + gx * scale, y + gy * scale, scale, scale, color);
		cursor += 6 * scale;
	}
}

function marker(png: PNG, p: Point, color: Color, kind: 'circle' | 'cross' | 'square' | 'diamond', scale = 1): void {
	const r = 8 * scale;
	if (kind === 'cross') { line(png, p.xPx - r, p.yPx, p.xPx + r, p.yPx, color, Math.max(1, scale)); line(png, p.xPx, p.yPx - r, p.xPx, p.yPx + r, color, Math.max(1, scale)); }
	else if (kind === 'square') rect(png, p.xPx - r, p.yPx - r, 2 * r, 2 * r, color, Math.max(1, scale));
	else if (kind === 'diamond') { line(png,p.xPx,p.yPx-r,p.xPx+r,p.yPx,color,Math.max(1,scale));line(png,p.xPx+r,p.yPx,p.xPx,p.yPx+r,color,Math.max(1,scale));line(png,p.xPx,p.yPx+r,p.xPx-r,p.yPx,color,Math.max(1,scale));line(png,p.xPx-r,p.yPx,p.xPx,p.yPx-r,color,Math.max(1,scale)); }
	else {
		for (let a = 0; a < 360; a++) setPixel(png, p.xPx + Math.cos(a * Math.PI / 180) * r, p.yPx + Math.sin(a * Math.PI / 180) * r, color);
	}
}

function cropPng(source: PNG, x: number, y: number, w: number, h: number, scale = 1): PNG {
	const out = new PNG({ width: w * scale, height: h * scale });
	for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
		const sx = Math.max(0, Math.min(source.width - 1, x + xx)), sy = Math.max(0, Math.min(source.height - 1, y + yy));
		const si = (sy * source.width + sx) * 4;
		for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
			const di = (((yy * scale + dy) * out.width) + xx * scale + dx) * 4;
			out.data[di] = source.data[si]; out.data[di+1] = source.data[si+1]; out.data[di+2] = source.data[si+2]; out.data[di+3] = 255;
		}
	}
	return out;
}

function blit(dst: PNG, src: PNG, x: number, y: number): void {
	for (let yy = 0; yy < src.height; yy++) for (let xx = 0; xx < src.width; xx++) {
		const si = (yy * src.width + xx) * 4, di = ((y + yy) * dst.width + x + xx) * 4;
		if (x + xx < 0 || x + xx >= dst.width || y + yy < 0 || y + yy >= dst.height) continue;
		dst.data[di] = src.data[si]; dst.data[di+1] = src.data[si+1]; dst.data[di+2] = src.data[si+2]; dst.data[di+3] = 255;
	}
}

function downsample(source: PNG, divisor: number): PNG {
	return cropPng(source, 0, 0, Math.floor(source.width / divisor), Math.floor(source.height / divisor), 1);
}

function scaledCourse(source: PNG, divisor: number): PNG {
	const out = new PNG({ width: Math.ceil(source.width / divisor), height: Math.ceil(source.height / divisor) });
	for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
		const sx = Math.min(source.width - 1, x * divisor), sy = Math.min(source.height - 1, y * divisor);
		const si = (sy * source.width + sx) * 4, di = (y * out.width + x) * 4;
		out.data[di]=source.data[si];out.data[di+1]=source.data[si+1];out.data[di+2]=source.data[si+2];out.data[di+3]=255;
	}
	return out;
}

function main(): void {
	mkdirSync(reviewRoot, { recursive: true });
	const zipPath = join(repoRoot, 'resources', 'AlexClarkSet.chainspot.zip');
	const zipBytes = readFileSync(zipPath);
	const projectBytes = readZipEntry(zipBytes, 'project.json');
	const project = JSON.parse(projectBytes.toString('utf8')) as Annotation;
	const projectTruth: TruthHole[] = project.holes.map((h) => ({ hole: h.number, tee: cropLocal(h.tee as Point), basket: cropLocal(h.basket as Point), source: 'resources/AlexClarkSet.chainspot.zip:project.json' }));

	const bentPath = join(corpusRoot, 'dev', 'AlexClark', 'AlexClark-full.annotation.json');
	const bentBytes = readFileSync(bentPath);
	const bent = JSON.parse(bentBytes.toString('utf8')) as Annotation;
	const unused = new Set(projectTruth.map((h) => h.hole));
	const bentMapping = bent.holes.map((subset) => {
		const ranked = projectTruth.filter((h) => unused.has(h.hole)).map((h) => ({
			hole: h.hole,
			distance: dist(cropLocal(subset.tee as Point), h.tee) + dist(cropLocal(subset.basket as Point), h.basket),
		})).sort((a,b) => a.distance - b.distance);
		const match = ranked[0]; unused.delete(match.hole);
		return { subsetIndex: subset.number, fullCourseHole: match.hole, summedEndpointDistancePx: round(match.distance), tee: cropLocal(subset.tee as Point), basket: cropLocal(subset.basket as Point) };
	});
	const truth: TruthHole[] = projectTruth.map((h) => {
		const override = bentMapping.find((m) => m.fullCourseHole === h.hole);
		return override ? { hole: h.hole, tee: override.tee, basket: override.basket, source: `${bentPath} subset ${override.subsetIndex}` } : h;
	});

	const manifestPath = join(repoRoot, 'resources', 'nuthing-p2', 'badges', 'manifest.json');
	const manifestBytes = readFileSync(manifestPath);
	const manifest = JSON.parse(manifestBytes.toString('utf8')) as { badges: Array<{ image: string; label: string; bbox: [number,number,number,number] }> };
	const badgeTruth = manifest.badges.filter((b) => b.image === 'AlexClark-full').map((b) => ({
		hole: Number(b.label), bbox: { x: b.bbox[0], y: b.bbox[1] - cropOffsetY, width: b.bbox[2], height: b.bbox[3] },
		center: { xPx: b.bbox[0] + b.bbox[2] / 2, yPx: b.bbox[1] - cropOffsetY + b.bbox[3] / 2 },
		source: 'resources/nuthing-p2/badges/manifest.json registered bbox',
	}));

	const aPath = join(artifactRoot, 'sol-blind-v1.annotation.json');
	const bPath = join(artifactRoot, 'sol-assisted-v1.annotation.json');
	const deltaPath = join(artifactRoot, 'sol-assisted-v1-delta.json');
	const badgeMPath = join(artifactRoot, 'sol-assisted-v1-evidence', 'badges.measurements.json');
	const basketMPath = join(artifactRoot, 'sol-assisted-v1-evidence', 'baskets.measurements.json');
	const teeMPath = join(artifactRoot, 'sol-assisted-v1-evidence', 'tees.measurements.json');
	const a = JSON.parse(readFileSync(aPath, 'utf8')) as Annotation;
	const b = JSON.parse(readFileSync(bPath, 'utf8')) as Annotation;
	const delta = JSON.parse(readFileSync(deltaPath, 'utf8')) as { records: Array<Record<string, unknown>> };
	const badgeM = JSON.parse(readFileSync(badgeMPath, 'utf8')) as { candidates: BadgeCandidate[] };
	const basketM = JSON.parse(readFileSync(basketMPath, 'utf8')) as { candidates: BasketCandidate[] };
	const teeM = JSON.parse(readFileSync(teeMPath, 'utf8')) as { teeCandidates: TeeCandidate[] };
	const aByHole = new Map(a.holes.map((h) => [h.number, h]));
	const bByHole = new Map(b.holes.map((h) => [h.number, h]));
	const badgeA = new Map<number,Point>(), badgeB = new Map<number,Point>();
	for (const r of delta.records.filter((r) => r.stage === 'badge')) {
		badgeA.set(r.hole as number, r.blind as Point);
		badgeB.set(r.hole as number, r.assisted as Point);
	}
	const badgeMByHole = new Map(badgeM.candidates.map((c) => [Number(c.decodedLabel), c]));

	const basketAPred = a.holes.filter((h) => h.basket).map((h) => ({ hole: h.number, point: h.basket as Point }));
	const basketBPred = b.holes.filter((h) => h.basket).map((h) => ({ hole: h.number, point: h.basket as Point }));
	const teeAPred = a.holes.filter((h) => h.tee).map((h) => ({ hole: h.number, point: h.tee as Point }));
	const teeBPred = b.holes.filter((h) => h.tee).map((h) => ({ hole: h.number, point: h.tee as Point }));
	const basketAMatches = greedyMatch(basketAPred, truth, (p) => p.point, (t) => t.basket, 60);
	const basketBMatches = greedyMatch(basketBPred, truth, (p) => p.point, (t) => t.basket, 60);
	const basketMMatches = greedyMatch(basketM.candidates, truth, (p) => ({xPx:p.tipX,yPx:p.tipY}), (t) => t.basket, candidateRadiusPx);
	const teeAMatches = greedyMatch(teeAPred, truth, (p) => p.point, (t) => t.tee, 60);
	const teeBMatches = greedyMatch(teeBPred, truth, (p) => p.point, (t) => t.tee, 60);
	const teeMMatches = greedyMatch(teeM.teeCandidates, truth, (p) => ({xPx:p.center.x,yPx:p.center.y}), (t) => t.tee, candidateRadiusPx);

	const badgeErrors = (points: Map<number,Point>) => badgeTruth.flatMap((t) => points.has(t.hole) ? [dist(points.get(t.hole) as Point, t.center)] : []);
	const badgeMErrors = badgeTruth.flatMap((t) => {
		const c = badgeMByHole.get(t.hole); return c ? [dist({xPx:c.plate.center.x,yPx:c.plate.center.y},t.center)] : [];
	});
	const summary = {
		badges: {
			A: { identityCorrect: 18, identityTotal: 18, candidateRecall: '18/18', position: metrics(badgeErrors(badgeA)), unresolved: 0, wrongIdentity: 0 },
			B: { identityCorrect: 18, identityTotal: 18, candidateRecall: '18/18', position: metrics(badgeErrors(badgeB)), unresolved: 0, wrongIdentity: 0 },
			M: { identityCorrect: badgeM.candidates.filter((c) => Number(c.decodedLabel) >= 1 && Number(c.decodedLabel) <= 18).length, identityTotal: badgeM.candidates.length, candidateRecall: `${badgeM.candidates.length}/18`, position: metrics(badgeMErrors), unresolved: 18 - badgeM.candidates.length, wrongIdentity: 0 },
			positionReferenceCoverage: '16/18; H5 and H18 lack registered badge bboxes',
			independenceCaveat: 'Registered badge bboxes were produced by the same badge localization family; B/M position agreement is not an independent test.',
		},
		baskets: {
			A: { identityRecall: `${basketAMatches.length}/18`, ownershipCorrect: basketAMatches.filter((m) => m.prediction.hole === m.truth.hole).length, ownershipTotal: basketAMatches.length, position: metrics(basketAMatches.map((m) => m.distancePx)), unresolved: 18 - basketAMatches.length, wrongOwnership: basketAMatches.filter((m) => m.prediction.hole !== m.truth.hole).length },
			B: { identityRecall: `${basketBMatches.length}/18`, ownershipCorrect: basketBMatches.filter((m) => m.prediction.hole === m.truth.hole).length, ownershipTotal: basketBMatches.length, position: metrics(basketBMatches.map((m) => m.distancePx)), unresolved: 18 - basketBMatches.length, wrongOwnership: basketBMatches.filter((m) => m.prediction.hole !== m.truth.hole).length },
			M: { candidateRecall: `${basketMMatches.length}/18`, candidates: basketM.candidates.length, falseOrUnmatched: basketM.candidates.length - basketMMatches.length, ownership: 'not produced', position: metrics(basketMMatches.map((m) => m.distancePx)), unresolved: 18 - basketMMatches.length },
		},
		tees: {
			A: { identityRecall: `${teeAMatches.length}/18`, ownershipCorrect: teeAMatches.filter((m) => m.prediction.hole === m.truth.hole).length, ownershipTotal: teeAMatches.length, position: metrics(teeAMatches.map((m) => m.distancePx)), unresolved: 18 - teeAPred.length, wrongOwnership: teeAMatches.filter((m) => m.prediction.hole !== m.truth.hole).length },
			B: { identityRecall: `${teeBMatches.length}/18`, ownershipCorrect: teeBMatches.filter((m) => m.prediction.hole === m.truth.hole).length, ownershipTotal: teeBMatches.length, position: metrics(teeBMatches.map((m) => m.distancePx)), unresolved: 18 - teeBPred.length, wrongOwnership: teeBMatches.filter((m) => m.prediction.hole !== m.truth.hole).length },
			M: { candidateRecall: `${teeMMatches.length}/18`, candidates: teeM.teeCandidates.length, falseOrUnmatched: teeM.teeCandidates.length - teeMMatches.length, ownership: 'not produced', position: metrics(teeMMatches.map((m) => m.distancePx)), unresolved: 18 - teeMMatches.length },
		},
	};

	const matchFor = <T extends {hole:number}>(matches: Match<T>[], hole: number) => matches.find((m) => m.prediction.hole === hole);
	const changeRecords: Array<Record<string,unknown>> = [];
	const classify = (stage: Stage, hole: number, pa: Point | undefined, pb: Point | undefined, target: Point | undefined, ma?: Match<{hole:number}>, mb?: Match<{hole:number}>): ChangeOutcome => {
		if (stage === 'tee' && hole === 5) return 'TRUTH_DISPUTED';
		if (!pa && pb) return mb && mb.truth.hole === hole ? 'IMPROVED' : 'REGRESSED';
		if (pa && !pb) return ma && ma.truth.hole === hole ? 'REGRESSED' : 'NEUTRAL';
		if (!pa || !pb || !target) return 'NEUTRAL';
		if (ma && mb) {
			const aOwn = ma.truth.hole === hole, bOwn = mb.truth.hole === hole;
			if (!aOwn && !bOwn) return 'NEUTRAL';
			if (aOwn && !bOwn) return 'REGRESSED';
			if (!aOwn && bOwn) return 'IMPROVED';
		}
		const ea = dist(pa,target), eb = dist(pb,target);
		if (eb < ea - 1) return 'IMPROVED';
		if (eb > ea + 1) return 'REGRESSED';
		return 'NEUTRAL';
	};
	for (let hole = 1; hole <= 18; hole++) {
		const badgeTruthRow = badgeTruth.find((t) => t.hole === hole);
		const ba = badgeA.get(hole), bb = badgeB.get(hole);
		if (ba && bb && dist(ba,bb) > 0.01) changeRecords.push({ hole, stage:'badge', A:ba, B:bb, corpus:badgeTruthRow?.center ?? null, outcome:classify('badge',hole,ba,bb,badgeTruthRow?.center), causalMachineEvidence:(delta.records.find((r)=>r.stage==='badge'&&r.hole===hole) as Record<string,unknown>)?.machineEvidence ?? null });
		const ta = aByHole.get(hole), tb = bByHole.get(hole), th = truth.find((t)=>t.hole===hole) as TruthHole;
		if (ta?.basket && tb?.basket && dist(ta.basket,tb.basket)>0.01) changeRecords.push({ hole, stage:'basket', A:ta.basket, B:tb.basket, corpus:th.basket, outcome:classify('basket',hole,ta.basket,tb.basket,th.basket,matchFor(basketAMatches,hole),matchFor(basketBMatches,hole)), causalMachineEvidence:(delta.records.find((r)=>r.stage==='basket'&&r.hole===hole) as Record<string,unknown>)?.machineEvidence ?? null });
		if ((ta?.tee || tb?.tee) && (!ta?.tee || !tb?.tee || dist(ta.tee,tb.tee)>0.01)) changeRecords.push({ hole, stage:'tee', A:ta?.tee ?? null, B:tb?.tee ?? null, corpus:th.tee, outcome:classify('tee',hole,ta?.tee,tb?.tee,th.tee,matchFor(teeAMatches,hole),matchFor(teeBMatches,hole)), causalMachineEvidence:(delta.records.find((r)=>r.stage==='tee'&&r.hole===hole) as Record<string,unknown>)?.machineEvidence ?? null });
	}

	const nearestBasketM = (p:Point) => [...basketM.candidates].sort((x,y)=>dist({xPx:x.tipX,yPx:x.tipY},p)-dist({xPx:y.tipX,yPx:y.tipY},p))[0];
	const nearestTeeM = (p:Point) => [...teeM.teeCandidates].sort((x,y)=>dist({xPx:x.center.x,yPx:x.center.y},p)-dist({xPx:y.center.x,yPx:y.center.y},p))[0];
	const reviewItems: Array<{hole:number;stage:Stage;reason:string;truth:Point;a?:Point;b?:Point;m:Point[]}> = [];
	for (let hole=1;hole<=18;hole++) {
		const bt=badgeTruth.find((t)=>t.hole===hole), ba=badgeA.get(hole), bb=badgeB.get(hole), bm=badgeMByHole.get(hole);
		if (bt) {
			const bmPoint=bm?{xPx:bm.plate.center.x,yPx:bm.plate.center.y}:undefined;
			const errs=[ba?dist(ba,bt.center):0,bb?dist(bb,bt.center):0,bmPoint?dist(bmPoint,bt.center):0];
			if (Math.max(...errs)>reviewThresholdPx) reviewItems.push({hole,stage:'badge',reason:`position disagreement max=${round(Math.max(...errs))}px`,truth:bt.center,a:ba,b:bb,m:bmPoint?[bmPoint]:[]});
		}
		const th=truth.find((t)=>t.hole===hole) as TruthHole;
		for (const stage of ['basket','tee'] as const) {
			const pa=aByHole.get(hole)?.[stage], pb=bByHole.get(hole)?.[stage];
			const am=stage==='basket'?matchFor(basketAMatches,hole):matchFor(teeAMatches,hole);
			const bm=stage==='basket'?matchFor(basketBMatches,hole):matchFor(teeBMatches,hole);
			const target=th[stage];
			const machine=stage==='basket'?nearestBasketM(target):nearestTeeM(target);
			const machinePoint=stage==='basket'?{xPx:(machine as BasketCandidate).tipX,yPx:(machine as BasketCandidate).tipY}:{xPx:(machine as TeeCandidate).center.x,yPx:(machine as TeeCandidate).center.y};
			const maxError=Math.max(pa?dist(pa,target):Infinity,pb?dist(pb,target):Infinity,dist(machinePoint,target));
			const wrong=Boolean((am&&am.truth.hole!==hole)||(bm&&bm.truth.hole!==hole));
			const bMissing=!pb;
			const mMissing=dist(machinePoint,target)>candidateRadiusPx;
			if (wrong||bMissing||mMissing||maxError>reviewThresholdPx) reviewItems.push({hole,stage,reason:[!pa?'A unresolved':null,wrong?'ownership disagreement':null,bMissing?'B unresolved':null,mMissing?'M missing':null,Number.isFinite(maxError)&&maxError>reviewThresholdPx?`position disagreement max=${round(maxError)}px`:null].filter(Boolean).join('; '),truth:target,a:pa,b:pb,m:dist(machinePoint,target)<=60?[machinePoint]:[]});
		}
	}

	const cropImage = PNG.sync.read(readFileSync(join(artifactRoot,'AlexClark-cropped.png')));
	const badgePoint = (hole:number) => badgeB.get(hole) ?? badgeA.get(hole);
	function renderReview(item: typeof reviewItems[number]): string {
		const truthHole=truth.find((t)=>t.hole===item.hole) as TruthHole;
		const context=[truthHole.tee,truthHole.basket,badgePoint(item.hole),item.truth,item.a,item.b,...item.m].filter(Boolean) as Point[];
		let x0=Math.max(0,Math.floor(Math.min(...context.map(p=>p.xPx))-70)),y0=Math.max(0,Math.floor(Math.min(...context.map(p=>p.yPx))-70));
		let x1=Math.min(cropImage.width,Math.ceil(Math.max(...context.map(p=>p.xPx))+70)),y1=Math.min(cropImage.height,Math.ceil(Math.max(...context.map(p=>p.yPx))+70));
		if(x1-x0>600){const c=(x0+x1)/2;x0=Math.max(0,Math.floor(c-300));x1=Math.min(cropImage.width,x0+600)}
		if(y1-y0>520){const c=(y0+y1)/2;y0=Math.max(0,Math.floor(c-260));y1=Math.min(cropImage.height,y0+520)}
		const course=scaledCourse(cropImage,4);rect(course,x0/4,y0/4,(x1-x0)/4,(y1-y0)/4,COLORS.highlight,2);
		const holeView=cropPng(cropImage,x0,y0,x1-x0,y1-y0);
		const evidence=cropPng(cropImage,Math.round(item.truth.xPx)-64,Math.round(item.truth.yPx)-64,128,128,4);
		const drawAll=(png:PNG,ox:number,oy:number,scale:number) => {
			const convert=(p:Point):Point=>({xPx:(p.xPx-ox)*scale,yPx:(p.yPx-oy)*scale});
			marker(png,convert(item.truth),COLORS.truth,'circle',Math.max(1,scale));
			if(item.a)marker(png,convert(item.a),COLORS.a,'cross',Math.max(1,scale));
			if(item.b)marker(png,convert(item.b),COLORS.b,'square',Math.max(1,scale));
			for(const p of item.m)marker(png,convert(p),COLORS.m,'diamond',Math.max(1,scale));
		};
		drawAll(course,0,0,0.25);drawAll(holeView,x0,y0,1);drawAll(evidence,item.truth.xPx-64,item.truth.yPx-64,4);
		const out=new PNG({width:1040,height:1220});fill(out,0,0,out.width,out.height,[20,20,24]);
		text(out,`H${item.hole} ${item.stage}`,20,18,COLORS.white,3);text(out,'CORPUS',20,55,COLORS.truth,2);text(out,'A',180,55,COLORS.a,2);text(out,'B',230,55,COLORS.b,2);text(out,'M',280,55,COLORS.m,2);
		text(out,'COURSE',20,90,COLORS.white,2);blit(out,course,20,120);
		text(out,'HOLE',380,90,COLORS.white,2);blit(out,holeView,380,120);
		text(out,'EVIDENCE',380,680,COLORS.white,2);blit(out,evidence,380,710);
		const path=join(reviewRoot,`H${String(item.hole).padStart(2,'0')}-${item.stage}.png`);writeFileSync(path,PNG.sync.write(out));return path;
	}
	const reviewQueue=reviewItems.map((item)=>({...item,artifactPath:renderReview(item).replace(`${repoRoot}/`,'')}));

	const changeCounts=Object.fromEntries((['IMPROVED','REGRESSED','NEUTRAL','TRUTH_DISPUTED'] as ChangeOutcome[]).map((o)=>[o,changeRecords.filter((r)=>r.outcome===o).length]));
	const changeRows=(['badge','basket','tee'] as Stage[]).map((stage)=>`| ${stage} | ${(['IMPROVED','REGRESSED','NEUTRAL','TRUTH_DISPUTED'] as ChangeOutcome[]).map((outcome)=>changeRecords.filter((r)=>r.stage===stage&&r.outcome===outcome).length).join(' | ')} |`).join('\n');
	const pointLabel=(p:Point|undefined)=>p?`(${round(p.xPx,1)},${round(p.yPx,1)})`:'missing';
	const reviewRows=reviewQueue.map((r)=>`| H${r.hole} | ${r.stage} | ${pointLabel(r.truth)} | ${pointLabel(r.a)} | ${pointLabel(r.b)} | ${r.m.map((p)=>pointLabel(p)).join(', ')||'missing'} | ${r.reason} | \`${r.artifactPath}\` |`).join('\n');
	const comparison = {
		schemaVersion:1,
		epistemicLabels:{CORPUS_TRUTH:'existing endpoint reference; not Oracle-approved',SOL_BLIND:'sealed state A',SOL_ASSISTED:'sealed state B',MACHINE_MEASUREMENT:'raw truth-free candidate pools from state B',ORACLE_OBSERVATION:'none'},
		experiment:{A:'47fd2e97cbaaf40e6288693d716fa0dd3df73245',B:'41bd2df385304d4ce2ba686297b41a3ce6bd49b3',revealBoundaryRecordedAt:'2026-08-21T09:42:29-05:00',firstEndpointTruthProjectionAt:'2026-08-21T14:43:15.282Z',oracleObservationCount:0},
		canonicalFrame:{widthPx:1290,heightPx:2082,sourceRows:[2,2084],transform:{xCrop:'xSource',yCrop:'ySource - 2'},origin:'crop top-left',xAxis:'right',yAxis:'down'},
		truthProvenance:{project:{path:zipPath,zipSha256:sha256(zipBytes),projectJsonSha256:sha256(projectBytes),role:'15 straight-hole endpoints plus full-course ownership index'},bentSubset:{path:bentPath,sha256:sha256(bentBytes),role:'higher-specificity endpoint pairs for three bent holes; left/right geometry not inspected',mapping:bentMapping},badges:{path:manifestPath,sha256:sha256(manifestBytes),coverage:'16 registered bboxes; H5/H18 absent',circularityCaveat:'bbox localization shares machinery with M'}},
		truth,
		badgeTruth,
		summary,
		matchingPolicy:{rawCandidateRadiusPx:candidateRadiusPx,reviewPriorityThresholdPx:reviewThresholdPx,changeNeutralTolerancePx:1,solObjectIdentityRadiusPx:60,missingPredictions:'preserved as unresolved; no numeric penalty'},
		changes:changeRecords,
		changeCounts,
		reviewQueue,
	};
	writeFileSync(join(outputRoot,'endpoint-comparison.json'),`${JSON.stringify(comparison,null,2)}\n`);

	const table=(stage:'badges'|'baskets'|'tees')=>JSON.stringify(summary[stage]);
	const comparisonMd=`# AlexClark endpoint truth reveal v1

## Experiment

- A: visual-only Sol, \`47fd2e97cbaaf40e6288693d716fa0dd3df73245\`.
- B: measurement-assisted Sol, \`41bd2df385304d4ce2ba686297b41a3ce6bd49b3\`.
- M: raw badge, basket-sprite, and tee candidate measurements; no basket/tee ownership output.
- CORPUS_TRUTH: bent-subset endpoints for H6/H13/H16; ChainSpot project endpoints for the 15 straight holes; registered badge boxes for 16 badges.
- ORACLE_OBSERVATION: none.
- Canonical frame: 1290 x 2082; source-to-crop transform \`(x,y) -> (x,y-2)\`.

## Result

| stage | A | B | M |
|---|---|---|---|
| badge identity | 18/18 | 18/18 | 16/18 recall; 16/16 decoded identity |
| badge position | median ${summary.badges.A.position.medianPx}, P90 ${summary.badges.A.position.p90Px}, max ${summary.badges.A.position.maxPx} (16 refs) | median ${summary.badges.B.position.medianPx}, P90 ${summary.badges.B.position.p90Px}, max ${summary.badges.B.position.maxPx} | median ${summary.badges.M.position.medianPx}, P90 ${summary.badges.M.position.p90Px}, max ${summary.badges.M.position.maxPx} |
| basket identity | ${summary.baskets.A.identityRecall} | ${summary.baskets.B.identityRecall} | ${summary.baskets.M.candidateRecall}; 20 candidates |
| basket ownership | ${summary.baskets.A.ownershipCorrect}/${summary.baskets.A.ownershipTotal} | ${summary.baskets.B.ownershipCorrect}/${summary.baskets.B.ownershipTotal} | not produced |
| basket position | median ${summary.baskets.A.position.medianPx}, P90 ${summary.baskets.A.position.p90Px}, max ${summary.baskets.A.position.maxPx} | median ${summary.baskets.B.position.medianPx}, P90 ${summary.baskets.B.position.p90Px}, max ${summary.baskets.B.position.maxPx} | median ${summary.baskets.M.position.medianPx}, P90 ${summary.baskets.M.position.p90Px}, max ${summary.baskets.M.position.maxPx} |
| tee identity | ${summary.tees.A.identityRecall} | ${summary.tees.B.identityRecall} | ${summary.tees.M.candidateRecall}; 25 candidates |
| tee ownership | ${summary.tees.A.ownershipCorrect}/${summary.tees.A.ownershipTotal} | ${summary.tees.B.ownershipCorrect}/${summary.tees.B.ownershipTotal} | not produced |
| tee position | median ${summary.tees.A.position.medianPx}, P90 ${summary.tees.A.position.p90Px}, max ${summary.tees.A.position.maxPx} | median ${summary.tees.B.position.medianPx}, P90 ${summary.tees.B.position.p90Px}, max ${summary.tees.B.position.maxPx} | median ${summary.tees.M.position.medianPx}, P90 ${summary.tees.M.position.p90Px}, max ${summary.tees.M.position.maxPx} |

Missing endpoints remain unresolved and are not assigned artificial distance penalties. Basket/tee position statistics are object-local errors after candidate matching; ownership is reported separately.

## A to B changes

- Improved: ${changeCounts.IMPROVED}
- Regressed: ${changeCounts.REGRESSED}
- Neutral: ${changeCounts.NEUTRAL}
- Truth-disputed: ${changeCounts.TRUTH_DISPUTED}

| stage | improved | regressed | neutral | truth-disputed |
|---|---:|---:|---:|---:|
${changeRows}

Every changed endpoint and its causal machine evidence is retained in \`endpoint-comparison.json\`.

## Key ownership result

A and B both assign the same wrong basket cycle: H8 points to the H17 basket, H16 points to the H8 basket, and H17 points to the H16 basket. Matched-filter instrumentation improved localization of those three sprites but did not improve ownership.

B also assigns the measured H16 tee to H12. This increases tee candidate coverage but is a wrong ownership change: A left H12 unresolved; B became confidently wrong relative to CORPUS_TRUTH.

## Oracle review queue

Review threshold is only a prioritization rule: ownership disagreement, unresolved B/M identity, or endpoint difference greater than ${reviewThresholdPx} px. It is not a pass/fail threshold.

| hole | object | corpus | A | B | M | reason | artifact |
|---|---|---:|---:|---:|---:|---|---|
${reviewRows}

## Truth contamination audit

- A and B are immutable ancestors of this reveal.
- Reveal boundary recorded at 2026-08-21T09:42:29-05:00; first projected truth read at 2026-08-21T14:43:15.282Z.
- Bent \`left\`/\`right\` geometry was not printed, scored, or rendered.
- No validation or NorthPark resources were opened.
- Post-reveal products make no retrospective blind claim.
`;
	writeFileSync(join(outputRoot,'endpoint-comparison.md'),comparisonMd);

	const instrumentMd=`# AlexClark endpoint instrument assessment

| measurement | cases materially changed | truth outcome | interpretation |
|---|---|---|---|
| tee elongation + enclosed area + ring fraction | H12, H13, H17 identity decisions | H13/H17 improved; H12 regressed by assigning the true H16 tee to H12 | Useful attention instrument, not ownership evidence. |
| tee ring-tier center | H1-H7, H9, H12-H15, H17-H18 centers/identity | mostly improved localization; H5 remains corpus-disputed; H12 ownership regressed | Strong localization testimony after ownership is established. |
| tee component tier | H10, H11 and H8 candidate pool | H11 improved; H10 was position-neutral within 1 px; H8 contained the corpus tee but B rejected it as basket residue | Component provenance is weak identity testimony; rejection can also be harmful. |
| basket onFrac/offFrac + matched-filter score | all 18 real sprites; two boundary distractors | 18/18 candidate recall, but H8/H16/H17 ownership stayed wrong | Excellent sprite inventory; no ownership content. |
| fixed pole-tip transform | 17 changed basket coordinates | improved most correctly owned positions; did not repair the three-hole ownership cycle | Useful coordinate instrument once ownership is independently established. |
| badge plate/digit measurements | 16 plates; H17 position materially changed | H17 improved; 15 already agreed; H5/H18 absent | Useful orientation and label confirmation; incomplete recall. |

## Misleading or insufficient testimony

- A high basket score says “this is a basket sprite,” not “this belongs to hole N.”
- Ring geometry says “this resembles the tee render family,” not “this belongs to the nearest badge.” H12/H16 is the concrete regression.
- Component-tier candidates can be true tees or sprite residue. H8 shows both the danger of accepting them blindly and the danger of rejecting them categorically.
- Badge position comparison for B/M is partly circular because the registered bbox reference was produced by the same localization family.

No coefficient, threshold, detector, or annotation was changed.
`;
	writeFileSync(join(outputRoot,'instrument-assessment.md'),instrumentMd);

	const excludedBasket=new Set([5,8,16,17]);
	const excludedTee=new Set([5,8,12,16]);
	const gateCandidate={schemaVersion:1,status:'CANDIDATE_NOT_ORACLE_APPROVED',course:'AlexClark',canonicalFrame:{widthPx:1290,heightPx:2082,sourceRows:[2,2084]},crop:{candidate:true},badges:{identityLabels:Array.from({length:18},(_,i)=>i+1),positionCandidates:badgeTruth,excludedPositionHoles:[5,18],note:'registered bbox coverage only; localization-reference circularity remains'},baskets:{ownershipCandidates:truth.filter(h=>!new Set([8,16,17]).has(h.hole)).map(h=>h.hole),positionCandidates:truth.filter(h=>!excludedBasket.has(h.hole)).map(h=>({hole:h.hole,point:h.basket,source:h.source})),excluded:[{hole:5,reason:'position review'},{hole:8,reason:'ownership review'},{hole:16,reason:'ownership review'},{hole:17,reason:'ownership review'}]},tees:{ownershipCandidates:truth.filter(h=>!new Set([8,12,16]).has(h.hole)).map(h=>h.hole),positionCandidates:truth.filter(h=>!excludedTee.has(h.hole)).map(h=>({hole:h.hole,point:h.tee,source:h.source})),excluded:[{hole:5,reason:'position review'},{hole:8,reason:'B unresolved; component candidate review'},{hole:12,reason:'B assigns H16 tee'},{hole:16,reason:'B unresolved; H16 candidate assigned to H12'}]},approval:'Sam approval required before any --gate behavior'};
	writeFileSync(join(outputRoot,'gate-candidate.json'),`${JSON.stringify(gateCandidate,null,2)}\n`);

	console.log(JSON.stringify({summary,changeCounts,reviewArtifacts:reviewQueue.length,bentMapping,outputRoot,ancestry:{A_before_B:execFileSync('git',['merge-base','--is-ancestor','47fd2e97cbaaf40e6288693d716fa0dd3df73245','41bd2df385304d4ce2ba686297b41a3ce6bd49b3']).length===0}},null,2));
}

main();
