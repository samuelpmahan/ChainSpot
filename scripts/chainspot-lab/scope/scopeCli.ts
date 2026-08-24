import { existsSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeInput } from '../sweep/inputShim';
import { loadTruth } from '../sweep/truthScoring';
import { loadScopeManifest, resolveManifestCasePaths } from './manifest';
import { makeContactSheet, renderScope } from './render';
import { activePinsForImage, loadSearchState, recordSuccessfulScope, saveSearchState } from './searchState';
import { isStatefulScopeArgs, runStatefulScope, type StatefulRenderOptions } from './searchCli';
import { SCOPE_TEMPLATES } from './templates';
import type { BoxTuple, PointTuple, Rect, ScopeRequest, ScopeResolvedRequest } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const DEFAULT_OUT = resolve(REPO_ROOT, 'artifacts', 'scope');
const SEARCH_STATE = process.env.LAB_SCOPE_STATE ? resolve(process.env.LAB_SCOPE_STATE) : resolve(DEFAULT_OUT, 'search-state.json');

function usage(exitCode = 0): never {
	console.error([
		'SCOPE — point, inspect, cross-check, and preserve visual search evidence',
		'',
		'Usage:',
		'  ./lab scope IMAGE x,y [--name NAME] [--out FILE]',
		'  ./lab scope IMAGE x,y,w,h [--name NAME] [--out FILE]',
		'  ./lab scope mark IMAGE NAME x,y [--out FILE]',
		'  ./lab scope dots IMAGE NAME x,y x,y ... [--out FILE]',
		'  ./lab scope path IMAGE NAME x,y x,y ... [--color N] [--out FILE]   # one-shot',
		'',
		'Stateful search paths:',
		'  ./lab scope path start IMAGE NAME x,y [--color N]',
		'  ./lab scope path add NAME x,y',
		'  ./lab scope path back NAME',
		'  ./lab scope path branch NAME NEW_NAME',
		'  ./lab scope path show NAME',
		'  ./lab scope path revisit NAME POINT_NUMBER',
		'  ./lab scope path log NAME',
		'  ./lab scope path list',
		'',
		'TempPins:',
		'  ./lab scope pin temp [IMAGE] NAME x,y [--ttl N]   # default ttl=3',
		'  ./lab scope pin here NAME [--ttl N]              # last successful scope focus',
		'  ./lab scope pin keep NAME',
		'  ./lab scope pin release NAME',
		'  ./lab scope pin list',
		'',
		'Batch / assisted:',
		'  ./lab scope --hole N IMAGE ANNOTATION.json [--out FILE]',
		'  ./lab scope --manifest MANIFEST.json [--case NAME] [--out-dir DIR]',
		'  ./lab scope contact-sheet MANIFEST.json [--case NAME] [--out FILE]',
		'  ./lab scope templates',
		'',
		'Default output is a 1→1→3 nearest-neighbor crosscheck: context | local | three forensic zooms.',
		'The forensic triplet is overlay-free and centered on the previous path point (or the requested point otherwise).',
		'',
		'Back removes a point from the VISIBLE trail but keeps it in the append-only search log.',
		'Revisit can inspect a historical point without restoring it to the visible trail.',
		'TempPins remain visible for N subsequent successful scope renders, then expire from view.',
		'`pin keep` promotes a TempPin to a persistent visible pin; release/expiry remain logged.',
		`Search state: ${SEARCH_STATE}`,
		'',
		'Manifest annotation is OPTIONAL. No annotation = BLIND.',
		'BLIND cases may scope/mark/draw/search, but hole-derived framing is unavailable.',
		'',
		'Every PNG gets a .json sidecar containing source rectangles, pins, and mode.',
		'',
		'Raster decoding goes through sweep/inputShim.decodeInput: one LAB raster intake seam.',
		'Scope itself does NOT execute the detector/algorithm plan.'
	].join('\n'));
	process.exit(exitCode);
}

