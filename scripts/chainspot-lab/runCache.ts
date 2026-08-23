import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

export interface StageCodec<T> {
	load(dir: string): T;
	save(dir: string, value: T): void;
}

export interface CachedStage<T> {
	key: string;
	value: T;
	cacheHit: boolean;
	elapsedMs: number;
}

interface StageMeta {
	key: string;
	stage: string;
	createdAt: string;
}

export interface LabRunCacheOptions {
	inputPath: string;
	cacheRoot: string;
	repoRoot: string;
	maxStageMs?: number;
}

function sha256(parts: Iterable<string | Uint8Array>): string {
	const hash = createHash('sha256');
	for (const part of parts) {
		hash.update(part);
		hash.update('\0');
	}
	return hash.digest('hex');
}

function fileDigest(path: string): string {
	return sha256([readFileSync(path)]);
}

export function jsonCodec<T>(name = 'value.json'): StageCodec<T> {
	return {
		load(dir) {
			return JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
		},
		save(dir, value) {
			writeFileSync(join(dir, name), `${JSON.stringify(value)}\n`);
		}
	};
}

export function writeTypedArray(
	path: string,
	value: Uint8Array | Int32Array | Float32Array
): void {
	writeFileSync(path, Buffer.from(value.buffer, value.byteOffset, value.byteLength));
}

export function readUint8(path: string): Uint8Array {
	const b = readFileSync(path);
	return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

export function readInt32(path: string): Int32Array {
	const b = readFileSync(path);
	return new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

export function readFloat32(path: string): Float32Array {
	const b = readFileSync(path);
	return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/**
 * Persistent LAB stage cache. A stage key follows the actual execution
 * dependency graph: input bytes, upstream keys, transitive relative imports,
 * config, stage closure, and codec implementation. No hand-maintained SHA
 * registry is required.
 */
export class LabRunCache {
	readonly inputPath: string;
	readonly inputKey: string;
	readonly runDir: string;
	readonly repoRoot: string;
	readonly maxStageMs: number;

	constructor(options: LabRunCacheOptions) {
		this.inputPath = resolve(options.inputPath);
		this.repoRoot = resolve(options.repoRoot);
		this.maxStageMs = options.maxStageMs ?? 40_000;
		this.inputKey = fileDigest(this.inputPath);
		const slug = basename(this.inputPath).replace(/[^A-Za-z0-9._-]+/g, '_');
		this.runDir = join(resolve(options.cacheRoot), `${slug}-${this.inputKey.slice(0, 12)}`);
		mkdirSync(this.runDir, { recursive: true });
	}

	dependencyDigest(paths: readonly string[]): string {
		const pieces: string[] = [];
		const visited = new Set<string>();
		const resolveImport = (from: string, specifier: string): string | null => {
			const base = resolve(dirname(from), specifier);
			const candidates = [
				base,
				`${base}.ts`,
				`${base}.tsx`,
				`${base}.js`,
				`${base}.json`,
				join(base, 'index.ts'),
				join(base, 'index.tsx')
			];
			return candidates.find((candidate) => existsSync(candidate)) ?? null;
		};
		const visit = (abs: string): void => {
			const canonical = resolve(abs);
			if (visited.has(canonical)) return;
			visited.add(canonical);
			const bytes = readFileSync(canonical);
			pieces.push(relative(this.repoRoot, canonical), sha256([bytes]));
			if (!/\.(?:[cm]?js|tsx?)$/.test(canonical)) return;
			const text = bytes.toString('utf8');
			const imports = [...text.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)]
				.map((match) => resolveImport(canonical, match[1]))
				.filter((path): path is string => path !== null)
				.sort();
			for (const imported of imports) visit(imported);
		};
		for (const path of [...paths].sort()) visit(resolve(this.repoRoot, path));
		return sha256(pieces);
	}

	stage<T>(options: {
		name: string;
		upstream?: readonly string[];
		dependencies?: readonly string[];
		config?: unknown;
		codec: StageCodec<T>;
		compute: () => T;
	}): CachedStage<T> {
		const dependencyKey = this.dependencyDigest(options.dependencies ?? []);
		const key = sha256([
			this.inputKey,
			options.name,
			...(options.upstream ?? []),
			dependencyKey,
			JSON.stringify(options.config ?? null),
			options.compute.toString(),
			options.codec.load.toString(),
			options.codec.save.toString()
		]);
		const dir = join(this.runDir, options.name);
		const stageMetaPath = join(dir, '.stage.json');

		if (existsSync(stageMetaPath)) {
			try {
				const meta = JSON.parse(readFileSync(stageMetaPath, 'utf8')) as StageMeta;
				if (meta.key === key) {
					const started = performance.now();
					const value = options.codec.load(dir);
					const elapsedMs = performance.now() - started;
					console.log(`[cache] ${options.name}: HIT (${elapsedMs.toFixed(1)}ms)`);
					return { key, value, cacheHit: true, elapsedMs };
				}
			} catch {
				// Incomplete/corrupt cache: recompute atomically below.
			}
		}

		const started = performance.now();
		const value = options.compute();
		const elapsedMs = performance.now() - started;
		if (elapsedMs > this.maxStageMs) {
			throw new Error(
				`${options.name} exceeded LAB stage budget: ${(elapsedMs / 1000).toFixed(2)}s > ${(this.maxStageMs / 1000).toFixed(0)}s`
			);
		}

		const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(tmp, { recursive: true });
		options.codec.save(tmp, value);
		const meta: StageMeta = { key, stage: options.name, createdAt: new Date().toISOString() };
		writeFileSync(join(tmp, '.stage.json'), `${JSON.stringify(meta, null, 2)}\n`);
		rmSync(dir, { recursive: true, force: true });
		renameSync(tmp, dir);
		console.log(`[cache] ${options.name}: MISS (${elapsedMs.toFixed(1)}ms)`);
		return { key, value, cacheHit: false, elapsedMs };
	}
}
