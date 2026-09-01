<script lang="ts">
	import type { M1WorkbenchLibrary } from './badgeSpecimen';
	import { projectM1Image, type M1Projection } from './m1Projection';

	let {
		library,
		subjectId,
		projection = 'components',
		zoom = 6,
		showReceipt = true
	}: {
		library: M1WorkbenchLibrary;
		subjectId: string;
		projection?: M1Projection;
		zoom?: number;
		showReceipt?: boolean;
	} = $props();

	let canvas: HTMLCanvasElement;
	let object = $derived(library.objects.find((value) => value.id === subjectId));
	let component = $derived(library.components.find((value) => value.id === subjectId));
	let image = $derived(projectM1Image(library, subjectId, projection));
	let relationships = $derived(
		object
			? object.relationshipIds.flatMap((id) => {
					const value = library.relationships.find((candidate) => candidate.id === id);
					return value ? [value] : [];
				})
			: []
	);

	$effect(() => {
		if (!canvas) return;
		canvas.width = image.width;
		canvas.height = image.height;
		const context = canvas.getContext('2d');
		if (!context) return;
		context.putImageData(
			new ImageData(Uint8ClampedArray.from(image.rgba), image.width, image.height),
			0,
			0
		);
	});
</script>

<article data-subject={subjectId} data-projection={projection}>
	<header>
		<div><strong>{subjectId}</strong><span>{projection}</span></div>
		<code>{image.width}×{image.height} px · ({image.x},{image.y})</code>
	</header>
	<div class="canvas-shell">
		<canvas
			bind:this={canvas}
			style:width={`${image.width * zoom}px`}
			style:height={`${image.height * zoom}px`}
			aria-label={`${subjectId} ${projection} M1 projection`}
		></canvas>
	</div>
	{#if showReceipt && object}
		{#if object.accounting.status === 'known'}
			<dl class="receipt">
				<div>
					<dt>Available M1</dt>
					<dd>{object.accounting.availablePixels.length}</dd>
				</div>
				<div>
					<dt>Explained M1</dt>
					<dd>{object.accounting.explainedPixels.length}</dd>
				</div>
				<div>
					<dt>Unexplained M1</dt>
					<dd>{object.accounting.unexplainedPixels.length}</dd>
				</div>
				<div>
					<dt>Coverage</dt>
					<dd>
						{object.accounting.availablePixels.length
							? `${((object.accounting.explainedPixels.length / object.accounting.availablePixels.length) * 100).toFixed(2)}%`
							: 'UNKNOWN'}
					</dd>
				</div>
			</dl>
		{:else}
			<p class="unknown">UNKNOWN — {object.accounting.reason}</p>
		{/if}
		<h3>Constituent components</h3>
		<ul>
			{#each object.componentUses as use}<li><code>{use.componentId}</code> — {use.role}</li>{/each}
		</ul>
		<h3>Preserved relationships</h3>
		<ul>
			{#each relationships as relation}
				<li>
					<code>{relation.containerComponentId}</code>
					{relation.predicate} <code>{relation.memberComponentId}</code> via {relation.selection}{relation.margins
						? ` [${relation.margins.join(',')}]`
						: ''}
				</li>
			{/each}
		</ul>
	{:else if showReceipt && component}
		<dl class="receipt">
			<div>
				<dt>Primitive pixels</dt>
				<dd>{component.pixels.length}</dd>
			</div>
			<div>
				<dt>Consumers</dt>
				<dd>{component.consumers.length}</dd>
			</div>
		</dl>
		<h3>Consumers</h3>
		<ul>
			{#each component.consumers as consumer}<li>
					<code>{consumer.objectId}</code> — {consumer.role}
				</li>{/each}
		</ul>
	{/if}
</article>

<style>
	article {
		display: grid;
		gap: 0.75rem;
		padding: 1rem;
		color: #171717;
		font:
			14px/1.35 ui-sans-serif,
			system-ui,
			sans-serif;
	}
	header {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 1rem;
	}
	header div {
		display: grid;
	}
	header span {
		color: #6d28d9;
		font-weight: 650;
		text-transform: uppercase;
		font-size: 0.72rem;
	}
	header code {
		color: #737373;
		font-size: 0.75rem;
	}
	.canvas-shell {
		width: fit-content;
		max-width: 100%;
		overflow: auto;
		border: 1px solid #a3a3a3;
		background: repeating-conic-gradient(#e5e5e5 0 25%, white 0 50%) 0/16px 16px;
	}
	canvas {
		display: block;
		image-rendering: pixelated;
	}
	.receipt {
		display: grid;
		grid-template-columns: repeat(4, minmax(7rem, 1fr));
		gap: 0.5rem;
		margin: 0;
		max-width: 44rem;
	}
	.receipt div {
		padding: 0.55rem 0.7rem;
		border: 1px solid #d4d4d4;
		background: #fafafa;
	}
	.receipt dt {
		color: #737373;
		font-size: 0.7rem;
		text-transform: uppercase;
	}
	.receipt dd {
		margin: 0.15rem 0 0;
		font-size: 1.15rem;
		font-weight: 700;
	}
	h3 {
		margin: 0.25rem 0 0;
		font-size: 0.85rem;
	}
	ul {
		margin: 0;
		padding-left: 1.25rem;
	}
	.unknown {
		border: 1px solid #f59e0b;
		padding: 0.7rem;
		background: #fffbeb;
	}
</style>