function slug(value: string): string {
	return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'scope';
}

function parsePoint(text: string): PointTuple {
	const parts = text.split(',').map(Number);
	if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) throw new Error(`lab scope: expected x,y, got '${text}'.`);
	return [parts[0], parts[1]];
}

function parsePointOrBox(text: string): { point?: PointTuple; box?: BoxTuple } {
	const parts = text.split(',').map(Number);
	if (parts.some((n) => !Number.isFinite(n))) throw new Error(`lab scope: invalid coordinate '${text}'.`);
	if (parts.length === 2) return { point: [parts[0], parts[1]] };
	if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return { box: [parts[0], parts[1], parts[2], parts[3]] };
	throw new Error(`lab scope: expected x,y or x,y,w,h, got '${text}'.`);
}

function bounds(points: readonly PointTuple[], pad = 16): Rect {
	const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
	const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
	return { x: x0 - pad, y: y0 - pad, w: Math.max(1, x1 - x0 + pad * 2), h: Math.max(1, y1 - y0 + pad * 2) };
}

function requestToResolved(request: ScopeRequest, annotationPath?: string): ScopeResolvedRequest {
	const template = request.template ?? 'default';
	const color = request.color ?? 0;
	if (request.point) return { name: request.name ?? `point-${Math.round(request.point[0])}-${Math.round(request.point[1])}`, kind: 'point', focus: { x: request.point[0], y: request.point[1], w: 1, h: 1 }, points: [request.point], template, color };
	if (request.box) return { name: request.name ?? `box-${request.box.map((n) => Math.round(n)).join('-')}`, kind: 'box', focus: { x: request.box[0], y: request.box[1], w: request.box[2], h: request.box[3] }, points: [], template, color };
	if (request.mark) return { name: request.name ?? 'mark', kind: 'mark', focus: { x: request.mark[0], y: request.mark[1], w: 1, h: 1 }, points: [request.mark], template, color };
	if (request.dots) {
		if (request.dots.length < 2) throw new Error('lab scope: dots requires at least two points.');
		return { name: request.name ?? 'dots', kind: 'dots', focus: bounds(request.dots), points: request.dots, template, color };
	}
	if (request.path) {
		if (request.path.length < 1) throw new Error('lab scope: path requires at least one point.');
		if (request.pointLabels && request.pointLabels.length !== request.path.length) throw new Error('lab scope: path pointLabels must match path point count.');
		return { name: request.name ?? 'path', kind: 'path', focus: bounds(request.path), points: request.path, pointLabels: request.pointLabels, template, color };
	}
	if (request.hole !== undefined) {
		if (!annotationPath) throw new Error(`lab scope: hole ${request.hole} requires an annotation path; BLIND mode will not derive truth.`);
		const truth = loadTruth(annotationPath);
		const hole = truth.holes.find((h) => h.number === request.hole);
		if (!hole) throw new Error(`lab scope: annotation has no hole ${request.hole}.`);
		const points: PointTuple[] = [[hole.tee.xPx, hole.tee.yPx], ...hole.corridorBends.map((p) => [p.xPx, p.yPx] as PointTuple), [hole.basket.xPx, hole.basket.yPx]];
		const pad = Math.max(24, hole.corridorWidthPx * 1.5);
		return { name: request.name ?? `hole-${request.hole}`, kind: 'hole', focus: bounds(points, pad), points, template, color, hole: request.hole };
	}
	throw new Error('lab scope: empty request.');
}

function validateResolvedRequest(request: ScopeResolvedRequest, width: number, height: number): void {
	const inside = ([x, y]: PointTuple) => x >= 0 && y >= 0 && x < width && y < height;
	for (const p of request.points) {
		if (!inside(p)) throw new Error(`lab scope: point ${p[0]},${p[1]} is outside image bounds 0..${width - 1},0..${height - 1}.`);
	}
	if (request.kind === 'box') {
		const r = request.focus;
		if (r.x < 0 || r.y < 0 || r.x + r.w > width || r.y + r.h > height) {
			throw new Error(`lab scope: box ${r.x},${r.y},${r.w},${r.h} exceeds image bounds ${width}x${height}.`);
		}
	}
}

