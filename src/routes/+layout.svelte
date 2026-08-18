<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { base } from '$app/paths';
	import DemoGuide from '$lib/components/DemoGuide.svelte';
	import WorkflowKeyboardAffordances from '$lib/components/WorkflowKeyboardAffordances.svelte';
	import { annotationNavState, requestAnnotationDone } from '$lib/annotationNav.svelte';
	import { installVisionFlagConsole } from '$lib/autoAnnotation/visionFlags';

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
		installVisionFlagConsole();
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
			href="{base}/annotate-course"
			class="nav-link"
			class:active={page.url.pathname === `${base}/annotate-course` || page.url.pathname === `${base}/`}
			aria-current={page.url.pathname === `${base}/annotate-course` || page.url.pathname === `${base}/` ? 'page' : undefined}
		>
			Annotate Course
		</a>
		<a
			href="{base}/map-round"
			class="nav-link"
			class:active={page.url.pathname === `${base}/map-round`}
			aria-current={page.url.pathname === `${base}/map-round` ? 'page' : undefined}
		>
			Map Round
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
			href="{base}/demo"
			class="nav-link"
			class:active={page.url.pathname === `${base}/demo`}
			aria-current={page.url.pathname === `${base}/demo` ? 'page' : undefined}
		>
			Demo
		</a>
		{#if annotationNavState.active}
			<span class="app-nav-divider" aria-hidden="true"></span>
			<div class="global-annotation-controls">
				<button
					type="button"
					class="global-done-button"
					data-testid="annotate-done"
					data-demo-anchor="annotation-done"
					disabled={!annotationNavState.canFinish || annotationNavState.doneRunning}
					onclick={requestAnnotationDone}
					title="Finish annotating and move to Create Graphics"
				>
					Done
				</button>
			</div>
		{/if}
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

<!--
	Centralized keyboard affordances that delegate to each route's existing
	buttons/state transitions instead of duplicating their business logic.
-->
<WorkflowKeyboardAffordances />

<!--
	The walkthrough rail lives in the layout, not in any one route, so a tour
	survives client-side navigation between the stages it walks through. It
	renders nothing unless a tour is running.
-->
<DemoGuide />

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

	.app-nav-divider {
		flex: 0 0 auto;
		height: 2rem;
		margin: 0 0.25rem;
		border-left: 1px solid #27272a;
	}

	.global-annotation-controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 0 0 auto;
	}

	.global-done-button:focus-visible {
		outline: 2px solid #60a5fa;
		outline-offset: 1px;
	}

	.global-done-button {
		min-height: 2.65rem;
		padding: 0.45rem 0.85rem;
		border: 1px solid #2563eb;
		border-radius: 6px;
		background: #2563eb;
		color: #fff;
		font-size: 0.8rem;
		font-weight: 650;
		cursor: pointer;
	}

	.global-done-button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
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
