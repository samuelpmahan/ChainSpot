import { existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { decodeInput } from '../sweep/inputShim';
import {
	addTempPin,
	addTrailPoint,
	backTrail,
	branchTrail,
	findTrailPoint,
	keepPin,
	lastScopeFocus,
	loadSearchState,
	logTrailEvent,
	pinByName,
	releasePin,
	saveSearchState,
	startTrail,
	trailByName,
	visibleTrailPoints,
	type ScopeSearchState,
	type TrailState
} from './searchState';
import { consumeViewOptions } from './viewOptions';
import type { PointTuple, ScopePinStyle, ScopeRequest } from './types';

export interface StatefulRenderOptions {
	readonly ageTempPins?: boolean;
	readonly expectedImageId?: string;
}

export type RenderOne = (
	imagePath: string,
	annotationPath: string | undefined,
	request: ScopeRequest,
	outputPath?: string,
	outDir?: string,
	options?: StatefulRenderOptions
) => Promise<string>;

export interface StatefulScopeContext {
	readonly statePath: string;
	readonly defaultOut: string;
	readonly renderOne: RenderOne;
}

const PATH_ACTIONS = new Set(['start', 'add', 'back', 'branch', 'show', 'revisit', 'log', 'list']);
const PIN_STYLES = new Set<ScopePinStyle>(['ring-dot', 'crosshair', 'diamond']);

export function isStatefulScopeArgs(args: readonly string[]): boolean {
	return args[0] === 'pin' || (args[0] === 'path' && PATH_ACTIONS.has(args[1] ?? ''));
}

function parsePoint(text: string): PointTuple {
	const parts = text.split(',').map(Number);
	if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) throw new Error(`lab scope: expected x,y, got '${text}'.`);
	return [parts[0], parts[1]];
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	if (index + 1 >= args.length) throw new Error(`lab scope: ${name} needs a value.`);
	const value = args[index + 1];
	args.splice(index, 2);
	return value;
}

function pinStyle(text: string | undefined): ScopePinStyle {
	const style = (text ?? 'ring-dot') as ScopePinStyle;
	if (!PIN_STYLES.has(style)) throw new Error(`lab scope: pin style must be ring-dot, crosshair, or diamond; got '${text}'.`);
	return style;
}

function trailRequest(trail: TrailState, view?: ScopeRequest['view']): ScopeRequest {
	const visible = visibleTrailPoints(trail);
	return {
		name: `trail-${trail.name}`,
		path: visible.map((point) => point.point),
		pointLabels: visible.map((point) => point.id),
		color: trail.color,
		view
	};
}

function trailOutput(defaultOut: string, trail: TrailState): string {
	const base = basename(trail.imagePath, extname(trail.imagePath)).replace(/[^a-zA-Z0-9._-]+/g, '-');
	return resolve(defaultOut, base, `trail-${trail.name.replace(/[^a-zA-Z0-9._-]+/g, '-')}.png`);
}

async function imageIdentity(imagePath: string): Promise<{ imagePath: string; imageId: string }> {
	const resolvedPath = resolve(imagePath);
	if (!existsSync(resolvedPath)) throw new Error(`lab scope: image does not exist: ${resolvedPath}`);
	const { report } = await decodeInput(resolvedPath);
	return { imagePath: resolvedPath, imageId: report.imageId };
}

async function renderPersistedTrail(
	previous: ScopeSearchState,
	next: ScopeSearchState,
	trailName: string,
	ctx: StatefulScopeContext,
	out?: string,
	view?: ScopeRequest['view']
): Promise<void> {
	const trail = trailByName(next, trailName);
	saveSearchState(ctx.statePath, next);
	try {
		await ctx.renderOne(
			trail.imagePath,
			undefined,
			trailRequest(trail, view),
			out ?? trailOutput(ctx.defaultOut, trail),
			ctx.defaultOut,
			{ expectedImageId: trail.imageId }
		);
	} catch (error) {
		saveSearchState(ctx.statePath, previous);
		throw error;
	}
}

function printPathList(state: ScopeSearchState): void {
	const trails = Object.values(state.trails).sort((a, b) => a.name.localeCompare(b.name));
	if (trails.length === 0) {
		console.log('(no saved search paths)');
		return;
	}
	for (const trail of trails) console.log(`${trail.name}\t${trail.visiblePointIds.join('→')}\t${trail.imagePath}`);
}

function printPathLog(state: ScopeSearchState, name: string): void {
	const trail = trailByName(state, name);
	const events = state.events.filter((event) => event.trail === name || event.detail?.includes(name));
	for (const event of events) {
		const point = event.point ? ` ${event.point[0]},${event.point[1]}` : '';
		const pointId = event.pointId !== undefined ? ` #${event.pointId}` : '';
		console.log(`${event.id}\t${event.op}${pointId}${point}${event.detail ? `\t${event.detail}` : ''}`);
	}
	console.log(`state: ${trail.visiblePointIds.join('→')} visible; ${trail.points.length} historical point(s)`);
}

