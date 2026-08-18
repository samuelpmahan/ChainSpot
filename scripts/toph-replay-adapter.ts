/**
 * ChainSpot's Toph `ReplayAdapter` implementation for the Pancake CV
 * pipeline: `createChainSpotReplayAdapter` runs `runPancakePipeline`
 * headlessly (via `scripts/lib/cvReplayCore.ts`, the same machinery
 * `cv-replay-run.ts`'s CLI uses) under an arbitrary effective config, then
 * SYNTHESIZES a Toph trace from the pipeline's own rich per-stage
 * diagnostics using toph's runtime API. Per the cross-repo contract (§9),
 * no `@toph`/toph imports live in `src/lib`; trace synthesis happens only
 * here, after execution, from `StageExecutionRecord`s and the P6
 * gate/swap diagnostics.
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ChainSpotCvConfig } from '../src/lib/autoAnnotation/cvConfig';
import { CV_PARAM_SCHEMA, DEFAULT_CV_CONFIG } from '../src/lib/autoAnnotation/cvConfig';
import type { CvStageId, PancakeResult, StageExecutionRecord } from '../src/lib/autoAnnotation/cvPipeline';
import { score } from '../src/lib/autoAnnotation/p6AssignmentScoring';
import type { TruthHole } from '../src/lib/autoAnnotation/p6AssignmentScoring';
import { loadCvReplayContext, loadExternalTruth, runCvReplayPipeline } from './lib/cvReplayCore';

// ---------------------------------------------------------------------------------------
// Toph runtime + replay types, imported from the sibling repo by absolute/relative path
// (tsx-resolvable; no npm package dependency between the two repos).
// ---------------------------------------------------------------------------------------

type TophRuntime = typeof import('/workspace/toph/src/runtime/index.js');
type TophReplay = typeof import('/workspace/toph/src/replay/index.js');
type TraceRun = import('/workspace/toph/src/runtime/index.js').TraceRun;
type ReplayAdapter = import('/workspace/toph/src/replay/index.js').ReplayAdapter;
type AdapterRunOutput = import('/workspace/toph/src/replay/index.js').AdapterRunOutput;
type ParamSpec = import('/workspace/toph/src/replay/index.js').ParamSpec;

async function importToph(tophDir: string): Promise<{ runtime: TophRuntime; replay: TophReplay }> {
	const runtimeUrl = pathToFileURL(resolve(tophDir, 'src/runtime/index.ts')).href;
	const replayUrl = pathToFileURL(resolve(tophDir, 'src/replay/index.ts')).href;
	const runtime = (await import(runtimeUrl)) as TophRuntime;
	const replay = (await import(replayUrl)) as TophReplay;
	return { runtime, replay };
}

// ---------------------------------------------------------------------------------------
// Canonical stage id -> numeric Toph stage id, and a minimal ManifestFragment naming them
// (and the swap checks) so the viewer's scrubber/inspector can resolve names.
// ---------------------------------------------------------------------------------------

const STAGE_ORDER: readonly CvStageId[] = [
	'source',
	'p1.rawObjectMask',
	'p2.holeNumbers',
	'p3.ownership',
	'p4.ribbonSegmentation',
	'p4.ribbonOwnership',
	'p5.sparseAssignment',
	'p6.lowParAssignment',
	'p6.swapAdjudication',
	'final.displayGrammar'
];
const STAGE_NUMERIC_ID = new Map<CvStageId, number>(STAGE_ORDER.map((id, index) => [id, index + 1]));

const ENTITY_KIND = { hole: 1, basket: 2, tee: 3 } as const;
const SWAP_CHECK_ID = 1;

function buildManifest(): unknown {
	return {
		stages: STAGE_ORDER.map((id) => ({
			id: STAGE_NUMERIC_ID.get(id),
			name: id,
			kind: 'filter',
			source: { file: 'src/lib/autoAnnotation/cvPipeline.ts', line: 0 }
		})),
		checks: [
			{
				id: SWAP_CHECK_ID,
				stageId: STAGE_NUMERIC_ID.get('p6.swapAdjudication'),
				code: 'ribbonImprovementPx >= minRibbonImprovementPx',
				operator: 'gte',
				unit: 'px',
				source: { file: 'src/lib/autoAnnotation/p6LowParBasketAssignment.ts', line: 0 }
			}
		],
		assets: [],
		entityKinds: [
			{ id: ENTITY_KIND.hole, name: 'hole', source: { file: 'src/lib/autoAnnotation/cvPipeline.ts', line: 0 } },
			{ id: ENTITY_KIND.basket, name: 'basket', source: { file: 'src/lib/autoAnnotation/cvPipeline.ts', line: 0 } },
			{ id: ENTITY_KIND.tee, name: 'tee', source: { file: 'src/lib/autoAnnotation/cvPipeline.ts', line: 0 } }
		]
	};
}

// ---------------------------------------------------------------------------------------
// Trace synthesis
// ---------------------------------------------------------------------------------------

interface HoleBadgeLike {
	readonly holeNumber: number;
	readonly xPx: number;
	readonly yPx: number;
}

function synthesizeTrace(
	runtime: TophRuntime,
	pipeline: PancakeResult,
	stageRecords: readonly StageExecutionRecord[],
	config: ChainSpotCvConfig
): TraceRun {
	runtime.startTrace({ pipeline: 'chainspot.pancake' });

	// Object identity is what ties a later enterElement()/relate() back to the entity
	// spawned at its origin stage -- reuse the SAME array-element references the pipeline
	// itself produced rather than rebuilding equivalent-but-distinct objects.
	const holeRefByNumber = new Map<number, HoleBadgeLike>(
		pipeline.p2LabeledBadges.map((badge) => [badge.holeNumber, badge])
	);
	const basketRefs = pipeline.rawMaskObjects.baskets;
	const teeRefs = pipeline.rawMaskObjects.tees;

	let nextCheckSeq = 1;

	for (const record of stageRecords) {
		const stageId = STAGE_NUMERIC_ID.get(record.id);
		if (stageId === undefined) continue; // unreachable given STAGE_ORDER covers every CvStageId
		const invocationId = runtime.enterStage(stageId);

		for (const [name, value] of Object.entries(record.summary)) {
			runtime.recordMeasure(invocationId, name, value);
		}
		// Deliberately NOT recording wall-clock `ms` as a measure: toph's
		// `stagesEquivalentThrough`/`firstDivergentStage` treat every measure as a
		// semantic fact for structural equivalence, and wall-clock timing is pure
		// non-deterministic noise (varies run-to-run even under an identical
		// config) -- recording it here would make every replay "diverge" at
		// whichever stage happens to jitter first, defeating the point of the
		// comparison. Per-stage timing is still fully visible in `run.json`'s
        // summary.wallMs (whole-pipeline) and in `StageExecutionRecord.ms` on
        // disk for anyone who wants it; it is just not a divergence signal.

		if (record.id === 'p1.rawObjectMask') {
			runtime.spawnEntities(ENTITY_KIND.basket, basketRefs as unknown as readonly unknown[]);
			runtime.spawnEntities(ENTITY_KIND.tee, teeRefs as unknown as readonly unknown[]);
		}

		if (record.id === 'p2.holeNumbers') {
			runtime.spawnEntities(ENTITY_KIND.hole, pipeline.p2LabeledBadges as unknown as readonly unknown[]);
		}

		if (record.id === 'p6.lowParAssignment') {
			// P6.1 (gated) assignment: relate every resolved hole -> its assigned basket.
			for (const assignment of pipeline.p6LowParBasketAssignment.originalP6?.assignments ?? []) {
				if (assignment.assignedBasketIndex === null) continue;
				const holeRef = holeRefByNumber.get(assignment.holeNumber);
				const basketRef = basketRefs[assignment.assignedBasketIndex];
				if (holeRef === undefined || basketRef === undefined) continue;
				const holeElementId = runtime.enterElement(invocationId, holeRef);
				const basketElementId = runtime.enterElement(invocationId, basketRef);
				runtime.keep(holeElementId);
				runtime.keep(basketElementId);
				runtime.recordDataflow({
					t: 'relate',
					stage: invocationId,
					left: holeElementId,
					right: basketElementId,
					relation: 'assigned'
				});
			}
		}

		if (record.id === 'p6.swapAdjudication') {
			const swap = pipeline.p6LowParBasketAssignment.swapAdjudication;
			const minRibbonImprovementPx = config.p6.swap.minRibbonImprovementPx;
			for (const pair of swap?.pairs ?? []) {
				if (pair.ribbonImprovementPx === null) continue;
				const pairElementId = runtime.enterElement(invocationId);
				runtime.gte(pairElementId, SWAP_CHECK_ID, pair.ribbonImprovementPx, minRibbonImprovementPx);
				if (pair.swapApplied) runtime.keep(pairElementId);
			}
			// Applied-swap reassignments: relate each changed hole to its POST-swap basket.
			const changed = new Set(swap?.changedHoleNumbers ?? []);
			for (const assignment of pipeline.p6LowParBasketAssignment.assignments) {
				if (!changed.has(assignment.holeNumber) || assignment.assignedBasketIndex === null) continue;
				const holeRef = holeRefByNumber.get(assignment.holeNumber);
				const basketRef = basketRefs[assignment.assignedBasketIndex];
				if (holeRef === undefined || basketRef === undefined) continue;
				const holeElementId = runtime.enterElement(invocationId, holeRef);
				const basketElementId = runtime.enterElement(invocationId, basketRef);
				runtime.keep(holeElementId);
				runtime.keep(basketElementId);
				runtime.recordDataflow({
					t: 'relate',
					stage: invocationId,
					left: holeElementId,
					right: basketElementId,
					relation: 'reassigned'
				});
			}
		}
	}

	void nextCheckSeq; // reserved for future multi-check stages; single check id today.
	return runtime.finishTrace();
}

// ---------------------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------------------

export interface CreateChainSpotReplayAdapterOptions {
	readonly imagePath: string;
	readonly projectRoot: string;
	readonly tophDir: string;
	readonly truthPath?: string;
}

function gitRevisionSync(cwd: string): string {
	try {
		return execSync('git rev-parse HEAD', { cwd }).toString().trim();
	} catch {
		return 'unknown';
	}
}

export async function createChainSpotReplayAdapter(
	options: CreateChainSpotReplayAdapterOptions
): Promise<ReplayAdapter> {
	const { runtime } = await importToph(options.tophDir);

	const context = await loadCvReplayContext(options.imagePath, options.projectRoot, options.truthPath);
	const truthHoles: readonly TruthHole[] | undefined = context.truthHoles;

	const chainspotRev = gitRevisionSync(options.projectRoot);
	const tophRev = gitRevisionSync(options.tophDir);

	return {
		pipelineId: 'chainspot.pancake',
		codeVersion: { chainspot: chainspotRev, toph: tophRev },
		source: {
			name: context.image.fileName,
			sha256: context.sha256,
			widthPx: context.image.widthPx,
			heightPx: context.image.heightPx
		},
		defaults: DEFAULT_CV_CONFIG,
		paramSchema: CV_PARAM_SCHEMA as unknown as readonly ParamSpec[],

		async execute(effectiveConfig: object): Promise<AdapterRunOutput> {
			const config = effectiveConfig as ChainSpotCvConfig;
			const stageRecords: StageExecutionRecord[] = [];
			const { wallMs, pipeline, correctness } = await runCvReplayPipeline(context, config, (record) => {
				stageRecords.push(record);
			});

			const trace = synthesizeTrace(runtime, pipeline, stageRecords, config);
			const manifest = buildManifest();

			const p6 = pipeline.p6LowParBasketAssignment;
			const swap = p6.swapAdjudication;

			const summary: Record<string, number | string | boolean | null> = {
				wallMs,
				holes: pipeline.grammar.holes.length,
				assignedByLowPar: p6.assignedByLowPar,
				lockedByP4: p6.lockedByP4,
				unresolved: p6.unresolved,
				'p62.swapsApplied': swap?.swapsApplied ?? 0,
				'p62.changedHoles': (swap?.changedHoleNumbers ?? []).join(',')
			};
			if (truthHoles && truthHoles.length > 0 && correctness) {
				summary['assignment.correct'] = correctness.correct;
				summary['assignment.incorrect'] = correctness.incorrect.length;
				summary['assignment.scoredAgainst'] = options.truthPath ?? context.image.fileName;
			}

			const final = pipeline.p6LowParBasketAssignment.assignments.map((assignment) => {
				const basket =
					assignment.assignedBasketIndex !== null
						? pipeline.rawMaskObjects.baskets[assignment.assignedBasketIndex]
						: undefined;
				return {
					holeNumber: assignment.holeNumber,
					teeIndex: assignment.teeIndex,
					assignedBasketIndex: assignment.assignedBasketIndex,
					basketXPx: basket?.centerXPx ?? null,
					basketYPx: basket?.centerYPx ?? null,
					status: assignment.status,
					assignmentReason: assignment.assignmentReason
				};
			});

			return { trace, manifest, summary, final };
		}
	};
}

// Re-exported for the smoke script and proof scripts so they don't need to know the
// truth-loading detail (bare TruthHole[] vs a fixture without independent basket truth).
export { loadExternalTruth, score };
