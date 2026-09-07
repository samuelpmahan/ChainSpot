<script lang="ts">
	import type { Disc } from './model';
	let { disc, fit = 'contain' }: { disc: Disc; fit?: 'contain' | 'cover' } = $props();
	let failedSrc = $state('');
	// Color belongs to this fallback renderer, never to Disc facts. These are UI placeholders.
	const swatches = ['#a8d7bd', '#edab9e', '#bfb1d7', '#e1c479', '#95bbd4', '#dacbb1', '#d5a7b8'];
	let color = $derived(
		swatches[
			disc.id.startsWith('sample-')
				? [
						'sample-buzzz-mint',
						'sample-zone-coral',
						'sample-destroyer-lilac',
						'sample-leopard-sun',
						'sample-mako-blue',
						'sample-teebird-sand',
						'sample-buzzz-rose'
					].indexOf(disc.id) % swatches.length
				: 0
		] ?? swatches[0]
	);
</script>

<div class="disc-image" class:photo={!!disc.image} style:--disc-color={color}>
	{#if disc.image && failedSrc !== disc.image.src}
		<img
			src={disc.image.src}
			alt={disc.image.alt || `${disc.manufacturer} ${disc.mold}: exact disc photo`}
			style:object-fit={fit}
			onerror={() => (failedSrc = disc.image?.src ?? '')}
		/>
	{:else}
		<div
			class="placeholder"
			aria-label={`${disc.mold || 'Disc'} placeholder illustration; no photo`}
		>
			<div class="plastic">
				<div class="stamp">
					<span>{disc.manufacturer || 'YOUR DISC'}</span><strong>{disc.mold || 'Untitled'}</strong
					><i></i><small>{disc.image ? 'IMAGE UNAVAILABLE' : 'SAMPLE / NO PHOTO'}</small>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.disc-image {
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		overflow: hidden;
		min-width: 0;
		min-height: 0;
	}
	img {
		width: 100%;
		height: 100%;
		display: block;
	}
	.placeholder {
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		padding: 2%;
		box-sizing: border-box;
		container-type: size;
	}
	.plastic {
		width: 94cqmin;
		height: 94cqmin;
		max-width: 100%;
		max-height: 100%;
		border-radius: 50%;
		background: var(--disc-color);
		box-shadow:
			inset 0 0 0 2px #fff4,
			inset 0 0 0 8px #0000000b,
			0 6px 9px #0002;
		display: grid;
		place-items: center;
		transform: rotate(-12deg);
	}
	.stamp {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		border: 1px solid #27312d55;
		border-radius: 50%;
		width: 71%;
		height: 71%;
		gap: 4%;
		color: #283630;
		overflow: hidden;
	}
	.stamp span {
		font-size: 6cqmin;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		max-width: 85%;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.stamp strong {
		font-size: 13cqmin;
		line-height: 1.2;
		max-width: 90%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 750;
		letter-spacing: -0.035em;
	}
	.stamp i {
		display: block;
		height: 1px;
		background: currentColor;
		width: 50%;
		opacity: 0.5;
	}
	.stamp small {
		font:
			500 4.3cqmin ui-monospace,
			monospace;
		letter-spacing: 0.02em;
	}
</style>
