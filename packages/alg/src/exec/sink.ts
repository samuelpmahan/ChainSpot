// R1: the injected sink boundary. executeCompiledPlan (gateway.ts) never
// touches disk itself — it hands artifact bytes and receipts to whatever
// ExecSink the caller provides. This file stays browser-safe: sha256.ts's
// synchronous hash (not Web Crypto) so the sink interface — and therefore
// executeCompiledPlan — can stay synchronous, matching runEngine's
// existing public (and parity-pinned) synchronous contract. The Node
// filesystem sink lives in node-sink.ts, a separate module the core never
// imports.

import type { ArtifactKind, ArtifactRef, Receipt } from './contract';
import { sha256HexSync } from './sha256';

export interface ExecSink {
	putArtifact(kind: ArtifactKind, id: string, bytes: Uint8Array): ArtifactRef;
	putReceipt(receipt: Receipt): void;
}

/** No-op sink: hashes nothing, stores nothing, for callers that don't want receipts/artifacts collected (the trace-off fast path). */
export function createNullSink(): ExecSink {
	return {
		putArtifact(kind, id) {
			return { id, kind, sha256: '', uri: '' };
		},
		putReceipt() {}
	};
}

export interface MemorySink extends ExecSink {
	readonly artifacts: ArtifactRef[];
	readonly receipts: Receipt[];
	readonly blobs: Map<string, Uint8Array>;
}

/** In-memory sink: the browser-safe default. Collects everything for the caller to inspect or hand to its own storage. */
export function createMemorySink(): MemorySink {
	const artifacts: ArtifactRef[] = [];
	const receipts: Receipt[] = [];
	const blobs = new Map<string, Uint8Array>();
	return {
		artifacts,
		receipts,
		blobs,
		putArtifact(kind, id, bytes) {
			const sha256 = sha256HexSync(bytes);
			const ref: ArtifactRef = { id, kind, sha256, uri: `memory://${id}` };
			blobs.set(id, bytes);
			artifacts.push(ref);
			return ref;
		},
		putReceipt(receipt) {
			receipts.push(receipt);
		}
	};
}
