import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { decodeImageFile } from '../nuthing/decode';
import { runBadgeStage } from '../../src/lib/nuthing/badgeStage';
import { readCourseBadges } from '../../src/lib/nuthing/digits/readBadges';
import { predictProbs } from '../../src/lib/nuthing/digits/logistic';
import type { LogisticModel } from '../../src/lib/nuthing/digits/logistic';
import { computeRibbonSupport } from '../../src/lib/nuthing/ribbon';
import {
	prepareSpriteTemplate,
	matchBasketSprites,
	detectTeeRings,
	collectTeePoints,
	type SpriteTemplate
} from '../../src/lib/nuthing/endpoints';
import { buildSupportCost } from '../../src/lib/autoAnnotation/middleOutRibbon';
import { detectMapViewport, cropRows } from '../../src/lib/nuthing/viewport';

const FIELD_SCALE = 3;
const FIELD_ORIENTATIONS = 12;
const FIELD_WIDTHS_SRC = [24, 32, 40, 48, 56, 64];
const WAIVER_RADIUS_FIELD = 6;
const WAIVER_MAX_COST = 1.4;
const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY = [-1, -1, -1, 0, 0, 1, 1, 1];
const STEPS = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];
const QUANTUM = 0.125;
const RING = 64;

function dijkstraFrom(cost: Float32Array, w: number, h: number, seedX: number, seedY: number): { dist: Float64Array; prev: Int32Array } {
	const n = w * h;
	const local = new Float32Array(cost);
	for (let dy = -WAIVER_RADIUS_FIELD; dy <= WAIVER_RADIUS_FIELD; dy++) {
		for (let dx = -WAIVER_RADIUS_FIELD; dx <= WAIVER_RADIUS_FIELD; dx++) {
			if (dx * dx + dy * dy > WAIVER_RADIUS_FIELD * WAIVER_RADIUS_FIELD) continue;
			const x = seedX + dx;
			const y = seedY + dy;
			if (x < 0 || x >= w || y < 0 || y >= h) continue;
			const i = y * w + x;
			if (local[i] > WAIVER_MAX_COST) local[i] = WAIVER_MAX_COST;
		}
	}
	const dist = new Float64Array(n).fill(Infinity);
	const prev = new Int32Array(n).fill(-1);
	const done = new Uint8Array(n);
	const buckets: number[][] = Array.from({ length: RING }, () => []);
	const seed = seedY * w + seedX;
	dist[seed] = 0;
	buckets[0].push(seed);
	let pending = 1;
	let cursor = 0;
	while (pending > 0) {
		const bucket = buckets[cursor % RING];
		if (!bucket.length) {
			cursor++;
			continue;
		}
		const idx = bucket.pop() as number;
		pending--;
		if (done[idx]) continue;
		const q = Math.floor(dist[idx] / QUANTUM);
		if (q > cursor) {
			buckets[q % RING].push(idx);
			pending++;
			continue;
		}
		done[idx] = 1;
		const x = idx % w;
		const y = (idx - x) / w;
		for (let k = 0; k < 8; k++) {
			const nx = x + DX[k];
			const ny = y + DY[k];
			if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
			const ni = ny * w + nx;
			if (done[ni]) continue;
			const cand = dist[idx] + 0.5 * (local[idx] + local[ni]) * STEPS[k];
			if (cand < dist[ni]) {
				dist[ni] = cand;
				prev[ni] = idx;
				const qq = Math.floor(cand / QUANTUM);
				buckets[qq % RING].push(ni);
				pending++;
			}
		}
	}
	return { dist, prev };
}

function backtrack(prev: Int32Array, goal: number): number[] {
	const cells: number[] = [];
	for (let c = goal; c >= 0; c = prev[c]) cells.push(c);
	cells.reverse();
	return cells;
}