function printPinList(state: ScopeSearchState): void {
	const pins = Object.values(state.pins).sort((a, b) => a.name.localeCompare(b.name));
	if (pins.length === 0) {
		console.log('(no active pins)');
		return;
	}
	for (const pin of pins) {
		const life = pin.kind === 'kept' ? 'KEPT' : `TEMP ttl=${pin.ttlRemaining}`;
		console.log(`${pin.name}\t${life}\t${pin.style}\t${pin.point[0]},${pin.point[1]}\t${pin.imagePath}`);
	}
}

export async function runStatefulScope(args: string[], ctx: StatefulScopeContext): Promise<void> {
	if (args[0] === 'path') return runPath(args.slice(1), ctx);
	if (args[0] === 'pin') return runPin(args.slice(1), ctx);
	throw new Error(`lab scope: unsupported stateful command '${args[0]}'.`);
}

async function runPath(args: string[], ctx: StatefulScopeContext): Promise<void> {
	const action = args[0];
	const state = loadSearchState(ctx.statePath);

	if (action === 'list') {
		if (args.length !== 1) throw new Error('Usage: lab scope path list');
		printPathList(state);
		return;
	}
	if (action === 'log') {
		if (args.length !== 2) throw new Error('Usage: lab scope path log NAME');
		printPathLog(state, args[1]);
		return;
	}
	if (action === 'start') {
		const rest = args.slice(1);
		const out = option(rest, '--out');
		const colorText = option(rest, '--color');
		const color = colorText === undefined ? 0 : Number(colorText);
		if (!Number.isFinite(color)) throw new Error('lab scope: --color must be numeric.');
		const view = consumeViewOptions(rest);
		if (rest.length !== 3) throw new Error('Usage: lab scope path start IMAGE NAME x,y [view flags]');
		const [image, name, pointText] = rest;
		const point = parsePoint(pointText);
		const identity = await imageIdentity(image);
		const next = startTrail(state, { name, imagePath: identity.imagePath, imageId: identity.imageId, point, color });
		await renderPersistedTrail(state, next, name, ctx, out, view);
		return;
	}
	if (action === 'add') {
		const rest = args.slice(1);
		const out = option(rest, '--out');
		const view = consumeViewOptions(rest);
		if (rest.length !== 2) throw new Error('Usage: lab scope path add NAME x,y [view flags]');
		const [name, pointText] = rest;
		const next = addTrailPoint(state, name, parsePoint(pointText));
		await renderPersistedTrail(state, next, name, ctx, out, view);
		return;
	}
	if (action === 'back') {
		const rest = args.slice(1);
		const out = option(rest, '--out');
		const view = consumeViewOptions(rest);
		if (rest.length !== 1) throw new Error('Usage: lab scope path back NAME [view flags]');
		const name = rest[0];
		const next = backTrail(state, name);
		await renderPersistedTrail(state, next, name, ctx, out, view);
		return;
	}
	if (action === 'branch') {
		const rest = args.slice(1);
		const out = option(rest, '--out');
		const view = consumeViewOptions(rest);
		if (rest.length !== 2) throw new Error('Usage: lab scope path branch NAME NEW_NAME [view flags]');
		const [sourceName, newName] = rest;
		const next = branchTrail(state, sourceName, newName);
		await renderPersistedTrail(state, next, newName, ctx, out, view);
		return;
	}
	if (action === 'show') {
		const rest = args.slice(1);
		const out = option(rest, '--out');
		const view = consumeViewOptions(rest);
		if (rest.length !== 1) throw new Error('Usage: lab scope path show NAME [view flags]');
		const name = rest[0];
		const next = logTrailEvent(state, name, 'path-show');
		await renderPersistedTrail(state, next, name, ctx, out, view);
		return;
	}
	if (action === 'revisit') {
		const rest = args.slice(1);
		const out = option(rest, '--out');
		const view = consumeViewOptions(rest);
		if (rest.length !== 2) throw new Error('Usage: lab scope path revisit NAME POINT_NUMBER [view flags]');
		const [name, idText] = rest;
		const id = Number(idText);
		if (!Number.isInteger(id) || id <= 0) throw new Error('lab scope: revisit point number must be a positive integer.');
		const trail = trailByName(state, name);
		const point = findTrailPoint(state, name, id);
		const next = logTrailEvent(state, name, 'path-revisit', point);
		saveSearchState(ctx.statePath, next);
		try {
			await ctx.renderOne(
				trail.imagePath,
				undefined,
				{ name: `${name}-revisit-${id}`, point: point.point, color: trail.color, view },
				out,
				ctx.defaultOut,
				{ expectedImageId: trail.imageId }
			);
		} catch (error) {
			saveSearchState(ctx.statePath, state);
			throw error;
		}
		return;
	}

	throw new Error('Usage: lab scope path start|add|back|branch|show|revisit|log|list ...');
}

