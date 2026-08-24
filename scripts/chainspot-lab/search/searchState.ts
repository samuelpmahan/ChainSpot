import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PointTuple, ScopePinOverlay, ScopePinStyle } from '../scope/types';

export interface TrailPoint {
	readonly id: number;
	readonly point: PointTuple;
}

export interface SearchPage {
	readonly name: string;
	readonly imagePath: string;
	readonly imageId: string;
}

export interface TrailState {
	readonly name: string;
	readonly imagePath: string;
	readonly imageId: string;
	readonly page: string;
	readonly color: number;
	readonly points: readonly TrailPoint[];
	readonly visiblePointIds: readonly number[];
	readonly nextPointId: number;
}

export interface PinState {
	readonly name: string;
	readonly imagePath: string;
	readonly imageId: string;
	readonly page: string;
	readonly point: PointTuple;
	readonly kind: 'temp' | 'kept';
	readonly style: ScopePinStyle;
	readonly ttlRemaining: number | null;
}

export interface TraversalState {
	readonly name: string;
	readonly imagePath: string;
	readonly imageId: string;
	readonly page: string;
	readonly radiusPx: number;
	readonly trailName: string;
}

export type SearchEventOp =
	| 'page-new' | 'page-use' | 'page-clear'
	| 'path-start' | 'path-add' | 'path-back' | 'path-branch' | 'path-show' | 'path-revisit'
	| 'pin-temp' | 'pin-keep' | 'pin-style' | 'pin-release' | 'pin-expire'
	| 'traverse-start' | 'traverse-move' | 'traverse-back'
	| 'scope';

export interface SearchEvent {
	readonly id: number;
	readonly op: SearchEventOp;
	readonly page?: string;
	readonly trail?: string;
	readonly pin?: string;
	readonly traversal?: string;
	readonly imagePath?: string;
	readonly imageId?: string;
	readonly pointId?: number;
	readonly point?: PointTuple;
	readonly detail?: string;
}

export interface LastScopeFocus {
	readonly imagePath: string;
	readonly imageId: string;
	readonly page: string;
	readonly point: PointTuple;
}

export interface SearchState {
	readonly schemaVersion: 2;
	readonly nextEventId: number;
	readonly pages: Readonly<Record<string, SearchPage>>;
	readonly activePageByImage: Readonly<Record<string, string>>;
	readonly trails: Readonly<Record<string, TrailState>>;
	readonly pins: Readonly<Record<string, PinState>>;
	readonly traversals: Readonly<Record<string, TraversalState>>;
	readonly events: readonly SearchEvent[];
	readonly lastFocus?: LastScopeFocus;
}

const DEFAULT_PAGE = 'scratch';
const pageKey = (imageId: string, page: string) => `${imageId}::${page}`;

export function emptySearchState(): SearchState {
	return { schemaVersion: 2, nextEventId: 1, pages: {}, activePageByImage: {}, trails: {}, pins: {}, traversals: {}, events: [] };
}

function normalizeStyle(value: unknown): ScopePinStyle {
	return value === 'crosshair' || value === 'diamond' || value === 'ring-dot' ? value : 'ring-dot';
}

function appendEvent(state: SearchState, event: Omit<SearchEvent, 'id'>): SearchState {
	return { ...state, nextEventId: state.nextEventId + 1, events: [...state.events, { id: state.nextEventId, ...event }] };
}

