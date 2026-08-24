import { existsSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanonicalTruth } from '@chainspot/alg/g0/truth';
import { decodeInput } from '../sweep/inputShim';
import { loadTruth } from '../sweep/truthScoring';
import { loadScopeManifest, resolveManifestCasePaths } from './manifest';
import { makeContactSheet, renderScope } from './render';
import {
	ageTempPinsForImage,
	loadSearchState,
	recordSuccessfulScope,
	saveSearchState,
	type ScopeSearchState
} from './searchState';
import { isStatefulScopeArgs, runStatefulScope, type StatefulRenderOptions } from './searchCliV2';
import { SCOPE_TEMPLATES } from './templates';
import { consumeViewOptions, resolveScopeView } from './viewOptions';
import type {
	BoxTuple,
	PointTuple,
	Rect,
	ScopeCanonicalMeta,
	ScopePinOverlay,
	ScopeRequest,
	ScopeResolvedRequest
} from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const DEFAULT_OUT = resolve(REPO_ROOT, 'artifacts', 'scope');
const SEARCH_STATE = process.env.LAB_SCOPE_STATE ? resolve(process.env.LAB_SCOPE_STATE) : resolve(DEFAULT_OUT, 'search-state.json');

function usage(exitCode = 0): never {
	console.error([
		'SCOPE — embodied visual inspection over Sweep-canonicalized raster input',
		'',
		'Raster contract:',
		'  raw capture(s) -> Sweep StripChrome -> Sweep AutoStitch -> canonical raster -> Scope AutoCrop',
		'',
		'Usage:',
		'  ./lab scope IMAGE x,y [view flags] [--name NAME] [--out FILE]',
		'  ./lab scope IMAGE x,y,w,h [view flags] [--name NAME] [--out FILE]',
		'  ./lab scope mark IMAGE NAME x,y [view flags]',
		'  ./lab scope dots IMAGE NAME x,y x,y ... [view flags]',
		'  ./lab scope path IMAGE NAME x,y x,y ... [view flags]   # one-shot',
		'',
		'Stateful search:',
		'  ./lab scope path start IMAGE NAME x,y [view flags]',
		'  ./lab scope path add NAME x,y [view flags]',
		'  ./lab scope path back NAME [view flags]',
		'  ./lab scope path branch NAME NEW_NAME [view flags]',
		'  ./lab scope path show NAME [view flags]',
		'  ./lab scope path revisit NAME POINT_NUMBER [view flags]',
		'  ./lab scope path log NAME',
		'  ./lab scope path list',
		'',
		'TempPins:',
		'  ./lab scope pin temp [IMAGE] NAME x,y [--ttl N] [--style ring-dot|crosshair|diamond]',
		'  ./lab scope pin here NAME [--ttl N] [--style ring-dot|crosshair|diamond]',
		'  ./lab scope pin keep NAME',
		'  ./lab scope pin style NAME ring-dot|crosshair|diamond',
		'  ./lab scope pin release NAME',
		'  ./lab scope pin list',
		'',
		'Batch / assisted:',
		'  ./lab scope --hole N IMAGE ANNOTATION.json [view flags]',
		'  ./lab scope --manifest MANIFEST.json [--case NAME] [--out-dir DIR]',
		'  ./lab scope contact-sheet MANIFEST.json [--case NAME] [--out FILE]',
		'  ./lab scope templates',
		'',
		'View flags (all defaults are visible in panel labels + JSON sidecar):',
		'  --context N       Context source span (default 800 canonical px)',
		'  --context-out N   Context output size (default 800)',
		'  --local-extra-w N total extra Local width (default 100)',
		'  --local-extra-h N total extra Local height (default 100)',
		'  --local-out N     Local output size',
		'  --fw N --fm N --ft N   forensic wide/mid/tight source spans',
		'  --forensic-out N  forensic tile output size',
		'  --no-grid         remove canonical-coordinate grid from Context/Local',
		'',
		'Context/Local use natural bilinear resampling and preserve aspect ratio.',
		'Forensics use nearest-neighbor + a hairline target with a clear center.',
		`Search state: ${SEARCH_STATE}`,
		'',
		'Manifest annotation is OPTIONAL. No annotation = BLIND.',
		'Scope never executes the detector plan; Sweep remains the only algorithm executor.'
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

function bounds(points: readonly PointTuple[], pad = 0): Rect {
	const xs = points.map((p) => p[0]);
	const ys = points.map((p) => p[1]);
	const x0 = Math.min(...xs);
	const x1 = Math.max(...xs);
	const y0 = Math.min(...ys);
	const y1 = Math.max(...ys);
	return {
		x: x0 - pad,
		y: y0 - pad,
		w: Math.max(1, x1 - x0 + pad * 2),
		h: Math.max(1, y1 - y0 + pad * 2)
	};
}

function requestToResolved(request: ScopeRequest, truth?: CanonicalTruth): ScopeResolvedRequest {
	const template = request.template ?? 'default';
	const color = request.color ?? 0;
	const common = { template, color, view: request.view, richOverlay: request.richOverlay };
	if (request.point) {
		return { ...common, name: request.name ?? `point-${Math.round(request.point[0])}-${Math.round(request.point[1])}`, kind: 'point', focus: { x: request.point[0], y: request.point[1], w: 1, h: 1 }, points: [request.point] };
	}
	if (request.box) {
		return { ...common, name: request.name ?? `box-${request.box.map((n) => Math.round(n)).join('-')}`, kind: 'box', focus: { x: request.box[0], y: request.box[1], w: request.box[2], h: request.box[3] }, points: [] };
	}
	if (request.mark) {
		return { ...common, name: request.name ?? 'mark', kind: 'mark', focus: { x: request.mark[0], y: request.mark[1], w: 1, h: 1 }, points: [request.mark] };
	}
	if (request.dots) {
		if (request.dots.length < 2) throw new Error('lab scope: dots requires at least two points.');
		return { ...common, name: request.name ?? 'dots', kind: 'dots', focus: bounds(request.dots), points: request.dots };
	}
	if (request.path) {
		if (request.path.length < 1) throw new Error('lab scope: path requires at least one point.');
		if (request.pointLabels && request.pointLabels.length !== request.path.length) throw new Error('lab scope: path pointLabels must match path point count.');
		return { ...common, name: request.name ?? 'path', kind: 'path', focus: bounds(request.path), points: request.path, pointLabels: request.pointLabels };
	}
	if (request.hole !== undefined) {
		if (!truth) throw new Error(`lab scope: hole ${request.hole} requires annotation; BLIND mode will not derive truth.`);
		const hole = truth.holes.find((candidate) => candidate.number === request.hole);
		if (!hole) throw new Error(`lab scope: annotation has no hole ${request.hole}.`);
		const points: PointTuple[] = [
			[hole.tee.xPx, hole.tee.yPx],
			...hole.corridorBends.map((point) => [point.xPx, point.yPx] as PointTuple),
			[hole.basket.xPx, hole.basket.yPx]
		];
		// Geometry width is part of the hole; Local then adds its separate +100 W/H default.
		const shapePad = Math.max(0, hole.corridorWidthPx / 2);
		return { ...common, name: request.name ?? `hole-${request.hole}`, kind: 'hole', focus: bounds(points, shapePad), points, hole: request.hole };
	}
	throw new Error('lab scope: empty request.');
}

function validateResolvedRequest(request: ScopeResolvedRequest, width: number, height: number): void {
	const inside = ([x, y]: PointTuple) => x >= 0 && y >= 0 && x < width && y < height;
	for (const point of request.points) {
		if (!inside(point)) throw new Error(`lab scope: canonical point ${point[0]},${point[1]} is outside 0..${width - 1},0..${height - 1}.`);
	}
	if (request.kind === 'box') {
		const r = request.focus;
		if (r.x < 0 || r.y < 0 || r.x + r.w > width || r.y + r.h > height) {
			throw new Error(`lab scope: canonical box ${r.x},${r.y},${r.w},${r.h} exceeds ${width}x${height}.`);
		}
	}
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	if (index + 1 >= args.length) throw new Error(`lab scope: ${name} needs a value.`);
	const value = args[index + 1];
	args.splice(index, 2);
	return value;
}

function activePinsForIdentities(state: ScopeSearchState, identities: ReadonlySet<string>): readonly ScopePinOverlay[] {
	return Object.values(state.pins)
		.filter((pin) => identities.has(pin.imageId) && (pin.kind === 'kept' || (pin.ttlRemaining ?? 0) > 0))
		.map((pin) => ({ name: pin.name, point: pin.point, kind: pin.kind, style: pin.style, ttlRemaining: pin.ttlRemaining ?? undefined }));
}

function workingCursor(request: ScopeResolvedRequest): PointTuple {
	if (request.points.length > 0) return request.points[request.points.length - 1];
	return [request.focus.x + request.focus.w / 2, request.focus.y + request.focus.h / 2];
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
	const rawTruth = annotationPath ? loadTruth(annotationPath) : undefined;
	const { report, image, canonicalTruth } = await decodeInput(imagePath, rawTruth);
	const identities = new Set([report.imageId, ...report.rawImageIds]);
	if (options.expectedImageId && !identities.has(options.expectedImageId)) {
		throw new Error(`lab scope: saved search state belongs to raster ${options.expectedImageId}; canonical/raw identities for ${imagePath} do not match.`);
	}
	if (options.expectedImageId && report.rawImageIds.includes(options.expectedImageId)) {
		const shift = report.singleSourceOffset;
		if (shift && (shift.xPx !== 0 || shift.yPx !== 0)) {
			throw new Error('lab scope: saved trail is in pre-StripChrome coordinates; start a new trail on the canonical raster rather than silently shifting evidence.');
		}
	}
	if (rawTruth && !report.truthMatch) throw new Error(`lab scope: supplied annotation does not correspond to canonicalized raster ${imagePath}.`);
	if (report.truthMatch?.warning) console.warn(`lab scope: truth warning: ${report.truthMatch.warning}`);

	const resolvedRequest = requestToResolved(request, canonicalTruth ?? rawTruth);
	validateResolvedRequest(resolvedRequest, image.width, image.height);
	const base = slug(basename(imagePath, extname(imagePath)));
	const output = outputPath ? resolve(outputPath) : resolve(outDir, base, `${slug(resolvedRequest.name)}.png`);

	const prior = loadSearchState(SEARCH_STATE);
	let renderState = prior;
	if (options.ageTempPins !== false) {
		for (const identity of identities) renderState = ageTempPinsForImage(renderState, identity);
	}
	const pins = activePinsForIdentities(renderState, identities);
	const canonical: ScopeCanonicalMeta = {
		imageId: report.imageId,
		widthPx: report.widthPx,
		heightPx: report.heightPx,
		stripChrome: report.stripChrome,
		autoStitch: { sourceCount: report.autoStitch.sourceCount, hadFallback: report.autoStitch.hadFallback }
	};

	const meta = renderScope({
		raster: { width: image.width, height: image.height, data: image.data, imageId: report.imageId },
		imagePath: resolve(imagePath),
		annotationPath: annotationPath ? resolve(annotationPath) : undefined,
		canonical,
		request: resolvedRequest,
		pins,
		outputPath: output
	});

	const stateIdentity = options.expectedImageId && identities.has(options.expectedImageId) ? options.expectedImageId : report.imageId;
	const next = recordSuccessfulScope(renderState, { imagePath, imageId: stateIdentity, focus: workingCursor(meta.request) });
	saveSearchState(SEARCH_STATE, next);

	console.log(`${meta.mode} · ${resolvedRequest.name} -> ${output}`);
	console.log(`  canonical: ${report.widthPx}x${report.heightPx} · StripChrome=${report.stripChrome.source} · AutoStitch=${report.autoStitch.sourceCount}`);
	console.log(`  view: context=${meta.view.contextSpanPx}px local=focus+${meta.view.localExtraWidthPx}W/+${meta.view.localExtraHeightPx}H forensic=${meta.view.forensicWidePx}/${meta.view.forensicMidPx}/${meta.view.forensicTightPx}px grid=${meta.view.grid ? 'on' : 'off'}`);
	if (pins.length > 0) console.log(`  pins: ${pins.map((pin) => `${pin.name}:${pin.style}${pin.kind === 'temp' ? `(${pin.ttlRemaining})` : '(kept)'}`).join(', ')}`);
	console.log(`  next: ./lab scope pin here <name> --ttl 3 | ./lab scope path start ${imagePath} <name> <x,y> | ./lab scope --help`);
	return output;
}

async function runManifest(manifestPath: string, caseName?: string, outDir?: string): Promise<string[]> {
	const loaded = loadScopeManifest(manifestPath);
	const selected = caseName ? loaded.cases.filter((entry) => entry.name === caseName) : loaded.cases;
	if (selected.length === 0) throw new Error(`lab scope: manifest has no case '${caseName}'.`);
	const outputs: string[] = [];
	for (const rawCase of selected) {
		const entry = resolveManifestCasePaths(loaded.dir, rawCase);
		console.log(`\n=== scope case ${entry.name} · ${entry.annotation ? 'TRUTH AVAILABLE' : 'BLIND'} ===`);
		for (let index = 0; index < entry.scopes.length; index++) {
			const request = entry.scopes[index];
			const caseOut = resolve(outDir ?? DEFAULT_OUT, slug(entry.name));
			outputs.push(await renderOne(entry.image, entry.annotation, { ...request, name: request.name ?? `scope-${index + 1}`, color: request.color ?? index }, undefined, caseOut));
		}
	}
	return outputs;
}

async function main(): Promise<void> {
	const rawArgs = process.argv.slice(2);
	const args = rawArgs[0] === 'scope' ? rawArgs.slice(1) : rawArgs;
	if (args.length === 0 || args.includes('--help') || args.includes('-h')) usage(0);

	if (args[0] === 'templates') {
		for (const template of Object.values(SCOPE_TEMPLATES)) console.log(`${template.id}\t${template.description}`);
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
		const hole = Number(args[1]);
		const image = args[2];
		const annotation = args[3];
		const rest = args.slice(4);
		if (!Number.isInteger(hole) || hole <= 0 || !image || !annotation) usage(2);
		const out = option(rest, '--out');
		const view = consumeViewOptions(rest);
		if (rest.length > 0) throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);
		await renderOne(image, annotation, { name: `hole-${hole}`, hole, view: resolveScopeView(view) }, out);
		return;
	}
	if (args[0] === 'mark' || args[0] === 'dots' || args[0] === 'path') {
		const kind = args[0];
		const image = args[1];
		const name = args[2];
		const rest = args.slice(3);
		if (!image || !name) usage(2);
		const out = option(rest, '--out');
		const colorText = option(rest, '--color');
		const color = colorText === undefined ? 0 : Number(colorText);
		if (!Number.isFinite(color)) throw new Error('lab scope: --color must be numeric.');
		const view = consumeViewOptions(rest);
		const points = rest.map(parsePoint);
		if (kind === 'mark' && points.length !== 1) throw new Error('lab scope: mark requires exactly one x,y point.');
		if (kind === 'dots' && points.length < 2) throw new Error('lab scope: dots requires at least two x,y points.');
		if (kind === 'path' && points.length < 1) throw new Error('lab scope: path requires at least one x,y point.');
		const request: ScopeRequest = kind === 'mark'
			? { name, mark: points[0], color, view }
			: kind === 'dots'
				? { name, dots: points, color, view }
				: { name, path: points, color, view };
		await renderOne(image, undefined, request, out);
		return;
	}

	const image = args[0];
	const coordinate = args[1];
	const rest = args.slice(2);
	if (!image || !coordinate) usage(2);
	const name = option(rest, '--name');
	const out = option(rest, '--out');
	const template = option(rest, '--template');
	const view = consumeViewOptions(rest);
	if (rest.length > 0) throw new Error(`lab scope: unexpected args: ${rest.join(' ')}`);
	const parsed = parsePointOrBox(coordinate);
	await renderOne(image, undefined, { name, template, view, ...parsed }, out);
}

main().catch((error) => {
	console.error((error as Error).message);
	process.exit(1);
});
