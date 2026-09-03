import {
	compileABFeatureSet,
	composePcr,
	createExecBoard,
	executeABFeatureSet,
	type ABFeatureSet,
	type ABFeatureSetManifest,
	type Pcr,
	type PxC
} from '@chainspot/alg/exec';
import { nullFeatureContext } from '@chainspot/alg/detectors/threeFactor/features/types';
import {
	createCaptureSourceFilesFeature,
	type CaptureSourceFilesProducer
} from './sourceIntake.feature';
import {
	createScoutThumbnailsFeature,
	type ScoutThumbnailBatchProducer
} from './scoutThumbnails.feature';
import type { ScoutThumbnailTrace } from './scoutThumbnails';

export type GateColor = 'red' | 'yellow' | 'green';

export interface NaiveGateJudgment {
	readonly id: 'S0.scout-thumbnail-sufficiency';
	readonly name: 'NaiveScoutThumbnailGate';
	readonly color: GateColor;
	readonly reads: readonly ['px.run.scoutThumbnail', 'px.source.thumbnails'];
	readonly assumption: 'A 256px-max thumbnail is sufficient for source-kind scouting.';
	readonly verdict: string;
	readonly challengers: readonly [512, 1024];
}

export interface S0StageInspection {
	readonly id: 'S0';
	readonly name: 'SourceIntakeStage';
	readonly color: GateColor;
	readonly gates: readonly [NaiveGateJudgment];
}

export interface S0IntakePcrRun {
	readonly pxc: PxC;
	readonly manifest: ABFeatureSetManifest;
	readonly pcr: Pcr;
	readonly stage: S0StageInspection;
}

export interface S0IntakeRunArgs {
	readonly selectedFiles: readonly File[];
	readonly runId: string;
	readonly invocation: string;
	readonly maxSidePx?: number;
	readonly capture?: CaptureSourceFilesProducer;
	readonly scout?: ScoutThumbnailBatchProducer;
}

export const S0_TO_S1_ADDRESS = 'px.course.canonicalPixels' as const;

export const S0_DEFAULT_PLAN = {
	maxSidePx: 256,
	challengers: [512, 1024] as const,
	assumption: 'A 256px-max thumbnail is sufficient for source-kind scouting.' as const
};

/**
 * A deliberately strong, oversimplified incumbent. It reads materialized PxC
 * state and judges it; it neither schedules nor performs CV.
 */
export function judgeNaiveScoutThumbnailGate(pxc: Pick<PxC, 'get' | 'has'>): NaiveGateJudgment {
	const reads = ['px.run.scoutThumbnail', 'px.source.thumbnails'] as const;
	if (!pxc.has(reads[1])) {
		return {
			id: 'S0.scout-thumbnail-sufficiency',
			name: 'NaiveScoutThumbnailGate',
			color: 'yellow',
			reads,
			assumption: S0_DEFAULT_PLAN.assumption,
			verdict: 'UNKNOWN — no scout thumbnails have materialized.',
			challengers: S0_DEFAULT_PLAN.challengers
		};
	}
	const traces = pxc.get<readonly ScoutThumbnailTrace[]>(reads[1]);
	if (traces.length === 0) {
		return {
			id: 'S0.scout-thumbnail-sufficiency',
			name: 'NaiveScoutThumbnailGate',
			color: 'yellow',
			reads,
			assumption: S0_DEFAULT_PLAN.assumption,
			verdict: 'UNKNOWN — the selected source set was empty.',
			challengers: S0_DEFAULT_PLAN.challengers
		};
	}
	const rejected = traces.filter((trace) => trace.verdict !== 'accepted');
	return {
		id: 'S0.scout-thumbnail-sufficiency',
		name: 'NaiveScoutThumbnailGate',
		color: rejected.length === 0 ? 'yellow' : 'red',
		reads,
		assumption: S0_DEFAULT_PLAN.assumption,
		verdict:
			rejected.length === 0
				? `${traces.length}/${traces.length} sources produced an inspectable scout thumbnail. Sufficiency for source-kind scouting remains UNKNOWN until a real scout comparison challenges the 256px incumbent.`
				: `${rejected.length}/${traces.length} sources could not produce an inspectable scout thumbnail.`,
		challengers: S0_DEFAULT_PLAN.challengers
	};
}

export async function runS0IntakePcr(args: S0IntakeRunArgs): Promise<S0IntakePcrRun> {
	const maxSidePx = args.maxSidePx ?? S0_DEFAULT_PLAN.maxSidePx;
	const definition: ABFeatureSet = {
		id: 's0-source-intake',
		seededSlots: ['px.source.selectedFiles', 'px.run.scoutThumbnail'],
		features: [
			createCaptureSourceFilesFeature(args.capture),
			createScoutThumbnailsFeature(args.scout)
		]
	};
	const compiled = compileABFeatureSet(
		definition,
		{ 'scout-thumbnails': { enabled: true } },
		`s0:scout-max-side=${maxSidePx}`
	);
	const pxc = createExecBoard();
	pxc.set('px.source.selectedFiles', args.selectedFiles);
	pxc.set('px.run.scoutThumbnail', {
		runId: args.runId,
		paramsHash: compiled.plan.paramsHash ?? compiled.plan.planFingerprint,
		maxSidePx
	});
	const manifest = await executeABFeatureSet(compiled, pxc, nullFeatureContext, {
		runId: args.runId,
		invocation: args.invocation
	});
	const pcr = composePcr(
		{
			id: 's0-source-intake-pcr',
			title: 'S0 SourceIntake PCR',
			tickIds: ['capture-source-files.capture', 'scout-thumbnails.produce']
		},
		compiled.plan,
		manifest.operations
	);
	const gate = judgeNaiveScoutThumbnailGate(pxc);
	return {
		pxc,
		manifest,
		pcr,
		stage: { id: 'S0', name: 'SourceIntakeStage', color: gate.color, gates: [gate] }
	};
}