function migrateV1(parsed: any): SearchState {
	let next = emptySearchState();
	const pageFor = (imagePath: string, imageId: string) => {
		const key = pageKey(imageId, DEFAULT_PAGE);
		if (!next.pages[key]) {
			next = { ...next, pages: { ...next.pages, [key]: { name: DEFAULT_PAGE, imagePath: resolve(imagePath), imageId } }, activePageByImage: { ...next.activePageByImage, [imageId]: DEFAULT_PAGE } };
		}
	};
	for (const trail of Object.values(parsed.trails ?? {}) as any[]) pageFor(trail.imagePath, trail.imageId);
	for (const pin of Object.values(parsed.pins ?? {}) as any[]) pageFor(pin.imagePath, pin.imageId);
	if (parsed.lastFocus) pageFor(parsed.lastFocus.imagePath, parsed.lastFocus.imageId);
	const trails = Object.fromEntries(Object.entries(parsed.trails ?? {}).map(([name, trail]: [string, any]) => [name, { ...trail, page: DEFAULT_PAGE }]));
	const pins = Object.fromEntries(Object.entries(parsed.pins ?? {}).map(([name, pin]: [string, any]) => [name, { ...pin, page: DEFAULT_PAGE, style: normalizeStyle(pin.style) }]));
	const lastFocus = parsed.lastFocus ? { ...parsed.lastFocus, page: DEFAULT_PAGE } : undefined;
	return { ...next, nextEventId: parsed.nextEventId ?? 1, trails, pins, events: parsed.events ?? [], lastFocus };
}

export function loadSearchState(path: string): SearchState {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath)) return emptySearchState();
	const parsed = JSON.parse(readFileSync(resolvedPath, 'utf8')) as any;
	if (parsed.schemaVersion === 1) return migrateV1(parsed);
	if (parsed.schemaVersion !== 2 || typeof parsed.nextEventId !== 'number' || !parsed.pages || !parsed.trails || !parsed.pins || !parsed.traversals || !Array.isArray(parsed.events)) {
		throw new Error(`lab search: invalid search state at ${resolvedPath}.`);
	}
	const pins = Object.fromEntries(Object.entries(parsed.pins).map(([name, pin]: [string, any]) => [name, { ...pin, style: normalizeStyle(pin.style), page: pin.page ?? DEFAULT_PAGE }]));
	return { ...parsed, pins } as SearchState;
}

export function saveSearchState(path: string, state: SearchState): void {
	const resolvedPath = resolve(path);
	mkdirSync(dirname(resolvedPath), { recursive: true });
	writeFileSync(resolvedPath, JSON.stringify(state, null, 2) + '\n');
}

export function ensurePage(state: SearchState, input: { imagePath: string; imageId: string; page?: string }): SearchState {
	const name = input.page ?? state.activePageByImage[input.imageId] ?? DEFAULT_PAGE;
	const key = pageKey(input.imageId, name);
	if (state.pages[key]) return state;
	let next: SearchState = {
		...state,
		pages: { ...state.pages, [key]: { name, imagePath: resolve(input.imagePath), imageId: input.imageId } },
		activePageByImage: { ...state.activePageByImage, [input.imageId]: state.activePageByImage[input.imageId] ?? name }
	};
	return appendEvent(next, { op: 'page-new', page: name, imagePath: resolve(input.imagePath), imageId: input.imageId });
}

export function usePage(state: SearchState, imageId: string, page: string): SearchState {
	const found = state.pages[pageKey(imageId, page)];
	if (!found) throw new Error(`lab search: page '${page}' does not exist for this raster.`);
	let next: SearchState = { ...state, activePageByImage: { ...state.activePageByImage, [imageId]: page } };
	return appendEvent(next, { op: 'page-use', page, imagePath: found.imagePath, imageId });
}

export function activePageName(state: SearchState, imageId: string): string {
	return state.activePageByImage[imageId] ?? DEFAULT_PAGE;
}

export function pagesForImage(state: SearchState, imageId: string): readonly SearchPage[] {
	return Object.values(state.pages).filter((page) => page.imageId === imageId).sort((a, b) => a.name.localeCompare(b.name));
}

export function clearPage(state: SearchState, imageId: string, page: string): SearchState {
	const key = pageKey(imageId, page);
	const found = state.pages[key];
	if (!found) throw new Error(`lab search: page '${page}' does not exist for this raster.`);
	const trails = Object.fromEntries(Object.entries(state.trails).filter(([, trail]) => !(trail.imageId === imageId && trail.page === page)));
	const pins = Object.fromEntries(Object.entries(state.pins).filter(([, pin]) => !(pin.imageId === imageId && pin.page === page)));
	const traversals = Object.fromEntries(Object.entries(state.traversals).filter(([, traversal]) => !(traversal.imageId === imageId && traversal.page === page)));
	let next: SearchState = { ...state, trails, pins, traversals };
	return appendEvent(next, { op: 'page-clear', page, imagePath: found.imagePath, imageId });
}

