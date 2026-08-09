<script lang="ts">
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
		<a
			href="/ribbon-editor"
			class="nav-link"
			class:active={page.url.pathname === '/ribbon-editor'}
			aria-current={page.url.pathname === '/ribbon-editor' ? 'page' : undefined}
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
		height: 32px;
		box-sizing: content-box;
	}

	.app-nav {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.nav-link {
		color: #a1a1aa;
		text-decoration: none;
		font-size: 0.875rem;
		font-weight: 500;
		padding: 0.35rem 0.75rem;
		border-radius: 4px;
		transition: background-color 0.15s ease, color 0.15s ease;
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
</style>
