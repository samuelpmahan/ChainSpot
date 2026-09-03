import {
	compileABFeatureSet,
	createExecBoard,
	executeABFeatureSet,
	type ABFeatureSet,
	type ABFeatureSetManifest
} from '@chainspot/alg/exec';
import { sha256HexSyncText } from '@chainspot/alg/exec/sha256';
import { nullFeatureContext } from '@chainspot/alg/detectors/threeFactor/features/types';
import { captureSourceFilesFeature } from './sourceIntake.feature';
import { scoutThumbnailsFeature } from './scoutThumbnails.feature';
import { classifyAndScoutFeature } from './classifyAndScout.feature';
import { selectiveFullDecodeFeature } from './selectiveFullDecode.feature';
import { formatSourceCaptureReceipt, type SourceCaptureReceipt } from './sourceIntake';
import {
	assertScoutThumbnailCorrespondence,
	type ScoutThumbnailEvidence
} from './scoutThumbnailEvidence';
import type { ScoutThumbnailTrace } from './scoutThumbnails.types';
import {
	assertClassifyAndScoutCorrespondence,
	type ClassifyAndScoutEvidence
} from './classifyAndScoutEvidence';
import type { ClassifyAndScoutTrace } from './classifyAndScout.types';
import {
	assertSelectiveFullDecodeCorrespondenceRows,
	type SelectiveFullDecodeEvidence
} from './selectiveFullDecodeEvidence';
import type { SelectiveFullDecodeTrace } from './selectiveFullDecode.types';

export const intakeFeatureSet: ABFeatureSet = {
	id: 'intake-cv',
	seededSlots: [
		'px.source.selectedFiles',
		'px.run.scoutThumbnail',
		'classifyAndScout.options',
		'selectiveFullDecode.options'
	],
	features: [
		captureSourceFilesFeature,
		scoutThumbnailsFeature,
		classifyAndScoutFeature,
		selectiveFullDecodeFeature
	]
};

export interface IntakeFeatureSetInput {
	readonly selectedFiles: readonly File[];
	readonly runId: string;
	readonly invocation: string;
	readonly scoutParamsHash: string;
	readonly classifyParamsHash: string;
	readonly scoutEnabled: boolean;
	readonly selectiveFullDecodeEnabled?: boolean;
	readonly scoutMaxSidePx?: number;
}

export interface IntakeFeatureSetResult {
	readonly captureReceipt: SourceCaptureReceipt;
	readonly thumbnailTraces: readonly ScoutThumbnailTrace[];
	readonly thumbnailEvidence: readonly ScoutThumbnailEvidence[];
	readonly classificationTraces: readonly ClassifyAndScoutTrace[];
	readonly classificationEvidence: readonly ClassifyAndScoutEvidence[];
	readonly selectiveFullDecodeTraces: readonly SelectiveFullDecodeTrace[];
	readonly selectiveFullDecodeEvidence: readonly SelectiveFullDecodeEvidence[];
	readonly setManifest: ABFeatureSetManifest;
	readonly acceptanceReceiptHash: string;
	readonly acceptanceReceiptMarkdown: string;
}