function requireTrail(state: SearchState, name: string): TrailState {
	const trail = state.trails[name];
	if (!trail) throw new Error(`lab search: unknown path '${name}'. Try: lab search list`);
	return trail;
}

function requirePin(state: SearchState, name: string): PinState {
	const pin = state.pins[name];
	if (!pin) throw new Error(`lab search: unknown pin '${name}'. Try: lab search pins`);
	return pin;
}

export function visibleTrailPoints(trail: TrailState): readonly TrailPoint[] {
	const byId = new Map(trail.points.map((point) => [point.id, point]));
	return trail.visiblePointIds.map((id) => {
		const point = byId.get(id);
		if (!point) throw new Error(`lab search: path '${trail.name}' references missing point ${id}.`);
		return point;
	});
}

export function startTrail(state: SearchState, input: { name: string; imagePath: string; imageId: string; point: PointTuple; color?: number; page?: string }): SearchState {
	if (state.trails[input.name]) throw new Error(`lab search: path '${input.name}' already exists.`);
	let next = ensurePage(state, input);
	const page = input.page ?? activePageName(next, input.imageId);
	const first: TrailPoint = { id: 1, point: input.point };
	const trail: TrailState = { name: input.name, imagePath: resolve(input.imagePath), imageId: input.imageId, page, color: input.color ?? 0, points: [first], visiblePointIds: [1], nextPointId: 2 };
	next = { ...next, trails: { ...next.trails, [input.name]: trail } };
	return appendEvent(next, { op: 'path-start', page, trail: input.name, imagePath: trail.imagePath, imageId: trail.imageId, pointId: 1, point: input.point });
}

export function addTrailPoint(state: SearchState, name: string, point: PointTuple): SearchState {
	const trail = requireTrail(state, name);
	const id = trail.nextPointId;
	const nextTrail: TrailState = { ...trail, points: [...trail.points, { id, point }], visiblePointIds: [...trail.visiblePointIds, id], nextPointId: id + 1 };
	let next: SearchState = { ...state, trails: { ...state.trails, [name]: nextTrail } };
	return appendEvent(next, { op: 'path-add', page: trail.page, trail: name, imagePath: trail.imagePath, imageId: trail.imageId, pointId: id, point });
}

export function backTrail(state: SearchState, name: string): SearchState {
	const trail = requireTrail(state, name);
	if (trail.visiblePointIds.length <= 1) throw new Error(`lab search: path '${name}' is already at its start point.`);
	const removedId = trail.visiblePointIds[trail.visiblePointIds.length - 1];
	const removed = trail.points.find((point) => point.id === removedId);
	const nextTrail: TrailState = { ...trail, visiblePointIds: trail.visiblePointIds.slice(0, -1) };
	let next: SearchState = { ...state, trails: { ...state.trails, [name]: nextTrail } };
	return appendEvent(next, { op: 'path-back', page: trail.page, trail: name, imagePath: trail.imagePath, imageId: trail.imageId, pointId: removedId, point: removed?.point });
}

export function branchTrail(state: SearchState, sourceName: string, newName: string, targetPage?: string): SearchState {
	const source = requireTrail(state, sourceName);
	if (state.trails[newName]) throw new Error(`lab search: path '${newName}' already exists.`);
	let next = ensurePage(state, { imagePath: source.imagePath, imageId: source.imageId, page: targetPage ?? source.page });
	const visibleIds = new Set(source.visiblePointIds);
	const points = source.points.filter((point) => visibleIds.has(point.id));
	const maxId = points.reduce((max, point) => Math.max(max, point.id), 0);
	const branch: TrailState = { name: newName, imagePath: source.imagePath, imageId: source.imageId, page: targetPage ?? source.page, color: source.color + 1, points, visiblePointIds: [...source.visiblePointIds], nextPointId: maxId + 1 };
	next = { ...next, trails: { ...next.trails, [newName]: branch } };
	return appendEvent(next, { op: 'path-branch', page: branch.page, trail: newName, imagePath: source.imagePath, imageId: source.imageId, detail: `from ${sourceName}` });
}

