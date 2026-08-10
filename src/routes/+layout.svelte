<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { base } from '$app/paths';

	/**
	 * Client-only marker set after hydration and event delegation are in place.
	 * The e2e suite waits for it before simulating user interaction, because
	 * events dispatched before hydration completes are not delegated.
	 */
	$effect(() => {
		document.documentElement.dataset.appReady = 'true';
	});

	let { children }: { children: import('svelte').Snippet } = $props();

	/**
	 * No route in this app has a real drop zone, so a file the user drags over
	 * the page — even a mis-aimed drop — must never be allowed to reach the
	 * browser's default handling, which navigates away and destroys the
	 * in-memory editor session. Guard at the document level unconditionally.
	 */
	function preventDefaultDrag(event: DragEvent): void {
		event.preventDefault();
	}

	onMount(() => {
		document.addEventListener('dragover', preventDefaultDrag);
		document.addEventListener('drop', preventDefaultDrag);
		return () => {
			document.removeEventListener('dragover', preventDefaultDrag);
			document.removeEventListener('drop', preventDefaultDrag);
		};
	});
</script>

<header class="app-header">
	<nav class="app-nav" aria-label="Main Navigation">
		<a
			href="{base}/stitch-map"
			class="nav-link"
			class:active={page.url.pathname === `${base}/stitch-map`}
			aria-current={page.url.pathname === `${base}/stitch-map` ? 'page' : undefined}
		>
			Stitch Map
		</a>
		<a
			href="{base}/annotate-round"
			class="nav-link"
			class:active={page.url.pathname === `${base}/annotate-round` || page.url.pathname === `${base}/`}
			aria-current={page.url.pathname === `${base}/annotate-round` || page.url.pathname === `${base}/` ? 'page' : undefined}
		>
			Annotate Round
		</a>
		<a
			href="{base}/create-graphics"
			class="nav-link"
			class:active={page.url.pathname === `${base}/create-graphics`}
			aria-current={page.url.pathname === `${base}/create-graphics` ? 'page' : undefined}
		>
			Create Graphics
		</a>
	</nav>
	<nav class="dev-nav" aria-label="Developer tools">
		<a
			href="{base}/ribbon-editor"
			class="nav-link dev-link"
			class:active={page.url.pathname === `${base}/ribbon-editor`}
			aria-current={page.url.pathname === `${base}/ribbon-editor` ? 'page' : undefined}
		>
			Ribbon Goldens
		</a>
	</nav>
</header>

{@render children()}

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		background-color: #121214;
		color: #e4e4e7;
		font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
	}

	.app-header {
		display: flex;
		align-items: center;
		background-color: #18181b;
		border-bottom: 1px solid #27272a;
		padding: 0.5rem 1rem;
		padding-top: max(0.5rem, env(safe-area-inset-top));
		padding-left: max(1rem, env(safe-area-inset-left));
		padding-right: max(1rem, env(safe-area-inset-right));
		height: 32px;
		box-sizing: content-box;
	}

	.app-nav {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex: 1 1 auto;
		min-width: 0;
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: none;
	}

	.app-nav::-webkit-scrollbar {
		display: none;
	}

	.dev-nav {
		display: flex;
		align-items: center;
		flex: 0 0 auto;
		margin-left: 0.75rem;
		padding-left: 0.75rem;
		border-left: 1px solid #27272a;
	}

	.dev-link {
		font-size: 0.75rem;
		color: #71717a;
	}

	.nav-link {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		color: #a1a1aa;
		text-decoration: none;
		white-space: nowrap;
		font-size: 0.875rem;
		font-weight: 500;
		padding: 0.35rem 0.75rem;
		border-radius: 4px;
		transition: background-color 0.15s ease, color 0.15s ease;
		touch-action: manipulation;
	}

	.nav-link:hover {
		color: #f4f4f5;
		background-color: #27272a;
	}

	.nav-link:focus-visible {
		outline: 2px solid #3b82f6;
		outline-offset: 1px;
	}

	.nav-link.active {
		color: #ffffff;
		background-color: #27272a;
		font-weight: 600;
	}

	@media (max-width: 640px) {
		.app-header {
			height: auto;
			padding-top: max(0.6rem, env(safe-area-inset-top));
			padding-bottom: 0.6rem;
		}

		.nav-link {
			min-height: 2.75rem;
			padding: 0.5rem 0.85rem;
		}
	}
</style>
