<script lang="ts">
	import { tick } from 'svelte';
	import {
		clampRingOffset,
		radialPositions,
		RADIAL_BUTTON_SIZE_PX,
		RADIAL_RING_RADIUS_PX
	} from '$lib/radialMenu';

	/** One placement/delete action, in the same shape regardless of what domain it came from. */
	export interface RadialMenuAction {
		readonly id: string;
		/** Full accessible name — becomes both `aria-label` and the native tooltip (`title`). */
		readonly label: string;
		/** Short glyph rendered inside the button; decorative, so it's marked `aria-hidden`. */
		readonly icon: string;
		readonly danger?: boolean;
	}

	interface Props {
		/** Anchor point (the true click/placement point) in pane-local CSS px — never itself clamped. */
		anchor: { x: number; y: number };
		/** The pane's current CSS-px size, used to clamp the ring fully on-screen. */
		bounds: { width: number; height: number };
		actions: readonly RadialMenuAction[];
		onSelect: (id: string) => void;
		onClose: (reason: 'escape' | 'outside') => void;
		testid?: string;
	}

	let { anchor, bounds, actions, onSelect, onClose, testid = 'radial-menu' }: Props = $props();

	let rootEl = $state<HTMLDivElement | null>(null);
	let itemEls: (HTMLButtonElement | null)[] = $state([]);
	let activeIndex = $state(0);

	const positions = $derived(radialPositions(actions.length, { radius: RADIAL_RING_RADIUS_PX }));
	const clampDelta = $derived(
		clampRingOffset(positions, RADIAL_BUTTON_SIZE_PX, anchor, bounds)
	);

	// A shorter action list (e.g. a hitMarker delete-only menu replacing an
	// empty-space menu via the same open instance) must not leave the roving
	// tabindex pointing past the end.
	$effect(() => {
		if (activeIndex > actions.length - 1) activeIndex = Math.max(0, actions.length - 1);
	});

	// Focus moves into the menu the moment it (or a new action set) is shown —
	// accessibility requirement, not a nicety: without this a keyboard user has
	// no way to discover the menu opened at all.
	$effect(() => {
		void actions;
		void tick().then(() => itemEls[activeIndex]?.focus());
	});

	// Click-outside cancels. Registered on `window` rather than relying on a
	// blur/focusout handler so it fires for a pointer click anywhere outside —
	// including on the non-focusable map canvas — not just a focus change.
	$effect(() => {
		function handlePointerDown(event: PointerEvent): void {
			if (rootEl && event.target instanceof Node && !rootEl.contains(event.target)) {
				onClose('outside');
			}
		}
		window.addEventListener('pointerdown', handlePointerDown);
		return () => window.removeEventListener('pointerdown', handlePointerDown);
	});

	function focusIndex(index: number): void {
		if (actions.length === 0) return;
		activeIndex = ((index % actions.length) + actions.length) % actions.length;
		itemEls[activeIndex]?.focus();
	}

	/**
	 * ArrowRight/ArrowDown advance clockwise, ArrowLeft/ArrowUp advance
	 * counter-clockwise, both cycling through `radialPositions`'s own order —
	 * a plain next/previous step in that order, not spatial nearest-neighbor
	 * hit-testing, which "cycling items in radial order" doesn't require.
	 */
	function handleKeyDown(event: KeyboardEvent): void {
		switch (event.key) {
			case 'ArrowRight':
			case 'ArrowDown':
				event.preventDefault();
				focusIndex(activeIndex + 1);
				return;
			case 'ArrowLeft':
			case 'ArrowUp':
				event.preventDefault();
				focusIndex(activeIndex - 1);
				return;
			case 'Home':
				event.preventDefault();
				focusIndex(0);
				return;
			case 'End':
				event.preventDefault();
				focusIndex(actions.length - 1);
				return;
			case 'Escape':
				event.preventDefault();
				event.stopPropagation();
				onClose('escape');
				return;
		}
	}
</script>

<div
	bind:this={rootEl}
	class="radial-menu"
	data-testid={testid}
	role="menu"
	tabindex="-1"
	aria-label="Placement actions"
	style={`left:${anchor.x}px; top:${anchor.y}px;`}
	onkeydown={handleKeyDown}
>
	<span class="radial-menu-anchor" aria-hidden="true"></span>
	{#each actions as action, index (action.id)}
		{@const pos = positions[index]}
		<button
			bind:this={itemEls[index]}
			type="button"
			class="radial-menu-item"
			class:danger={action.danger}
			role="menuitem"
			data-testid={`radial-action-${action.id}`}
			aria-label={action.label}
			title={action.label}
			tabindex={index === activeIndex ? 0 : -1}
			style={`left:${pos.x + clampDelta.dx}px; top:${pos.y + clampDelta.dy}px;`}
			onfocus={() => (activeIndex = index)}
			onclick={() => onSelect(action.id)}
		>
			<span aria-hidden="true">{action.icon}</span>
		</button>
	{/each}
</div>

<style>
	.radial-menu {
		position: absolute;
		left: 0;
		top: 0;
		/*
		 * Deliberately non-zero: the root is the anchor point, and its buttons
		 * are all absolutely positioned relative to it (so they never grow this
		 * box). A true 0x0 box has an empty bounding rect, which several
		 * automated visibility checks (Playwright's `toBeVisible`, some
		 * accessibility tooling) treat as "not visible" even though its
		 * children plainly are.
		 */
		width: 1px;
		height: 1px;
		z-index: 30;
	}

	.radial-menu-anchor {
		position: absolute;
		left: -3px;
		top: -3px;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #38bdf8;
		box-shadow: 0 0 0 3px rgb(56 189 248 / 25%);
		pointer-events: none;
	}

	.radial-menu-item {
		position: absolute;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		margin: 0;
		padding: 0;
		border: 1px solid #52525b;
		border-radius: 50%;
		background: #27272a;
		color: #f4f4f5;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 1.1rem;
		font-weight: 700;
		line-height: 1;
		cursor: pointer;
		touch-action: manipulation;
		transform: translate(-50%, -50%);
		box-shadow: 0 6px 16px rgb(0 0 0 / 45%);
	}

	.radial-menu-item:hover {
		background: #3f3f46;
		border-color: #71717a;
	}

	.radial-menu-item.danger {
		background: #7f1d1d;
		border-color: #991b1b;
	}

	.radial-menu-item.danger:hover {
		background: #991b1b;
	}

	.radial-menu-item:focus {
		outline: 3px solid #38bdf8;
		outline-offset: 2px;
	}
</style>