export function findTrailPoint(state: SearchState, name: string, pointId: number): TrailPoint {
	const trail = requireTrail(state, name);
	const point = trail.points.find((candidate) => candidate.id === pointId);
	if (!point) throw new Error(`lab search: path '${name}' has no historical point ${pointId}.`);
	return point;
}

export function logTrailEvent(state: SearchState, name: string, op: 'path-show' | 'path-revisit', point?: TrailPoint): SearchState {
	const trail = requireTrail(state, name);
	return appendEvent(state, { op, page: trail.page, trail: name, imagePath: trail.imagePath, imageId: trail.imageId, pointId: point?.id, point: point?.point });
}

export function trailByName(state: SearchState, name: string): TrailState { return requireTrail(state, name); }

export function trailsForPage(state: SearchState, imageId: string, page: string): readonly TrailState[] {
	return Object.values(state.trails).filter((trail) => trail.imageId === imageId && trail.page === page).sort((a, b) => a.name.localeCompare(b.name));
}

export function addTempPin(state: SearchState, input: { name: string; imagePath: string; imageId: string; point: PointTuple; ttl: number; style?: ScopePinStyle; page?: string }): SearchState {
	if (!Number.isInteger(input.ttl) || input.ttl <= 0) throw new Error('lab search: TempPin ttl must be a positive integer.');
	if (state.pins[input.name]) throw new Error(`lab search: pin '${input.name}' already exists.`);
	let next = ensurePage(state, input);
	const page = input.page ?? activePageName(next, input.imageId);
	const pin: PinState = { name: input.name, imagePath: resolve(input.imagePath), imageId: input.imageId, page, point: input.point, kind: 'temp', style: input.style ?? 'ring-dot', ttlRemaining: input.ttl };
	next = { ...next, pins: { ...next.pins, [input.name]: pin } };
	return appendEvent(next, { op: 'pin-temp', page, pin: input.name, imagePath: pin.imagePath, imageId: pin.imageId, point: pin.point, detail: `ttl=${input.ttl} style=${pin.style}` });
}

export function keepPin(state: SearchState, name: string): SearchState {
	const pin = requirePin(state, name);
	const kept: PinState = { ...pin, kind: 'kept', ttlRemaining: null };
	let next: SearchState = { ...state, pins: { ...state.pins, [name]: kept } };
	return appendEvent(next, { op: 'pin-keep', page: pin.page, pin: name, imagePath: pin.imagePath, imageId: pin.imageId, point: pin.point, detail: `style=${pin.style}` });
}

export function stylePin(state: SearchState, name: string, style: ScopePinStyle): SearchState {
	const pin = requirePin(state, name);
	let next: SearchState = { ...state, pins: { ...state.pins, [name]: { ...pin, style } } };
	return appendEvent(next, { op: 'pin-style', page: pin.page, pin: name, imagePath: pin.imagePath, imageId: pin.imageId, point: pin.point, detail: `style=${style}` });
}

export function releasePin(state: SearchState, name: string): { state: SearchState; released: PinState } {
	const pin = requirePin(state, name);
	const pins = { ...state.pins };
	delete pins[name];
	let next: SearchState = { ...state, pins };
	next = appendEvent(next, { op: 'pin-release', page: pin.page, pin: name, imagePath: pin.imagePath, imageId: pin.imageId, point: pin.point });
	return { state: next, released: pin };
}

export function pinByName(state: SearchState, name: string): PinState { return requirePin(state, name); }

export function activePinsForPage(state: SearchState, imageId: string, page: string): readonly ScopePinOverlay[] {
	return Object.values(state.pins).filter((pin) => pin.imageId === imageId && pin.page === page && (pin.kind === 'kept' || (pin.ttlRemaining ?? 0) > 0)).map((pin) => ({ name: pin.name, point: pin.point, kind: pin.kind, style: pin.style, ttlRemaining: pin.ttlRemaining ?? undefined }));
}

