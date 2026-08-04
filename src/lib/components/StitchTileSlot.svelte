<script lang="ts">
	import type { TileSlot } from '$lib/stitch/geometry';

	interface Props {
		slot: TileSlot;
		label: string;
		fileName: string | null;
		dimensions: string | null;
		error: string | null;
		onFile: (file: File) => void;
		onRemove: () => void;
	}

	let {
		slot,
		label,
		fileName,
		dimensions,
		error,
		onFile,
		onRemove
	}: Props = $props();

	function handleChange(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (file) onFile(file);
	}
</script>

<section class="tile-slot" data-testid={`tile-slot-${slot}`} aria-label={label}>
	<h3>{label}</h3>
	{#if fileName}
		<p class="tile-file" data-testid={`tile-file-${slot}`}>{fileName}</p>
		<p class="tile-dims" data-testid={`tile-dims-${slot}`}>{dimensions}</p>
		<div class="slot-actions">
			<label class="file-label">
				Replace
				<input
					class="file-input"
					type="file"
					accept="image/png,image/jpeg"
					data-testid={`tile-input-${slot}`}
					onchange={handleChange}
				/>
			</label>
			<button type="button" data-testid={`tile-remove-${slot}`} onclick={onRemove}>
				Remove
			</button>
		</div>
	{:else}
		<label class="file-label load-label">
			Load {label}
			<input
				class="file-input"
				type="file"
				accept="image/png,image/jpeg"
				data-testid={`tile-input-${slot}`}
				onchange={handleChange}
			/>
		</label>
	{/if}
	{#if error}
		<p class="slot-error" data-testid={`tile-error-${slot}`} role="alert">{error}</p>
	{/if}
</section>

<style>
	.tile-slot {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		padding: 0.7rem;
		border: 1px solid #27272a;
		border-radius: 8px;
		background-color: #1e1e24;
	}

	h3 {
		margin: 0;
		font-size: 0.9rem;
		font-weight: 600;
		color: #f4f4f5;
	}

	.tile-file,
	.tile-dims {
		margin: 0;
		font-size: 0.8rem;
		color: #a1a1aa;
		overflow-wrap: anywhere;
	}

	.slot-actions {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.file-label {
		display: inline-flex;
		align-items: center;
		padding: 0.3rem 0.7rem;
		border: 1px solid #3f3f46;
		border-radius: 4px;
		background-color: #27272a;
		color: #e4e4e7;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.load-label {
		justify-content: center;
		padding: 0.9rem;
		border-style: dashed;
	}

	.file-input {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}

	.slot-error {
		margin: 0;
		padding: 0.4rem 0.6rem;
		border-radius: 4px;
		background: #3f1d1d;
		border: 1px solid #7f1d1d;
		color: #fca5a5;
		font-size: 0.8rem;
	}
</style>
