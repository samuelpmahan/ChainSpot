<script lang="ts">
	import { base } from '$app/paths';
	import { onMount } from 'svelte';
	type Panel = { label: string; filename: string; widthPx: number; heightPx: number; address: string; imageId: string };
	let { data } = $props<{ data: { sourceSha: string; sourcePath: string; panels: Panel[]; crop: { cropMethod: string; upperRowsRemoved: number; lowerRowsRemoved: number; totalPxRemoved: number; pctPxRemoved: number }; receipt: string; contract: string } }>();
	let selected = $state(1);
	let zoomed = $state(false);
	let viewport: HTMLDivElement;
	let panel = $derived(data.panels[selected]);
	function select(index: number) { selected = index; viewport?.scrollTo(0, 0); }
	function fit() { zoomed = false; viewport?.scrollTo(0, 0); }
	function key(event: KeyboardEvent) {
		if (event.ctrlKey || event.metaKey || event.altKey || (event.target as HTMLElement)?.matches('input, textarea, select')) return;
		if (event.key.toLowerCase() === 'f') { fit(); event.preventDefault(); }
		if (event.key.toLowerCase() === 'z') { zoomed = !zoomed; event.preventDefault(); }
	}
	onMount(() => { document.documentElement.dataset.appReady = 'true'; });
</script>

<svelte:head><title>LABUI · S0 · Dash’s Track</title><meta name="description" content="Inspect the frozen S0 input and cropped PxC image." /></svelte:head>
<svelte:window onkeydown={key} />

