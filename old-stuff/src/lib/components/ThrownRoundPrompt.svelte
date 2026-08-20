<script lang="ts">
	/**
	 * CHSPT-65: asked BEFORE any crop/stitch — a thrown-round screenshot mixed
	 * into a batch must never reach the clean composite. One thumbnail per
	 * selected capture, plus a "no thrown round" fallback that stitches
	 * everything as clean, exactly as the importer always did.
	 *
	 * Extracted verbatim from Stitch Map's inline `pendingImport` prompt so the
	 * front door (`/`) can present the identical choice before it ever hands
	 * captures to Stitch Map. The caller owns the object URLs in `items` (create
	 * them before mounting, revoke them once `onChoose`/`onCancel` resolves the
	 * prompt) — this component only reads them for thumbnails.
	 */
	interface Props {
		items: readonly { file: File; url: string }[];
		/** index = that capture is the thrown round; null = no thrown round in batch. */
		onChoose: (index: number | null) => void;
		onCancel: () => void;
	}

	let { items, onChoose, onCancel }: Props = $props();
</script>

<div class="pre-import-prompt" data-testid="pre-import-prompt">
	<h3>Before stitching — is one of these the thrown round?</h3>
	<p class="section-note">
		The thrown round (the screenshot with the purple round path) is set aside for Create Graphics
		and kept out of the clean map. Pick it here, or stitch everything as clean.
	</p>
	<ul class="pre-import-grid">
		{#each items as item, index (item.url)}
			<li class="pre-import-item">
				<img class="pre-import-thumb" src={item.url} alt={item.file.name} />
				<span class="pre-import-name">{item.file.name}</span>
				<button
					type="button"
					class="thrown-round-pick"
					data-testid="pre-import-thrown-{index}"
					onclick={() => onChoose(index)}
				>
					Thrown round
				</button>
			</li>
		{/each}
	</ul>
	<div class="pre-import-actions">
		<button
			type="button"
			class="btn primary"
			data-testid="pre-import-none"
			onclick={() => onChoose(null)}
		>
			{items.length === 1
				? 'No thrown round — crop it as the clean map'
				: `No thrown round — stitch all ${items.length}`}
		</button>
		<button type="button" class="btn ghost" data-testid="pre-import-cancel" onclick={onCancel}>
			Cancel import
		</button>
	</div>
</div>

<style>
	.pre-import-prompt {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding: 0.9rem 1rem;
		border: 1px solid #4c1d95;
		border-radius: 8px;
		background-color: #1e1e24;
	}

	.pre-import-prompt h3 {
		margin: 0;
		font-size: 1rem;
		color: #f4f4f5;
	}

	.section-note {
		margin: 0;
		font-size: 0.9rem;
		color: #a1a1aa;
		line-height: 1.5;
	}

	.pre-import-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 0.8rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.pre-import-item {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.35rem;
		width: 160px;
	}

	.pre-import-thumb {
		width: 160px;
		height: 120px;
		object-fit: cover;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		background: #101014;
	}

	.pre-import-name {
		max-width: 160px;
		font-size: 0.75rem;
		color: #a1a1aa;
		overflow-wrap: anywhere;
		text-align: center;
	}

	.pre-import-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
	}

	.thrown-round-pick {
		padding: 0.2rem 0.55rem;
		border: 1px solid #4c1d95;
		border-radius: 4px;
		background-color: #2e1065;
		color: #ddd6fe;
		font-size: 0.78rem;
		cursor: pointer;
	}

	.btn {
		font-size: 0.8rem;
		padding: 0.5rem 0.85rem;
		border-radius: 6px;
		border: 1px solid #3f3f46;
		background: #27272a;
		color: #e4e4e7;
		cursor: pointer;
	}

	.btn.ghost {
		background: transparent;
		color: #a1a1aa;
	}

	.btn.primary {
		background: #fbbf24;
		border-color: #fbbf24;
		color: #241804;
		font-weight: 650;
	}
</style>
