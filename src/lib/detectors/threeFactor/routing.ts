import type { LegEvidence, SupportFieldEvidence } from './types';
import { buildSupportCost, DEFAULT_RIBBON_KNOBS, type RibbonKnobs } from './ribbon';

const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY = [-1, -1, -1, 0, 0, 1, 1, 1];
const STEP = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];
const QUANTUM = 0.125;
const RING = 64;

export interface RoutePoint {
	readonly id: string;
	readonly xPx: number;
	readonly yPx: number;
}

interface Flood {
	readonly distance: Float64Array;
	readonly previous: Int32Array;
}

function flood(field: SupportFieldEvidence, source: RoutePoint, ribbonKnobs: RibbonKnobs): Flood {
	const cost = buildSupportCost(field, ribbonKnobs);
	const size = field.width * field.height;
	const distance = new Float64Array(size).fill(Infinity);
	const previous = new Int32Array(size).fill(-1);
	const done = new Uint8Array(size);
	const local = new Float32Array(cost);
	const sx = Math.max(0, Math.min(field.width - 1, Math.round(source.xPx / field.scale)));
	const sy = Math.max(0, Math.min(field.height - 1, Math.round(source.yPx / field.scale)));
	for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
		if (dx * dx + dy * dy > 36) continue;
		const x = sx + dx;
		const y = sy + dy;
		if (x < 0 || y < 0 || x >= field.width || y >= field.height) continue;
		const cell = y * field.width + x;
		if (local[cell] > 1.4) local[cell] = 1.4;
	}
	const queues: number[][] = Array.from({ length: RING }, () => []);
	const seed = sy * field.width + sx;
	distance[seed] = 0;
	queues[0].push(seed);
	let pending = 1;
	let cursor = 0;
	while (pending > 0) {
		const queue = queues[cursor % RING];
		if (!queue.length) {
			cursor++;
			continue;
		}
		const current = queue.pop() as number;
		pending--;
		if (done[current]) continue;
		const scheduled = Math.floor(distance[current] / QUANTUM);
		if (scheduled > cursor) {
			queues[scheduled % RING].push(current);
			pending++;
			continue;
		}
		done[current] = 1;
		const x = current % field.width;
		const y = Math.floor(current / field.width);
		for (let k = 0; k < 8; k++) {
			const nx = x + DX[k];
			const ny = y + DY[k];
			if (nx < 0 || ny < 0 || nx >= field.width || ny >= field.height) continue;
			const next = ny * field.width + nx;
			if (done[next]) continue;
			const candidate = distance[current] + 0.5 * (local[current] + local[next]) * STEP[k];
			if (candidate < distance[next]) {
				distance[next] = candidate;
				previous[next] = current;
				queues[Math.floor(candidate / QUANTUM) % RING].push(next);
				pending++;
			}
		}
	}
	return { distance, previous };
}

function pathFor(
	field: SupportFieldEvidence,
	flooded: Flood,
	point: RoutePoint,
	yOffsetPx: number
): LegEvidence {
	const x = Math.max(0, Math.min(field.width - 1, Math.round(point.xPx / field.scale)));
	const y = Math.max(0, Math.min(field.height - 1, Math.round((point.yPx - yOffsetPx) / field.scale)));
	const goal = y * field.width + x;
	if (!Number.isFinite(flooded.distance[goal])) {
		return { endpointId: point.id, geodesic: Infinity, path: [], reachable: false };
	}
	const cells: number[] = [];
	for (let cell = goal; cell >= 0; cell = flooded.previous[cell]) {
		cells.push(cell);
		if (cell === flooded.previous[cell]) break;
	}
	cells.reverse();
	return {
		endpointId: point.id,
		geodesic: flooded.distance[goal],
		path: cells.map((cell) => [
			(cell % field.width) * field.scale,
			Math.floor(cell / field.width) * field.scale + yOffsetPx
		] as [number, number]),
		reachable: true
	};
}

export function routeBadgeLegs(
	field: SupportFieldEvidence,
	badge: RoutePoint,
	tees: readonly RoutePoint[],
	baskets: readonly RoutePoint[],
	yOffsetPx: number,
	ribbonKnobs: RibbonKnobs = DEFAULT_RIBBON_KNOBS
): { tees: readonly LegEvidence[]; baskets: readonly LegEvidence[] } {
	const flooded = flood(field, { ...badge, yPx: badge.yPx - yOffsetPx }, ribbonKnobs);
	return {
		tees: tees.map((tee) => pathFor(field, flooded, tee, yOffsetPx)),
		baskets: baskets.map((basket) => pathFor(field, flooded, basket, yOffsetPx))
	};
}
