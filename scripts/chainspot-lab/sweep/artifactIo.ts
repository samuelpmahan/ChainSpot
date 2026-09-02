// Reads back what the Node sink (@chainspot/alg/exec/node-sink) already
// wrote to <outDir>/artifacts/<kind>/<id>.bin and dispatches each artifact
// through rendererContract.ts's RENDERERS registry. RENDERERS starts empty
// (Codex workers fill it in against the published contract) -- every kind
// falls back to "the raw bytes are already on disk, plus a one-line text
// stub" until a renderer for that kind lands. This file never recomputes
// artifact content; it only reads bytes the algorithm's sink already wrote
// and hands them to a renderer (or a stub note) for presentation.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ArtifactKind, ArtifactRef } from '@chainspot/alg/exec';
import { RENDERERS } from './rendererContract';

const JSON_KINDS: readonly ArtifactKind[] = [
	'componentSet',
	'candidateSet',
	'badgeEvidence',
	'm1Representation',
	'm2Representation',
	'polyline',
	'measurementTable'
];

export interface ArtifactRenderResult {
	readonly artifactRef: ArtifactRef;
	readonly rendered: boolean;
	readonly summary: string;
	readonly filesWritten: readonly string[];
}

/** outDir is the SAME directory createNodeSink(outDir) was given -- the
 * artifact bytes are already sitting under <outDir>/artifacts/<kind>/. This
 * writes any renderer output (or a stub) under <outDir>/renders/<kind>/. */
export function renderArtifact(
	outDir: string,
	opId: string,
	gate: string,
	artifactRef: ArtifactRef
): ArtifactRenderResult {
	const bytesPath = resolve(outDir, 'artifacts', artifactRef.kind, `${artifactRef.id}.bin`);
	const bytes = existsSync(bytesPath) ? new Uint8Array(readFileSync(bytesPath)) : new Uint8Array(0);
	const parsed = JSON_KINDS.includes(artifactRef.kind) ? safeParseJson(bytes) : undefined;

	const renderDir = join(outDir, 'renders', artifactRef.kind);
	mkdirSync(renderDir, { recursive: true });

	const renderer = RENDERERS[artifactRef.kind];
	if (renderer) {
		const output = renderer({
			artifactRef,
			bytes,
			parsed,
			// ArtifactRef gained an optional `dims` field on the alg side (Chunk A's
			// candidate fix (a) from the GAP note above) -- forward it verbatim.
			// This is a source OUTSIDE the artifact's own bytes (the producing
			// extractor's in-memory width/height), never inferred from the
			// payload, so it satisfies RendererInput.dims's contract as written.
			// Verified end-to-end 2026-08-25 via a real `lab sweep` against
			// DashsTrack-full.jpg: badgeStage.masks's rgba/mask artifacts all
			// carried dims (1290x2083) through gateway.ts -> createNodeSink ->
			// here -> the mask renderer, which rasterized successfully. Still
			// `undefined` for any artifact whose extractor/sink doesn't populate
			// ArtifactRef.dims -- that stays a per-artifact/per-sink fact, not
			// something to special-case here.
			dims: artifactRef.dims,
			baseRasterPngPath: undefined,
			outDir: renderDir,
			opId,
			gate
		});
		return {
			artifactRef,
			// A registered renderer running is not the same fact as it having
			// rendered anything -- a renderer can decline (mask with no/mismatched
			// dims; measurementTable with unparseable JSON) and fall back to a
			// text-only stub note of its own. Testimony comes from the renderer's
			// own truthful `rendered` flag (rendererContract.ts), never from
			// "was RENDERERS[kind] set".
			rendered: output.rendered,
			summary: output.summary,
			filesWritten: output.filesWritten
		};
	}

	const stubPath = join(renderDir, `${artifactRef.id}.stub.txt`);
	const stub =
		`No renderer registered for artifact kind '${artifactRef.kind}' yet.\n` +
		`See scripts/chainspot-lab/sweep/rendererContract.ts for the interface to implement.\n\n` +
		`artifactRef: ${JSON.stringify(artifactRef, null, 2)}\n` +
		`bytes: ${bytes.byteLength} byte(s) on disk at ${bytesPath}\n` +
		(parsed !== undefined ? `parsed preview: ${JSON.stringify(parsed).slice(0, 500)}\n` : '');
	writeFileSync(stubPath, stub);
	return {
		artifactRef,
		rendered: false,
		summary: `no renderer for '${artifactRef.kind}' -- raw bytes + stub written`,
		filesWritten: [stubPath]
	};
}

function safeParseJson(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return undefined;
	}
}
