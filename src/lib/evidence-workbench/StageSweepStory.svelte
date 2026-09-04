<script lang="ts">
	let {
		stage,
		runName,
		showReceipt = true
	}: { stage: string; runName: string; showReceipt?: boolean } = $props();

	let receipt = $state('');
	let receiptFailure = $state<string | null>(null);
	let imageReady = $state(false);
	let imageFailure = $state<string | null>(null);
	let request = 0;

	let artifactUrl = $derived(`/sweep/stages/${runName}-through-${stage}/progression.png`);
	let receiptUrl = $derived(`/sweep/stages/${runName}-through-${stage}/run.receipt.txt`);
	let materializationState = $derived(
		imageFailure || receiptFailure ? 'huh' : imageReady && receipt ? 'ready' : 'loading'
	);
	let materializationFailure = $derived(imageFailure ?? receiptFailure);

	$effect(() => {
		const url = receiptUrl;
		const id = ++request;
		receipt = '';
		receiptFailure = null;
		imageReady = false;
		imageFailure = null;
		void fetch(url)
			.then(async (response) => {
				if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
				return response.text();
			})
			.then(
				(text) => {
					if (id === request) receipt = text;
				},
				(error) => {
					if (id === request) receiptFailure = error instanceof Error ? error.message : String(error);
				}
			);
	});
</script>

<main data-materialization-state={materializationState}>
	<header>
		<div>
			<span>{stage} · materialized Stage percept</span>
			<h1>{runName}</h1>
			<p>LAB Sweep materializes the Stage; this Story only projects that materialization.</p>
		</div>
		<code>View Arg · showReceipt={String(showReceipt)}</code>
	</header>

	<section class="percept">
		<img
			src={artifactUrl}
			alt={`${stage} materialized progression for ${runName}`}
			onload={() => {
				imageReady = true;
				imageFailure = null;
			}}
			onerror={() => {
				imageReady = false;
				imageFailure = `image unavailable: ${artifactUrl}`;
			}}
		/>
	</section>

	{#if materializationFailure}
		<section class="receipt" data-materialization-huh>
			<p class="failure">HUH: Story could not GET its Sweep materialization: {materializationFailure}</p>
		</section>
	{:else if showReceipt}
		<section class="receipt">
			<h2>Receipt</h2>
			{#if receipt}
				<pre>{receipt}</pre>
			{:else}
				<p>GETting materialized receipt…</p>
			{/if}
		</section>
	{/if}
</main>

<style>
	main {
		display: grid;
		gap: 1rem;
		padding: 1rem;
		background: #fff;
		color: #171717;
		font:
			14px/1.45 ui-sans-serif,
			system-ui,
			sans-serif;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: end;
		gap: 1rem;
		border-bottom: 4px solid #6d28d9;
		padding-bottom: 0.8rem;
	}
	header span,
	h2 {
		color: #5b21b6;
		font-weight: 800;
	}
	h1 {
		margin: 0.15rem 0;
		font-size: 1.45rem;
	}
	p {
		margin: 0.25rem 0;
	}
	code {
		padding: 0.35rem 0.5rem;
		background: #f5f3ff;
		border: 1px solid #ddd6fe;
	}
	.percept,
	.receipt {
		border: 1px solid #d4d4d4;
		padding: 0.8rem;
		background: #fafafa;
	}
	img {
		display: block;
		width: 100%;
		height: auto;
		object-fit: contain;
	}
	pre {
		margin: 0;
		white-space: pre-wrap;
		font:
			12px/1.5 ui-monospace,
			SFMono-Regular,
			Menlo,
			Consolas,
			monospace;
	}
	.failure {
		color: #b91c1c;
		font-weight: 800;
	}
	@media (max-width: 760px) {
		header {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>