export function ageTempPinsForPage(state: SearchState, imageId: string, page: string): SearchState {
	let next = state;
	const pins: Record<string, PinState> = { ...state.pins };
	let changed = false;
	for (const [name, pin] of Object.entries(state.pins)) {
		if (pin.imageId !== imageId || pin.page !== page || pin.kind !== 'temp' || pin.ttlRemaining === null) continue;
		if (pin.ttlRemaining <= 1) {
			delete pins[name];
			next = appendEvent(next, { op: 'pin-expire', page, pin: name, imagePath: pin.imagePath, imageId: pin.imageId, point: pin.point });
		} else pins[name] = { ...pin, ttlRemaining: pin.ttlRemaining - 1 };
		changed = true;
	}
	return changed ? { ...next, pins } : next;
}

export function recordSuccessfulScope(state: SearchState, input: { imagePath: string; imageId: string; page: string; focus: PointTuple }): SearchState {
	let next = ensurePage(state, { imagePath: input.imagePath, imageId: input.imageId, page: input.page });
	next = { ...next, lastFocus: { imagePath: resolve(input.imagePath), imageId: input.imageId, page: input.page, point: input.focus }, activePageByImage: { ...next.activePageByImage, [input.imageId]: input.page } };
	return appendEvent(next, { op: 'scope', page: input.page, imagePath: resolve(input.imagePath), imageId: input.imageId, point: input.focus });
}

export function lastScopeFocus(state: SearchState): LastScopeFocus {
	if (!state.lastFocus) throw new Error('lab search: no previous successful visual search exists for `pin here`.');
	return state.lastFocus;
}

export function startTraversal(state: SearchState, input: { name: string; imagePath: string; imageId: string; point: PointTuple; radiusPx: number; page?: string; color?: number }): SearchState {
	if (!Number.isFinite(input.radiusPx) || input.radiusPx <= 0) throw new Error('lab traverse: radius must be positive.');
	if (state.traversals[input.name]) throw new Error(`lab traverse: traversal '${input.name}' already exists.`);
	let next = startTrail(state, { name: input.name, imagePath: input.imagePath, imageId: input.imageId, point: input.point, page: input.page, color: input.color });
	const trail = trailByName(next, input.name);
	const traversal: TraversalState = { name: input.name, imagePath: trail.imagePath, imageId: trail.imageId, page: trail.page, radiusPx: input.radiusPx, trailName: trail.name };
	next = { ...next, traversals: { ...next.traversals, [input.name]: traversal } };
	return appendEvent(next, { op: 'traverse-start', page: trail.page, traversal: input.name, trail: trail.name, imagePath: trail.imagePath, imageId: trail.imageId, point: input.point, detail: `radius=${input.radiusPx}` });
}

export function traversalByName(state: SearchState, name: string): TraversalState {
	const traversal = state.traversals[name];
	if (!traversal) throw new Error(`lab traverse: unknown traversal '${name}'. Try: lab traverse list`);
	return traversal;
}

export function moveTraversal(state: SearchState, name: string, point: PointTuple, detail: string): SearchState {
	const traversal = traversalByName(state, name);
	let next = addTrailPoint(state, traversal.trailName, point);
	return appendEvent(next, { op: 'traverse-move', page: traversal.page, traversal: name, trail: traversal.trailName, imagePath: traversal.imagePath, imageId: traversal.imageId, point, detail });
}

export function backTraversal(state: SearchState, name: string): SearchState {
	const traversal = traversalByName(state, name);
	let next = backTrail(state, traversal.trailName);
	const trail = trailByName(next, traversal.trailName);
	const point = visibleTrailPoints(trail).at(-1)?.point;
	return appendEvent(next, { op: 'traverse-back', page: traversal.page, traversal: name, trail: traversal.trailName, imagePath: traversal.imagePath, imageId: traversal.imageId, point });
}
