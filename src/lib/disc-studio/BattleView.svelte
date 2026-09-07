<script lang="ts">
	import DiscCard from './DiscCard.svelte';
	import { cardStateFor, type Workspace } from './model';
	let {
		workspace,
		selectedEntryId = null,
		onselect,
		change = null,
		showDelta = true
	}: {
		workspace: Workspace;
		selectedEntryId?: string | null;
		onselect?: (id: string) => void;
		change?: { entryId: string; from: number; to: number } | null;
		showDelta?: boolean;
	} = $props();
</script>

<div
	class="battle"
	class:stack={workspace.battleAppearance.layout === 'stack'}
	class:grid={workspace.battleAppearance.layout === 'grid'}
	style:--entries={Math.max(1, workspace.battle.entries.length)}
	data-testid="battle-render"
>
	{#each workspace.battle.entries as entry (entry.id)}
		{@const disc = workspace.discs.find((d) => d.id === entry.discId)}
		{#if disc}
			{#if onselect}<button
					type="button"
					class="entry"
					class:inspected={selectedEntryId === entry.id}
					aria-label={`Inspect ${disc.mold} entry`}
					onclick={() => onselect?.(entry.id)}
					><DiscCard
						{disc}
						appearance={workspace.cardAppearance}
						state={cardStateFor(workspace.battleVisual, entry.id)}
						score={workspace.battleAppearance.showScores ? entry.score : undefined}
						delta={showDelta && change?.entryId === entry.id ? change.to - change.from : undefined}
					/></button
				>
			{:else}<div class="entry">
					<DiscCard
						{disc}
						appearance={workspace.cardAppearance}
						state={cardStateFor(workspace.battleVisual, entry.id)}
						score={workspace.battleAppearance.showScores ? entry.score : undefined}
						delta={showDelta && change?.entryId === entry.id ? change.to - change.from : undefined}
					/>
				</div>{/if}
		{/if}
	{/each}
</div>

<style>
	.battle {
		display: grid;
		grid-template-columns: repeat(var(--entries), minmax(0, 1fr));
		align-items: stretch;
		gap: 12px;
		width: 100%;
	}
	.stack {
		grid-template-columns: 1fr;
	}
	.grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
	.entry {
		border: 0;
		background: none;
		padding: 0;
		margin: 0;
		color: inherit;
		text-align: inherit;
		min-width: 0;
		font: inherit;
		display: block;
	}
	button.entry {
		cursor: pointer;
		border-radius: 13px;
		outline-offset: 5px;
	}
	button.entry:focus-visible {
		outline: 2px dashed #476454;
	}
</style>