function buildAcceptanceReceipt(
	runId: string,
	capture: SourceCaptureReceipt,
	thumbnailEvidence: readonly ScoutThumbnailEvidence[],
	classificationEvidence: readonly ClassifyAndScoutEvidence[],
	selectiveFullDecodeEvidence: readonly SelectiveFullDecodeEvidence[]
): { readonly hash: string; readonly markdown: string } {
	for (const evidence of thumbnailEvidence) {
		assertScoutThumbnailCorrespondence(evidence.cliText, evidence.visualRender);
	}
	for (const evidence of classificationEvidence) {
		assertClassifyAndScoutCorrespondence(evidence);
	}
	assertSelectiveFullDecodeCorrespondenceRows(selectiveFullDecodeEvidence);

	const featureRows = thumbnailEvidence.flatMap((thumbnail, index) => {
		const classification = classificationEvidence[index];
		return [
			`## Image ${index + 1}: \`${thumbnail.visualRender.imageId}\``,
			'',
			'- reviewer verification: **PASS** — CLI rows correspond to the VisualRender model',
			'- human pixel review: **REQUIRED** for acceptance',
			'',
			'### Measurement / math description',
			'',
			'```text',
			thumbnail.mathText,
			...(classification ? [classification.mathText] : ['classify-and-scout UNKNOWN']),
			'```',
			'',
			'### VisualRender model',
			'',
			'```json',
			JSON.stringify(
				{
					thumbnail: thumbnail.visualRender,
					classification: classification?.visualRender ?? 'UNKNOWN'
				},
				null,
				2
			),
			'```',
			'',
			'### CLI text',
			'',
			'```text',
			thumbnail.cliText,
			...(classification ? [classification.cliText] : ['classify-and-scout UNKNOWN']),
			'```',
			''
		];
	});
	const selectiveDecodeRows = selectiveFullDecodeEvidence.flatMap((evidence, index) => [
		`## Selective full decode ${index + 1}: \`${evidence.visualRender.regionObjectId}\``,
		'',
		'- reviewer verification: **PASS** — CLI row corresponds to the VisualRender model',
		'- human pixel review: **REQUIRED** for acceptance',
		'',
		'### Measurement / math description',
		'',
		'```text',
		evidence.mathText,
		'```',
		'',
		'### VisualRender model',
		'',
		'```json',
		JSON.stringify(evidence.visualRender, null, 2),
		'```',
		'',
		'### CLI text',
		'',
		'```text',
		evidence.cliText,
		'```',
		''
	]);
	const body = [
		`- run: \`${runId}\``,
		'- correspondence verifier: **PASS**',
		'- acceptance verdict: **HUMAN VISUAL REVIEW REQUIRED**',
		'',
		'## Source capture CLI',
		'',
		'```text',
		formatSourceCaptureReceipt(capture),
		'```',
		'',
		...featureRows,
		...selectiveDecodeRows
	].join('\n');
	const hash = sha256HexSyncText(body);
	return {
		hash,
		markdown: ['# Intake Acceptance Receipt', '', `- full-detail hash: \`${hash}\``, body].join(
			'\n'
		)
	};
}

export async function runIntakeFeatureSet(
	input: IntakeFeatureSetInput
): Promise<IntakeFeatureSetResult> {
	const compiled = compileABFeatureSet(
		intakeFeatureSet,
		{
			'scout-thumbnails': { enabled: input.scoutEnabled },
			'classify-and-scout': { enabled: input.scoutEnabled },
			'selective-full-decode': {
				enabled: input.selectiveFullDecodeEnabled ?? input.scoutEnabled
			}
		},
		input.classifyParamsHash
	);
	const board = createExecBoard();
	board.set('px.source.selectedFiles', input.selectedFiles);
	board.set('px.run.scoutThumbnail', {
		runId: input.runId,
		paramsHash: input.scoutParamsHash,
		maxSidePx: input.scoutMaxSidePx ?? 256
	});
	board.set('classifyAndScout.options', {
		runId: input.runId,
		paramsHash: input.classifyParamsHash
	});
	board.set('selectiveFullDecode.options', {
		runId: input.runId,
		paramsHash: input.classifyParamsHash,
		featureId: 'selective-full-decode'
	});
	const setManifest = await executeABFeatureSet(compiled, board, nullFeatureContext, {
		runId: input.runId,
		invocation: input.invocation
	});
	const captureReceipt = board.get<SourceCaptureReceipt>('px.source.captureReceipt');
	const thumbnailTraces = board.has('px.source.thumbnails')
		? board.get<readonly ScoutThumbnailTrace[]>('px.source.thumbnails')
		: [];
	const thumbnailEvidence = board.has('px.source.thumbnailInspections')
		? board.get<readonly ScoutThumbnailEvidence[]>('px.source.thumbnailInspections')
		: [];
	const classificationTraces = board.has('classifyAndScout.trace')
		? board.get<readonly ClassifyAndScoutTrace[]>('classifyAndScout.trace')
		: [];
	const classificationEvidence = board.has('classifyAndScout.evidence')
		? board.get<readonly ClassifyAndScoutEvidence[]>('classifyAndScout.evidence')
		: [];
	const selectiveFullDecodeTraces = board.has('selectiveFullDecode.trace')
		? board.get<readonly SelectiveFullDecodeTrace[]>('selectiveFullDecode.trace')
		: [];
	const selectiveFullDecodeEvidence = board.has('selectiveFullDecode.evidence')
		? board.get<readonly SelectiveFullDecodeEvidence[]>('selectiveFullDecode.evidence')
		: [];
	const acceptanceReceipt = buildAcceptanceReceipt(
		input.runId,
		captureReceipt,
		thumbnailEvidence,
		classificationEvidence,
		selectiveFullDecodeEvidence
	);

	return {
		captureReceipt,
		thumbnailTraces,
		thumbnailEvidence,
		classificationTraces,
		classificationEvidence,
		selectiveFullDecodeTraces,
		selectiveFullDecodeEvidence,
		setManifest,
		acceptanceReceiptHash: acceptanceReceipt.hash,
		acceptanceReceiptMarkdown: acceptanceReceipt.markdown
	};
}
