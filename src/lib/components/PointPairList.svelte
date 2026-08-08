<script lang="ts">
	import type { ControlPointPair, ImageAsset } from '$lib/domain/project';
	import type { PointSelection } from '$lib/pointSelection';
	import { selectionMatches } from '$lib/pointSelection';
	import { sideDisplay } from '$lib/pointListFormat';

	interface Props {
		pairs: readonly ControlPointPair[];
		images: readonly ImageAsset[];
		selection: PointSelection | null;
		/** Bumped by the parent whenever domain state may have changed. */
		refresh: number;
		/** False while a correspondence is being created so management cannot break pending state. */
		interactive?: boolean;
		onSelectSide?: (pairId: string, side: 'source' | 'target') => void;
		onLabelCommit?: (pairId: string, label: string | null) => void;
		onReorder?: (pairId: string, direction: -1 | 1) => void;
		onToggleEnabled?: (pairId: string) => void;
		onDelete?: (pairId: string) => void;
	}

	let {
		pairs,
		images,
		selection,
		refresh,
		interactive = true,
		onSelectSide,
		onLabelCommit,
		onReorder,
		onToggleEnabled,
		onDelete
	}: Props = $props();

	/** Per-row label drafts keyed by stable pair id; present only while the user is typing. */
	let labelDrafts = $state<Record<string, string>>({});
	/** The pair id whose label input currently has focus, or null. */
	let focusedLabelPairId = $state<string | null>(null);
	/** Guards the blur that follows an Enter commit so the same edit commits once. */
	let committedViaEnter = $state<Set<string>>(new Set());

	function imageFor(imageId: string): ImageAsset | undefined {
		return images.find((image) => image.id === imageId);
	}

	function displayFor(pair: ControlPointPair) {
		return {
			source: sideDisplay(pair.source, imageFor(pair.source.imageId)),
			target: sideDisplay(pair.target, imageFor(pair.target.imageId))
		};
	}

	/**
	 * Undo/redo and external domain changes re-sync the label fields unless the user is
	 * actively editing one, so an in-progress draft is never clobbered.
	 */
	$effect(() => {
		void refresh;
		void pairs;
		if (!focusedLabelPairId) {
			labelDrafts = {};
		}
	});

	function handleLabelFocus(pairId: string): void {
		focusedLabelPairId = pairId;
	}

	function handleLabelInput(pairId: string, event: Event): void {
		labelDrafts[pairId] = (event.currentTarget as HTMLInputElement).value;
	}

	/**
	 * Commits a coherent label edit in one domain action: trimmed empty becomes null,
	 * an unchanged label is a no-op (no history entry), and a real change fires once.
	 * A blur with no draft (the user never typed) is always a no-op so moving focus
	 * away cannot clear an untouched label.
	 */
	function commitLabel(pairId: string): void {
		const pair = pairs.find((candidate) => candidate.id === pairId);
		if (!pair) return;
		if (!(pairId in labelDrafts)) return;
		const trimmed = labelDrafts[pairId].trim();
		const next = trimmed === '' ? null : trimmed;
		if (pair.label === next) {
			delete labelDrafts[pairId];
			return;
		}
		onLabelCommit?.(pairId, next);
		delete labelDrafts[pairId];
	}

	/** Human-readable accessible name for a pair's side-select button. */
	function sideAriaLabel(pair: ControlPointPair, side: 'source' | 'target'): string {
		return `Select the ${side} point of pair ${pair.ordinal}`;
	}

	function handleLabelKeyDown(event: KeyboardEvent): void {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		const pairId = (event.currentTarget as HTMLInputElement).dataset.pairId ?? '';
		if (!pairId) return;
		commitLabel(pairId);
		committedViaEnter = new Set(committedViaEnter).add(pairId);
		(event.currentTarget as HTMLInputElement).blur();
	}

	function handleLabelBlur(pairId: string): void {
		focusedLabelPairId = null;
		if (committedViaEnter.has(pairId)) {
			const next = new Set(committedViaEnter);
			next.delete(pairId);
			committedViaEnter = next;
			delete labelDrafts[pairId];
			return;
		}
		commitLabel(pairId);
	}
</script>

