import { randomUUID } from 'node:crypto';
import { hashCanonical } from './hashing';

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface EntityRef {
	/** Hash of the immutable Replay Node output that created this entity. */
	readonly producerObjectHash: string;
	/** Stable within that output, e.g. `component:label-42`, never an array position. */
	readonly localId: string;
}

export interface EntityLineageEdge {
	readonly child: EntityRef;
	readonly parent: EntityRef;
	/** Machine-readable relationship such as `derived-from` or `merged-from`. */
	readonly relation: string;
}

export type ApplicabilityResult =
	| { readonly status: 'applicable' }
	| { readonly status: 'not_applicable'; readonly reasonCode: string; readonly detail?: string };

export function entityKey(ref: EntityRef): string {
	if (!SHA256_PATTERN.test(ref.producerObjectHash)) {
		throw new TypeError(`Invalid producer object hash: ${ref.producerObjectHash}`);
	}
	if (ref.localId.length === 0 || ref.localId.trim() !== ref.localId) {
		throw new TypeError('Entity localId must be non-empty and have no surrounding whitespace');
	}
	return `${ref.producerObjectHash}:${encodeURIComponent(ref.localId)}`;
}

/** Build a replay-stable local ID from semantic evidence rather than list position. */
export function stableLocalEntityId(kind: string, localIdentity: unknown): string {
	if (kind.length === 0 || kind.trim() !== kind) throw new TypeError('Entity kind is invalid');
	return `${kind}:${hashCanonical({ entityLocalIdentitySchemaVersion: 1, kind, localIdentity })}`;
}

/** A run is one execution attempt. It is intentionally not deterministic. */
export function newRunId(): string {
	return randomUUID();
}
