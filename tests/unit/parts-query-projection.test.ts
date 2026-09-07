import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { projectRun, queryPresets } from '../../src/lib/parts-query/projection';
import { loadTables } from '../../src/lib/parts-query/tables';
import type { PqlRun } from '../../packages/alg/src/exec/pql';

const component = (id: string, pixels: number[], label = 1) => ({ id, address: `px.part.${id}`, kind: 'component', polarity: 'white', label, widthPx: 4, heightPx: 4, pixels: Uint32Array.from(pixels) });
const run = (output: unknown): PqlRun => ({ PrincipleComponentRender: 'S1', Ticks: [{ name: 'BadgeAssembly', Calculations: [{ call: 'fn.test.select' as `fn.${string}`, actualCall: 'fn.test.select', with: {}, args: {}, into: 'px.out', inputs: {}, output }] }] });

describe('projectRun', () => {
  it('keeps rejected and incomplete groups, deduplicates shared parts, and records paths', () => {
    const shared = component('shared', [0, 1, 4]);
    const projected = projectRun(run({ candidates: [{ id: 'candidate-a', parts: [{ part: shared, bbox: [9, 8, 7, 6], area: 99 }] }, { id: 'candidate-b', parts: [shared] }], rejected: [{ id: 'plate-x', reasons: ['width outside range'], part: shared }], incomplete: [{ id: 'plate-y', reason: 'no contained white digit material' }] }));
    expect(projected.tables.results.rows.map(row => row.collection)).toEqual(['candidates', 'candidates', 'rejected', 'incomplete']);
    expect(projected.tables.parts.rows).toHaveLength(1);
    expect(projected.tables.parts.rows[0]).toMatchObject({ part_key: 'px.part.shared', pixel_count: 3, bbox_x: 9, bbox_y: 8, bbox_width: 7, bbox_height: 6 });
    expect(projected.tables.parts.rows[0].bbox_source_result).toBe('r0:candidates[0]');
    expect(projected.tables.result_parts.rows.filter(row => row.part_key === 'px.part.shared')).toHaveLength(3);
    expect(projected.tables.results.rows.find(row => row.collection === 'rejected')?.reason).toBe('width outside range');
    expect(projected.targets.get('r0:candidates[0]')).toMatchObject({ calculation: 0, item: 'candidates:0', part: 'px.part.shared' });
  });
  it('projects empty and scalar outputs deterministically', () => {
    const projected = projectRun(run({ candidates: [], rejected: [], incomplete: [] }));
    expect(projected.tables.results.rows).toEqual([]);
    expect(projected.tables.parts.rows).toEqual([]);
    expect(projected.tables.result_parts.rows).toEqual([]);
    expect([...projected.targets]).toEqual([]);
    expect(Object.keys(projected.tables.results.columns)).toContain('reason');
  });
  it('counts dense mask membership rather than zero entries as pixel indexes', () => {
    const projected = projectRun(run({ kind: 'mask', id: 'white-mask', address: 'px.mask.white', widthPx: 3, heightPx: 2, pixels: Uint8Array.from([0, 1, 0, 1, 1, 0]) }));
    expect(projected.tables.parts.rows[0]).toMatchObject({ pixel_count: 3, bbox_x: null, bbox_y: null, bbox_width: null, bbox_height: null });
  });
});

describe('queryPresets', () => {
  it('keeps every preset result row addressable', () => {
    expect(queryPresets).toHaveLength(3);
    for (const preset of queryPresets) expect(preset.sql).toMatch(/result_key/);
  });

  it('executes every preset in DuckDB and aggregates candidate parts correctly', async () => {
    const shared = component('shared', [0, 1, 4]);
    const unique = component('unique', [10, 11]);
    const projected = projectRun(run({
      candidates: [
        { id: 'candidate-a', parts: [shared, shared] },
        { id: 'candidate-b', parts: [shared] }
      ],
      rejected: [{ id: 'plate-x', reason: 'width outside range', part: unique }]
    }));
    const require = createRequire(import.meta.url);
    const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
    const db = await duckdb.createDuckDB({
      mvp: { mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm') },
      eh: { mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm') }
    }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
    await db.instantiate();
    const connection = db.connect();
    try {
      await loadTables(connection, projected.tables);
      const rows: Record<string, unknown>[][] = queryPresets.map((preset) => connection.query(preset.sql).toArray().map((row: { toJSON(): Record<string, unknown> }) => row.toJSON()));
      expect(rows[0]).toHaveLength(2);
      expect(rows[0].map((row) => Number(row.part_count))).toEqual([1, 1]);
      expect(rows[1]).toHaveLength(1);
      expect(rows[1][0]).toMatchObject({ id: 'unique', reason: 'width outside range', pixel_count: 2 });
      expect(rows[2]).toHaveLength(2);
      expect(rows[2].map((row) => Number(row.candidate_count))).toEqual([2, 2]);
      expect(rows.flat().every((row) => projected.targets.has(String(row.result_key)))).toBe(true);
    } finally {
      connection.close();
      db.reset();
    }
  });
});