function option(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	if (i < 0) return undefined;
	if (i + 1 >= args.length) throw new Error(`lab scope: ${name} needs a value.`);
	const value = args[i + 1];
	args.splice(i, 2);
	return value;
}

async function renderOne(
	imagePath: string,
	annotationPath: string | undefined,
	request: ScopeRequest,
	outputPath?: string,
	outDir = DEFAULT_OUT,
	options: StatefulRenderOptions = {}
): Promise<string> {
	if (!existsSync(imagePath)) throw new Error(`lab scope: image does not exist: ${imagePath}`);
	if (annotationPath && !existsSync(annotationPath)) throw new Error(`lab scope: annotation does not exist: ${annotationPath}`);
	const truth = annotationPath ? loadTruth(annotationPath) : undefined;
	const { report, image } = await decodeInput(imagePath, truth);
	if (options.expectedImageId && report.imageId !== options.expectedImageId) {
		throw new Error(`lab scope: saved search state belongs to raster ${options.expectedImageId}, but ${imagePath} now decodes as ${report.imageId}.`);
	}
	if (truth && !report.truthMatch) {
		throw new Error(`lab scope: supplied annotation does not match raster ${imagePath}; refusing truth-assisted scope.`);
	}
	if (report.truthMatch?.warning) console.warn(`lab scope: truth warning: ${report.truthMatch.warning}`);
	const resolvedRequest = requestToResolved(request, annotationPath);
	validateResolvedRequest(resolvedRequest, image.width, image.height);
	const base = slug(basename(imagePath, extname(imagePath)));
	const output = outputPath ? resolve(outputPath) : resolve(outDir, base, `${slug(resolvedRequest.name)}.png`);
	let state = loadSearchState(SEARCH_STATE);
	const pins = activePinsForImage(state, report.imageId);
	const meta = renderScope({
		raster: { width: image.width, height: image.height, data: image.data, imageId: report.imageId },
		imagePath: resolve(imagePath),
		annotationPath: annotationPath ? resolve(annotationPath) : undefined,
		request: resolvedRequest,
		pins,
		outputPath: output
	});
	const inspection = meta.panels.find((panel) => panel.name === 'forensic-wide') ?? meta.panels[meta.panels.length - 1];
	const focus: PointTuple = [inspection.source.x + inspection.source.w / 2, inspection.source.y + inspection.source.h / 2];
	state = recordSuccessfulScope(state, { imagePath, imageId: report.imageId, focus, ageTempPins: options.ageTempPins });
	saveSearchState(SEARCH_STATE, state);
	console.log(`${meta.mode} · ${resolvedRequest.name} -> ${output}`);
	if (pins.length > 0) console.log(`  pins: ${pins.map((p) => `${p.name}${p.kind === 'temp' ? `(${p.ttlRemaining})` : '(kept)'}`).join(', ')}`);
	console.log(`  next: ./lab scope pin here <name> --ttl 3 | ./lab scope path start ${imagePath} <name> <x,y> | ./lab scope --help`);
	return output;
}

async function runManifest(manifestPath: string, caseName?: string, outDir?: string): Promise<string[]> {
	const loaded = loadScopeManifest(manifestPath);
	const selected = caseName ? loaded.cases.filter((c) => c.name === caseName) : loaded.cases;
	if (selected.length === 0) throw new Error(`lab scope: manifest has no case '${caseName}'.`);
	const outputs: string[] = [];
	for (const rawCase of selected) {
		const c = resolveManifestCasePaths(loaded.dir, rawCase);
		console.log(`\n=== scope case ${c.name} · ${c.annotation ? 'TRUTH AVAILABLE' : 'BLIND'} ===`);
		for (let i = 0; i < c.scopes.length; i++) {
			const req = c.scopes[i];
			const caseOut = resolve(outDir ?? DEFAULT_OUT, slug(c.name));
			outputs.push(await renderOne(c.image, c.annotation, { ...req, name: req.name ?? `scope-${i + 1}`, color: req.color ?? i }, undefined, caseOut));
		}
	}
	return outputs;
}

