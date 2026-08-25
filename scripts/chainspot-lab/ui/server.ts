import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PNG } from 'pngjs';
import { loadLabConfig, resolveCourseContext } from '../context/context.mjs';
import { loadScopeInput, runScopeOperation, scopeSlug } from '../scope/operation';
import type { PointTuple, ScopePinStyle, ScopeRequest } from '../scope/types';
import {
	activePageName,
	addTempPin,
	addTrailPoint,
	ageTempPinsForPage,
	backTrail,
	backTraversal,
	branchTrail,
	clearPage,
	ensurePage,
	keepPin,
	loadSearchState,
	moveTraversal,
	pinByName,
	recordSuccessfulScope,
	releasePin,
	saveSearchState,
	startTrail,
	startTraversal,
	stylePin,
	trailByName,
	traversalByName,
	usePage,
	visibleTrailPoints,
	type SearchState
} from '../search/searchState';
import { runSweepOperation } from '../sweep/operation';
import {
	assertTraverseInside,
	traversalCurrentPoint,
	traversalNeighbors,
	traverseAnchorPoint,
	traverseTarget,
	type TraverseMove
} from '../traverse/operation';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAB_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(LAB_DIR, '../..');
const APP_DIR = resolve(HERE, 'app');
const ARTIFACT_ROOT = resolve(REPO_ROOT, 'artifacts');
const UPLOAD_ROOT = resolve(ARTIFACT_ROOT, 'ui', 'uploads');
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const SEARCH_STATE = process.env.LAB_SEARCH_STATE
	? resolve(process.env.LAB_SEARCH_STATE)
	: resolve(ARTIFACT_ROOT, 'search', 'search-state.json');

interface CachedCanonical {
	readonly imagePath: string;
	readonly annotationPath?: string;
	readonly width: number;
	readonly height: number;
	readonly imageId: string;
	readonly png: Buffer;
	readonly report: Awaited<ReturnType<typeof loadScopeInput>>['decoded']['report'];
	readonly truth: Awaited<ReturnType<typeof loadScopeInput>>['truth'];
}

const canonicalCache = new Map<string, CachedCanonical>();

function usage(code = 0): never {
	console.error([
		'LAB UI — local interactive CV workbench',
		'',
		'Usage:',
		'  lab ui [--port N] [--no-open]',
		'',
		'UI is bound to 127.0.0.1 only. It calls LAB operations directly:',
		'  Sweep intake/execution · Scope · Search Pages · Traverse',
		'',
		'Persisted `lab set` course context is shared with the workbench.',
		'No production/demo frontend is required.'
	].join('\n'));
	process.exit(code);
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	if (index + 1 >= args.length) throw new Error(`lab ui: ${name} needs a value.`);
	const value = args[index + 1];
	args.splice(index, 2);
	return value;
}

function flag(args: string[], name: string): boolean {
	const index = args.indexOf(name);
	if (index < 0) return false;
	args.splice(index, 1);
	return true;
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body, null, 2);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(text)
	});
	res.end(text);
}

async function readJson(req: import('node:http').IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > 2_000_000) throw new Error('lab ui: request body exceeds 2MB.');
		chunks.push(buffer);
	}
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > MAX_UPLOAD_BYTES) throw new Error('lab ui: upload exceeds 100MB.');
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

function uploadExtension(kind: string, name: string): string {
	const extension = extname(basename(name)).toLowerCase();
	if (kind === 'raster' && ['.png', '.jpg', '.jpeg'].includes(extension)) return extension;
	if (kind === 'annotation' && extension === '.json') return extension;
	throw new Error(`lab ui: ${kind === 'annotation' ? 'annotation must be JSON' : 'raster must be PNG, JPG, or JPEG'}.`);
}

async function upload(req: import('node:http').IncomingMessage, url: URL): Promise<string> {
	const kind = url.searchParams.get('kind');
	const name = url.searchParams.get('name');
	if (kind !== 'raster' && kind !== 'annotation') throw new Error('lab ui: upload kind must be raster or annotation.');
	if (!name) throw new Error('lab ui: upload name is required.');
	const extension = uploadExtension(kind, name);
	const body = await readBody(req);
	if (!body.length) throw new Error('lab ui: upload is empty.');
	const stem = basename(name, extension).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || kind;
	const destination = resolve(UPLOAD_ROOT, kind, `${Date.now()}-${stem}${extension}`);
	mkdirSync(dirname(destination), { recursive: true });
	writeFileSync(destination, body);
	return destination;
}

