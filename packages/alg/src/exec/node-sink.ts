// R1: the ONLY file in exec/** allowed to touch node:fs/node:path. Never
// imported by contract.ts, board.ts, sink.ts, compile.ts, operations.ts,
// sha256.ts or gateway.ts — those stay browser-safe. This is the Node-only
// proof-plan sink: artifacts land under <outDir>/artifacts/<kind>/<id>.bin,
// receipts are appended one JSON object per line to
// <outDir>/receipts.jsonl. Deterministic given a deterministic outDir +
// plan: same plan, same inputs, same bytes on disk every run. Synchronous
// throughout (writeFileSync/appendFileSync + sha256.ts's sync digest) to
// match ExecSink's synchronous contract.

import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactKind, ArtifactRef, RasterDims, Receipt } from './contract';
import { sha256HexSync } from './sha256';
import type { ExecSink } from './sink';

export function createNodeSink(outDir: string): ExecSink {
	const artifactsDir = join(outDir, 'artifacts');
	mkdirSync(artifactsDir, { recursive: true });
	const receiptsPath = join(outDir, 'receipts.jsonl');
	if (existsSync(receiptsPath)) writeFileSync(receiptsPath, '');

	return {
		putArtifact(kind: ArtifactKind, id: string, bytes: Uint8Array, dims?: RasterDims): ArtifactRef {
			const sha256 = sha256HexSync(bytes);
			const kindDir = join(artifactsDir, kind);
			mkdirSync(kindDir, { recursive: true });
			const filePath = join(kindDir, `${id}.bin`);
			writeFileSync(filePath, bytes);
			return { id, kind, sha256, uri: `file://${filePath.replace(/\\/g, '/')}`, ...(dims ? { dims } : {}) };
		},
		putReceipt(receipt: Receipt): void {
			appendFileSync(receiptsPath, `${JSON.stringify(receipt)}\n`);
		}
	};
}