async function main(): Promise<void> {
	const rawArgs = process.argv.slice(2);
	const args = rawArgs[0] === 'scope' ? rawArgs.slice(1) : rawArgs;
	if (args.length === 0 || args.includes('--help') || args.includes('-h')) usage(0);
	if (args[0] === 'templates') {
		for (const t of Object.values(SCOPE_TEMPLATES)) console.log(`${t.id}\t${t.description}`);
		return;
	}
	if (isStatefulScopeArgs(args)) {
		await runStatefulScope(args, { statePath: SEARCH_STATE, defaultOut: DEFAULT_OUT, renderOne });
		return;
	}
	if (args[0] === '--manifest') {
		const manifest = args[1];
		if (!manifest) usage(2);
		const rest = args.slice(2);
		const caseName = option(rest, '--case');
		const outDir = option(rest, '--out-dir');
		if (rest.length > 0) throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);
		await runManifest(manifest, caseName, outDir);
		return;
	}
	if (args[0] === 'contact-sheet') {
		const manifest = args[1];
		if (!manifest) usage(2);
		const rest = args.slice(2);
		const caseName = option(rest, '--case');
		const out = option(rest, '--out');
		if (rest.length > 0) throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);
		const outputs = await runManifest(manifest, caseName);
		const output = resolve(out ?? resolve(DEFAULT_OUT, `contact-sheet-${slug(caseName ?? basename(manifest, extname(manifest)))}.png`));
		makeContactSheet(outputs, output);
		console.log(`contact-sheet -> ${output}`);
		return;
	}
	if (args[0] === '--hole') {
		const n = Number(args[1]);
		const image = args[2];
		const annotation = args[3];
		const rest = args.slice(4);
		if (!Number.isInteger(n) || n <= 0 || !image || !annotation) usage(2);
		const out = option(rest, '--out');
		if (rest.length > 0) throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);
		await renderOne(image, annotation, { name: `hole-${n}`, hole: n }, out);
		return;
	}
	if (args[0] === 'mark' || args[0] === 'dots' || args[0] === 'path') {
		const kind = args[0];
		const image = args[1], name = args[2];
		const rest = args.slice(3);
		if (!image || !name) usage(2);
		const out = option(rest, '--out');
		const colorText = option(rest, '--color');
		const color = colorText === undefined ? 0 : Number(colorText);
		if (!Number.isFinite(color)) throw new Error(`lab scope: --color must be numeric.`);
		const points = rest.map(parsePoint);
		if (kind === 'mark' && points.length !== 1) throw new Error('lab scope: mark requires exactly one x,y point.');
		if (kind === 'dots' && points.length < 2) throw new Error('lab scope: dots requires at least two x,y points.');
		if (kind === 'path' && points.length < 1) throw new Error('lab scope: path requires at least one x,y point.');
		const req: ScopeRequest = kind === 'mark' ? { name, mark: points[0], color } : kind === 'dots' ? { name, dots: points, color } : { name, path: points, color };
		await renderOne(image, undefined, req, out);
		return;
	}
	const image = args[0];
	const coord = args[1];
	const rest = args.slice(2);
	if (!image || !coord) usage(2);
	const name = option(rest, '--name');
	const out = option(rest, '--out');
	const template = option(rest, '--template');
	if (rest.length > 0) throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);
	const parsed = parsePointOrBox(coord);
	await renderOne(image, undefined, { name, template, ...parsed }, out);
}

main().catch((err) => {
	console.error((err as Error).message);
	process.exit(1);
});
