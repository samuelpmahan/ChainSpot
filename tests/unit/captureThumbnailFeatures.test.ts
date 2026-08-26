import { describe, expect, test } from 'vitest';
import {
	compileABFeatureSet,
	createExecBoard,
	executeABFeatureSet,
	type ABFeatureSet
} from '@chainspot/alg/exec';
import { nullFeatureContext } from '@chainspot/alg/detectors/threeFactor/features/types';
import {
	createCaptureSourceFilesFeature,
	type CaptureSourceFilesProducer
} from '$lib/sourceIntake.feature';
import {
	createScoutThumbnailsFeature,
	type ScoutThumbnailBatchProducer
} from '$lib/scoutThumbnails.feature';
import type { SourceCaptureReceipt } from '$lib/sourceIntake';
import type { ScoutThumbnailTrace } from '$lib/scoutThumbnails';

const selectedFile = { name: 'accepted.png' } as File;
const rejectedFile = { name: 'broken.png' } as File;

const captureReceipt: SourceCaptureReceipt = {
	snapshotMs: 1,
	totalMs: 2,
	entries: [
		{
			ok: true,
			source: {
				file: selectedFile,
				selectionIndex: 0,
				imageId: 'image-1',
				sourceByteLength: 3,
				readMs: 1,
				hashMs: 1
			}
		},
		{
			ok: false,
			file: rejectedFile,
			selectionIndex: 1,
			reason: 'source-read-or-hash-failed'
		}
	]
};

function trace(): ScoutThumbnailTrace {
	return {
		runId: 'run-1',
		imageId: 'image-1',
		paramsHash: 'params-1',
		featureId: 'scout-thumbnails',
		traceHash: 'trace-1',
		objectIds: { source: 'image-1', thumbnail: 'image-1:thumbnail' },
		source: { widthPx: 1000, heightPx: 500 },
		thumbnail: { widthPx: 256, heightPx: 128 },
		transform: {
			sourceToThumbnail: { sx: 0.256, sy: 0.256 },
			thumbnailToSource: { sx: 1000 / 256, sy: 500 / 128 }
		},
		decoder: 'fake-decoder',
		resampler: 'fake-resampler',
		timingsMs: { decode: 1, resize: 2, total: 3 },
		verdict: 'accepted'
	};
}

describe('capture and scout ABFeatures', () => {
	async function evidenceHashFor(scoutTrace: ScoutThumbnailTrace): Promise<string> {
		const set: ABFeatureSet = {
			id: 'capture-and-scout',
			seededSlots: ['selectedFiles', 'scoutThumbnail.options'],
			features: [
				createCaptureSourceFilesFeature(async () => captureReceipt),
				createScoutThumbnailsFeature(async () => [scoutTrace])
			]
		};
		const compiled = compileABFeatureSet(set, { 'scout-thumbnails': { enabled: true } });
		const board = createExecBoard();
		board.set('selectedFiles', [selectedFile, rejectedFile]);
		board.set('scoutThumbnail.options', { runId: 'run-1', paramsHash: 'params-1' });
		return (
			await executeABFeatureSet(compiled, board, nullFeatureContext, {
				runId: 'feature-test',
				invocation: 'vitest captureThumbnailFeatures'
			})
		).manifestHash;
	}

	test('awaits the real slot flow, preserves capture rejection evidence, and pairs thumbnail evidence', async () => {
		const order: string[] = [];
		const capture: CaptureSourceFilesProducer = async (selection) => {
			order.push(`capture:${Array.from(selection ?? []).length}:start`);
			await Promise.resolve();
			order.push('capture:end');
			return captureReceipt;
		};
		const scout: ScoutThumbnailBatchProducer = async (sources, options) => {
			order.push(
				`scout:${sources.map((source) => source.imageId).join(',')}:${options.runId}:start`
			);
			await Promise.resolve();
			order.push('scout:end');
			return [trace()];
		};
		const set: ABFeatureSet = {
			id: 'capture-and-scout',
			seededSlots: ['selectedFiles', 'scoutThumbnail.options'],
			features: [createCaptureSourceFilesFeature(capture), createScoutThumbnailsFeature(scout)]
		};
		const compiled = compileABFeatureSet(set, { 'scout-thumbnails': { enabled: true } });
		const board = createExecBoard();
		board.set('selectedFiles', [selectedFile, rejectedFile]);
		board.set('scoutThumbnail.options', { runId: 'run-1', paramsHash: 'params-1' });

		const receipt = await executeABFeatureSet(compiled, board, nullFeatureContext, {
			runId: 'feature-test',
			invocation: 'vitest captureThumbnailFeatures'
		});

		expect(order).toEqual([
			'capture:2:start',
			'capture:end',
			'scout:image-1:run-1:start',
			'scout:end'
		]);
		expect(
			board.get<readonly { imageId: string }[]>('capturedSources').map((source) => source.imageId)
		).toEqual(['image-1']);
		expect(board.get<SourceCaptureReceipt>('captureSourceReceipt')).toBe(captureReceipt);
		expect(board.get<SourceCaptureReceipt>('captureSourceReceipt').entries[1]).toMatchObject({
			ok: false,
			reason: 'source-read-or-hash-failed'
		});
		expect(board.get<readonly ScoutThumbnailTrace[]>('thumbnail')).toEqual([trace()]);
		const evidence =
			board.get<readonly { cliText: string; visualRender: { traceHash: string } }[]>(
				'scoutThumbnail.evidence'
			);
		expect(evidence).toHaveLength(1);
		expect(evidence[0].cliText).toContain('traceHash=trace-1');
		expect(evidence[0].visualRender.traceHash).toBe('trace-1');
		expect(receipt.operations.map((operation) => operation.opId)).toEqual([
			'capture-source-files.capture',
			'scout-thumbnails.produce'
		]);
		for (const operation of receipt.operations) {
			expect(operation.actualConsumes).toEqual(operation.declaredConsumes);
			expect(operation.actualProduces).toEqual(operation.declaredProduces);
		}
		expect(receipt.operations[0].artifacts).toMatchObject([
			{ id: 'capture-source-files.ledger', kind: 'measurementTable', sha256: expect.any(String) }
		]);
		expect(receipt.operations[1].artifacts).toMatchObject([
			{
				id: 'scout-thumbnails.trace-metadata',
				kind: 'measurementTable',
				sha256: expect.any(String)
			}
		]);
	});

	test('keeps the scout deviation out of the default compiled set', () => {
		const set: ABFeatureSet = {
			id: 'capture-default-only',
			seededSlots: ['selectedFiles'],
			features: [createCaptureSourceFilesFeature(), createScoutThumbnailsFeature()]
		};
		const compiled = compileABFeatureSet(set);

		expect(compiled.enabledFeatureIds).toEqual(['capture-source-files']);
		expect(compiled.plan.ops.map((operation) => operation.id)).toEqual([
			'capture-source-files.capture'
		]);
	});

	test('hashes semantic feature output but excludes wall-clock timings', async () => {
		const baseline = await evidenceHashFor(trace());
		const timingOnly = await evidenceHashFor({
			...trace(),
			timingsMs: { decode: 100, resize: 200, total: 300 }
		});
		const changedVerdict = await evidenceHashFor({
			...trace(),
			traceHash: 'trace-rejected',
			thumbnail: undefined,
			transform: undefined,
			decoder: 'UNKNOWN',
			resampler: 'UNKNOWN',
			verdict: 'rejected',
			reason: 'browser decoder unavailable'
		});

		expect(timingOnly).toBe(baseline);
		expect(changedVerdict).not.toBe(baseline);
	});
});