function mime(path: string): string {
	switch (extname(path).toLowerCase()) {
		case '.html': return 'text/html; charset=utf-8';
		case '.js': return 'text/javascript; charset=utf-8';
		case '.css': return 'text/css; charset=utf-8';
		case '.json': return 'application/json; charset=utf-8';
		case '.png': return 'image/png';
		case '.jpg': case '.jpeg': return 'image/jpeg';
		case '.txt': return 'text/plain; charset=utf-8';
		default: return 'application/octet-stream';
	}
}

function resolveUserPath(path: string): string {
	return resolve(process.cwd(), path);
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	if (rel === '') return true;
	if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) return false;
	if (/^[a-zA-Z]:[\\/]/.test(rel)) return false;
	return true;
}

function artifactUrl(path: string): string {
	return `/api/file?path=${encodeURIComponent(path)}`;
}

function serveFile(res: import('node:http').ServerResponse, path: string): void {
	if (!existsSync(path) || !statSync(path).isFile()) {
		json(res, 404, { error: `file not found: ${path}` });
		return;
	}
	const data = readFileSync(path);
	res.writeHead(200, { 'content-type': mime(path), 'cache-control': 'no-store', 'content-length': data.length });
	res.end(data);
}

function canonicalPng(width: number, height: number, data: Uint8Array | Uint8ClampedArray): Buffer {
	const png = new PNG({ width, height });
	png.data.set(data);
	return PNG.sync.write(png);
}

async function openCanonical(imagePath: string, annotationPath?: string): Promise<CachedCanonical> {
	const loaded = await loadScopeInput(resolveUserPath(imagePath), annotationPath ? resolveUserPath(annotationPath) : undefined);
	const { image, report } = loaded.decoded;
	const cached: CachedCanonical = {
		imagePath: loaded.imagePath,
		annotationPath: loaded.annotationPath,
		width: image.width,
		height: image.height,
		imageId: report.imageId,
		png: canonicalPng(image.width, image.height, image.data),
		report,
		truth: loaded.truth
	};
	canonicalCache.set(report.imageId, cached);
	return cached;
}

function publicCanonical(cached: CachedCanonical) {
	return {
		imagePath: cached.imagePath,
		annotationPath: cached.annotationPath,
		imageId: cached.imageId,
		width: cached.width,
		height: cached.height,
		imageUrl: `/api/image/${cached.imageId}.png`,
		stripChrome: cached.report.stripChrome,
		autoStitch: cached.report.autoStitch,
		truthMatch: cached.report.truthMatch
	};
}

function publicContext() {
	const config = loadLabConfig();
	if (!config.course) return { config, course: null };
	try {
		const context = resolveCourseContext(config);
		return {
			config,
			course: {
				name: context.manifest.course,
				corpusRoot: context.corpusRoot,
				imagePath: context.imagePath,
				annotationPath: context.annotationPath,
				manifestPath: context.manifest.path
			}
		};
	} catch (error) {
		return { config, course: null, error: (error as Error).message };
	}
}

function searchState(): SearchState {
	return loadSearchState(SEARCH_STATE);
}

function saveState(state: SearchState): SearchState {
	saveSearchState(SEARCH_STATE, state);
	return state;
}

function searchSummary(state: SearchState) {
	return {
		...state,
		pageIndex: Object.values(state.pages).map((page) => ({
			...page,
			active: activePageName(state, page.imageId) === page.name
		}))
	};
}

function completeVisualInteraction(
	state: SearchState,
	input: { imagePath: string; imageId: string; page: string; focus: PointTuple; agePins?: boolean }
): SearchState {
	let next = input.agePins === false ? state : ageTempPinsForPage(state, input.imageId, input.page);
	next = recordSuccessfulScope(next, {
		imagePath: input.imagePath,
		imageId: input.imageId,
		page: input.page,
		focus: input.focus
	});
	return next;
}

