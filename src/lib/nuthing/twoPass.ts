/**
 * Two-Pass Execution Protocol — CULLED RUN vs FULL REPLAY.
 *
 * A small, dependency-free, browser-portable generic that formalizes how a
 * downstream per-candidate task is measured against a CandidatePool<T>
 * (see ./candidatePool.ts for the primary/forwarded/culled semantics).
 *
 * Pass A — "CULLED RUN": runs `task` over `pool.forwarded` (primary +
 * secondary, i.e. everything at or above the theoretical floor, plus the
 * priority-primary candidates regardless of score). This is the number that
 * matters operationally: it is what a real system would spend, under the
 * theoretical floor, on this downstream task.
 *
 * Pass B — "FULL REPLAY": returns to the exact same boundary (the same
 * CandidatePool, the same `task`) and re-runs `task` over `pool.unculled`,
 * the complete ranked population. This pass exists purely for diagnostic
 * clarity and for falsification of the floor: because nothing is ever
 * erased from a CandidatePool, the FULL REPLAY can show whether any
 * culled-for-compute candidate would in fact have been valuable downstream
 * evidence. It is deliberately NOT an optimization shortcut — the task must
 * actually re-execute against the culled candidates too (culled results are
 * not just "the forwarded results plus nothing"), never merely inspected or
 * reused from Pass A's leftovers, or the falsification check would be
 * meaningless.
 *
 * Both passes are timed independently with performance.now() so their cost
 * can be compared directly (candidate count and wall time).
 */

import type { CandidatePool, RankedCandidate } from './candidatePool';

export interface TwoPassPass<R> {
	results: R[];
	seconds: number;
	candidateCount: number;
}

export interface TwoPassOutcome<R> {
	/** Pass A: task run over pool.forwarded — the operational timing number. */
	culledRun: TwoPassPass<R>;
	/** Pass B: task re-run over pool.unculled — diagnostic / floor falsification. */
	fullReplay: TwoPassPass<R>;
}

function timedRun<T, R>(
	candidates: RankedCandidate<T>[],
	task: (c: RankedCandidate<T>) => R
): TwoPassPass<R> {
	const results: R[] = new Array(candidates.length);
	const t0 = performance.now();
	for (let i = 0; i < candidates.length; i++) {
		results[i] = task(candidates[i]);
	}
	const seconds = (performance.now() - t0) / 1000;
	return { results, seconds, candidateCount: candidates.length };
}

/**
 * Run the same per-candidate `task` twice over a CandidatePool<T>: once
 * (CULLED RUN) over the forwarded set, and once more (FULL REPLAY) over the
 * complete unculled population. See module docstring for the semantics of
 * each pass — Pass B must actually re-execute `task`, not merely inspect
 * Pass A's leftovers.
 */
export function runTwoPass<T, R>(
	pool: CandidatePool<T>,
	task: (c: RankedCandidate<T>) => R
): TwoPassOutcome<R> {
	const culledRun = timedRun(pool.forwarded, task);
	const fullReplay = timedRun(pool.unculled, task);
	return { culledRun, fullReplay };
}
