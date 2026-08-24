import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PointTuple, ScopePinOverlay } from './types';

export interface TrailPoint {
	readonly id: number;
	readonly point: PointTuple;
}

export interface TrailState {
	readonly name: string;
	readonly imagePath: string;
	readonly imageId: string;
	readonly color: number;
	readonly points: readonly TrailPoint[];
	readonly visiblePointIds: readonly number[];
	readonly nextPointId: number;
}

export interface PinState {
	readonly name: string;
	readonly imagePath: string;
	readonly imageId: string;
	readonly point: PointTuple;
	readonly kind: 'temp' | 'kept';
	readonly ttlRemaining: number | null;
}

export type ScopeSearchEventOp =
	| 'path-start'
	| 'path-add'
	| 'path-back'
	| 'path-branch'
	| 'path-show'
	| 'path-revisit'
	| 'pin-temp'
	| 'pin-keep'
	| 'pin-release'
	| 'pin-expire'
	| 'scope';

export interface ScopeSearchEvent {
	readonly id: number;
	readonly op: ScopeSearchEventOp;
	readonly trail?: string;
	readonly pin?: string;
	readonly imagePath?: string;
	readonly imageId?: string;
	readonly pointId?: number;
	readonly point?: PointTuple;
	readonly detail?: string;
}

export interface LastScopeFocus {
	readonly imagePath: string;
	readonly imageId: string;
	readonly point: PointTuple;
}

export interface ScopeSearchState {
	readonly schemaVersion: 1;
	readonly nextEventId: number;
	readonly trails: Readonly<Record<string, TrailState>>;
	readonly pins: Readonly<Record<string, PinState>>;
	readonly events: readonly ScopeSearchEvent[];
	readonly lastFocus?: LastScopeFocus;
}

export function emptySearchState(): ScopeSearchState {
	return { schemaVersion: 1, nextEventId: 1, trails: {}, pins: {}, events: [] };
}

export function loadSearchState(path: string): ScopeSearchState {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath)) return emptySearchState();
	const parsed = JSON.parse(readFileSync(resolvedPath, 'utf8')) as ScopeSearchState;
	if (parsed.schemaVersion !== 1 || typeof parsed.nextEventId !== 'number' || !parsed.trails || !parsed.pins || !Array.isArray(parsed.events)) {
		throw new Error(`lab scope: invalid search state at ${resolvedPath}.`);
	}
	return parsed;
}

export function saveSearchState(path: string, state: ScopeSearchState): void {
	const resolvedPath = resolve(path);
	mkdirSync(dirname(resolvedPath), { recursive: true });
	writeFileSync(resolvedPath, JSON.stringify(state, null, 2) + '\n');
}

function appendEvent(state: ScopeSearchState, event: Omit<ScopeSearchEvent, 'id'>): ScopeSearchState {
	return {
		...state,
		nextEventId: state.nextEventId + 1,
		events: [...state.events, { id: state.nextEventId, ...event }]
	};
}

function requireTrail(state: ScopeSearchState, name: string): TrailState {
	const trail = state.trails[name];
	if (!trail) throw new Error(`lab scope: unknown path '${name}'. Try: lab scope path list`);
	return trail;
}

function requirePin(state: ScopeSearchState, name: string): PinState {
	const pin = state.pins[name];
	if (!pin) throw new Error(`lab scope: unknown pin '${name}'. Try: lab scope pin list`);
	return pin;
}

export function visibleTrailPoints(trail: TrailState): readonly TrailPoint[] {
	const byId = new Map(trail.points.map((p) => [p.id, p]));
	return trail.visiblePointIds.map((id) => {
		const point = byId.get(id);
		if (!point) throw new Error(`lab scope: path '${trail.name}' references missing point ${id}.`);
		return point;
	});
}

export function startTrail(
	state: ScopeSearchState,
	input: { name: string; imagePath: string; imageId: string; point: PointTuple; color?: number }
): ScopeSearchState {
	if (state.trails[input.name]) throw new Error(`lab scope: path '${input.name}' already exists.`);
	const first: TrailPoint = { id: 1, point: input.point };
	const trail: TrailState = {
		name: input.name,
		imagePath: resolve(input.imagePath),
		imageId: input.imageId,
		color: input.color ?? 0,
		points: [first],
		visiblePointIds: [1],
		nextPointId: 2
	};
	let next: ScopeSearchState = { ...state, trails: { ...state.trails, [input.name]: trail } };
	next = appendEvent(next, { op: 'path-start', trail: input.name, imagePath: trail.imagePath, imageId: trail.imageId, pointId: 1, point: input.point });
	return next;
}

export function addTrailPoint(state: ScopeSearchState, name: string, point: PointTuple): ScopeSearchState {
	const trail = requireTrail(state, name);
	const id = trail.nextPointId;
	const nextTrail: TrailState = {
		...trail,
		points: [...trail.points, { id, point }],
		visiblePointIds: [...trail.visiblePointIds, id],
		nextPointId: id + 1
	};
	let next: ScopeSearchState = { ...state, trails: { ...state.trails, [name]: nextTrail } };
	next = appendEvent(next, { op: 'path-add', trail: name, imagePath: trail.imagePath, imageId: trail.imageId, pointId: id, point });
	return next;
}

export function backTrail(state: ScopeSearchState, name: string): ScopeSearchState {
	const trail = requireTrail(state, name);
	if (trail.visiblePointIds.length <= 1) throw new Error(`lab scope: path '${name}' is already at its start point.`);
	const removedId = trail.visiblePointIds[trail.visiblePointIds.length - 1];
	const removed = trail.points.find((p) => p.id === removedId);
	const nextTrail: TrailState = { ...trail, visiblePointIds: trail.visiblePointIds.slice(0, -1) };
	let next: ScopeSearchState = { ...state, trails: { ...state.trails, [name]: nextTrail } };
	next = appendEvent(next, { op: 'path-back', trail: name, imagePath: trail.imagePath, imageId: trail.imageId, pointId: removedId, point: removed?.point });
	return next;
}

