<script lang="ts">
  import { onMount } from 'svelte';
  import type { PqlRun } from '../../../packages/alg/src/exec/pql';
  import { projectRun, queryPresets } from './projection';

  let { run, onselect }: { run: PqlRun; onselect: (target: { calculation: number; item: string; part?: string }) => void } = $props();
  let selected = $state(0);
  let rows = $state.raw<Record<string, unknown>[]>([]);
  let status = $state('Loading DuckDB…');
  let busy = $state(true);
  let error = $state('');
  let version = $state('');
  let startupMs = $state(0);
  let projection = $state.raw<ReturnType<typeof projectRun>>();
  let database = $state.raw<Awaited<ReturnType<typeof import('./database').openRunDatabase>>>();
  let active = true;
  const columns = $derived(rows.length ? Object.keys(rows[0]) : []);

  async function execute(index: number) {
    if (!database || busy) return;
    selected = index; busy = true; error = ''; rows = [];
    const start = performance.now();
    try {
      const result = await database.query(queryPresets[index].sql);
      if (active) {
        rows = result;
        status = `${result.length} rows · ${(performance.now() - start).toFixed(1)} ms · completed S1 snapshot`;
      }
    } catch (cause) { if (active) error = String(cause); }
    finally { if (active) busy = false; }
  }

  function inspect(row: Record<string, unknown>) {
    const target = projection?.targets.get(String(row.result_key));
    if (target) onselect({ ...target, ...(typeof row.part_key === 'string' ? { part: row.part_key } : {}) });
  }

  onMount(() => {
    active = true;
    const start = performance.now();
    void (async () => {
      try {
        projection = projectRun(run);
        const { openRunDatabase } = await import('./database');
        const opened = await openRunDatabase(projection);
        if (!active) { await opened.close(); return; }
        database = opened; version = opened.version;
        startupMs = performance.now() - start;
        status = `Snapshot loaded in ${startupMs.toFixed(0)} ms`;
        busy = false;
        await execute(0);
      } catch (cause) { if (active) { error = String(cause); busy = false; } }
    })();
    return () => { active = false; void database?.close(); };
  });
</script>

<section class="query-panel" aria-label="Query completed run" data-query-ready={!busy && !!database}>
  <header><strong>Query the run</strong><span>{version ? `DuckDB ${version} · startup ${(startupMs / 1000).toFixed(2)} s` : 'DuckDB-Wasm'}</span><span role="status">{busy ? 'Working…' : status}</span></header>
  <nav aria-label="Run queries">
    {#each queryPresets as preset, index}
      <button disabled={busy || !database} class:active={selected === index} onclick={() => execute(index)}>{preset.title}</button>
    {/each}
  </nav>
  <details><summary>SQL · {queryPresets[selected].title}</summary><pre>{queryPresets[selected].sql}</pre></details>
  {#if error}<p role="alert">{error} · Pixel inspection remains available below.</p>{/if}
  {#if rows.length}
    <div class="table-scroll"><table><thead><tr><th>Pixels</th>{#each columns as column}<th>{column}</th>{/each}</tr></thead>
      <tbody>{#each rows as row}<tr><td><button disabled={!projection?.targets.has(String(row.result_key))} onclick={() => inspect(row)}>Inspect</button></td>
        {#each columns as column}<td>{row[column] === null ? '—' : String(row[column])}</td>{/each}</tr>{/each}</tbody>
    </table></div>
  {:else if !busy && !error}<p>No matching rows in this completed run.</p>{/if}
</section>

<style>
  .query-panel { margin: 10px 0; padding: 12px; border: 1px solid #45463f; border-radius: 6px; background: #1b1d1c; color: #eee1c3; font: 12px/1.4 system-ui, sans-serif; }
  header, nav { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 8px; }
  header span { color: #bbaa87; } button { cursor: pointer; border: 1px solid #61543b; border-radius: 4px; padding: 5px 9px; background: #272b28; color: inherit; }
  button.active { border-color: #e5c16c; } button:disabled { opacity: .5; cursor: default; }
  button:focus-visible, summary:focus-visible { outline: 2px solid #e5c16c; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; } summary { cursor: pointer; }
  .table-scroll { overflow: auto; max-height: 230px; margin-top: 8px; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #363c36; white-space: nowrap; }
  th { position: sticky; top: 0; background: #202621; } [role='alert'] { color: #ffada0; }
</style>
