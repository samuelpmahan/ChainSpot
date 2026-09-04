<script lang="ts">
	import type { RgbaRaster } from '@chainspot/alg/detect';
	import { createS0Stage, formatS0ReceiptText } from '@chainspot/alg/exec';
	import type { S0IntakePcrRun } from '$lib/s0IntakePcr';
	import { runS0IntakePcr } from '$lib/s0IntakePcr';
	import TickInspection from './TickInspection.svelte';

	let { showReceipt = true }: { showReceipt?: boolean } = $props();

	const stage = createS0Stage();
	let selectedFile = $state<File | null>(null);
	let run = $state<S0IntakePcrRun | null>(null);
	let running = $state(false);
	let failure = $state<string | null>(null);
	let gatewayCrossings = $state(0);
	let request = 0;
	let receiptText = $derived(
		run
			? formatS0ReceiptText(run, {
					inputLabel: run.file.name,
					progression: 'FullImage → crop boundary → CroppedImage in PxC → cache FullImage'
				})
			: ''
	);

	$effect(() => {
		const file = selectedFile;
		if (!file) return;
		const id = ++request;
		running = true;
		failure = null;
		gatewayCrossings += 1;
		void runS0IntakePcr({ selectedFiles: [file], stage })
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

	function chooseFile(event: Event) {
		selectedFile = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
		run = null;
	}

	function rasterCanvas(raster: RgbaRaster): HTMLCanvasElement {
		const canvas = document.createElement('canvas');
		canvas.width = raster.widthPx;
		canvas.height = raster.heightPx;
		canvas
			.getContext('2d')
			?.putImageData(
				new ImageData(new Uint8ClampedArray(raster.rgba), raster.widthPx, raster.heightPx),
				0,
				0
			);
		return canvas;
	}

	function paintProgression(canvas: HTMLCanvasElement, value: S0IntakePcrRun) {
		const panelWidth = Math.min(360, value.fullImage.widthPx);
		const scale = panelWidth / value.fullImage.widthPx;
		const panelHeight = Math.round(value.fullImage.heightPx * scale);
		const croppedHeight = Math.round(value.croppedImage.heightPx * scale);
		const topOffset = Math.round((value.crop.insets?.top ?? 0) * scale);
		const gap = 48;
		const labelHeight = 36;
		canvas.width = panelWidth * 3 + gap * 2;
		canvas.height = labelHeight + panelHeight;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.fillStyle = '#e5e7eb';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.fillStyle = '#171717';
		ctx.font = '800 16px ui-sans-serif, system-ui, sans-serif';
		ctx.fillText('1 · FULLIMAGE', 8, 24);
		ctx.fillText('2 · CROP', panelWidth + gap + 8, 24);
		ctx.fillText('3 · PxC', (panelWidth + gap) * 2 + 8, 24);

		const full = rasterCanvas(value.fullImage);
		const cropped = rasterCanvas(value.croppedImage);
		const firstX = 0;
		const secondX = panelWidth + gap;
		const thirdX = (panelWidth + gap) * 2;
		ctx.drawImage(full, firstX, labelHeight, panelWidth, panelHeight);
		ctx.drawImage(full, secondX, labelHeight, panelWidth, panelHeight);

		const insets = value.crop.insets;
		if (insets) {
			const top = Math.round(insets.top * scale);
			const bottom = Math.round(insets.bottom * scale);
			const left = Math.round(insets.left * scale);
			const right = Math.round(insets.right * scale);
			ctx.fillStyle = 'rgba(239, 68, 68, 0.34)';
			ctx.fillRect(secondX, labelHeight, panelWidth, top);
			ctx.fillRect(secondX, labelHeight + panelHeight - bottom, panelWidth, bottom);
			ctx.fillRect(secondX, labelHeight + top, left, panelHeight - top - bottom);
			ctx.fillRect(
				secondX + panelWidth - right,
				labelHeight + top,
				right,
				panelHeight - top - bottom
			);
			ctx.strokeStyle = '#facc15';
			ctx.lineWidth = 3;
			ctx.strokeRect(
				secondX + left,
				labelHeight + top,
				panelWidth - left - right,
				panelHeight - top - bottom
			);
		}

		ctx.drawImage(cropped, thirdX, labelHeight + topOffset, panelWidth, croppedHeight);
		ctx.strokeStyle = '#525252';
		ctx.lineWidth = 1;
		for (const x of [firstX, secondX, thirdX]) {
			ctx.strokeRect(x + 0.5, labelHeight + 0.5, panelWidth - 1, panelHeight - 1);
		}
		ctx.fillStyle = '#6d28d9';
		ctx.font = '800 28px ui-sans-serif, system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.fillText('→', panelWidth + gap / 2, labelHeight + panelHeight / 2);
		ctx.fillText('→', panelWidth * 2 + gap * 1.5, labelHeight + panelHeight / 2);
		ctx.textAlign = 'start';
	}

	function drawProgression(canvas: HTMLCanvasElement, value: S0IntakePcrRun) {
		paintProgression(canvas, value);
		return { update: (next: S0IntakePcrRun) => paintProgression(canvas, next) };
	}
</script>

<main>
	<header>
		<div>
			<span>S0 · Intake → PxC</span>
			<h1>Full image → cropped image</h1>
			<p>S0 starts with this page: decode sanitizes, crop materializes, FullImage caches last.</p>
		</div>
		<label>Full image <input type="file" accept="image/*" onchange={chooseFile} /></label>
	</header>

	{#if running}<p class="pending">Decoding and cropping…</p>{/if}
	{#if failure}<p class="failure">{failure}</p>{/if}

	{#if run}
		<section class="receipt">
			<div class="progression" aria-label="S0 aligned visual progression">
				<canvas use:drawProgression={run}></canvas>
			</div>
			{#if showReceipt}
				<h2>Receipt</h2>
				<pre>{receiptText}</pre>
			{/if}
		</section>

		<details>
			<summary>Tick testimony</summary>
			<TickInspection pcr={run.pcr} tickId={run.testimony.opId} residue={[]} />
		</details>
	{:else if !selectedFile}
		<section class="empty">
			<h2>Ready</h2>
			<p>Select the real full screenshot. S0 will show exactly what it removed.</p>
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
	header {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		align-items: end;
		border-bottom: 4px solid #6d28d9;
		padding-bottom: 1rem;
	}
	header span,
	h2 {
		color: #5b21b6;
		font-weight: 800;
	}
	h1 {
		margin: 0.2rem 0;
		font-size: 1.5rem;
	}
	p {
		margin: 0.35rem 0;
	}
	label {
		display: grid;
		gap: 0.35rem;
		font-weight: 800;
	}
	.progression {
		padding: 0.75rem;
		border: 1px solid #d4d4d4;
		background: #fafafa;
	}
	canvas {
		display: block;
		width: 100%;
		height: auto;
		border: 1px solid #737373;
	}
	.receipt,
	.empty,
	details {
		border: 1px solid #d4d4d4;
		padding: 0.8rem;
		background: #fafafa;
	}
	pre {
		margin: 0;
		white-space: pre-wrap;
		font:
			12px/1.55 ui-monospace,
			SFMono-Regular,
			Menlo,
			Consolas,
			monospace;
	}
	.pending {
		color: #6d28d9;
		font-weight: 800;
	}
	.failure {
		color: #b91c1c;
		font-weight: 800;
	}
	summary {
		cursor: pointer;
		font-weight: 800;
	}
	@media (max-width: 780px) {
		header {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>
