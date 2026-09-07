<script lang="ts">
  import { untrack } from 'svelte';
  import type { PxC } from '../../../packages/alg/src/exec/board';
  import type { PqlRun } from '../../../packages/alg/src/exec/pql';
  import { renderPartsSvg, partsViewBox } from '../../../packages/alg/src/exec/render';
  import { containsPart, inspectableParts, metadata, outputGroups } from './parts';

  let { pxc, run, width, height, source }: {
    pxc: PxC; run: PqlRun; width: number; height: number; source: string;
  } = $props();

  interface ViewState {
    calculation: number;
    item: string;
    selectedPart: string | null;
    hidden: readonly string[];
    showSource: boolean;
    wholeRaster: boolean;
  }
  const viewAddress = 'px.view.partsInspector';
  let revision = $state(0);
  let filter = $state('');
  let pixelMessage = $state('');
  const operations = $derived(run.Ticks.flatMap((tick, tickIndex) =>
    tick.Calculations.map((calculation, calculationIndex) => ({
      tick: tick.name, tickIndex, calculationIndex, calculation
    }))));

  function defaults(): ViewState {
    return { calculation: Math.max(0, operations.length - 1), item: '', selectedPart: null,
      hidden: [], showSource: false, wholeRaster: false };
  }

  // Board has no subscriptions yet; revision announces this view's own immutable writes.
  const view = $derived.by(() => {
    void revision;
    return pxc.has(viewAddress) ? pxc.get<ViewState>(viewAddress) : defaults();
  });

  function update(patch: Partial<ViewState>) {
    const next = { ...view, ...patch };
    pxc.set(viewAddress, Object.freeze({ ...next, hidden: Object.freeze([...next.hidden]) }));
    revision += 1;
  }

  $effect(() => {
    const currentRun = run;
    const currentPxc = pxc;
    untrack(() => {
      void currentRun;
      const next = defaults();
      currentPxc.set(viewAddress, Object.freeze({ ...next, hidden: Object.freeze([]) }));
      revision += 1;
      filter = '';
      pixelMessage = '';
    });
  });

  const operation = $derived(operations[view.calculation]);
  const groups = $derived(operation ? outputGroups(operation.calculation.output) : []);
  const items = $derived(groups.flatMap(group => group.items));
  const item = $derived(items.find(value => value.key === view.item) ?? items[0]);
  const parts = $derived(item ? inspectableParts(item.value) : []);
  const selectedPart = $derived(parts.find(part => part.key === view.selectedPart));
  const allLayers = $derived(parts.map(part => part.layer));
  const visibleParts = $derived(parts.filter(part => !view.hidden.includes(part.key)));
  const frame = $derived(view.wholeRaster ? [0, 0, width, height] as [number, number, number, number]
    : partsViewBox(allLayers, width, height));
  const svg = $derived(renderPartsSvg(visibleParts.map(part => part.layer), width, height,
    view.showSource ? source : '', frame));
  const shownGroups = $derived(groups.map(group => ({ ...group, items: group.items.filter(value =>
    `${value.label} ${value.reason}`.toLowerCase().includes(filter.toLowerCase())) })));

  function selectCalculation(index: number) {
    update({ calculation: index, item: '', selectedPart: null, hidden: [] });
    filter = '';
    pixelMessage = '';
  }

  function selectItem(key: string) {
    // Sam's preference: each result selection starts with every Part visible.
    update({ item: key, selectedPart: null, hidden: [] });
    pixelMessage = '';
  }

  function togglePart(key: string) {
    update({ hidden: view.hidden.includes(key) ? view.hidden.filter(id => id !== key) : [...view.hidden, key] });
  }

  function isolate(key: string) {
    update({ selectedPart: key, hidden: parts.filter(part => part.key !== key).map(part => part.key) });
  }

  function pickPixel(event: MouseEvent) {
    // Keyboard navigation is provided by the matching Part buttons in the inspector.
    if (event.detail === 0) return;
    const canvas = event.currentTarget as HTMLButtonElement;
    const element = canvas.querySelector('svg');
    const matrix = element?.getScreenCTM();
    if (!element || !matrix) return;
    const point = element.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const local = point.matrixTransform(matrix.inverse());
    const x = Math.floor(local.x), y = Math.floor(local.y);
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    const hits = visibleParts.filter(part => part.layer.pixels.includes(index));
    if (hits.length) {
      const current = hits.findIndex(part => part.key === view.selectedPart);
      const chosen = hits[(current + 1) % hits.length];
      update({ selectedPart: chosen.key });
      pixelMessage = `(${x}, ${y}) · ${chosen.id}${hits.length > 1 ? ` · ${hits.length} overlapping Parts; click to cycle` : ''}`;
    } else pixelMessage = `(${x}, ${y}) · no visible Part owns this pixel`;
  }

  const producer = $derived.by(() => {
    const part = selectedPart;
    if (!part) return undefined;
    // Children may be nested in an output set without being published at individual addresses.
    return operations.find(candidate => containsPart(candidate.calculation.output, part.key));
  });

  function shortCall(call: string) { return call.split('.').slice(-1)[0]; }
