import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson } from './canonicalJson';

export function sha256Bytes(bytes: Uint8Array | string): string {
	return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(path: string): string {
	return sha256Bytes(readFileSync(path));
}

export function hashCanonical(value: unknown): string {
	return sha256Bytes(canonicalJson(value));
}

export interface ReplayNodeInvocationIdentity {
	readonly cacheKeySchemaVersion: 1;
	readonly nodeType: string;
	readonly outputSchemaVersion: number;
	readonly implementation: {
		readonly id: string;
		readonly version: string;
		readonly sourceDigest: string;
	};
	readonly parameters: unknown;
	readonly orderedInputObjectHashes: readonly string[];
	readonly relevantEnvironment: unknown;
}

/** Deterministic identity for one node computation and therefore its cache lookup. */
export function computeInvocationKey(identity: ReplayNodeInvocationIdentity): string {
	return hashCanonical(identity);
}

export interface ResolvedExperimentIdentity {
	readonly experimentHashSchemaVersion: 1;
	readonly resolvedManifest: unknown;
	readonly resolvedSuite: unknown;
	readonly registryResolution: unknown;
}

/**
 * Deterministic experiment identity. Re-running this exact resolution yields
 * the same hash, while each execution receives a separate runId.
 */
export function computeExperimentHash(identity: ResolvedExperimentIdentity): string {
	return hashCanonical(identity);
}
