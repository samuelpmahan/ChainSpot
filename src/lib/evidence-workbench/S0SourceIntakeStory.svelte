<script lang="ts">
	import type { S0IntakePcrRun } from '$lib/s0IntakePcr';
	import { S0_DEFAULT_PLAN, runS0IntakePcr } from '$lib/s0IntakePcr';
	import TickInspection from './TickInspection.svelte';

	let {
		maxSidePx = 256,
		selectedTick = 'scout-thumbnails.produce',
		zoom = 2,
		showReceipt = true
	}: {
		maxSidePx?: number;
		selectedTick?: string;
		zoom?: number;
		showReceipt?: boolean;
	} = $props();

	let selectedFiles = $state<readonly File[]>([]);
	let run = $state<S0IntakePcrRun | null>(null);
	let running = $state(false);
	let failure = $state<string | null>(null);
	let gatewayCrossings = $state(0);
	let sourceDimensions = $state<Record<number, string>>({});
	let request = 0;

	$effect(() => {
		const files = selectedFiles;
		const runArg = maxSidePx;
		if (files.length === 0) return;
		const id = ++request;
		running = true;
		failure = null;
		gatewayCrossings += 1;
		void runS0IntakePcr({
			selectedFiles: files,
			runId: `storybook-s0-${gatewayCrossings}`,
			invocation: 'S0SourceIntakeStory Run Args',
			maxSidePx: runArg
		})
			.then(
				(next) => {
					if (id === request) run = next;
				},
				(error) => {
					if (id === request) failure = error instanceof Error ? error.message : String(error);
				}
			)
			.finally(() => {
				if (id === request) running = false;
			});
	});

	let traces = $derived(
		run?.pxc.has('px.source.thumbnails')
			? run.pxc.get<
					readonly {
						imageId: string;
						verdict: string;
						reason?: string;
						thumbnail?: { widthPx: number; heightPx: number };
						thumbnailBitmap?: ImageBitmap;
					}[]
				>('px.source.thumbnails')
			: []
	);

	function chooseFiles(event: Event) {
		selectedFiles = Array.from((event.currentTarget as HTMLInputElement).files ?? []);
		sourceDimensions = {};
		run = null;
	}

	function previewSource(node: HTMLImageElement, file: File) {
		let url = URL.createObjectURL(file);
		node.src = url;
		return {
			update(next: File) {
				URL.revokeObjectURL(url);
				url = URL.createObjectURL(next);
				node.src = url;
			},
			destroy() {
				URL.revokeObjectURL(url);
			}
		};
	}

	function recordSourceDimensions(index: number, event: Event) {
		const image = event.currentTarget as HTMLImageElement;
		sourceDimensions[index] = `${image.naturalWidth}×${image.naturalHeight}px`;
	}

	function drawThumbnail(canvas: HTMLCanvasElement, bitmap: ImageBitmap | undefined) {
		function paint(next: ImageBitmap | undefined) {
			if (!next) return;
			canvas.width = next.width;
			canvas.height = next.height;
			canvas.getContext('2d')?.drawImage(next, 0, 0);
		}
		paint(bitmap);
		return { update: paint };
	}
</script>