export function branchTrail(state: ScopeSearchState, sourceName: string, newName: string): ScopeSearchState {
	const source = requireTrail(state, sourceName);
	if (state.trails[newName]) throw new Error(`lab scope: path '${newName}' already exists.`);
	const visibleIds = new Set(source.visiblePointIds);
	const points = source.points.filter((p) => visibleIds.has(p.id));
	const maxId = points.reduce((max, p) => Math.max(max, p.id), 0);
	const branch: TrailState = {
		name: newName,
		imagePath: source.imagePath,
		imageId: source.imageId,
		color: source.color + 1,
		points,
		visiblePointIds: [...source.visiblePointIds],
		nextPointId: maxId + 1
	};
	let next: ScopeSearchState = { ...state, trails: { ...state.trails, [newName]: branch } };
	next = appendEvent(next, { op: 'path-branch', trail: newName, imagePath: source.imagePath, imageId: source.imageId, detail: `from ${sourceName}` });
	return next;
}

export function findTrailPoint(state: ScopeSearchState, name: string, pointId: number): TrailPoint {
	const trail = requireTrail(state, name);
	const point = trail.points.find((p) => p.id === pointId);
	if (!point) throw new Error(`lab scope: path '${name}' has no historical point ${pointId}.`);
	return point;
}

export function logTrailEvent(state: ScopeSearchState, name: string, op: 'path-show' | 'path-revisit', point?: TrailPoint): ScopeSearchState {
	const trail = requireTrail(state, name);
	return appendEvent(state, { op, trail: name, imagePath: trail.imagePath, imageId: trail.imageId, pointId: point?.id, point: point?.point });
}

export function trailByName(state: ScopeSearchState, name: string): TrailState {
	return requireTrail(state, name);
}

export function addTempPin(
	state: ScopeSearchState,
	input: { name: string; imagePath: string; imageId: string; point: PointTuple; ttl: number }
): ScopeSearchState {
	if (!Number.isInteger(input.ttl) || input.ttl <= 0) throw new Error('lab scope: TempPin ttl must be a positive integer.');
	if (state.pins[input.name]) throw new Error(`lab scope: pin '${input.name}' already exists.`);
	const pin: PinState = {
		name: input.name,
		imagePath: resolve(input.imagePath),
		imageId: input.imageId,
		point: input.point,
		kind: 'temp',
		ttlRemaining: input.ttl
	};
	let next: ScopeSearchState = { ...state, pins: { ...state.pins, [input.name]: pin } };
	next = appendEvent(next, { op: 'pin-temp', pin: input.name, imagePath: pin.imagePath, imageId: pin.imageId, point: pin.point, detail: `ttl=${input.ttl}` });
	return next;
}

export function keepPin(state: ScopeSearchState, name: string): ScopeSearchState {
	const pin = requirePin(state, name);
	const kept: PinState = { ...pin, kind: 'kept', ttlRemaining: null };
	let next: ScopeSearchState = { ...state, pins: { ...state.pins, [name]: kept } };
	next = appendEvent(next, { op: 'pin-keep', pin: name, imagePath: pin.imagePath, imageId: pin.imageId, point: pin.point });
	return next;
}

export function releasePin(state: ScopeSearchState, name: string): { state: ScopeSearchState; released: PinState } {
	const pin = requirePin(state, name);
	const pins = { ...state.pins };
	delete pins[name];
	let next: ScopeSearchState = { ...state, pins };
	next = appendEvent(next, { op: 'pin-release', pin: name, imagePath: pin.imagePath, imageId: pin.imageId, point: pin.point });
	return { state: next, released: pin };
}

export function pinByName(state: ScopeSearchState, name: string): PinState {
	return requirePin(state, name);
}

export function activePinsForImage(state: ScopeSearchState, imageId: string): readonly ScopePinOverlay[] {
	return Object.values(state.pins)
		.filter((pin) => pin.imageId === imageId)
		.map((pin) => ({
			name: pin.name,
			point: pin.point,
			kind: pin.kind,
			ttlRemaining: pin.ttlRemaining ?? undefined
		}));
}

export function recordSuccessfulScope(
	state: ScopeSearchState,
	input: { imagePath: string; imageId: string; focus: PointTuple; ageTempPins?: boolean }
): ScopeSearchState {
	let next: ScopeSearchState = {
		...state,
		lastFocus: { imagePath: resolve(input.imagePath), imageId: input.imageId, point: input.focus }
	};
	next = appendEvent(next, { op: 'scope', imagePath: resolve(input.imagePath), imageId: input.imageId, point: input.focus });
	if (input.ageTempPins === false) return next;

	const pins: Record<string, PinState> = { ...next.pins };
	for (const [name, pin] of Object.entries(next.pins)) {
		if (pin.imageId !== input.imageId || pin.kind !== 'temp' || pin.ttlRemaining === null) continue;
		const ttl = pin.ttlRemaining - 1;
		if (ttl <= 0) {
			delete pins[name];
			next = appendEvent(next, { op: 'pin-expire', pin: name, imagePath: pin.imagePath, imageId: pin.imageId, point: pin.point });
		} else {
			pins[name] = { ...pin, ttlRemaining: ttl };
		}
	}
	return { ...next, pins };
}

export function lastScopeFocus(state: ScopeSearchState): LastScopeFocus {
	if (!state.lastFocus) throw new Error('lab scope: no previous successful scope exists for `pin here`.');
	return state.lastFocus;
}
