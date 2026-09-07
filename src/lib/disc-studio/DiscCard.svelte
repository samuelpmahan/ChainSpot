<script lang="ts">
	import DiscImage from './DiscImage.svelte';
	import {
		defaultAppearance,
		neutralCard,
		flightKeys,
		formatNumber,
		type Disc,
		type CardAppearance,
		type CardState
	} from './model';
	let {
		disc,
		appearance = defaultAppearance,
		state = neutralCard,
		score,
		delta
	}: {
		disc: Disc;
		appearance?: CardAppearance;
		state?: CardState;
		score?: number;
		delta?: number;
	} = $props();
</script>

<article
	class="disc-card"
	class:paper={appearance.theme === 'paper'}
	class:compact={appearance.layout === 'compact'}
	class:flight-first={appearance.hierarchy === 'flight'}
	class:highlighted={state.highlighted}
	class:winner={state.emphasis === 'winner'}
	data-testid="disc-card"
	data-disc-id={disc.id}
>
	<div class="photo-area"><DiscImage {disc} fit={appearance.imageFit} /></div>
	<div class="card-copy">
		<div class="identity">
			<div class="manufacturer">{disc.manufacturer || 'Manufacturer'}</div>
			<h3>{disc.mold || 'Untitled disc'}</h3>
			{#if appearance.showVariant}<p class="variant">{disc.variant || ' '}</p>{/if}
		</div>
		<div class="numbers" aria-label="Flight numbers">
			{#each flightKeys as key}<div>
					<strong>{formatNumber(disc.flight[key])}</strong><span>{key}</span>
				</div>{/each}
		</div>
	</div>
	{#if score !== undefined}<div class="score">
			<span>SCORE</span><strong data-testid="rendered-score">{formatNumber(score)}</strong
			>{#if delta !== undefined && delta !== 0}<b class="delta"
					>{delta > 0 ? '+' : ''}{formatNumber(delta)}</b
				>{/if}
		</div>{/if}
	{#if state.highlighted || state.emphasis !== 'none'}<div class="state-tag">
			{state.emphasis === 'winner' ? '★ Winner' : '● Highlight'}
		</div>{/if}
</article>

<style>
	.disc-card {
		font-family: Arial, Helvetica, sans-serif;
		--surface: #203731;
		--ink: #faf9f2;
		--secondary: #b1c3b9;
		--rule: #ffffff20;
		--accent: #d9f081;
		container-type: inline-size;
		position: relative;
		box-sizing: border-box;
		background: var(--surface);
		color: var(--ink);
		border: 2px solid transparent;
		border-radius: 13px;
		overflow: hidden;
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		text-align: left;
		box-shadow: 0 5px 12px #15282115;
	}
	.paper {
		--surface: #fcfbf6;
		--ink: #203731;
		--secondary: #617168;
		--rule: #20373124;
		--accent: #5a732d;
	}
	.highlighted {
		border-color: #b9dc68;
		box-shadow:
			0 0 0 2px #b9dc6860,
			0 5px 12px #15282115;
	}
	.winner {
		border-color: #e6bc61;
	}
	.photo-area {
		height: 63cqw;
		max-height: 235px;
		background: radial-gradient(ellipse at center, #ffffff0a, #0000000c);
		padding: 6px 12px 0;
		flex-shrink: 0;
	}
	.card-copy {
		display: flex;
		flex-direction: column;
		padding: 13px 15px 15px;
		gap: 14px;
		min-width: 0;
		flex: 1;
	}
	.manufacturer {
		font-size: 11px;
		line-height: 1.3;
		text-transform: uppercase;
		letter-spacing: 0.13em;
		font-weight: 650;
		color: var(--secondary);
		overflow-wrap: anywhere;
	}
	h3 {
		font-size: clamp(18px, 10.5cqw, 38px);
		letter-spacing: -0.035em;
		line-height: 1.07;
		margin: 5px 0 0;
		overflow-wrap: anywhere;
	}
	.variant {
		font-size: 11px;
		line-height: 1.4;
		color: var(--secondary);
		margin: 6px 0 0;
		overflow-wrap: anywhere;
	}
	.numbers {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		border-top: 1px solid var(--rule);
		padding-top: 10px;
		gap: 5px;
	}
	.numbers div {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.numbers strong {
		overflow-wrap: anywhere;
		font-size: clamp(18px, 10cqw, 32px);
		font-weight: 600;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.04em;
	}
	.numbers span {
		font-size: 8px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--secondary);
	}
	.score {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
		padding: 9px 15px;
		background: #0002;
		position: relative;
	}
	.paper .score {
		background: #20373108;
	}
	.score > span {
		font-size: 9px;
		letter-spacing: 0.17em;
		color: var(--secondary);
	}
	.score > strong {
		font-size: 36px;
		line-height: 1.05;
		font-weight: 600;
		letter-spacing: -0.05em;
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
		min-width: 0;
	}
	.delta {
		font-size: 11px;
		background: var(--accent);
		color: var(--surface);
		border-radius: 5px;
		padding: 3px 5px;
	}
	.state-tag {
		position: absolute;
		top: 9px;
		left: 9px;
		padding: 4px 7px;
		font-size: 8px;
		font-weight: 800;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		background: #cce88b;
		color: #203731;
		border-radius: 4px;
	}
	.winner .state-tag {
		background: #e6bc61;
	}
	.flight-first .numbers {
		order: -1;
		border-top: 0;
		padding-top: 0;
	}
	.flight-first .identity {
		border-top: 1px solid var(--rule);
		padding-top: 11px;
	}
	.flight-first .numbers strong {
		overflow-wrap: anywhere;
		font-size: clamp(22px, 14cqw, 44px);
	}
	.flight-first h3 {
		font-size: clamp(16px, 8cqw, 30px);
	}
	.compact {
		display: grid;
		grid-template-columns: 70px minmax(0, 1fr);
		grid-template-rows: 1fr auto;
		min-height: 118px;
		border-radius: 8px;
	}
	.compact .photo-area {
		padding: 4px;
		width: 70px;
		height: 100%;
		min-height: 80px;
		box-sizing: border-box;
		grid-row: 1/3;
		max-height: none;
	}
	.compact .card-copy {
		padding: 12px 10px 8px;
		gap: 8px;
	}
	.compact .manufacturer {
		font-size: 8px;
		letter-spacing: 0.09em;
	}
	.compact h3 {
		font-size: 18px;
		line-height: 1.05;
		margin: 3px 0 0;
	}
	.compact .variant {
		font-size: 8px;
		margin-top: 4px;
	}
	.compact .numbers {
		padding-top: 6px;
		gap: 4px;
	}
	.compact .numbers strong {
		overflow-wrap: anywhere;
		font-size: 14px;
	}
	.compact .numbers span {
		font-size: 6px;
		letter-spacing: 0;
	}
	.compact .score {
		grid-column: 2;
		padding: 5px 10px;
		min-height: 29px;
	}
	.compact .score > strong {
		font-size: 24px;
	}
	.compact .score > span {
		font-size: 7px;
	}
	.compact .state-tag {
		top: 5px;
		left: 4px;
		font-size: 6px;
		padding: 3px;
		letter-spacing: 0;
	}
	.compact.flight-first .identity {
		padding-top: 6px;
	}
	.compact.flight-first .numbers strong {
		overflow-wrap: anywhere;
		font-size: 19px;
	}
</style>
