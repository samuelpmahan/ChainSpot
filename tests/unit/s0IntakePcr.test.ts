import { describe, expect, test } from 'vitest';
import type { SourceCaptureReceipt } from '$lib/sourceIntake';
import type { ScoutThumbnailTrace } from '$lib/scoutThumbnails';
import {
	S0_DEFAULT_PLAN,
	S0_TO_S1_ADDRESS,
	judgeNaiveScoutThumbnailGate,
	runS0IntakePcr
} from '$lib/s0IntakePcr';

const file = { name: 'course.png' } as File;
const captureReceipt: SourceCaptureReceipt = {
	snapshotMs: 0,
	totalMs: 0,
	entries: [
		{
			ok: true,
			source: {
				file,
				selectionIndex: 0,
				imageId: 'course-1',
				sourceByteLength: 3,
				readMs: 0,
				hashMs: 0
			}
		}
	]
};

function acceptedTrace(maxSidePx = 256): ScoutThumbnailTrace {
	return {
		runId: 's0-test',
		imageId: 'course-1',
		paramsHash: `s0:scout-max-side=${maxSidePx}`,
		featureId: 'scout-thumbnails',
		traceHash: `trace-${maxSidePx}`,
		objectIds: { source: 'course-1', thumbnail: 'course-1:thumbnail' },
		source: { widthPx: 1000, heightPx: 500 },
		thumbnail: { widthPx: maxSidePx, heightPx: Math.round(maxSidePx / 2) },
		transform: {
			sourceToThumbnail: { sx: maxSidePx / 1000, sy: maxSidePx / 1000 },
			thumbnailToSource: { sx: 1000 / maxSidePx, sy: 1000 / maxSidePx }
		},
		decoder: 'test-decoder',
		resampler: 'test-resampler',
		timingsMs: { decode: 0, resize: 0, total: 0 },
		verdict: 'accepted'
	};
}

describe('S0 SourceIntake PCR kernel', () => {
	test('runs two real ABFeature Ticks over one PxC and composes testimony only afterward', async () => {
		const run = await runS0IntakePcr({
			selectedFiles: [file],
			runId: 's0-test',
			invocation: 'vitest S0 kernel',
			capture: async () => captureReceipt,
			scout: async (_sources, options) => [acceptedTrace(options.maxSidePx)]
		});

		expect(run.pcr.ticks.map((tick) => tick.operation.id)).toEqual([
			'capture-source-files.capture',
			'scout-thumbnails.produce'
		]);
		expect(run.pcr.ticks[1].testimony.actualConsumes).toEqual([
			'px.source.capturedSources',
			'px.run.scoutThumbnail'
		]);
		expect(run.pxc.get('px.source.thumbnails')).toEqual([acceptedTrace()]);
		expect(run.stage).toMatchObject({ id: 'S0', color: 'yellow' });
		expect(run.stage.gates[0].verdict).toContain('remains UNKNOWN');
		expect('run' in run.pcr).toBe(false);
	});

	test('NaiveGate exposes its strong assumption and keeps UNKNOWN yellow', () => {
		const empty = {
			has: () => false,
			get: () => {
				throw new Error('unread');
			}
		};
		const judgment = judgeNaiveScoutThumbnailGate(empty);
		expect(judgment.color).toBe('yellow');
		expect(judgment.assumption).toBe(S0_DEFAULT_PLAN.assumption);
		expect(judgment.challengers).toEqual([512, 1024]);
	});

	test('names the finish-line address the completing agent must populate', () => {
		expect(S0_TO_S1_ADDRESS).toBe('px.course.canonicalPixels');
	});

	test.todo(
		'real browser S0 populates px.course.canonicalPixels and S1 reads the same object without a second decode'
	);
});
