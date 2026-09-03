import type { OperationArtifact } from '@chainspot/alg/exec';
import type { ABFeature } from '@chainspot/alg/detectors/threeFactor/features/types';

import {
	captureSelectedSources,
	type CapturedSource,
	type SourceCaptureReceipt
} from './sourceIntake';

export type CaptureSourceFilesProducer = (
	selection: Iterable<File> | null
) => Promise<SourceCaptureReceipt>;

function captureLedgerArtifact(receipt: SourceCaptureReceipt): OperationArtifact {
	const entries = receipt.entries.map((entry) =>
		entry.ok
			? {
					verdict: 'accepted',
					imageId: entry.source.imageId,
					selectionIndex: entry.source.selectionIndex,
					sourceByteLength: entry.source.sourceByteLength,
					name: entry.source.file.name
				}
			: {
					verdict: 'rejected',
					selectionIndex: entry.selectionIndex,
					name: entry.file.name,
					reason: entry.reason
				}
	);
	return {
		id: 'capture-source-files.ledger',
		kind: 'measurementTable',
		bytes: new TextEncoder().encode(JSON.stringify({ featureId: 'capture-source-files', entries }))
	};
}

/**
 * Baseline intake plumbing: snapshot the selection once, then preserve both
 * accepted sources and rejected entries for downstream evidence.
 */
export function createCaptureSourceFilesFeature(
	capture: CaptureSourceFilesProducer = captureSelectedSources
): ABFeature {
	return {
		id: 'capture-source-files',
		gate: 'shared',
		kind: 'baseline',
		defaultEnabled: true,
		note: 'Snapshot selected Files and retain the raw-byte SHA-256 source ledger.',
		knobs: {},
		operations: [
			{
				spec: {
					id: 'capture-source-files.capture',
					kind: 'materialize',
					gate: 'shared',
					unit: 'capture-source-files',
					consumes: ['px.source.selectedFiles'],
					produces: ['px.source.capturedSources', 'px.source.captureReceipt'],
					calculations: ['fn.captureSelectedSources'],
					accessConformance: 'exact',
					features: ['capture-source-files'],
					note: 'Await the existing raw-byte source capture; successful sources and rejected entries share one receipt.'
				},
				calculationBindings: [{ address: 'fn.captureSelectedSources', calculate: capture }],
				async run(board) {
					const selection = board.get<Iterable<File> | null>('px.source.selectedFiles');
					const receipt = await capture(selection);
					const capturedSources: readonly CapturedSource[] = receipt.entries.flatMap((entry) =>
						entry.ok ? [entry.source] : []
					);
					board.set('px.source.capturedSources', capturedSources);
					board.set('px.source.captureReceipt', receipt);
				},
				extractArtifacts(board) {
					return [
						captureLedgerArtifact(board.get<SourceCaptureReceipt>('px.source.captureReceipt'))
					];
				}
			}
		]
	};
}

export const captureSourceFilesFeature = createCaptureSourceFilesFeature();
