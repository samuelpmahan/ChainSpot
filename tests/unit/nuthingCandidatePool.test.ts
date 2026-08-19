import { describe, expect, it } from 'vitest';
import {
  CandidatePool,
  TEE_THEORETICAL_FLOOR,
} from '../../src/lib/nuthing/candidatePool';

const entries = [
  { value: 'a', score: 0.95 },
  { value: 'b', score: 0.9 },
  { value: 'c', score: 0.55 },
  { value: 'd', score: 0.41 },
  { value: 'e', score: 0.4 },
  { value: 'f', score: 0.39 },
  { value: 'g', score: 0.05 },
];

describe('CandidatePool', () => {
  it('partitions by rank and theoretical floor', () => {
    const pool = new CandidatePool(entries, {
      primaryCount: 2,
      theoreticalFloor: TEE_THEORETICAL_FLOOR,
    });
    expect(pool.primary.map((c) => c.value)).toEqual(['a', 'b']);
    expect(pool.secondary.map((c) => c.value)).toEqual(['c', 'd', 'e']);
    expect(pool.forwarded.map((c) => c.value)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(pool.culled.map((c) => c.value)).toEqual(['f', 'g']);
  });

  it('score exactly at the floor is forwarded, not culled', () => {
    const pool = new CandidatePool(entries, { primaryCount: 0, theoreticalFloor: 0.4 });
    expect(pool.forwarded.some((c) => c.value === 'e')).toBe(true);
    expect(pool.culled.some((c) => c.value === 'e')).toBe(false);
  });

  it('never erases evidence: unculled and all always carry every candidate', () => {
    const pool = new CandidatePool(entries, { primaryCount: 2, theoreticalFloor: 0.4 });
    expect(pool.all).toHaveLength(entries.length);
    expect(pool.unculled).toHaveLength(entries.length);
    expect(new Set([...pool.forwarded, ...pool.culled].map((c) => c.value)).size).toBe(
      entries.length,
    );
  });

  it('assigns 1-based ranks in descending score order with stable ties', () => {
    const pool = new CandidatePool(
      [
        { value: 'x', score: 0.5 },
        { value: 'y', score: 0.9 },
        { value: 'z', score: 0.5 },
      ],
      { primaryCount: 1, theoreticalFloor: 0.4 },
    );
    expect(pool.all.map((c) => c.value)).toEqual(['y', 'x', 'z']);
    expect(pool.all.map((c) => c.rank)).toEqual([1, 2, 3]);
  });

  it('respects preRanked input order', () => {
    const pool = new CandidatePool(
      [
        { value: 'first', score: 0.1 },
        { value: 'second', score: 0.9 },
      ],
      { primaryCount: 1, theoreticalFloor: 0.4, preRanked: true },
    );
    expect(pool.all.map((c) => c.value)).toEqual(['first', 'second']);
  });

  it('primaryCount larger than population yields all-primary', () => {
    const pool = new CandidatePool(entries.slice(0, 2), {
      primaryCount: 18,
      theoreticalFloor: 0.4,
    });
    expect(pool.primary).toHaveLength(2);
    expect(pool.secondary).toHaveLength(0);
    expect(pool.culled).toHaveLength(0);
  });
});
