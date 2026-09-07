import type { PqlRun } from '../../../packages/alg/src/exec/pql';

export type SQLType = 'VARCHAR' | 'INTEGER' | 'DOUBLE' | 'BOOLEAN';
export type SQLValue = string | number | boolean | null;
export interface ProjectionTable {
  columns: Record<string, SQLType>;
  rows: Record<string, SQLValue>[];
}
export interface ProjectionTarget {
  calculation: number;
  item: string;
  part?: string;
}
export interface RunProjection {
  tables: { results: ProjectionTable; parts: ProjectionTable; result_parts: ProjectionTable };
  targets: Map<string, ProjectionTarget>;
}

const RESULT_COLUMNS: Record<string, SQLType> = {
  result_key: 'VARCHAR', calculation_index: 'INTEGER', tick: 'VARCHAR', call: 'VARCHAR',
  output_address: 'VARCHAR', collection: 'VARCHAR', label: 'VARCHAR', id: 'VARCHAR',
  kind: 'VARCHAR', verdict: 'VARCHAR', status: 'VARCHAR', reason: 'VARCHAR'
};
const PART_COLUMNS: Record<string, SQLType> = {
  part_key: 'VARCHAR', id: 'VARCHAR', kind: 'VARCHAR', pixel_count: 'INTEGER',
  bbox_x: 'INTEGER', bbox_y: 'INTEGER', bbox_width: 'INTEGER', bbox_height: 'INTEGER',
  polarity: 'VARCHAR', label: 'INTEGER', bbox_source_result: 'VARCHAR'
};
const RELATION_COLUMNS: Record<string, SQLType> = { result_key: 'VARCHAR', part_key: 'VARCHAR', role_path: 'VARCHAR' };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function scalar(value: unknown): SQLValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value as SQLValue;
  return null;
}
function scalarField(value: Record<string, unknown>, ...keys: string[]): SQLValue {
  for (const key of keys) { const candidate = scalar(value[key]); if (candidate !== null) return candidate; }
  return null;
}
function partKey(value: Record<string, unknown>, path: string): string {
  return String(value.address ?? value.id ?? path);
}
function bboxAndCount(node: Record<string, unknown>): { count: number; bbox: [number, number, number, number] | null } {
  const pixels = node.pixels;
  if (!pixels || typeof pixels === 'string' || typeof pixels === 'function') return { count: 0, bbox: null };
  const iterable = ArrayBuffer.isView(pixels) || Array.isArray(pixels) ? pixels as ArrayLike<unknown> : null;
  if (!iterable) return { count: 0, bbox: null };
  let count = 0;
  const denseMask = node.kind === 'mask';
  for (let i = 0; i < iterable.length; i++) {
    const raw = iterable[i];
    const index = denseMask ? (raw ? i : -1) : (typeof raw === 'number' ? raw : (raw ? i : -1));
    if (index < 0) continue;
    count++;
  }
  return { count, bbox: null };
}

