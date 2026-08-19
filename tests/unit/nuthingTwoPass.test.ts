import { describe, expect, it } from 'vitest';
import { CandidatePool } from '../../src/lib/nuthing/candidatePool';
import { runTwoPass } from '../../src/lib/nuthing/twoPass';

const entries = [
  { value: 'a', score: 0.95 },
  { value: 'b', score: 0.9 },
  { value: 'c', score: 0.55 },
  { value: 'd', score: 0.41 },
  { value: 'e', score: 0.4 },
  { value: 'f', score: 0.39 },
  { value: 'g', score: 0.05 },
];

function makePool(primaryCount: number): CandidatePool<string> {
  return new CandidatePool(entries, { primaryCount, theoreticalFloor: 0.4 });
}

describe('runTwoPass', () => {
  it('CULLED RUN covers pool.forwarded and FULL REPLAY covers pool.unculled', () => {
    const pool = makePool(2);
    const outcome = runTwoPass(pool, (c) => c.value);
    expect(outcome.culledRun.candidateCount).toBe(pool.forwarded.length);
    expect(outcome.fullReplay.candidateCount).toBe(pool.unculled.length);
    expect(outcome.culledRun.candidateCount).toBeLessThan(outcome.fullReplay.candidateCount);
    expect(outcome.fullReplay.candidateCount).toBe(entries.length);
  });

  it('results preserve pool ranking order for both passes', () => {
    const pool = makePool(2);
    const outcome = runTwoPass(pool, (c) => c.value);
    expect(outcome.culledRun.results).toEqual(pool.forwarded.map((c) => c.value));
    expect(outcome.fullReplay.results).toEqual(pool.unculled.map((c) => c.value));
    // FULL REPLAY sees every candidate, including the culled tail.
    expect(outcome.fullReplay.results).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    // CULLED RUN skips the sub-floor tail.
    expect(outcome.culledRun.results).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('both passes actually re-execute the task (invocation counts match candidate counts, not shared)', () => {
    const pool = makePool(2);
    let invocations = 0;
    const seenRanks: number[] = [];
    const outcome = runTwoPass(pool, (c) => {
      invocations++;
      seenRanks.push(c.rank);
      return c.rank;
    });
    // Each pass independently invokes task once per candidate: forwarded (5)
    // + unculled (7) = 12 total invocations, not 7 (which would mean Pass B
    // only inspected Pass A's leftovers instead of truly re-running).
    expect(invocations).toBe(pool.forwarded.length + pool.unculled.length);
    expect(outcome.culledRun.results).toEqual([1, 2, 3, 4, 5]);
    expect(outcome.fullReplay.results).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // The culled ranks (6, 7) appear only in the FULL REPLAY invocation set.
    const culledRanks = seenRanks.filter((r) => r === 6 || r === 7);
    expect(culledRanks).toEqual([6, 7]);
  });

  it('timing fields are present and non-negative for both passes', () => {
    const pool = makePool(0);
    const outcome = runTwoPass(pool, (c) => c.value.length);
    expect(outcome.culledRun.seconds).toBeGreaterThanOrEqual(0);
    expect(outcome.fullReplay.seconds).toBeGreaterThanOrEqual(0);
  });

  it('an empty forwarded set still runs a (possibly empty) CULLED RUN and a full FULL REPLAY', () => {
    // primaryCount 0 and every score below an artificially high floor.
    const pool = new CandidatePool(entries, { primaryCount: 0, theoreticalFloor: 2.0 });
    expect(pool.forwarded).toHaveLength(0);
    const outcome = runTwoPass(pool, (c) => c.value);
    expect(outcome.culledRun.results).toEqual([]);
    expect(outcome.culledRun.candidateCount).toBe(0);
    expect(outcome.fullReplay.results).toEqual(pool.all.map((c) => c.value));
    expect(outcome.fullReplay.candidateCount).toBe(entries.length);
  });
});