function main(): void {
	const args = process.argv.slice(2);
	const take = (flag: string): string | null => {
		const i = args.indexOf(flag);
		if (i < 0) return null;
		const value = args[i + 1] ?? null;
		args.splice(i, 2);
		return value;
	};
	const input = take('--input');
	const out = take('--out');
	const course = take('--course') ?? 'validation-course';
	if (!input || !out) throw new Error('Usage: tsx apgd-blind-d08.ts --input IMAGE --out CACHE.json [--course NAME]');
	mkdirSync(dirname(out), { recursive: true });
	const t0 = performance.now();
	const full = decodeImageFile(input);
	const viewport = detectMapViewport(full);
	const image = cropRows(full, viewport);
	const stage = runBadgeStage(image);
	const model = JSON.parse(readFileSync('resources/nuthing-p2/digits/models/logistic.json', 'utf8')) as LogisticModel;
	const readings = readCourseBadges(stage, { name: 'logistic', scores: (mask) => predictProbs(model, mask) });
	const field = computeRibbonSupport(image, {
		scale: FIELD_SCALE,
		orientations: FIELD_ORIENTATIONS,
		widthsSrc: FIELD_WIDTHS_SRC
	});
	const cost = buildSupportCost(field.support);
	const spriteTemplate = prepareSpriteTemplate(
		JSON.parse(readFileSync('resources/nuthing-p2/endpoints/basket-sprite.json', 'utf8')) as SpriteTemplate
	);
	const insideBadgePt = (x: number, y: number): boolean => stage.badges.some(
		(b) => x >= b.bboxX - 3 && x <= b.bboxX + b.bboxW + 3 && y >= b.bboxY - 3 && y <= b.bboxY + b.bboxH + 3
	);
	const insideBadgeInterior = (x: number, y: number): boolean => stage.badges.some(
		(b) => Math.abs(x - b.cx) <= b.bboxW / 2 - 7 && Math.abs(y - b.cy) <= b.bboxH / 2 - 7
	);
	const sprites = matchBasketSprites(stage.brightMask, spriteTemplate);
	const rings = detectTeeRings(stage.brightMask).filter((r) => !insideBadgeInterior(r.cx, r.cy));
	const badgeLabels = new Set(stage.badges.map((b) => b.label));
	const teeComponents = stage.brightComponents.filter(
		(c) => !badgeLabels.has(c.label) && !insideBadgePt(c.cx, c.cy)
	);
	const teeCands = collectTeePoints(rings, teeComponents, sprites);
	const baskets = sprites.map((s, i) => ({
		id: `B${i}`,
		x: s.tipX,
		y: s.tipY,
		spriteCx: s.cx,
		spriteCy: s.cy,
		score: s.score,
		onFrac: s.onFrac,
		offFrac: s.offFrac
	}));
	const tees = teeCands.map((t, i) => {
		const component = t.tier === 'component'
			? teeComponents
				.filter((c) => Math.hypot(c.cx - t.cx, c.cy - t.cy) <= 2)
				.sort((a, b) => Math.hypot(a.cx - t.cx, a.cy - t.cy) - Math.hypot(b.cx - t.cx, b.cy - t.cy))[0]
			: undefined;
		return {
			id: `T${i}`,
			x: t.cx,
			y: t.cy,
			tier: t.tier,
			angle: t.ring?.angle ?? component?.angle ?? null,
			onRing: baskets.some((b) => Math.abs(Math.hypot(t.cx - b.x, t.cy - b.y) - 84) <= 12)
		};
	});
	const clampCell = (v: number, hi: number): number => Math.max(0, Math.min(hi - 1, Math.round(v)));
	const toCell = (x: number, y: number): number => clampCell(y / field.scale, field.height) * field.width + clampCell(x / field.scale, field.width);
	const badges = readings
		.filter((reading) => reading.label.length > 0)
		.sort((a, b) => a.badge.cy - b.badge.cy || a.badge.cx - b.badge.cx)
		.map((reading, badgeIndex) => {
			const bx = clampCell(reading.badge.cx / field.scale, field.width);
			const by = clampCell(reading.badge.cy / field.scale, field.height);
			const routed = dijkstraFrom(cost, field.width, field.height, bx, by);
			const legFor = (endpointId: string, x: number, y: number) => {
				const goal = toCell(x, y);
				const reachable = Number.isFinite(routed.dist[goal]);
				const cells = reachable ? backtrack(routed.prev, goal) : [];
				const path: number[] = [];
				for (const c of cells) path.push(c % field.width, Math.floor(c / field.width));
				return { endpointId, geodesic: reachable ? routed.dist[goal] : null, path, reachable };
			};
			return {
				id: `badge-${badgeIndex}`,
				label: reading.label,
				confidence: Number.isFinite(reading.confidence) ? reading.confidence : null,
				cx: reading.badge.cx,
				cy: reading.badge.cy,
				legs: [
					...tees.map((tee) => legFor(tee.id, tee.x, tee.y)),
					...baskets.map((basket) => legFor(basket.id, basket.x, basket.y))
				]
			};
		});
	writeFileSync(`${out.replace(/\.json$/i, '')}-field.bin`, Buffer.from(field.support.buffer, field.support.byteOffset, field.support.byteLength));
	writeFileSync(`${out.replace(/\.json$/i, '')}-theta.bin`, Buffer.from(field.bestTheta.buffer, field.bestTheta.byteOffset, field.bestTheta.byteLength));
	writeFileSync(out, JSON.stringify({
		course,
		input,
		full: { width: full.width, height: full.height },
		viewport,
		field: { width: field.width, height: field.height, scale: field.scale },
		params: { orientations: FIELD_ORIENTATIONS, widthsSrc: FIELD_WIDTHS_SRC, cost: '1+4*(1-s)^2' },
		endpoints: { tees, baskets },
		badges,
		wallMs: Math.round(performance.now() - t0)
	}, null, 2));
	console.log(`${course}: badges=${badges.length} tees=${tees.length} baskets=${baskets.length} field=${field.width}x${field.height} wallMs=${Math.round(performance.now() - t0)}`);
}

main();
