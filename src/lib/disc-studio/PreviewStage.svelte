<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	let {
		width,
		surface = 'neutral',
		actualSize = false,
		children
	}: {
		width: number;
		surface?: 'neutral' | 'light' | 'dark' | 'busy';
		actualSize?: boolean;
		children: Snippet;
	} = $props();
	let boundary: HTMLDivElement;
	let content: HTMLDivElement;
	let available = $state(800);
	let height = $state(360);
	let scale = $derived(actualSize ? 1 : Math.min(1, available / width));
	onMount(() => {
		const measure = () => {
			available = Math.max(180, boundary.clientWidth - 48);
			height = content.offsetHeight;
		};
		const observer = new ResizeObserver(measure);
		observer.observe(boundary);
		observer.observe(content);
		measure();
		return () => observer.disconnect();
	});
</script>

<div
	class="stage"
	class:light={surface === 'light'}
	class:dark={surface === 'dark'}
	class:busy={surface === 'busy'}
	bind:this={boundary}
	data-testid="preview-stage"
>
	<div class="stage-label">COMPOSITION PREVIEW <span>NOT A PLACEMENT DECISION</span></div>
	<div class="scroller">
		<div class="scaled" style:width={`${width * scale}px`} style:height={`${height * scale}px`}>
			<div
				class="content"
				bind:this={content}
				style:width={`${width}px`}
				style:transform={`scale(${scale})`}
			>
				{@render children()}
			</div>
		</div>
	</div>
	<div class="measure">
		{width} × {Math.round(height)} px
		<span
			>{Math.round(scale * 100)}% display · {actualSize
				? 'scroll to inspect at 1:1'
				: 'fit to workspace'}</span
		>
	</div>
</div>

<style>
	.stage {
		background: #dde2d7;
		border: 1px solid #cdd5c7;
		border-radius: 16px;
		color: #5a6c60;
		min-width: 0;
		overflow: hidden;
	}
	.light {
		background: #faf9f5;
		border-color: #e1ded4;
	}
	.dark {
		background: #172320;
		color: #bac7bd;
		border-color: #172320;
	}
	.busy {
		background-color: #b9c2b6;
		background-image:
			repeating-linear-gradient(
				27deg,
				#f2eee030 0,
				#f2eee030 13px,
				transparent 13px,
				transparent 47px
			),
			repeating-linear-gradient(
				119deg,
				#66715c25 0,
				#66715c25 18px,
				transparent 18px,
				transparent 81px
			);
	}
	.stage-label,
	.measure {
		font:
			10px/1.3 ui-monospace,
			monospace;
		letter-spacing: 0.06em;
		padding: 17px 20px;
		display: flex;
		justify-content: space-between;
		gap: 10px;
	}
	.stage-label span {
		opacity: 0.65;
		font-size: 8px;
		align-self: center;
	}
	.scroller {
		overflow: auto;
		padding: 18px 24px 24px;
		min-height: 240px;
		display: flex;
		align-items: center;
		box-sizing: border-box;
	}
	.scaled {
		position: relative;
		margin: auto;
		flex: none;
	}
	.content {
		transform-origin: top left;
		position: absolute;
		top: 0;
		left: 0;
	}
	.measure {
		border-top: 1px solid #74836f20;
		font-size: 10px;
		letter-spacing: 0;
	}
</style>
