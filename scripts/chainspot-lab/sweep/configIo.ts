// Config load -> parse -> resolve -> compile, for both `./lab compile` and
// `./lab sweep`. Every step below calls straight into @chainspot/alg's own
// exports (parseConfig/resolveConfig/compileExecutionPlan/DEFAULT_EXECUTION)
// -- LAB does not re-implement config semantics, it only reads a file off
// disk and hands the parsed JSON to the algorithm.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	DEFAULT_EXECUTION,
	parseConfig,
	resolveConfig,
	type ResolvedConfig,
	type ThreeFactorConfig
} from '@chainspot/alg/detectors/threeFactor';
import { compileExecutionPlan, type CompiledExecutionPlan } from '@chainspot/alg/exec';

export interface LoadedConfig {
	readonly path: string;
	readonly raw: ThreeFactorConfig;
	readonly resolved: ResolvedConfig;
	readonly plan: CompiledExecutionPlan;
}

/** Reads a config JSON file, validates it (parseConfig), merges registry
 * defaults with its deviations (resolveConfig), and compiles the resulting
 * operation plan (compileExecutionPlan) -- exactly the same three calls
 * tests/unit/exec.evidenceChains.test.ts makes by hand. Throws (with the
 * algorithm's own error message) on a malformed config or an illegal
 * execution order -- LAB does not soften or reinterpret those errors. */
export function loadConfig(configPath: string, paramsHash?: string): LoadedConfig {
	const path = resolve(configPath);
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(path, 'utf8'));
	} catch (err) {
		throw new Error(`lab: could not read/parse config at ${path}: ${(err as Error).message}`);
	}
	const raw = parseConfig(json);
	const resolved = resolveConfig(raw, DEFAULT_EXECUTION);
	const plan = compileExecutionPlan(resolved, paramsHash);
	return { path, raw, resolved, plan };
}