function trailCursor(state: SearchState, name: string): { imagePath: string; imageId: string; page: string; point: PointTuple } {
	const trail = trailByName(state, name);
	const point = visibleTrailPoints(trail).at(-1)?.point;
	if (!point) throw new Error(`lab ui: trail '${name}' has no visible point.`);
	return { imagePath: trail.imagePath, imageId: trail.imageId, page: trail.page, point };
}

function currentTraversal(state: SearchState, name: string) {
	const traversal = traversalByName(state, name);
	const current = traversalCurrentPoint(state, name);
	return {
		...traversal,
		current,
		neighbors: traversalNeighbors(current, traversal.radiusPx),
		visiblePointIds: visibleTrailPoints(trailByName(state, traversal.trailName)).map((point) => point.id)
	};
}

function listConfigs(): string[] {
	const root = resolve(REPO_ROOT, 'packages', 'alg', 'src');
	const found: string[] = [];
	const walk = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && entry.name.endsWith('.json') && path.split(sep).includes('configs')) found.push(relative(REPO_ROOT, path));
		}
	};
	walk(root);
	return found.sort();
}

function listArtifacts(root: string): { path: string; relativePath: string; url?: string; kind: string }[] {
	const out: { path: string; relativePath: string; url?: string; kind: string }[] = [];
	const walk = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) {
				const extension = extname(path).toLowerCase();
				out.push({
					path,
					relativePath: relative(root, path),
					url: ['.png', '.jpg', '.jpeg', '.json', '.txt'].includes(extension) ? artifactUrl(path) : undefined,
					kind: extension.slice(1) || 'bin'
				});
			}
		}
	};
	walk(root);
	return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function handleApi(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL): Promise<boolean> {
	if (!url.pathname.startsWith('/api/')) return false;
	try {
		if (req.method === 'GET' && url.pathname === '/api/health') {
			json(res, 200, { ok: true, repoRoot: REPO_ROOT, searchState: SEARCH_STATE });
			return true;
		}
		if (req.method === 'GET' && url.pathname === '/api/context') {
			json(res, 200, publicContext());
			return true;
		}
		if (req.method === 'GET' && url.pathname === '/api/configs') {
			json(res, 200, { configs: listConfigs() });
			return true;
		}
		if (req.method === 'GET' && url.pathname === '/api/state') {
			json(res, 200, searchSummary(searchState()));
			return true;
		}
		if (req.method === 'GET' && url.pathname.startsWith('/api/image/')) {
			const imageId = basename(url.pathname, '.png');
			const cached = canonicalCache.get(imageId);
			if (!cached) {
				json(res, 404, { error: `canonical image ${imageId} is not open in this LAB UI process.` });
				return true;
			}
			res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': cached.png.length });
			res.end(cached.png);
			return true;
		}
		if (req.method === 'GET' && url.pathname === '/api/file') {
			const path = url.searchParams.get('path');
			if (!path) throw new Error('lab ui: /api/file requires path.');
			const resolved = resolve(path);
			if (!isInside(ARTIFACT_ROOT, resolved)) throw new Error('lab ui: only LAB artifacts may be served.');
			serveFile(res, resolved);
			return true;
		}
		if (req.method === 'POST' && url.pathname === '/api/upload') {
			json(res, 200, { path: await upload(req, url) });
			return true;
		}
		if (req.method === 'POST' && url.pathname === '/api/open') {
			const body = await readJson(req);
			if (typeof body.imagePath !== 'string' || body.imagePath.trim() === '') throw new Error('lab ui: imagePath is required.');
			const cached = await openCanonical(body.imagePath, typeof body.annotationPath === 'string' && body.annotationPath.trim() ? body.annotationPath : undefined);
			json(res, 200, publicCanonical(cached));
			return true;
		}
		if (req.method === 'POST' && url.pathname === '/api/scope') {
			const body = await readJson(req);
			if (typeof body.imagePath !== 'string') throw new Error('lab ui: imagePath is required.');
			const request = body.request as ScopeRequest;
			const stamp = `${Date.now()}-${scopeSlug(request.name ?? (request.full ? 'full' : 'scope'))}`;
			const outputPath = resolve(ARTIFACT_ROOT, 'ui', 'scope', `${stamp}.png`);
			const result = await runScopeOperation({
				imagePath: resolveUserPath(body.imagePath),
				annotationPath: typeof body.annotationPath === 'string' && body.annotationPath.trim() ? resolveUserPath(body.annotationPath) : undefined,
				request,
				outputPath
			});
			json(res, 200, { outputPath: result.outputPath, artifactUrl: artifactUrl(result.outputPath), meta: result.meta, report: result.report });
			return true;
		}
		if (req.method === 'POST' && url.pathname === '/api/search/action') {
			const body = await readJson(req);
			let state = searchState();
			const action = body.action;
			if (action === 'page-new') state = ensurePage(state, { imagePath: body.imagePath, imageId: body.imageId, page: body.page });
			else if (action === 'page-use') state = usePage(state, body.imageId, body.page);
			else if (action === 'page-clear') state = clearPage(state, body.imageId, body.page);
			else if (action === 'path-click') {
				const point = body.point as PointTuple;
				if (state.trails[body.name]) state = addTrailPoint(state, body.name, point);
				else state = startTrail(state, { name: body.name, imagePath: body.imagePath, imageId: body.imageId, page: body.page, point, color: body.color ?? 0 });
				const cursor = trailCursor(state, body.name);
				state = completeVisualInteraction(state, { imagePath: cursor.imagePath, imageId: cursor.imageId, page: cursor.page, focus: cursor.point });
			} else if (action === 'path-back') {
				state = backTrail(state, body.name);
				const cursor = trailCursor(state, body.name);
				state = completeVisualInteraction(state, { imagePath: cursor.imagePath, imageId: cursor.imageId, page: cursor.page, focus: cursor.point });
			} else if (action === 'path-branch') {
				state = branchTrail(state, body.name, body.newName, body.page);
				const cursor = trailCursor(state, body.newName);
				state = completeVisualInteraction(state, { imagePath: cursor.imagePath, imageId: cursor.imageId, page: cursor.page, focus: cursor.point });
			} else if (action === 'pin-temp') {
				state = addTempPin(state, {
					name: body.name,
					imagePath: body.imagePath,
					imageId: body.imageId,
					page: body.page,
					point: body.point as PointTuple,
					ttl: Number(body.ttl ?? 3),
					style: (body.style ?? 'ring-dot') as ScopePinStyle
				});
				state = completeVisualInteraction(state, { imagePath: body.imagePath, imageId: body.imageId, page: body.page, focus: body.point as PointTuple, agePins: false });
			} else if (action === 'pin-keep') {
				const pin = pinByName(state, body.name);
				state = keepPin(state, body.name);
				state = completeVisualInteraction(state, { imagePath: pin.imagePath, imageId: pin.imageId, page: pin.page, focus: pin.point, agePins: false });
			} else if (action === 'pin-release') state = releasePin(state, body.name).state;
			else if (action === 'pin-style') {
				const pin = pinByName(state, body.name);
				state = stylePin(state, body.name, body.style as ScopePinStyle);
				state = completeVisualInteraction(state, { imagePath: pin.imagePath, imageId: pin.imageId, page: pin.page, focus: pin.point, agePins: false });
			} else throw new Error(`lab ui: unknown Search action '${action}'.`);
			json(res, 200, searchSummary(saveState(state)));
			return true;
		}
		if (req.method === 'POST' && url.pathname === '/api/traverse/action') {
			const body = await readJson(req);
			let state = searchState();
			if (body.action === 'start') {
				const cached = canonicalCache.get(body.imageId) ?? await openCanonical(body.imagePath, body.annotationPath);
				let point: PointTuple;
				if (typeof body.anchor === 'string' && body.anchor.trim()) point = traverseAnchorPoint(body.anchor.trim(), cached.truth);
				else point = body.point as PointTuple;
				assertTraverseInside(point, cached.width, cached.height);
				state = startTraversal(state, {
					name: body.name,
					imagePath: cached.imagePath,
					imageId: cached.imageId,
					page: body.page,
					point,
					radiusPx: Number(body.radiusPx ?? 75),
					color: body.color ?? 0
				});
				const traversal = traversalByName(state, body.name);
				state = completeVisualInteraction(state, { imagePath: traversal.imagePath, imageId: traversal.imageId, page: traversal.page, focus: point });
			} else if (body.action === 'move') {
				const traversal = traversalByName(state, body.name);
				const cached = canonicalCache.get(traversal.imageId) ?? await openCanonical(traversal.imagePath);
				const current = traversalCurrentPoint(state, body.name);
				const target = traverseTarget(current, traversal.radiusPx, body.move as TraverseMove);
				assertTraverseInside(target.point, cached.width, cached.height);
				state = moveTraversal(state, body.name, target.point, target.detail);
				state = completeVisualInteraction(state, { imagePath: traversal.imagePath, imageId: traversal.imageId, page: traversal.page, focus: target.point });
			} else if (body.action === 'back') {
				const traversal = traversalByName(state, body.name);
				state = backTraversal(state, body.name);
				const point = traversalCurrentPoint(state, body.name);
				state = completeVisualInteraction(state, { imagePath: traversal.imagePath, imageId: traversal.imageId, page: traversal.page, focus: point });
			} else if (body.action === 'show') {
				const traversal = traversalByName(state, body.name);
				const point = traversalCurrentPoint(state, body.name);
				state = completeVisualInteraction(state, { imagePath: traversal.imagePath, imageId: traversal.imageId, page: traversal.page, focus: point });
			} else throw new Error(`lab ui: unknown Traverse action '${body.action}'.`);
			state = saveState(state);
			json(res, 200, { state: searchSummary(state), traversal: currentTraversal(state, body.name) });
			return true;
		}
		if (req.method === 'POST' && url.pathname === '/api/sweep/run') {
			const body = await readJson(req);
			const configPath = resolveUserPath(body.configPath);
			const inputPaths = Array.isArray(body.inputPaths) ? body.inputPaths.map((path: string) => resolveUserPath(path)) : [];
			const truthPath = typeof body.truthPath === 'string' && body.truthPath.trim() ? resolveUserPath(body.truthPath) : undefined;
			const result = await runSweepOperation({ configPath, inputPaths, truthPath });
			json(res, 200, {
				configName: result.configName,
				configPath: result.configPath,
				outDir: result.outDir,
				report: result.report,
				renderedCount: result.renderedCount,
				stubbedCount: result.stubbedCount,
				truthScoringSkipped: result.truthScoringSkipped,
				scoreboard: result.scoreboard,
				ops: result.plan.ops.map((op) => ({ id: op.id, gate: op.gate, kind: (op as any).kind ?? (op as any).op ?? '' })),
				receipts: result.receipts.map((receipt) => ({ opId: receipt.opId, artifactCount: receipt.artifacts.length, artifacts: receipt.artifacts })),
				artifactRenders: result.artifactRenders,
				files: listArtifacts(result.outDir)
			});
			return true;
		}
		json(res, 404, { error: `unknown API route ${req.method} ${url.pathname}` });
		return true;
	} catch (error) {
		json(res, 400, { error: (error as Error).message, stack: process.env.LAB_UI_STACK === '1' ? (error as Error).stack : undefined });
		return true;
	}
}

