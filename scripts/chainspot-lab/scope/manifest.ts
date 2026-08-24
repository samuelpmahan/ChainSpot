import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BoxTuple, PointTuple, ScopeManifest, ScopeManifestCase, ScopeRequest } from './types';

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function point(value: unknown, where: string): PointTuple {
	if (!Array.isArray(value) || value.length !== 2 || !value.every(isFiniteNumber)) {
		throw new Error(`lab scope: ${where} must be [x,y].`);
	}
	return [value[0], value[1]];
}

function box(value: unknown, where: string): BoxTuple {
	if (!Array.isArray(value) || value.length !== 4 || !value.every(isFiniteNumber) || value[2] <= 0 || value[3] <= 0) {
		throw new Error(`lab scope: ${where} must be [x,y,w,h] with positive w/h.`);
	}
	return [value[0], value[1], value[2], value[3]];
}

function parseRequest(value: unknown, where: string): ScopeRequest {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`lab scope: ${where} must be an object.`);
	const raw = value as Record<string, unknown>;
	const request: ScopeRequest = {
		name: typeof raw.name === 'string' ? raw.name : undefined,
		point: raw.point === undefined ? undefined : point(raw.point, `${where}.point`),
		box: raw.box === undefined ? undefined : box(raw.box, `${where}.box`),
		mark: raw.mark === undefined ? undefined : point(raw.mark, `${where}.mark`),
		dots: raw.dots === undefined ? undefined : (Array.isArray(raw.dots) ? raw.dots.map((p, i) => point(p, `${where}.dots[${i}]`)) : (() => { throw new Error(`lab scope: ${where}.dots must be an array of [x,y].`); })()),
		path: raw.path === undefined ? undefined : (Array.isArray(raw.path) ? raw.path.map((p, i) => point(p, `${where}.path[${i}]`)) : (() => { throw new Error(`lab scope: ${where}.path must be an array of [x,y].`); })()),
		hole: raw.hole === undefined ? undefined : (isFiniteNumber(raw.hole) && Number.isInteger(raw.hole) && raw.hole > 0 ? raw.hole : (() => { throw new Error(`lab scope: ${where}.hole must be a positive integer.`); })()),
		template: typeof raw.template === 'string' ? raw.template : undefined,
		color: raw.color === undefined ? undefined : (isFiniteNumber(raw.color) ? Math.trunc(raw.color) : undefined)
	};
	const kinds = [request.point, request.box, request.mark, request.dots, request.path, request.hole].filter((v) => v !== undefined).length;
	if (kinds !== 1) throw new Error(`lab scope: ${where} must specify exactly one of point, box, mark, dots, path, or hole.`);
	return request;
}

function parseCase(value: unknown, where: string): ScopeManifestCase {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`lab scope: ${where} must be an object.`);
	const raw = value as Record<string, unknown>;
	if (typeof raw.name !== 'string' || raw.name.trim() === '') throw new Error(`lab scope: ${where}.name is required.`);
	if (typeof raw.image !== 'string' || raw.image.trim() === '') throw new Error(`lab scope: ${where}.image is required.`);
	if (!Array.isArray(raw.scopes) || raw.scopes.length === 0) throw new Error(`lab scope: ${where}.scopes must be a non-empty array.`);
	return {
		name: raw.name,
		image: raw.image,
		annotation: typeof raw.annotation === 'string' ? raw.annotation : undefined,
		scopes: raw.scopes.map((s, i) => parseRequest(s, `${where}.scopes[${i}]`))
	};
}

export interface LoadedScopeManifest {
	readonly path: string;
	readonly dir: string;
	readonly cases: readonly ScopeManifestCase[];
}

export function loadScopeManifest(manifestPath: string): LoadedScopeManifest {
	const path = resolve(manifestPath);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch (err) {
		throw new Error(`lab scope: could not read/parse manifest at ${path}: ${(err as Error).message}`);
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`lab scope: manifest at ${path} must be an object.`);
	const manifest = raw as ScopeManifest;
	if (manifest.version !== undefined && manifest.version !== 1) throw new Error(`lab scope: unsupported manifest version '${manifest.version}'.`);
	let cases: ScopeManifestCase[];
	if (Array.isArray(manifest.cases)) {
		cases = manifest.cases.map((c, i) => parseCase(c, `cases[${i}]`));
	} else {
		if (typeof manifest.image !== 'string' || !Array.isArray(manifest.scopes) || manifest.scopes.length === 0) {
			throw new Error('lab scope: manifest needs either cases[] or top-level image + scopes[].');
		}
		cases = [{
			name: 'default',
			image: manifest.image,
			annotation: typeof manifest.annotation === 'string' ? manifest.annotation : undefined,
			scopes: manifest.scopes.map((s, i) => parseRequest(s, `scopes[${i}]`))
		}];
	}
	return { path, dir: dirname(path), cases };
}

export function resolveManifestCasePaths(baseDir: string, entry: ScopeManifestCase): ScopeManifestCase {
	return {
		...entry,
		image: resolve(baseDir, entry.image),
		annotation: entry.annotation ? resolve(baseDir, entry.annotation) : undefined
	};
}