</script>

<div class="parts-workbench">
  <aside class="pane execution" aria-label="Execution and results">
    <h2>Execution <span>{run.Ticks.length} Ticks</span></h2>
    <nav aria-label="Calculation outputs">
      {#each run.Ticks as tick, tickIndex}
        <div class="tick-title">{tick.name} <span>{tick.Calculations.length}</span></div>
        {#each operations.filter(candidate => candidate.tickIndex === tickIndex) as candidate}
          {@const index = operations.indexOf(candidate)}
          <button class:active={view.calculation === index} class="operation"
            onclick={() => selectCalculation(index)} title={candidate.calculation.actualCall}>
            <span>{candidate.calculationIndex + 1}. {shortCall(candidate.calculation.actualCall)}</span>
          </button>
        {/each}
      {/each}
    </nav>
    {#if !operations.length}<p class="empty">This run contains no Calculation records.</p>{/if}
    <h2>Results <span>{items.length}</span></h2>
    <label class="search">Filter IDs or reasons
      <input type="search" bind:value={filter} placeholder="Component, candidate, reason…" />
    </label>
    <div class="results">
      {#each shownGroups as group}
        <div class="group-title">{group.name} <span>{groups.find(original => original.name === group.name)?.items.length ?? 0}</span></div>
        {#each group.items as result}
          <button class="result" class:active={item?.key === result.key} onclick={() => selectItem(result.key)}>
            <span>{result.label}</span>
            {#if result.reason}<small>{result.reason}</small>{/if}
          </button>
        {:else}
          <p class="empty">{filter ? 'No matches.' : `No ${group.name} returned.`}</p>
        {/each}
      {/each}
    </div>
  </aside>

  <section class="pane pixels" aria-label="Exact component pixels">
    <header>
      <div><h2>{operation?.tick ?? 'Parts'}</h2><p>{item?.label ?? 'No result selected'}</p></div>
      <span class="pixel-count">{visibleParts.length}/{parts.length} Parts</span>
    </header>
    <div class="toolbar">
      <label><input type="checkbox" checked={view.showSource} disabled={!source}
        onchange={() => update({ showSource: !view.showSource })} /> Source pixels</label>
      <button onclick={() => update({ wholeRaster: !view.wholeRaster })}>{view.wholeRaster ? 'Fit selected result' : 'Whole raster'}</button>
      <button onclick={() => update({ hidden: [] })} disabled={!view.hidden.length}>Show all Parts</button>
    </div>
    <button class="canvas" onclick={pickPixel} aria-label="Select a Part by clicking its pixels. Part selection is also available in the Parts panel.">
      {@html svg}
    </button>
    <p class="canvas-hint">{pixelMessage || 'Click pixels to select their Part. Visibility changes keep this framing.'}</p>
    {#if item && !parts.length}<p class="empty">This result contains no renderable component or mask Parts.</p>{/if}
    {#if item?.reason}<p class="reason">{item.reason}</p>{/if}
  </section>

  <aside class="pane inspection" aria-label="Parts and Calculation details">
    <h2>Accumulated Parts <span>{parts.length}</span></h2>
    <div class="part-list">
      {#each parts as part}
        <details class:selected={selectedPart?.key === part.key} open={selectedPart?.key === part.key}>
          <summary><span class="swatch" style:background={part.layer.color}></span>{part.id}<small>{part.layer.pixels.length} px</small>
            <span class="role-path">{part.paths.join(' · ') || 'output'}</span>
          </summary>
          <div class="part-controls">
            <label><input type="checkbox" checked={!view.hidden.includes(part.key)} onchange={() => togglePart(part.key)} /> Visible</label>
            <button onclick={() => update({ selectedPart: part.key })}>Select</button>
            <button onclick={() => isolate(part.key)}>Isolate</button>
          </div>
          <div class="paths">{#each part.paths as path}<code>{path || 'output'}</code>{/each}</div>
          <pre>{metadata(part.value)}</pre>
        </details>
      {:else}<p class="empty">Select a result containing pixel Parts.</p>{/each}
    </div>
    {#if selectedPart && producer}
      <div class="producer">
        <strong>First recorded in this run</strong>
        <button onclick={() => selectCalculation(operations.indexOf(producer))}>{producer.tick} / {shortCall(producer.calculation.actualCall)}</button>
      </div>
    {/if}
    {#if operation}
      <details open class="call-details">
        <summary>Calculation and arguments</summary>
        <dl><dt>Callable</dt><dd>{operation.calculation.actualCall}</dd>
          {#if operation.calculation.call !== operation.calculation.actualCall}<dt>Overrides</dt><dd>{operation.calculation.call}</dd>{/if}
          <dt>Inputs</dt><dd><pre>{metadata(operation.calculation.with)}</pre></dd>
          <dt>Arguments</dt><dd><pre>{metadata(operation.calculation.args)}</pre></dd>
          <dt>Output</dt><dd>{operation.calculation.into}</dd>
        </dl>
      </details>
    {/if}
  </aside>
</div>

<style>
  .parts-workbench { --line: #45463f; --muted: #aaa99b; --ink: #f1efde; display: grid; grid-template-columns: minmax(210px, .8fr) minmax(320px, 2fr) minmax(270px, 1fr); gap: 10px; color: var(--ink); font: 13px/1.4 system-ui, sans-serif; min-height: 72vh; }
  .pane { background: #1b1d1c; border: 1px solid var(--line); border-radius: 6px; min-width: 0; padding: 12px; }
  .execution, .inspection { max-height: 84vh; overflow-y: auto; }
  h2 { margin: 0 0 8px; font-size: 14px; display: flex; justify-content: space-between; gap: 8px; }
  h2 span, .tick-title span, .group-title span, small, .pixel-count { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  button { color: inherit; background: #272b28; border: 1px solid var(--line); padding: 5px 8px; border-radius: 4px; font: inherit; text-align: left; cursor: pointer; }
  button:hover { background: #373b34; }
  button:focus-visible, summary:focus-visible, input:focus-visible { outline: 2px solid #e5c16c; outline-offset: 2px; }
  button:disabled { opacity: .5; cursor: default; }
  button.active { border-color: #e5c16c; background: #3b382c; }
  .tick-title, .group-title { display: flex; justify-content: space-between; margin: 10px 0 4px; font-weight: 650; }
  .operation, .result { display: block; width: 100%; margin: 3px 0; overflow-wrap: anywhere; }
  nav { margin-bottom: 18px; }
  .result small { display: block; margin-top: 3px; color: #e2af9e; }
  .search { display: block; font-size: 11px; color: var(--muted); }
  .search input { box-sizing: border-box; display: block; width: 100%; margin: 4px 0 8px; padding: 7px; border: 1px solid var(--line); color: var(--ink); background: #111513; border-radius: 3px; }
  .pixels { display: flex; flex-direction: column; }
  header { display: flex; justify-content: space-between; gap: 8px; }
  header h2 { margin-bottom: 2px; }
  header p { margin: 0 0 8px; overflow-wrap: anywhere; color: var(--muted); font-size: 11px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; font-size: 12px; }
  label { display: inline-flex; align-items: center; gap: 4px; }
  input[type=checkbox] { accent-color: #e5c16c; }
  .canvas { padding: 0; display: block; height: 65vh; min-height: 320px; width: 100%; overflow: hidden; background: #444; cursor: crosshair; }
  .canvas-hint { font-size: 11px; color: var(--muted); margin: 8px 0 0; }
  .empty { color: var(--muted); font-size: 12px; margin: 8px 0; }
  .reason { color: #e2af9e; margin: 8px 0; }
  details { border-bottom: 1px solid var(--line); padding: 8px 0; }
  details.selected { border-left: 2px solid #e5c16c; padding-left: 6px; }
  summary { cursor: pointer; overflow-wrap: anywhere; font-size: 12px; }
  summary small { margin-left: 5px; white-space: nowrap; }
  .role-path { display: block; color: #c1ceb7; font: 10px/1.5 ui-monospace, monospace; margin-top: 3px; }
  .swatch { display: inline-block; width: 9px; height: 9px; border: 1px solid #777; margin-right: 6px; }
  .part-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0; font-size: 11px; }
  .paths { display: grid; gap: 3px; color: #c1ceb7; font-size: 11px; }
  code { overflow-wrap: anywhere; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.5 ui-monospace, monospace; margin: 6px 0; }
  .call-details { margin-top: 12px; }
  dl { margin: 8px 0 0; }
  dt { font-size: 11px; color: var(--muted); margin-top: 8px; }
  dd { margin: 2px 0 0; overflow-wrap: anywhere; font: 11px/1.5 ui-monospace, monospace; }
  .producer { margin-top: 10px; font-size: 11px; }
  .producer button { display: block; margin-top: 5px; width: 100%; }
  @media (max-width: 960px) { .parts-workbench { grid-template-columns: minmax(180px, .7fr) minmax(280px, 1.3fr); } .inspection { grid-column: 1 / -1; max-height: none; } }
  @media (max-width: 620px) { .parts-workbench { grid-template-columns: 1fr; } .execution { max-height: 42vh; } .inspection { grid-column: auto; } .canvas { height: 55vh; } }
</style>
