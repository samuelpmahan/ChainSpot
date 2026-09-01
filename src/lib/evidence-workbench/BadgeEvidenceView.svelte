<script lang="ts">
	import type { BadgeSpecimen } from './badgeSpecimen';
	import { projectBadgeImage, type BadgeProjection } from './badgeProjection';

	let {
		specimen,
		projection = 'raw',
		zoom = 8,
		showGrid = false,
		showReceipt = true
	}: {
		specimen: BadgeSpecimen;
		projection?: BadgeProjection;
		zoom?: number;
		showGrid?: boolean;
		showReceipt?: boolean;
	} = $props();

	let canvas: HTMLCanvasElement;

	$effect(() => {
		if (!canvas) return;
		const image = projectBadgeImage(specimen, projection);
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

<article class="evidence-view" data-projection={projection} data-specimen={specimen.id}>
	<header>
		<div>
			<strong>{specimen.title}</strong>
			<span>{projection}</span>
		</div>
		<code
			>{specimen.crop.width}×{specimen.crop.height} px · ({specimen.crop.x},{specimen.crop.y})</code
		>
	</header>
	<div class:grid={showGrid} class="canvas-shell">
		<canvas
			bind:this={canvas}
			style:width={`${specimen.crop.width * zoom}px`}
			style:height={`${specimen.crop.height * zoom}px`}
			aria-label={`${specimen.title} ${projection} projection`}
		></canvas>
	</div>
	{#if showReceipt}
		<dl class="receipt">
			<div>
				<dt>B+W owned</dt>
				<dd data-testid="owned-count">{specimen.metrics.ownedBw}</dd>
			</div>
			<div>
				<dt>AA added</dt>
				<dd data-testid="aa-count">{specimen.metrics.aaAdded}</dd>
			</div>
			<div>
				<dt>Residue before</dt>
				<dd>{specimen.metrics.residueBefore}</dd>
			</div>
			<div>
				<dt>Residue after</dt>
				<dd data-testid="residue-after-count">{specimen.metrics.residueAfter}</dd>
			</div>
		</dl>
	{/if}
</article>

<style>
	.evidence-view {
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
		gap: 0.1rem;
	}
	header strong {
		font-size: 1rem;
	}
	header span {
		color: #6d28d9;
		font-weight: 650;
		text-transform: uppercase;
		letter-spacing: 0.08em;
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
		background: repeating-conic-gradient(#e5e5e5 0 25%, white 0 50%) 0 / 16px 16px;
	}
	.canvas-shell.grid {
		background-size: 8px 8px;
	}
	canvas {
		display: block;
		image-rendering: pixelated;
	}
	.grid canvas {
		background-image:
			linear-gradient(#0002 1px, transparent 1px),
			linear-gradient(90deg, #0002 1px, transparent 1px);
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
		letter-spacing: 0.06em;
	}
	.receipt dd {
		margin: 0.15rem 0 0;
		font-size: 1.15rem;
		font-variant-numeric: tabular-nums;
		font-weight: 700;
	}
</style>
