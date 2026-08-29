import { existsSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeInput } from '../sweep/inputShim';
import { loadTruth } from '../sweep/truthScoring';
import { renderTraverseScope } from '../scope/render';
import type { PointTuple, ScopeCanonicalMeta, ScopeResolvedRequest } from '../scope/types';
import {
	activePinsForPage,
	ageTempPinsForPage,
	backTraversal,
	loadSearchState,
	moveTraversal,
	recordSuccessfulScope,
	saveSearchState,
	startTraversal,
	trailByName,
	trailsForPage,
	traversalByName,
	visibleTrailPoints,
	type SearchState,
	type TrailState
} from '../search/searchState';
import {
	assertTraverseInside,
	DEFAULT_TRAVERSE_RADIUS,
	traversalCurrentPoint,
	traverseAnchorPoint,
	traverseTarget,
	type TraverseMove
} from './operation';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const SEARCH_OUT = resolve(REPO_ROOT, 'artifacts', 'search');
const STATE_PATH = process.env.LAB_SEARCH_STATE ? resolve(process.env.LAB_SEARCH_STATE) : resolve(SEARCH_OUT, 'search-state.json');

function usage(code = 0): never {
	console.error([
		'TRAVERSE — navigate canonical image space with a movable visual cursor',
		'',
		'Traverse stores motion in Search and renders through Scope. The six numbered hex neighbors are convenient moves, not movement constraints.',
		'',
		'Usage:',
		'  lab traverse start IMAGE NAME x,y [--radius N] [--page PAGE]',
		'  lab traverse start IMAGE NAME --annotation FILE --start T7|N7|B7 [--radius N] [--page PAGE]',
		'  lab traverse go NAME 1|2|3|4|5|6',
		'  lab traverse go NAME --xy DX,DY',
		'  lab traverse go NAME --polar DISTANCE,ANGLE',
		'  lab traverse back NAME',
		'  lab traverse show NAME',
		'  lab traverse log NAME',
		'  lab traverse list',
		'',
		'Coordinates:',
		'  +x = right   +y = down',
		'  polar 0° = right, 90° = down, 180° = left, 270° = up',
		'',
		'Annotated starts:',
		'  Tn = Tee of hole n',
		'  Bn = Basket of hole n',
		'  Nn = rendered Number/Badge of hole n, only when annotation explicitly owns that anchor',
		'',
		'Options:',
		`  --radius N       discrete hex travel distance in canonical px (default ${DEFAULT_TRAVERSE_RADIUS})`,
		'  --page PAGE      Search Page receiving traversal evidence',
		'  --no-grid        suppress grid on traversal tiles',
		'  --tile-out N     traversal preview tile size (default 220)',
		'',
		'Every normal input is post-StripChrome/AutoStitch. Traverse never exposes pre-StripChrome pixels.',
		'Clickable workbench: lab ui',
		`Search state: ${STATE_PATH}`
	].join('\n'));
	process.exit(code);
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	if (index + 1 >= args.length) throw new Error(`lab traverse: ${name} needs a value.`);
	const value = args[index + 1];
	args.splice(index, 2);
	return value;
}
function flag(args: string[], name: string): boolean { const index = args.indexOf(name); if (index < 0) return false; args.splice(index, 1); return true; }
function parsePoint(text: string): PointTuple { const parts = text.split(',').map(Number); if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) throw new Error(`lab traverse: expected x,y, got '${text}'.`); return [parts[0], parts[1]]; }
function positive(text: string | undefined, name: string, fallback: number): number { if (text === undefined) return fallback; const value = Number(text); if (!Number.isFinite(value) || value <= 0) throw new Error(`lab traverse: ${name} must be positive.`); return value; }
function slug(value: string): string { return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'traverse'; }
function canonicalMeta(report: any): ScopeCanonicalMeta { return { imageId: report.imageId, widthPx: report.widthPx, heightPx: report.heightPx, stripChrome: report.stripChrome, alreadyCanonicalInput: report.alreadyCanonicalInput, autoStitch: { sourceCount: report.autoStitch.sourceCount, hadFallback: report.autoStitch.hadFallback } }; }
function bounds(points: readonly PointTuple[]) { const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys); return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }; }
function trailOverlay(trail: TrailState): ScopeResolvedRequest { const visible = visibleTrailPoints(trail), points = visible.map((p) => p.point); return { name: `trail-${trail.name}`, kind: 'path', focus: bounds(points), points, pointLabels: visible.map((p) => p.id), template: 'default', color: trail.color, richOverlay: true }; }

async function renderTraversal(state: SearchState, name: string, grid = true, tileOutputPx = 220): Promise<SearchState> {
	const traversal = traversalByName(state, name);
	const { report, image } = await decodeInput(traversal.imagePath);
	if (report.imageId !== traversal.imageId) throw new Error(`lab traverse: '${name}' canonical raster identity changed.`);
	let next = ageTempPinsForPage(state, traversal.imageId, traversal.page);
	const current = traversalCurrentPoint(next, name);
	const overlays = trailsForPage(next, traversal.imageId, traversal.page).map(trailOverlay);
	const pins = activePinsForPage(next, traversal.imageId, traversal.page);
	const base = slug(basename(traversal.imagePath, extname(traversal.imagePath)));
	const output = resolve(SEARCH_OUT, base, slug(traversal.page), `traverse-${slug(name)}.png`);
	renderTraverseScope({ raster: { width: image.width, height: image.height, data: image.data, imageId: report.imageId }, imagePath: traversal.imagePath, canonical: canonicalMeta(report), current, radiusPx: traversal.radiusPx, overlays, pins, grid, tileOutputPx, outputPath: output });
	next = recordSuccessfulScope(next, { imagePath: traversal.imagePath, imageId: traversal.imageId, page: traversal.page, focus: current });
	console.log(`TRAVERSE ${name} · ${traversal.page} · now ${current[0].toFixed(1)},${current[1].toFixed(1)} -> ${output}`);
	console.log('  move: go 1..6 | --xy dx,dy | --polar distance,angle');
	return next;
}