/** Project a completed PQL run into scalar DuckDB tables. Pixel buffers stay in PxC and are only measured. */
export function projectRun(run: PqlRun): RunProjection {
  const results: ProjectionTable = { columns: { ...RESULT_COLUMNS }, rows: [] };
  const parts: ProjectionTable = { columns: { ...PART_COLUMNS }, rows: [] };
  const resultParts: ProjectionTable = { columns: { ...RELATION_COLUMNS }, rows: [] };
  const targets = new Map<string, ProjectionTarget>();
  const partRows = new Map<string, Record<string, SQLValue>>();
  const relationSeen = new Set<string>();
  let calculationIndex = 0;

  function collectPart(node: Record<string, unknown>, path: string, resultKey: string, relationPath: string): string | undefined {
    const key = partKey(node, path);
    if (!partRows.has(key)) {
      const measured = bboxAndCount(node);
      const bbox = measured.bbox;
      partRows.set(key, {
        part_key: key, id: text(node.id) ?? key, kind: text(node.kind) ?? 'unknown', pixel_count: measured.count,
        bbox_x: bbox?.[0] ?? null, bbox_y: bbox?.[1] ?? null, bbox_width: bbox?.[2] ?? null, bbox_height: bbox?.[3] ?? null,
        polarity: text(node.polarity), label: typeof node.label === 'number' ? node.label : null, bbox_source_result: null
      });
    }
    const relation = `${resultKey}\u0000${key}\u0000${relationPath}`;
    if (!relationSeen.has(relation)) { relationSeen.add(relation); resultParts.rows.push({ result_key: resultKey, part_key: key, role_path: relationPath }); }
    return key;
  }
  function visitParts(node: unknown, path: string, resultKey: string, ancestors: Set<object>, rolePath = ''): string | undefined {
    if (!node || typeof node !== 'object' || ArrayBuffer.isView(node)) return undefined;
    const value = node as Record<string, unknown>;
    if (ancestors.has(value)) return undefined;
    if (value.kind === 'cropped-raster') return undefined;
    if (value.kind === 'component' || value.kind === 'mask') return collectPart(value, path, resultKey, rolePath || path);
    ancestors.add(value);
    let first: string | undefined;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'pixels') continue;
      const childPath = Array.isArray(node) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
      const found = visitParts(child, childPath, resultKey, ancestors, rolePath ? `${rolePath}.${key}` : childPath);
      if (key === 'part' && found && Array.isArray(value.bbox) && value.bbox.length === 4 && value.bbox.every((item) => typeof item === 'number')) {
        const row = partRows.get(found);
        if (row) {
          row.bbox_x = value.bbox[0] as number; row.bbox_y = value.bbox[1] as number;
          row.bbox_width = value.bbox[2] as number; row.bbox_height = value.bbox[3] as number;
          row.bbox_source_result = resultKey;
        }
      }
      if (!first && found) first = found;
    }
    ancestors.delete(value);
    return first;
  }
  function items(value: unknown): { collection: string; item: unknown; itemPath: string; itemKey: string }[] {
    if (Array.isArray(value)) return value.map((item, index) => ({ collection: 'items', item, itemPath: `[${index}]`, itemKey: `items:${index}` }));
    const node = object(value);
    if (node) {
      const groups = Object.entries(node).filter(([key, child]) => key !== 'pixels' && Array.isArray(child));
      if (groups.length) return groups.flatMap(([collection, child]) => (child as unknown[]).map((item, index) => ({ collection, item, itemPath: `${collection}[${index}]`, itemKey: `${collection}:${index}` })));
    }
    return [{ collection: 'output', item: value, itemPath: '', itemKey: 'output:0' }];
  }
  for (const tick of run.Ticks) {
    for (const calculation of tick.Calculations) {
      const currentCalculation = calculationIndex++;
      for (const entry of items(calculation.output)) {
        const resultKey = `r${currentCalculation}:${entry.itemPath || 'output'}`;
        const item = object(entry.item);
        const itemPart = visitParts(entry.item, '', resultKey, new Set<object>());
        const row: Record<string, SQLValue> = {
          result_key: resultKey, calculation_index: currentCalculation, tick: tick.name, call: calculation.actualCall,
          output_address: calculation.into, collection: entry.collection,
          label: item ? scalarField(item, 'label', 'name') : null, id: item ? scalarField(item, 'id') : null,
          kind: item ? scalarField(item, 'kind') : null, verdict: item ? scalarField(item, 'verdict') : null,
          status: item ? scalarField(item, 'status') : null,
          reason: item ? (Array.isArray(item.reasons) ? item.reasons.join('; ') : scalarField(item, 'reason', 'note')) : null
        };
        results.rows.push(row);
        targets.set(resultKey, { calculation: currentCalculation, item: entry.itemKey, ...(itemPart ? { part: itemPart } : {}) });
      }
    }
  }
  parts.rows = [...partRows.values()];
  return { tables: { results, parts, result_parts: resultParts }, targets };
}

export const queryPresets: readonly { id: string; title: string; sql: string }[] = [
  { id: 'candidates', title: 'Assembled candidates', sql: "SELECT r.result_key, r.id, COUNT(DISTINCT rp.part_key) AS part_count, MIN(rp.part_key) AS part_key FROM results r LEFT JOIN result_parts rp USING (result_key) WHERE r.collection = 'candidates' GROUP BY ALL ORDER BY r.result_key" },
  { id: 'rejected-plates', title: 'Rejected plates', sql: "SELECT r.result_key, MIN(rp.part_key) AS part_key, p.id, r.reason, p.pixel_count, p.bbox_width, p.bbox_height FROM results r LEFT JOIN result_parts rp USING (result_key) LEFT JOIN parts p ON p.part_key = rp.part_key WHERE r.collection = 'rejected' GROUP BY ALL ORDER BY r.result_key" },
  { id: 'shared-candidate-parts', title: 'Parts shared across assembled candidates', sql: "WITH distinct_parts AS (SELECT DISTINCT rp.result_key, rp.part_key FROM result_parts rp JOIN results r USING (result_key) WHERE r.collection = 'candidates') SELECT result_key, part_key, COUNT(*) OVER (PARTITION BY part_key) AS candidate_count FROM distinct_parts QUALIFY candidate_count > 1 ORDER BY part_key, result_key" }
];
