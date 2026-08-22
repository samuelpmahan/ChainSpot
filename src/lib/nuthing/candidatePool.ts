/**
 * CandidatePool<T> — reusable ranked-candidate primitive formalizing NuThing
 * P1's broad-candidate pattern (primary / secondary / culled-for-compute).
 *
 * Semantics (deliberate, do not "tighten"):
 *
 * - `primaryCount` comes from an observed cardinality in the evidence (for
 *   tees: the badge count). PRIMARY means "strongest candidates to process
 *   first" — a priority statement, never accepted ground truth.
 *
 * - `theoreticalFloor` (0.40 for tees, TEE_THEORETICAL_FLOOR) is a
 *   *theoretical floor*, NOT an acceptance threshold: below this score,
 *   current evidence suggests a candidate is unlikely to be worth downstream
 *   compute. That judgment is provisional and may be falsified by future
 *   truth. It gates *forwarding for compute only* and must never erase the
 *   evidence — the complete ranked population stays reachable via `all` and
 *   `unculled` regardless of forwarding decisions, so any downstream task can
 *   be replayed from the same boundary with every candidate (see the
 *   two-pass CULLED RUN / FULL REPLAY protocol in scripts/nuthing).
 *
 * Partition for rank r (1-based) and score s:
 *   r <= primaryCount                        -> PRIMARY
 *   r >  primaryCount && s >= theoreticalFloor -> SECONDARY (forwarded)
 *   r >  primaryCount && s <  theoreticalFloor -> CULLED FOR COMPUTE ONLY
 */

export interface RankedCandidate<T> {
	value: T;
	score: number;
	/** 1-based rank in descending score order. */
	rank: number;
}

/**
 * Current tee-candidate theoretical floor (B_CULL_IF_SCORE_BELOW in the
 * Python baseline). Provisional; falsifiable by FULL REPLAY evidence.
 */
export const TEE_THEORETICAL_FLOOR = 0.4;

export class CandidatePool<T> {
	/** Complete ranked population. Nothing is ever removed from this. */
	readonly all: RankedCandidate<T>[];
	/** Observed cardinality (e.g. badge count) — a priority cutoff, not truth. */
	readonly primaryCount: number;
	/** Theoretical compute floor — see module docs; never an acceptance test. */
	readonly theoreticalFloor: number;

	/**
	 * @param entries value/score pairs in ranking order if `preRanked`,
	 *   otherwise ranked here by descending score (stable: ties keep input
	 *   order, matching the baseline's stable sort).
	 */
	constructor(
		entries: { value: T; score: number }[],
		options: { primaryCount: number; theoreticalFloor: number; preRanked?: boolean }
	) {
		const ordered = options.preRanked
			? entries.slice()
			: entries
					.map((e, i) => [e, i] as const)
					.sort((a, b) => b[0].score - a[0].score || a[1] - b[1])
					.map(([e]) => e);
		this.all = ordered.map((e, i) => ({ value: e.value, score: e.score, rank: i + 1 }));
		this.primaryCount = options.primaryCount;
		this.theoreticalFloor = options.theoreticalFloor;
	}

	/** Strongest candidates to process first (rank <= primaryCount). */
	get primary(): RankedCandidate<T>[] {
		return this.all.slice(0, Math.min(this.primaryCount, this.all.length));
	}

	/** Non-primary candidates at or above the theoretical floor. */
	get secondary(): RankedCandidate<T>[] {
		return this.all.filter((c) => c.rank > this.primaryCount && c.score >= this.theoreticalFloor);
	}

	/** What a realistic (timed) downstream pass consumes: primary + secondary. */
	get forwarded(): RankedCandidate<T>[] {
		return this.all.filter((c) => c.rank <= this.primaryCount || c.score >= this.theoreticalFloor);
	}

	/** Withheld from downstream compute only — the evidence is retained. */
	get culled(): RankedCandidate<T>[] {
		return this.all.filter((c) => c.rank > this.primaryCount && c.score < this.theoreticalFloor);
	}

	/** Full population for diagnostic replay (identical to `all`). */
	get unculled(): RankedCandidate<T>[] {
		return this.all.slice();
	}
}