async function main(): Promise<void> {
	const raw = process.argv.slice(2);
	const args = raw[0] === 'traverse' ? raw.slice(1) : raw;
	if (!args.length || args.includes('--help') || args.includes('-h')) usage(0);
	let state = loadSearchState(STATE_PATH);
	const cmd = args[0];
	if (cmd === 'list') {
		for (const traversal of Object.values(state.traversals).sort((a, b) => a.name.localeCompare(b.name))) {
			console.log(`${traversal.name}\t${traversal.page}\tr=${traversal.radiusPx}\t${visibleTrailPoints(trailByName(state, traversal.trailName)).map((p) => p.id).join('→')}\t${traversal.imagePath}`);
		}
		return;
	}
	if (cmd === 'log') {
		const name = args[1];
		if (!name || args.length !== 2) throw new Error('Usage: lab traverse log NAME');
		for (const event of state.events.filter((event) => event.traversal === name)) console.log(`${event.id}\t${event.op}${event.point ? ` ${event.point[0]},${event.point[1]}` : ''}${event.detail ? `\t${event.detail}` : ''}`);
		return;
	}
	if (cmd === 'start') {
		const rest = args.slice(1);
		const radius = positive(option(rest, '--radius'), '--radius', DEFAULT_TRAVERSE_RADIUS);
		const page = option(rest, '--page');
		const annotation = option(rest, '--annotation');
		const startAnchor = option(rest, '--start');
		const grid = !flag(rest, '--no-grid');
		const tile = positive(option(rest, '--tile-out'), '--tile-out', 220);
		if (rest.length < 2) throw new Error('Usage: lab traverse start IMAGE NAME x,y | --annotation FILE --start Tn|Nn|Bn');
		const imagePath = resolve(rest.shift()!);
		const name = rest.shift()!;
		if (!existsSync(imagePath)) throw new Error(`lab traverse: image does not exist: ${imagePath}`);
		const rawTruth = annotation ? loadTruth(annotation) : undefined;
		const { report, image, canonicalTruth } = await decodeInput(imagePath, rawTruth);
		if (rawTruth && !report.truthMatch) throw new Error('lab traverse: annotation does not correspond to canonical raster.');
		let point: PointTuple;
		if (startAnchor) {
			if (rest.length) throw new Error('lab traverse: do not provide x,y with --start.');
			point = traverseAnchorPoint(startAnchor, canonicalTruth ?? rawTruth);
		} else {
			if (rest.length !== 1) throw new Error('lab traverse: start requires x,y when --start is absent.');
			point = parsePoint(rest[0]);
		}
		assertTraverseInside(point, image.width, image.height);
		state = startTraversal(state, { name, imagePath, imageId: report.imageId, point, radiusPx: radius, page });
		state = await renderTraversal(state, name, grid, tile);
		saveSearchState(STATE_PATH, state);
		return;
	}
	if (cmd === 'show' || cmd === 'back') {
		const rest = args.slice(1);
		const grid = !flag(rest, '--no-grid');
		const tile = positive(option(rest, '--tile-out'), '--tile-out', 220);
		if (rest.length !== 1) throw new Error(`Usage: lab traverse ${cmd} NAME`);
		const name = rest[0];
		if (cmd === 'back') state = backTraversal(state, name);
		state = await renderTraversal(state, name, grid, tile);
		saveSearchState(STATE_PATH, state);
		return;
	}
	if (cmd === 'go') {
		const rest = args.slice(1);
		const grid = !flag(rest, '--no-grid');
		const tile = positive(option(rest, '--tile-out'), '--tile-out', 220);
		const xyText = option(rest, '--xy');
		const polarText = option(rest, '--polar');
		if (!rest.length) throw new Error('Usage: lab traverse go NAME 1..6 | --xy DX,DY | --polar DISTANCE,ANGLE');
		const name = rest.shift()!;
		const traversal = traversalByName(state, name);
		const { report, image } = await decodeInput(traversal.imagePath);
		if (report.imageId !== traversal.imageId) throw new Error(`lab traverse: '${name}' canonical raster identity changed.`);
		const current = traversalCurrentPoint(state, name);
		let move: TraverseMove;
		if (xyText !== undefined) {
			if (polarText !== undefined || rest.length) throw new Error('lab traverse: choose exactly one movement form.');
			const [dx, dy] = parsePoint(xyText);
			move = { kind: 'xy', dx, dy };
		} else if (polarText !== undefined) {
			if (rest.length) throw new Error('lab traverse: choose exactly one movement form.');
			const [distance, angleDeg] = parsePoint(polarText);
			move = { kind: 'polar', distance, angleDeg };
		} else {
			if (rest.length !== 1) throw new Error('lab traverse: discrete move requires one neighbor 1..6.');
			move = { kind: 'hex', neighbor: Number(rest[0]) };
		}
		const target = traverseTarget(current, traversal.radiusPx, move);
		assertTraverseInside(target.point, image.width, image.height);
		state = moveTraversal(state, name, target.point, target.detail);
		state = await renderTraversal(state, name, grid, tile);
		saveSearchState(STATE_PATH, state);
		return;
	}
	usage(2);
}

main().catch((error) => {
	console.error((error as Error).message);
	process.exit(1);
});