<section
	class="point-pairs"
	id="point-pairs"
	tabindex="-1"
	data-testid="point-pairs"
	aria-label="Control point pairs"
>
	<header class="pairs-header">
		<h2>Point pairs</h2>
		<span class="pair-count" data-testid="pair-count">
			{pairs.length} pair{pairs.length === 1 ? '' : 's'}
		</span>
	</header>

	{#if pairs.length === 0}
		<p class="empty" data-testid="pair-list-empty">No control point pairs yet.</p>
	{:else}
		<ul class="pair-list">
			{#each pairs as pair (pair.id)}
				{@const display = displayFor(pair)}
				{@const sourceSelected = selectionMatches(selection, pair.id, 'source')}
				{@const targetSelected = selectionMatches(selection, pair.id, 'target')}
				{@const selected = sourceSelected || targetSelected}
				<li
					class="pair-row"
					class:selected={selected}
					class:disabled-pair={!pair.enabled}
					data-pair-id={pair.id}
					data-ordinal={pair.ordinal}
					data-testid="pair-row"
					aria-current={selected ? 'true' : undefined}
					aria-label={`Pair ${pair.ordinal}${pair.enabled ? '' : ', disabled'}${selected ? ', selected' : ''}`}
				>
				{#if selected}
					<span class="selected-mark" aria-hidden="true" data-testid={`pair-selected-mark-${pair.id}`}>✓</span>
				{/if}
				<span class="ordinal" data-testid={`pair-ordinal-${pair.id}`}>{pair.ordinal}</span>

					{#if !pair.enabled}
						<span class="disabled-tag" data-testid={`pair-disabled-${pair.id}`}>Disabled</span>
					{/if}

					<input
						class="label-input"
						type="text"
						data-testid={`pair-label-${pair.id}`}
						data-pair-id={pair.id}
						value={labelDrafts[pair.id] ?? pair.label ?? ''}
						placeholder="Add label"
						aria-label={`Label for pair ${pair.ordinal}`}
						disabled={!interactive}
						onfocus={() => handleLabelFocus(pair.id)}
						oninput={(event) => handleLabelInput(pair.id, event)}
						onkeydown={handleLabelKeyDown}
						onblur={() => handleLabelBlur(pair.id)}
					/>

					<button
						type="button"
						class="side"
						class:selected={sourceSelected}
						data-testid={`pair-source-${pair.id}`}
						data-side="source"
						aria-pressed={sourceSelected}
						aria-label={sideAriaLabel(pair, 'source')}
						disabled={!interactive}
						onclick={() => onSelectSide?.(pair.id, 'source')}
						title="Select the source point of this pair"
					>
						<span class="side-label">
							{#if sourceSelected}<span class="selected-mark" aria-hidden="true">✓ </span>{/if}Source
						</span>
						<span class="coord" data-testid={`pair-source-px-${pair.id}`}>
							({display.source.xPx}, {display.source.yPx})
						</span>
						<span class="norm" data-testid={`pair-source-norm-${pair.id}`}>
							({display.source.xNorm}, {display.source.yNorm})
						</span>
					</button>

					<button
						type="button"
						class="side"
						class:selected={targetSelected}
						data-testid={`pair-target-${pair.id}`}
						data-side="target"
						aria-pressed={targetSelected}
						aria-label={sideAriaLabel(pair, 'target')}
						disabled={!interactive}
						onclick={() => onSelectSide?.(pair.id, 'target')}
						title="Select the target point of this pair"
					>
						<span class="side-label">
							{#if targetSelected}<span class="selected-mark" aria-hidden="true">✓ </span>{/if}Target
						</span>
						<span class="coord" data-testid={`pair-target-px-${pair.id}`}>
							({display.target.xPx}, {display.target.yPx})
						</span>
						<span class="norm" data-testid={`pair-target-norm-${pair.id}`}>
							({display.target.xNorm}, {display.target.yNorm})
						</span>
					</button>

					<label class="enabled-toggle">
						<input
							type="checkbox"
							data-testid={`pair-enabled-${pair.id}`}
							checked={pair.enabled}
							aria-label={`Enable pair ${pair.ordinal}`}
							disabled={!interactive}
							onchange={() => onToggleEnabled?.(pair.id)}
						/>
						Enabled
					</label>

					<div class="reorder" role="group" aria-label={`Reorder pair ${pair.ordinal}`}>
						<button
							type="button"
							class="reorder-button"
							data-testid={`pair-up-${pair.id}`}
							disabled={!interactive || pair.ordinal <= 1}
							onclick={() => onReorder?.(pair.id, -1)}
							title="Move pair up"
							aria-label={`Move pair ${pair.ordinal} up`}
						>
							↑
						</button>
						<button
							type="button"
							class="reorder-button"
							data-testid={`pair-down-${pair.id}`}
							disabled={!interactive || pair.ordinal >= pairs.length}
							onclick={() => onReorder?.(pair.id, 1)}
							title="Move pair down"
							aria-label={`Move pair ${pair.ordinal} down`}
						>
							↓
						</button>
					</div>

					<button
						type="button"
						class="delete-button"
						data-testid={`pair-delete-${pair.id}`}
						disabled={!interactive}
						onclick={() => onDelete?.(pair.id)}
						title="Delete this pair"
						aria-label={`Delete pair ${pair.ordinal}`}
					>
						Delete
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.point-pairs {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.7rem;
		border: 1px solid #cbd5e1;
		border-radius: 6px;
		background: #f8fafc;
		color: #1f2937;
	}

	.pairs-header {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
	}

	.pairs-header h2 {
		margin: 0;
		font-size: 1rem;
	}

	.pair-count {
		font-size: 0.8rem;
		color: #475569;
	}

	.empty {
		margin: 0;
		font-size: 0.85rem;
		color: #475569;
	}

	.pair-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.pair-row {
		display: grid;
		grid-template-columns: auto 8.5rem auto auto auto 4.5rem auto;
		gap: 0.5rem;
		align-items: center;
		padding: 0.4rem 0.5rem;
		border: 1px solid #e2e8f0;
		border-radius: 4px;
		background: #ffffff;
	}

	.pair-row.selected {
		border-color: #b45309;
		box-shadow: 0 0 0 2px #fde68a;
		background: #fffbeb;
	}

	.pair-row.disabled-pair {
		opacity: 0.9;
	}

	.ordinal {
		font-weight: 600;
		min-width: 1.5rem;
		text-align: center;
	}

	.disabled-tag {
		font-size: 0.75rem;
		font-weight: 600;
		color: #7c2d12;
		background: #ffedd5;
		border: 1px solid #fdba74;
		border-radius: 999px;
		padding: 0.05rem 0.5rem;
		white-space: nowrap;
	}

	.label-input {
		font-size: 0.85rem;
	}

	.side {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.1rem;
		padding: 0.25rem 0.4rem;
		border: 1px solid transparent;
		border-radius: 4px;
		background: transparent;
		font-size: 0.8rem;
		text-align: left;
		cursor: pointer;
		min-width: 0;
	}

	.side:hover {
		background: #f1f5f9;
	}

	.side.selected {
		border-color: #b45309;
		background: #fffbeb;
		box-shadow: 0 0 0 1px #f59e0b inset;
	}

	.side-label {
		font-weight: 600;
		color: #1e293b;
	}

	.selected-mark {
		color: #b45309;
	}

	.coord {
		font-variant-numeric: tabular-nums;
		color: #334155;
	}

	.norm {
		font-variant-numeric: tabular-nums;
		color: #475569;
	}

	.enabled-toggle {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.8rem;
		white-space: nowrap;
	}

	.reorder {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.reorder-button {
		font-size: 0.85rem;
		line-height: 1.2;
	}

	.delete-button {
		font-size: 0.8rem;
	}

	button:focus-visible,
	input:focus-visible {
		outline: 2px solid #0f766e;
		outline-offset: 2px;
	}

	@media (max-width: 720px) {
		.pair-row {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			align-items: start;
		}

		.ordinal {
			justify-self: center;
		}

		.side {
			min-width: 0;
			overflow-wrap: anywhere;
		}

		.enabled-toggle {
			white-space: normal;
		}

		.reorder {
			flex-direction: row;
			justify-content: flex-start;
		}

		.delete-button {
			justify-self: start;
		}
	}
</style>
