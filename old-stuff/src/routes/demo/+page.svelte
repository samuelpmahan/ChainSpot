<script lang="ts">
	/**
	 * `/demo` — the guided walkthrough cover page.
	 *
	 * The page a prospective customer is sent. It explains the pipeline, names
	 * the real course whose real screenshots drive it, and then gets out of the
	 * way: "Start the walkthrough" loads those screenshots and drops the visitor
	 * into the actual Stitch Map route with the guide rail alongside.
	 *
	 * This route renders no product surface of its own. There is no simulated
	 * canvas, no recorded video, no screenshot of the app pretending to be the
	 * app — every claim made here is verified by the visitor a click later, in
	 * the real thing, on real data.
	 */
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { armDemoStep } from '$lib/demo/arming';
	import { DEMO_DATASET, DEMO_STEPS, demoRouteLabel, demoStepUrl } from '$lib/demo/catalog';
	import { demoTour } from '$lib/demo/tour.svelte';

	let starting = $state(false);
	let startError = $state<string | null>(null);

	async function startAt(stepIndex: number): Promise<void> {
		if (starting) return;
		starting = true;
		startError = null;
		try {
			const step = demoTour.start(stepIndex);
			const result = await armDemoStep(step);
			// A failed asset load is never a reason to strand the visitor on the
			// cover page: the route works perfectly well with their own files, and
			// the guide rail can retry the load from there.
			if (!result.ok) startError = result.message;
			await goto(demoStepUrl(step));
		} finally {
			starting = false;
		}
	}
</script>

<svelte:head>
	<title>Product walkthrough | ChainSpot</title>
	<meta
		name="description"
		content="A guided walkthrough of ChainSpot using real UDisc captures of a real disc golf course, run against the real product."
	/>
</svelte:head>

