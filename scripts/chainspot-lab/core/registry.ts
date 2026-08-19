import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { canonicalJson } from './canonicalJson';
import { hashCanonical, sha256Bytes } from './hashing';

export interface ResourceDeclaration {
	readonly cpuCores: number;
	readonly ramMiB: number;
	readonly gpu: null | {
		readonly required: boolean;
		readonly minVramMiB: number;
	};
}

export interface ImplementationRegistration {
	readonly id: string;
	readonly version: string;
	readonly nodeType: string;
	readonly language: 'typescript' | 'python';
	readonly entrypoint: string;
	/**
	 * Complete behavior-bearing source set: algorithm, adapters, and imported
	 * shared implementation files. Unrelated repository files stay out.
	 */
	readonly sources: readonly string[];
	readonly inputKinds: readonly string[];
	readonly outputKind: string;
	readonly resources: ResourceDeclaration;
}

export interface RegisteredImplementation extends ImplementationRegistration {
	readonly implementationKey: string;
	readonly sourceDigest: string;
	readonly sourceEntries: readonly { readonly path: string; readonly sha256: string }[];
}

export class ImplementationRegistry {
	private readonly repoRoot: string;
	private readonly entries = new Map<string, RegisteredImplementation>();

	constructor(repoRoot: string) {
		this.repoRoot = resolve(repoRoot);
	}

	register(registration: ImplementationRegistration): RegisteredImplementation {
		this.validateRegistration(registration);
		const sourceEntries = [...new Set(registration.sources.map((path) => this.normalizeSource(path)))]
			.sort()
			.map((path) => {
				const fullPath = this.resolveRepoFile(path);
				return { path, sha256: sha256Bytes(readFileSync(fullPath)) };
			});
		const sourceDigest = hashCanonical({ sourceDigestSchemaVersion: 1, files: sourceEntries });
		const implementationKey = hashCanonical({
			implementationIdentitySchemaVersion: 1,
			id: registration.id,
			version: registration.version,
			sourceDigest
		});
		const duplicateKey = `${registration.id}@${registration.version}`;
		if (this.entries.has(duplicateKey)) {
			throw new Error(`Implementation already registered: ${duplicateKey}`);
		}
		const registered: RegisteredImplementation = {
			...registration,
			entrypoint: this.normalizeSource(registration.entrypoint),
			sources: sourceEntries.map((entry) => entry.path),
			implementationKey,
			sourceDigest,
			sourceEntries
		};
		this.entries.set(duplicateKey, registered);
		return registered;
	}

	resolve(id: string, version: string): RegisteredImplementation {
		const entry = this.entries.get(`${id}@${version}`);
		if (!entry) throw new Error(`Unknown implementation: ${id}@${version}`);
		return entry;
	}

	list(): readonly RegisteredImplementation[] {
		return [...this.entries.values()].sort((a, b) => a.implementationKey.localeCompare(b.implementationKey));
	}

	resolutionJson(): string {
		return canonicalJson(this.list());
	}

	private normalizeSource(path: string): string {
		return path.split(sep).join('/');
	}

	private resolveRepoFile(path: string): string {
		if (isAbsolute(path)) throw new TypeError(`Source path must be repository-relative: ${path}`);
		const fullPath = resolve(this.repoRoot, path);
		const fromRoot = relative(this.repoRoot, fullPath);
		if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
			throw new TypeError(`Source path escapes repository: ${path}`);
		}
		if (!statSync(fullPath).isFile()) throw new TypeError(`Source is not a file: ${path}`);
		return fullPath;
	}

	private validateRegistration(registration: ImplementationRegistration): void {
		for (const [name, value] of [
			['id', registration.id],
			['version', registration.version],
			['nodeType', registration.nodeType],
			['outputKind', registration.outputKind]
		] as const) {
			if (value.length === 0 || value.trim() !== value) throw new TypeError(`${name} is invalid`);
		}
		if (registration.sources.length === 0) throw new TypeError('At least one behavior-bearing source is required');
		const normalizedEntrypoint = this.normalizeSource(registration.entrypoint);
		if (!registration.sources.map((source) => this.normalizeSource(source)).includes(normalizedEntrypoint)) {
			throw new TypeError('The entrypoint must be included in the behavior-bearing source set');
		}
		this.resolveRepoFile(normalizedEntrypoint);
		if (!Number.isInteger(registration.resources.cpuCores) || registration.resources.cpuCores < 1) {
			throw new TypeError('cpuCores must be a positive integer');
		}
		if (!Number.isInteger(registration.resources.ramMiB) || registration.resources.ramMiB < 1) {
			throw new TypeError('ramMiB must be a positive integer');
		}
		if (registration.resources.gpu && registration.resources.gpu.minVramMiB < 0) {
			throw new TypeError('minVramMiB cannot be negative');
		}
	}
}