async function runPin(args: string[], ctx: StatefulScopeContext): Promise<void> {
	const action = args[0];
	const state = loadSearchState(ctx.statePath);

	if (action === 'list') {
		if (args.length !== 1) throw new Error('Usage: lab scope pin list');
		printPinList(state);
		return;
	}
	if (action === 'temp') {
		const rest = args.slice(1);
		const out = option(rest, '--out');
		const ttlText = option(rest, '--ttl');
		const ttl = ttlText === undefined ? 3 : Number(ttlText);
		const style = pinStyle(option(rest, '--style'));
		const view = consumeViewOptions(rest);
		let name: string;
		let point: PointTuple;
		let imagePath: string;
		let imageId: string;
		if (rest.length === 2) {
			name = rest[0];
			point = parsePoint(rest[1]);
			const last = lastScopeFocus(state);
			imagePath = last.imagePath;
			imageId = last.imageId;
		} else if (rest.length === 3) {
			const [image, explicitName, pointText] = rest;
			name = explicitName;
			point = parsePoint(pointText);
			const identity = await imageIdentity(image);
			imagePath = identity.imagePath;
			imageId = identity.imageId;
		} else {
			throw new Error('Usage: lab scope pin temp [IMAGE] NAME x,y [--ttl N] [--style STYLE] [view flags]');
		}
		const next = addTempPin(state, { name, imagePath, imageId, point, ttl, style });
		saveSearchState(ctx.statePath, next);
		try {
			await ctx.renderOne(imagePath, undefined, { name: `pin-${name}`, point, view, richOverlay: false }, out, ctx.defaultOut, { ageTempPins: false, expectedImageId: imageId });
		} catch (error) {
			saveSearchState(ctx.statePath, state);
			throw error;
		}
		return;
	}
	if (action === 'here') {
		const rest = args.slice(1);
		const out = option(rest, '--out');
		const ttlText = option(rest, '--ttl');
		const ttl = ttlText === undefined ? 3 : Number(ttlText);
		const style = pinStyle(option(rest, '--style'));
		const view = consumeViewOptions(rest);
		if (rest.length !== 1) throw new Error('Usage: lab scope pin here NAME [--ttl N] [--style STYLE] [view flags]');
		const name = rest[0];
		const last = lastScopeFocus(state);
		const next = addTempPin(state, { name, imagePath: last.imagePath, imageId: last.imageId, point: last.point, ttl, style });
		saveSearchState(ctx.statePath, next);
		try {
			await ctx.renderOne(last.imagePath, undefined, { name: `pin-${name}`, point: last.point, view, richOverlay: false }, out, ctx.defaultOut, { ageTempPins: false, expectedImageId: last.imageId });
		} catch (error) {
			saveSearchState(ctx.statePath, state);
			throw error;
		}
		return;
	}
	if (action === 'keep') {
		const rest = args.slice(1);
		const out = option(rest, '--out');
		const view = consumeViewOptions(rest);
		if (rest.length !== 1) throw new Error('Usage: lab scope pin keep NAME [view flags]');
		const name = rest[0];
		const pin = pinByName(state, name);
		const next = keepPin(state, name);
		saveSearchState(ctx.statePath, next);
		try {
			await ctx.renderOne(pin.imagePath, undefined, { name: `pin-${name}`, point: pin.point, view, richOverlay: false }, out, ctx.defaultOut, { expectedImageId: pin.imageId });
		} catch (error) {
			saveSearchState(ctx.statePath, state);
			throw error;
		}
		return;
	}
	if (action === 'style') {
		const rest = args.slice(1);
		const out = option(rest, '--out');
		const view = consumeViewOptions(rest);
		if (rest.length !== 2) throw new Error('Usage: lab scope pin style NAME ring-dot|crosshair|diamond [view flags]');
		const [name, styleText] = rest;
		const style = pinStyle(styleText);
		const pin = pinByName(state, name);
		const next: ScopeSearchState = {
			...state,
			pins: { ...state.pins, [name]: { ...pin, style } }
		};
		saveSearchState(ctx.statePath, next);
		try {
			await ctx.renderOne(pin.imagePath, undefined, { name: `pin-${name}`, point: pin.point, view, richOverlay: false }, out, ctx.defaultOut, { expectedImageId: pin.imageId });
		} catch (error) {
			saveSearchState(ctx.statePath, state);
			throw error;
		}
		console.log(`pin ${name} style -> ${style}`);
		return;
	}
	if (action === 'release') {
		const rest = args.slice(1);
		if (rest.length !== 1) throw new Error('Usage: lab scope pin release NAME');
		const name = rest[0];
		const released = releasePin(state, name);
		saveSearchState(ctx.statePath, released.state);
		console.log(`released pin ${name}; it will not appear in subsequent scope renders`);
		return;
	}

	throw new Error('Usage: lab scope pin temp|here|keep|style|release|list ...');
}