<main class="demo-cover" data-testid="demo-cover">
	<section class="hero">
		<p class="eyebrow">Guided walkthrough</p>
		<h1>From four phone screenshots to broadcast-ready hole graphics</h1>
		<p class="hero-lede">
			ChainSpot turns the round map a player already has on their phone into reusable, on-air hole
			graphics on a clean aerial basemap. This walkthrough runs that whole pipeline in front of you
			— in the real application, on real captures of a real course.
		</p>
		<div class="hero-actions">
			<button
				type="button"
				class="primary"
				data-testid="demo-start"
				disabled={starting}
				onclick={() => startAt(0)}
			>
				{starting ? 'Loading the course…' : 'Start the walkthrough'}
			</button>
			<a class="secondary" href="{base}/stitch-map">Skip the tour, open the app</a>
		</div>
		{#if startError}
			<p class="error" data-testid="demo-start-error" role="alert">{startError}</p>
		{/if}
	</section>

	<section class="dataset" aria-labelledby="dataset-heading">
		<div class="dataset-copy">
			<h2 id="dataset-heading">What you will be working with</h2>
			<p>
				<strong>{DEMO_DATASET.courseName}</strong>, {DEMO_DATASET.cityState} —
				{DEMO_DATASET.holeCount} holes, captured as {DEMO_DATASET.captures.length} phone screenshots
				at a single fixed zoom, covering the property as a 2×2 grid.
			</p>
			<p>
				The capture files carry no grid position in their names and are not handed over in reading
				order. Whatever arrangement you see on the next screen, the product worked it out from the
				pixels while you watched.
			</p>
			<p>
				Partway through, the walkthrough reloads the browser on purpose — everything in this tab's
				memory disappears — and then annotates a second, real capture of the same course: a round
				actually played on it, with UDisc's own landing droplets and walking path already in the
				screenshot. What comes back after the reload is exactly what a real visit two days later
				would have: the course, remembered, nothing else.
			</p>
			<p class="fine">
				The clean basemap is not shipped with this demo. You will pull it live from public USGS
				aerial imagery, the same way a customer would, once before the reload and once after.
			</p>
		</div>
	</section>

	<section class="steps" aria-labelledby="steps-heading">
		<h2 id="steps-heading">The six steps</h2>
		<ol class="step-list" data-testid="demo-step-list">
			{#each DEMO_STEPS as step, index (step.id)}
				<li class="step-card">
					<div class="step-head">
						<span class="step-index">{index + 1}</span>
						<div>
							<h3>{step.title}</h3>
							<p class="step-route">{demoRouteLabel(step.route)}</p>
						</div>
					</div>
					<p class="step-lede">{step.lede}</p>
					<p class="step-mechanism">{step.mechanism}</p>
					<button
						type="button"
						class="step-start"
						data-testid="demo-start-step-{step.id}"
						disabled={starting}
						onclick={() => startAt(index)}
					>
						Start here
					</button>
				</li>
			{/each}
		</ol>
	</section>

	<section class="promises" aria-labelledby="promises-heading">
		<h2 id="promises-heading">What this demo is not doing</h2>
		<ul>
			<li>
				<strong>Not a mock.</strong> Every step navigates to a production route. There is no demo-only
				canvas, no scripted animation, and no pre-baked result.
			</li>
			<li>
				<strong>Not uploading anything.</strong> Images are decoded and processed in your browser. There
				is no ChainSpot server, so your captures cannot reach one.
			</li>
			<li>
				<strong>Not faking the map data.</strong> Course search calls OpenStreetMap Nominatim and the
				aerial comes from the USGS NAIP imagery service, live, from your browser.
			</li>
			<li>
				<strong>Not locking you in.</strong> Leave the tour whenever you like: the project stays loaded
				and you can carry straight on with your own course. Saved work is a portable zip you own.
			</li>
		</ul>
		<p class="fine">
			Aerial imagery courtesy of USGS NAIP (public domain). Course search results © OpenStreetMap
			contributors.
		</p>
	</section>
</main>

<style>
	.demo-cover {
		max-width: 62rem;
		margin: 0 auto;
		padding: 2rem 1.25rem 4rem;
		display: flex;
		flex-direction: column;
		gap: 2.75rem;
		color: #e4e4e7;
		line-height: 1.55;
	}

	.eyebrow {
		margin: 0 0 0.5rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		font-size: 0.75rem;
		font-weight: 700;
		color: #60a5fa;
	}

	h1 {
		margin: 0 0 0.75rem;
		font-size: clamp(1.75rem, 4vw, 2.5rem);
		line-height: 1.15;
		color: #fafafa;
	}

	.hero-lede {
		margin: 0 0 1.25rem;
		max-width: 46rem;
		font-size: 1.05rem;
		color: #d4d4d8;
	}

	.hero-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: center;
	}

	button,
	a.secondary {
		font: inherit;
		border-radius: 6px;
		border: 1px solid #3f3f46;
		background-color: #27272a;
		color: #e4e4e7;
		padding: 0.55rem 0.95rem;
		cursor: pointer;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
	}

	button:hover:not(:disabled),
	a.secondary:hover {
		background-color: #3f3f46;
	}

	button:disabled {
		opacity: 0.55;
		cursor: default;
	}

	button:focus-visible,
	a.secondary:focus-visible {
		outline: 2px solid #3b82f6;
		outline-offset: 1px;
	}

	button.primary {
		background-color: #2563eb;
		border-color: #2563eb;
		color: #ffffff;
		font-weight: 600;
		padding: 0.65rem 1.15rem;
	}

	button.primary:hover:not(:disabled) {
		background-color: #1d4ed8;
	}

	.error {
		margin: 0.85rem 0 0;
		padding: 0.5rem 0.7rem;
		border-radius: 6px;
		background-color: #7f1d1d;
		color: #fee2e2;
	}

	h2 {
		margin: 0 0 0.75rem;
		font-size: 1.25rem;
		color: #fafafa;
	}

	.dataset-copy {
		max-width: 46rem;
	}

	.dataset p {
		margin: 0 0 0.75rem;
		color: #d4d4d8;
	}

	.fine {
		font-size: 0.85rem;
		color: #a1a1aa;
	}

	.step-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
		gap: 1rem;
	}

	.step-card {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		background-color: #18181b;
		border: 1px solid #27272a;
		border-radius: 8px;
		padding: 1rem;
	}

	.step-head {
		display: flex;
		gap: 0.75rem;
		align-items: flex-start;
	}

	.step-index {
		flex: 0 0 auto;
		width: 1.85rem;
		height: 1.85rem;
		border-radius: 999px;
		background-color: #2563eb;
		color: #ffffff;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.step-card h3 {
		margin: 0;
		font-size: 1rem;
		color: #fafafa;
		line-height: 1.3;
	}

	.step-route {
		margin: 0.15rem 0 0;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #71717a;
	}

	.step-lede {
		margin: 0;
		color: #d4d4d8;
		font-size: 0.9rem;
	}

	.step-mechanism {
		margin: 0;
		color: #a1a1aa;
		font-size: 0.82rem;
	}

	.step-start {
		align-self: flex-start;
		margin-top: auto;
		padding: 0.4rem 0.75rem;
		font-size: 0.85rem;
	}

	.promises ul {
		margin: 0 0 0.9rem;
		padding-left: 1.15rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		color: #d4d4d8;
	}

</style>
