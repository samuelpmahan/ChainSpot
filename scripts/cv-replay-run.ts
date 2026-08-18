/**
 * Headless, config-driven replay runner for the Pancake CV pipeline.
 *
 * Runs the REAL production pipeline (`cvPipeline.ts`'s `runPancakePipeline`,
 * the same function `basketDetection.worker.ts` delegates to) against one
 * image or `.chainspot.zip`, with an arbitrary `ChainSpotCvConfig`, entirely
 * in Node. This is the mechanism a counterfactual-replay tool (Toph) drives:
 * grid search and manual parameter toggles both just call this with a
 * different config.
 *
 * This CLI is a thin wrapper around `scripts/lib/cvReplayCore.ts`'s
 * `loadCvReplayContext`/`runCvReplayPipeline`, which the Toph replay adapter
 * (`scripts/toph-replay-adapter.ts`) also imports so both entry points share
 * exactly one implementation of image/template loading and pipeline
 * execution.
 *
 * Unlike `pancake-harness.ts` (which drives the worker's message protocol
 * end-to-end, including its browser-only OffscreenCanvas plumbing, to prove
 * production parity), this script calls `runPancakePipeline` directly so it
 * can capture per-stage `StageExecutionRecord`s and an arbitrary config --
 * the worker's message protocol has neither.
 *
 * Usage:
 *   npx tsx scripts/cv-replay-run.ts --image <png/jpg/.chainspot.zip> --project-root . [--config <json file>] [--truth <json file>] [--out <json file>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StageExecutionRecord } from '../src/lib/autoAnnotation/cvPipeline';
import { DEFAULT_CV_CONFIG } from '../src/lib/autoAnnotation/cvConfig';
import type { ChainSpotCvConfig } from '../src/lib/autoAnnotation/cvConfig';
import { gitRevisionSync, loadCvReplayContext, runCvReplayPipeline } from './lib/cvReplayCore';

interface CliArgs {
	readonly image: string;
	readonly projectRoot: string;
	readonly configPath?: string;
	readonly outPath?: string;
	readonly truthPath?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
	const get = (flag: string): string | undefined => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const image = get('--image');
	const projectRoot = get('--project-root');
	if (!image || !projectRoot) {
		throw new Error(
			'Usage: npx tsx scripts/cv-replay-run.ts --image <png/jpg/.chainspot.zip> --project-root . [--config <json file>] [--truth <json file>] [--out <json file>]'
		);
	}
	return {
		image,
		projectRoot,
		configPath: get('--config'),
		outPath: get('--out'),
		truthPath: get('--truth')
	};
}

function deepMerge<T>(base: T, patch: unknown): T {
	if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base;
	const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
		const baseValue = (base as Record<string, unknown>)[key];
		result[key] =
			value !== null && typeof value === 'object' && !Array.isArray(value) && baseValue !== undefined
				? deepMerge(baseValue, value)
				: value;
	}
	return result as T;
}

function loadEffectiveConfig(configPath: string | undefined): ChainSpotCvConfig {
	if (!configPath) return DEFAULT_CV_CONFIG;
	const raw = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
	return deepMerge(DEFAULT_CV_CONFIG, raw);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const projectRoot = resolve(args.projectRoot);
	const config = loadEffectiveConfig(args.configPath);

	const context = await loadCvReplayContext(args.image, projectRoot, args.truthPath);

	const stages: StageExecutionRecord[] = [];
	const { wallMs, pipeline, correctness } = await runCvReplayPipeline(context, config, (record) => {
		stages.push(record);
	});

	const perHoleAssignments = pipeline.p6LowParBasketAssignment.assignments.map((assignment) => {
		const basket =
			assignment.assignedBasketIndex !== null ? pipeline.rawMaskObjects.baskets[assignment.assignedBasketIndex] : undefined;
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

	const output = {
		wallMs,
		sourceIdentity: {
			fileName: context.image.fileName,
			sha256: context.sha256,
			widthPx: context.image.widthPx,
			heightPx: context.image.heightPx
		},
		codeVersion: { chainspot: gitRevisionSync(projectRoot) },
		effectiveConfig: config,
		stages,
		p6: pipeline.p6LowParBasketAssignment,
		final: { holes: pipeline.grammar.holes.length },
		perHoleAssignments,
		correctness
	};

	const json = JSON.stringify(output, null, 2);
	if (args.outPath) {
		writeFileSync(resolve(args.outPath), json);
	} else {
		console.log(json);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
