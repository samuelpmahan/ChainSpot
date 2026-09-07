<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import { createExecBoard, createStage, yaml, type PxC, type PqlRun } from '$lib/pql-inspection-runtime';
	import PartInspector from '$lib/parts-inspector/PartInspector.svelte';
	import QueryPanel from '$lib/parts-query/QueryPanel.svelte';
	let requestedSelection = $state<{ calculation: number; item: string; part?: string }>();

	let status = $state('Loading the cropped S0 raster…');
	let error = $state('');
	let result = $state.raw<{ pxc: PxC; run: PqlRun; width: number; height: number } | null>(null);
	let sourceSha = $state('');
	const source = `${base}/labui-s0/CroppedImage.png`;

	onMount(() => {
		let active = true;
		async function start() {
			try {
				const responses = await Promise.all([
					fetch(`${base}/labui-s0/snapshot.json`),
					fetch(`${base}/labui-s0/CroppedImage.rgba`)
				]);
				if (responses.some(response => !response.ok)) throw new Error('S0 snapshot unavailable. Use the staging build to prepare the source raster.');
				const [snapshot, bytes] = await Promise.all([responses[0].json(), responses[1].arrayBuffer()]);
				if (!active) return;
				const panel = snapshot.panels.find((item: { address: string }) => item.address === 'px.course.canonicalPixels');
				if (!panel || bytes.byteLength !== panel.widthPx * panel.heightPx * 4) throw new Error('S0 raster dimensions do not match its stored bytes.');
				sourceSha = snapshot.sourceSha;
				const pxc = createExecBoard();
				pxc.set('px.course.canonicalPixels', {
					imageId: panel.imageId, widthPx: panel.widthPx, heightPx: panel.heightPx,
					rgba: new Uint8ClampedArray(bytes)
				});
				status = 'Running the S1 YAML composition…';
				await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
				if (!active) return;
				const variants = createStage(yaml).run({ pxc });
				const output = variants.find(variant => variant.kind === 'default');
				if (!output?.run || output.status !== 'completed') throw new Error(output?.error ?? 'S1 produced no completed Default run.');
				result = { pxc: output.pxc, run: output.run, width: panel.widthPx, height: panel.heightPx };
				status = 'S1 · Default · partial Stage';
			} catch (cause) {
				if (active) { error = cause instanceof Error ? cause.message : String(cause); status = 'S1 could not complete'; }
			} finally {
				if (active) document.documentElement.dataset.appReady = 'true';
			}
		}
		void start();
		return () => { active = false; };
	});
</script>

<svelte:head><title>LABUI · S1 Part inspection</title></svelte:head>
<header>
	<a href={`${base}/`}>← S0</a><strong>LABUI / S1 Parts</strong>
	<span>{status}</span>
	{#if sourceSha}<a href={`https://github.com/samuelpmahan/ChainSpot/commit/${sourceSha}`}>source {sourceSha.slice(0, 8)}</a>{/if}
</header>
{#if error}<p role="alert">{error}</p>{/if}
{#if result}
	{#key result.run}<QueryPanel run={result.run} onselect={target => requestedSelection = target} />{/key}
	<PartInspector pxc={result.pxc} run={result.run} width={result.width} height={result.height} {source} {requestedSelection} />
{:else if !error}<p role="status">{status}</p>{/if}

<style>
	:global(body) { margin: 0; background: #171208; color: #eee1c3; font: 13px/1.5 ui-monospace, monospace; }
	header { display: flex; flex-wrap: wrap; gap: 18px; align-items: center; padding: 12px 18px; border-bottom: 1px solid #5b4723; }
	a { color: #efbe6b; } span { color: #bbaa87; } p { margin: 18px; }
	[role='alert'] { color: #ffada0; }
</style>