<main>
	<header class="workbench-head">
		<div>
			<span>S0 · SourceIntakeStage</span>
			<h1>Source → ScoutThumbnail PCR</h1>
			<p>{S0_DEFAULT_PLAN.assumption}</p>
		</div>
		<label class="source-picker"
			>Real source files <input
				type="file"
				accept="image/*"
				multiple
				onchange={chooseFiles}
			/></label
		>
	</header>

	{#if selectedFiles.length > 0}
		<section class="first-proof">
			<p class="sequence">Rendering 1 · Selected Source</p>
			<h2><code>px.source.selectedFiles</code></h2>
			<p>This is the exact browser input entering S0. No crop, resize, or decode result yet.</p>
			<div class="source-strip">
				{#each selectedFiles as file, index (`${index}:${file.name}:${file.size}`)}
					<figure>
						<img
							use:previewSource={file}
							alt={`Selected source ${index + 1}: ${file.name}`}
							onload={(event) => recordSourceDimensions(index, event)}
						/>
						<figcaption>
							<strong>source[{index}]</strong> · {file.name} · {sourceDimensions[index] ?? 'reading dimensions…'} · {file.size.toLocaleString()} bytes
						</figcaption>
					</figure>
				{/each}
			</div>
		</section>
	{/if}

	<section class="lanes">
		<div>
			<strong>Run Args</strong><code>maxSidePx={maxSidePx}</code><small
				>crossings: {gatewayCrossings}</small
			>
		</div>
		<div>
			<strong>View Args</strong><code
				>tick={selectedTick} · zoom={zoom} · receipt={showReceipt}</code
			><small>do not cross gateway</small>
		</div>
	</section>

	{#if running}<p class="pending">Running the production ABFeatureSet gateway…</p>{/if}
	{#if failure}<p class="red">{failure}</p>{/if}
	{#if run}
		<section class="stage" data-color={run.stage.color}>
			<h2><span class="lamp {run.stage.color}"></span>{run.stage.name}</h2>
			{#each run.stage.gates as gate (gate.id)}
				<details open>
					<summary><span class="lamp {gate.color}"></span>{gate.name}</summary>
					<p><strong>Strong assumption:</strong> {gate.assumption}</p>
					<p>{gate.verdict}</p>
					<p><strong>Reads only:</strong> <code>{gate.reads.join(', ')}</code></p>
					<p><strong>Waiting challengers:</strong> {gate.challengers.join('px, ')}px</p>
				</details>
			{/each}
		</section>

		<TickInspection
			pcr={run.pcr}
			tickId={selectedTick}
			residue={[
				{
					label: 'S0PixelResidue',
					count: null,
					note: 'UNKNOWN — scouting changes scale; canonical course pixels are the deliberately open S0 finish line.'
				}
			]}
		/>

		<section>
			<h2>ScoutThumbnail Materialization</h2>
			<div class="contact-sheet">
				{#each traces as trace (trace.imageId)}
					<figure>
						{#if trace.thumbnailBitmap}<canvas
								use:drawThumbnail={trace.thumbnailBitmap}
								style:width={`${(trace.thumbnail?.widthPx ?? 1) * zoom}px`}
							></canvas>{/if}
						<figcaption>
							<code>{trace.imageId}</code> · {trace.verdict}{trace.reason
								? ` · ${trace.reason}`
								: ''}
						</figcaption>
					</figure>
				{/each}
			</div>
		</section>
	{:else if selectedFiles.length === 0}
		<section class="empty">
			<h2><span class="lamp yellow"></span>Default plan loaded</h2>
			<p>
				Select real course imagery. The first run executes capture → scout; changing only Tick,
				zoom, or receipt display remains projection-only.
			</p>
		</section>
	{/if}
</main>

<style>
	main {
		display: grid;
		gap: 1rem;
		padding: 1rem;
		color: #171717;
		background: #fff;
		font:
			14px/1.45 ui-sans-serif,
			system-ui,
			sans-serif;
	}
	.workbench-head {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		align-items: end;
		border-bottom: 4px solid #6d28d9;
		padding-bottom: 1rem;
	}
	.workbench-head span,
	h2,
	strong {
		color: #5b21b6;
	}
	h1 {
		margin: 0.2rem 0;
		font-size: 1.4rem;
	}
	p {
		margin: 0.35rem 0;
	}
	.source-picker {
		display: grid;
		gap: 0.35rem;
		font-weight: 700;
	}
	.lanes {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}
	.lanes div,
	section,
	details {
		border: 1px solid #d4d4d4;
		padding: 0.75rem;
		background: #fafafa;
	}
	.lanes div {
		display: grid;
		gap: 0.2rem;
	}
	.lanes small {
		color: #737373;
	}
	.stage {
		border-left: 6px solid currentColor;
	}
	.stage[data-color='green'] {
		color: #15803d;
	}
	.stage[data-color='yellow'] {
		color: #a16207;
	}
	.stage[data-color='red'],
	.red {
		color: #b91c1c;
	}
	details {
		margin-top: 0.5rem;
		color: #171717;
	}
	summary {
		cursor: pointer;
		font-weight: 800;
	}
	.lamp {
		display: inline-block;
		width: 0.72rem;
		height: 0.72rem;
		margin-right: 0.45rem;
		border-radius: 50%;
		vertical-align: 0.02rem;
	}
	.lamp.green {
		background: #22c55e;
	}
	.lamp.yellow {
		background: #eab308;
	}
	.lamp.red {
		background: #ef4444;
	}
	.contact-sheet {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		overflow: auto;
	}
	figure {
		margin: 0;
	}
	canvas {
		display: block;
		max-width: none;
		image-rendering: pixelated;
		border: 1px solid #737373;
	}
	figcaption {
		margin-top: 0.3rem;
	}
	.pending {
		color: #6d28d9;
		font-weight: 700;
	}
	.first-proof {
		border: 3px solid #171717;
		background: #fff;
	}
	.sequence {
		margin: 0 0 0.35rem;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	.source-strip {
		display: grid;
		gap: 0.75rem;
		margin-top: 0.75rem;
	}
	.source-strip img {
		display: block;
		width: 100%;
		height: auto;
		border: 1px solid #737373;
	}
	@media (max-width: 760px) {
		.workbench-head {
			align-items: stretch;
			flex-direction: column;
		}
		.lanes {
			grid-template-columns: 1fr;
		}
	}
</style>