<main class="labui">
	<header><span class="brand">LABUI_</span><a class="revision" href={`https://github.com/samuelpmahan/ChainSpot/commit/${data.sourceSha}`} title={data.sourceSha}>source {data.sourceSha.slice(0, 8)} ↗</a></header>
	<div class="context"><span>Dash’s Track <span class="muted">/ DashsTrack-full.jpg</span></span><span class="muted">S0 · build snapshot</span></div>
	<div class="layout">
		<nav class="pane" aria-label="S0 image views">
			<div class="heading">01 / STAGE</div><div class="stage">S0 <span class="muted">/ clean</span></div>
			<div class="outputs">{#each data.panels as item, index}<button aria-pressed={selected === index} onclick={() => select(index)}>{index === 0 ? 'Input' : 'Stored image'}<small>{item.label}</small></button>{/each}</div>
			<div class="flow"><div>ingest</div><div>↓ StripChrome</div><div>↓ store in PxC</div></div>
		</nav>
		<section class="pane image-pane" aria-label="Image viewer">
			<div class="heading">02 / IMAGE</div>
			<div class="viewbar"><span>{panel.label}</span><div class="tools"><button aria-pressed={!zoomed} onclick={fit}>Fit</button><button aria-pressed={zoomed} onclick={() => { zoomed = !zoomed; }}>Zoom 1:1</button></div></div>
			<!-- Scroll region is focusable so arrow keys can pan the 1:1 image. -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div class="viewport" class:zoomed bind:this={viewport} tabindex="0" role="region" aria-label="Image viewport; scroll to pan when zoomed">
				<img src={`${base}/labui-s0/${panel.filename}`} alt={`Dash’s Track · ${panel.label}`} width={panel.widthPx} height={panel.heightPx} />
			</div>
			<div class="caption">{panel.widthPx} × {panel.heightPx} px · {zoomed ? '1 image pixel per CSS pixel · scroll to pan' : 'fit to view'}</div>
		</section>
		<aside class="pane inspector"><div class="heading">03 / INSPECT</div><div class="inspect">
			<div class="block"><div class="label">S0 CONTRACT</div><div>Ingest the image.<br />StripChrome.<br />Store the result in PxC.</div></div>
			<div class="block"><div class="label">SELECTED</div><div class="value">{panel.label}</div><div class="address">{panel.address}</div></div>
			<div class="block"><div class="label">RUN</div><dl><dt>Crop method</dt><dd>{data.crop.cropMethod}</dd><dt>Rows removed</dt><dd>{data.crop.upperRowsRemoved} top · {data.crop.lowerRowsRemoved} bottom</dd><dt>Pixels removed</dt><dd>{data.crop.totalPxRemoved.toLocaleString('en-US')} · {data.crop.pctPxRemoved.toFixed(2)}%</dd></dl></div>
			<details><summary>Declared panels</summary><pre>{data.panels.map(p => `${p.label}\n  widthPx · heightPx · rgba`).join('\n\n')}</pre></details>
			<details><summary>Receipt</summary><pre>{data.receipt}</pre></details>
			<details><summary>Contract source</summary><pre>{data.contract}</pre></details>
			<a class="download" href={`${base}/labui-s0/snapshot.json`} download>Snapshot JSON ↓</a>
		</div></aside>
	</div>
	<footer><span>View controls · frozen S0 pixels</span><span>f fit · z zoom · Tab controls</span></footer>
</main>

<style>
	:global(body) { margin: 0; background: #171208; }
	.labui { --line: #5b4723; --gold: #efbe6b; --muted: #bbaa87; color: #eee1c3; background: #171208; font: 13px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; padding: 18px; min-height: 100dvh; box-sizing: border-box; }
	.labui * { box-sizing: border-box; }
	header,.context,footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
	header { border-bottom: 1px solid var(--line); padding-bottom: 10px; }
	.brand { color: var(--gold); letter-spacing: 2px; font-size: 23px; }
	a { color: var(--muted); text-underline-offset: 3px; }
	a:hover { color: var(--gold); }
	.context { padding: 12px 0; }
	.muted,.label,dt,.caption,footer { color: var(--muted); }
	.layout { display: grid; grid-template-columns: 180px minmax(0,1fr) 280px; gap: 10px; align-items: stretch; }
	.pane { border: 1px solid var(--line); background: #211a0e; min-width: 0; }
	.heading { padding: 9px 11px; color: var(--gold); border-bottom: 1px solid var(--line); letter-spacing: .6px; }
	.stage { padding: 12px; color: var(--gold); border-bottom: 1px solid var(--line); }
	.outputs { padding: 10px; display: grid; gap: 8px; }
	button { font: inherit; cursor: pointer; color: var(--muted); background: transparent; border: 1px solid var(--line); padding: 5px 9px; border-radius: 2px; }
	button:hover { color: #eee1c3; background: #372a15; }
	button[aria-pressed='true'] { color: var(--gold); background: #3b2d16; border-color: var(--gold); }
	button:focus-visible,a:focus-visible,summary:focus-visible,.viewport:focus-visible { outline: 2px solid var(--gold); outline-offset: 3px; }
	.outputs button { text-align: left; width: 100%; }
	small { display: block; color: var(--muted); font-size: 11px; }
	.flow { padding: 12px; border-top: 1px solid var(--line); color: var(--muted); }
	.flow div { padding: 5px 0; }
	.image-pane { display: flex; flex-direction: column; }
	.viewbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
	.tools { display: flex; gap: 5px; }
	.viewport { height: calc(100dvh - 228px); min-height: 360px; overflow: auto; background: #100d07; display: flex; align-items: center; justify-content: center; padding: 12px; }
	.viewport img { display: block; width: 100%; height: 100%; object-fit: contain; }
	.viewport.zoomed { display: block; }
	.viewport.zoomed img { width: auto; height: auto; max-width: none; }
	.caption { padding: 8px 11px; border-top: 1px solid var(--line); font-size: 11px; }
	.inspect { padding: 12px; overflow-wrap: anywhere; }
	.block { margin-bottom: 19px; }
	.label { font-size: 11px; letter-spacing: .6px; margin-bottom: 4px; }
	.value { color: var(--gold); }
	.address { font-size: 12px; }
	dl { margin: 0; } dd { margin: 0 0 12px; }
	details { border-top: 1px solid var(--line); padding: 10px 0; }
	summary { cursor: pointer; color: var(--gold); }
	pre { white-space: pre-wrap; font: 11px/1.6 ui-monospace,monospace; margin-bottom: 0; overflow-wrap: anywhere; }
	.download { display: inline-block; margin-top: 10px; font-size: 12px; }
	footer { padding-top: 10px; font-size: 11px; }
	@media(max-width: 850px) { .layout { grid-template-columns: 150px minmax(0,1fr); } .inspector { grid-column: 1/-1; } .inspect { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; } .block { margin: 0; } .viewport { height: 60dvh; } }
	@media(max-width: 480px) { .labui { padding: 10px; } .layout { grid-template-columns: 1fr; } .outputs { grid-template-columns: 1fr 1fr; } .flow { display: none; } .inspect { display: block; } .block { margin-bottom: 16px; } }
	@media(pointer: coarse) { button { min-height: 44px; } }
</style>