function openBrowser(url: string): void {
	try {
		if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
		else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
		else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
	} catch {
		// URL is always printed; browser opening is best-effort only.
	}
}

async function main(): Promise<void> {
	const raw = process.argv.slice(2);
	const args = raw[0] === 'ui' ? raw.slice(1) : [...raw];
	if (args.includes('--help') || args.includes('-h')) usage(0);
	const portText = option(args, '--port');
	const noOpen = flag(args, '--no-open');
	if (args.length > 0) throw new Error(`lab ui: unexpected args: ${args.join(' ')}`);
	const port = portText === undefined ? 4317 : Number(portText);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('lab ui: --port must be 1..65535.');

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
		if (await handleApi(req, res, url)) return;
		const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
		const path = resolve(APP_DIR, requested);
		if (!isInside(APP_DIR, path)) {
			json(res, 403, { error: 'forbidden' });
			return;
		}
		serveFile(res, path);
	});

	await new Promise<void>((resolvePromise, rejectPromise) => {
		server.once('error', rejectPromise);
		server.listen(port, '127.0.0.1', () => resolvePromise());
	});
	const url = `http://127.0.0.1:${port}/`;
	console.log(`LAB UI -> ${url}`);
	console.log(`  repo: ${REPO_ROOT}`);
	console.log(`  search state: ${SEARCH_STATE}`);
	console.log('  Ctrl-C to stop.');
	if (!noOpen) openBrowser(url);
}

main().catch((error) => {
	console.error(`lab ui: ${(error as Error).message}`);
	process.exit(1);
});
