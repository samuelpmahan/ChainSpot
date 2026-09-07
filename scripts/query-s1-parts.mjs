import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createExecBoard } from '../packages/alg/dist/exec/board.js';
import { createStage } from '../packages/alg/dist/stages/S1/exp/badge-assembly/stage.js';
import { projectRun, queryPresets } from '../src/lib/parts-query/projection.ts';
import { loadTables } from '../src/lib/parts-query/tables.ts';
import { pixelLayers, partsViewBox, renderPartsSvg } from '../packages/alg/dist/exec/render.js';

const require = createRequire(import.meta.url);
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const out = resolve(process.argv[2] ?? 'experiments/duckdb-inspection');
mkdirSync(out, { recursive: true });
const snapshot = JSON.parse(readFileSync('build/labui-s0/snapshot.json', 'utf8'));
const raster = snapshot.panels.find(p => p.address === 'px.course.canonicalPixels');
const bytes = readFileSync('build/labui-s0/CroppedImage.rgba');
const yaml = readFileSync('packages/alg/src/stages/S1/exp/badge-assembly/PrincipleComponentRender.yaml', 'utf8');
const pxc = createExecBoard();
pxc.set(raster.address, { imageId: raster.imageId, widthPx: raster.widthPx, heightPx: raster.heightPx, rgba: new Uint8ClampedArray(bytes) });
const start = performance.now();
const output = createStage(yaml).run({ pxc }).find(r => r.kind === 'default');
assert.equal(output.status, 'completed');
const executionMs = performance.now() - start;
const projectStart = performance.now();
const projection = projectRun(output.run);
const projectionMs = performance.now() - projectStart;
const dbStart = performance.now();
const db = await duckdb.createDuckDB({ mvp: { mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm') }, eh: { mainModule: require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm') } }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
await db.instantiate();
const connection = db.connect();
const queries = [];
try {
  await loadTables(connection, projection.tables);
  const databaseMs = performance.now() - dbStart;
  for (const preset of queryPresets) {
    const queryStart = performance.now();
    const rows = connection.query(preset.sql).toArray().map(row => JSON.parse(JSON.stringify(row.toJSON(), (_, value) => typeof value === 'bigint' ? Number(value) : value)));
    for (const row of rows) assert.ok(projection.targets.has(row.result_key), `Unresolvable result ${row.result_key}`);
    queries.push({ ...preset, elapsedMs: performance.now() - queryStart, rows });
  }
  // Reconcile SQL with the actual output, independently of the SQL projection's counts.
  const calculations = output.run.Ticks.flatMap(tick => tick.Calculations);
  const assembly = calculations.at(-1).output;
  assert.equal(queries[0].rows.length, assembly.candidates.length);
  const selection = calculations.find(c => c.actualCall.endsWith('.selectComponents')).output;
  assert.equal(queries[1].rows.length, selection.rejected.length);
  for (const row of queries[1].rows) {
    const rejected = selection.rejected.find(item => item.component.part.id === row.id);
    assert.ok(rejected);
    assert.equal(row.reason, rejected.reasons.join('; '));
    assert.equal(row.bbox_width, rejected.component.bbox[2]);
    assert.equal(row.bbox_height, rejected.component.bbox[3]);
  }
  for (const row of queries[0].rows) {
    assert.equal(row.part_count, pixelLayers(assembly.candidates.find(candidate => candidate.id === row.id)).length);
  }
  const masks = calculations.filter(c => c.output.kind === 'mask');
  for (const calculation of masks) {
    const mask = calculation.output;
    const expected = mask.pixels.reduce((count, value) => count + (value ? 1 : 0), 0);
    assert.equal(projection.tables.parts.rows.find(p => p.part_key === mask.address).pixel_count, expected);
  }
  const candidate = assembly.candidates.find(c => c.digitLoops.some(row => row.matches.length)) ?? assembly.candidates[0];
  const match = queries[0].rows.find(row => row.id === candidate.id);
  assert.ok(match, 'Visible candidate must resolve through a SQL result');
  const layers = pixelLayers(candidate);
  writeFileSync(join(out, 'candidate.svg'), renderPartsSvg(layers, raster.widthPx, raster.heightPx, '', partsViewBox(layers, raster.widthPx, raster.heightPx)));
  const receipt = {
    sourceCommit: snapshot.sourceSha, sourceImage: snapshot.sourcePath,
    sourceRgbaSha256: createHash('sha256').update(bytes).digest('hex'),
    compositionSha256: createHash('sha256').update(yaml).digest('hex'),
    engine: db.getVersion(), engineRuntime: 'DuckDB-Wasm / Node blocking (feature-selected bundle)',
    executionMs, projectionMs, databaseMs, ticks: output.run.Ticks.length, calculations: calculations.length,
    tables: Object.fromEntries(Object.entries(projection.tables).map(([name, table]) => [name, table.rows.length])),
    candidates: assembly.candidates.length, incomplete: assembly.incomplete.length,
    selectedPlates: selection.selected.length, rejectedPlates: selection.rejected.length,
    queries, selectedCandidate: candidate.id, selectedTarget: projection.targets.get(match.result_key),
    selectedParts: layers.map(layer => ({ role: layer.name, pixelCount: layer.pixels.length })),
    checks: ['SQL candidate count equals assembly output', 'SQL rejected count equals selection output', 'All rejected reasons and dimensions match recorded Calculation output', 'Each candidate Part count matches the existing renderer traversal', 'Every SQL result resolves to an inspector target', 'Dense mask counts equal nonzero pixels'],
    browserVerified: false
  };
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  writeFileSync(join(out, 'tables.json'), JSON.stringify(projection.tables) + '\n');
  console.log(JSON.stringify({ ...receipt, queries: queries.map(q => ({ id: q.id, rows: q.rows.length, elapsedMs: q.elapsedMs })) }, null, 2));
} finally { connection.close(); db.reset(); }
