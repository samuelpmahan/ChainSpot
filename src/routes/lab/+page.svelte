<script lang="ts">
	// LAB gate scrubber — dev tooling, not product UI. Load ANY image, run the
	// local threeFactor pipeline, and step through the sweep gates with the
	// same vocabulary as the CLI: G1 Badges -> G2 Baskets -> G3 Tees ->
	// G4 Tee->Badge -> G5 Path. Arrow keys scrub.
	import { rgbaFromFile } from '$lib/rgba';
	import type { ThreeFactorRun } from '$lib/detectors/threeFactor';

	const GATES = [
		{ id: 'G1', name: 'Badges', note: 'bright-family + dark-plate recovery; label + candidates' },
		{ id: 'G2', name: 'Baskets', note: 'sprite matches; tip marks the route endpoint' },
		{ id: 'G3', name: 'Tees', note: 'ring/component/recovered tiers; axis where known' },
		{ id: 'G4', name: 'Tee→Badge', note: 'one-to-one tee→badge ownership — no basket knowledge' },
		{ id: 'G5', name: 'Path', note: 'known tee → known badge → candidate basket, recovered route' }
	] as const;

	let imgUrl = $state<string | null>(null);
	let imgName = $state('');
	let run = $state<ThreeFactorRun | null>(null);
	let busy = $state<string | null>(null);
	let gate = $state(0);
	let runMs = $state(0);
	let elapsedS = $state(0);
	let worker: Worker | null = null;
	let ticker: ReturnType<typeof setInterval> | null = null;

	function stopTicker() {
		if (ticker) clearInterval(ticker);
		ticker = null;
	}

	async function onFile(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		if (imgUrl) URL.revokeObjectURL(imgUrl);
		imgUrl = URL.createObjectURL(file);
		imgName = file.name;
		run = null;
		worker?.terminate();
		stopTicker();
		busy = 'Rasterizing…';
		try {
			const raster = await rgbaFromFile(file);
			busy = 'Running threeFactor in worker…';
			elapsedS = 0;
			ticker = setInterval(() => elapsedS++, 1000);
			worker = new Worker(new URL('./threeFactor.worker.ts', import.meta.url), {
				type: 'module'
			});
			worker.onmessage = (msg: MessageEvent) => {
				stopTicker();
				if (msg.data.ok) {
					run = msg.data.run as ThreeFactorRun;
					runMs = msg.data.ms;
					busy = null;
					gate = 0;
				} else {
					busy = `Failed: ${msg.data.error}`;
				}
			};
			worker.onerror = (e) => {
				stopTicker();
				busy = `Worker error: ${e.message}`;
			};
			worker.postMessage(raster);
		} catch (e) {
			stopTicker();
			busy = `Failed: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	function onKey(event: KeyboardEvent) {
		if (event.key === 'ArrowRight') gate = Math.min(GATES.length - 1, gate + 1);
		else if (event.key === 'ArrowLeft') gate = Math.max(0, gate - 1);
		else return;
		event.preventDefault();
	}

	let m = $derived(run?.measurement ?? null);
	let a = $derived(run?.assignment ?? null);

	function byId<T extends { detId: string }>(list: readonly T[], id: string): T | undefined {
		return list.find((x) => x.detId === id);
	}
	function pairFor(badgeId: string, teeId: string, basketId: string) {
		return m?.rawPairs.find(
			(p) => p.badgeId === badgeId && p.teeId === teeId && p.basketId === basketId
		);
	}
	function poly(path: readonly (readonly [number, number])[]): string {
		return path.map(([x, y]) => `${x},${y}`).join(' ');
	}

	let counts = $derived(
		m
			? {
					badges: m.badges.length,
					baskets: m.baskets.length,
					tees: a?.tees.length ?? m.tees.length,
					owned: a?.assignments.length ?? 0,
					pairs: m.rawPairs.length
				}
			: null
	);
</script>

<svelte:window onkeydown={onKey} />

<div style="display: flex; gap: 1rem; align-items: baseline; flex-wrap: wrap;">
	<h1 style="margin: 0.25rem 0; font-size: 1.4rem;">LAB · gate scrubber</h1>
	<input type="file" accept="image/*" onchange={onFile} />
	{#if busy}<strong>{busy} {elapsedS > 0 ? `(${elapsedS}s)` : ''}</strong>{/if}
	{#if run}<span>{imgName} · ran in {runMs}ms</span>{/if}
	<a href="/">← Import Data</a>
</div>

{#if run && m}
	<div style="display: flex; gap: 0.75rem; align-items: center; margin: 0.4rem 0;">
		<button onclick={() => (gate = Math.max(0, gate - 1))} disabled={gate === 0}>◀</button>
		{#each GATES as g, i (g.id)}
			<button
				onclick={() => (gate = i)}
				style={i === gate ? 'font-weight: bold; outline: 2px solid black;' : ''}
			>
				{g.id} {g.name}
			</button>
		{/each}
		<button onclick={() => (gate = Math.min(GATES.length - 1, gate + 1))} disabled={gate === GATES.length - 1}>▶</button>
		<em>{GATES[gate].note}</em>
	</div>
	<div style="font-family: monospace; font-size: 13px; margin-bottom: 0.3rem;">
		badges {counts?.badges} · baskets {counts?.baskets} · tees {counts?.tees} · owned {counts?.owned} · raw pairs {counts?.pairs}
	</div>

	<svg
		viewBox={`0 0 ${m.widthPx} ${m.heightPx}`}
		style="width: 100%; max-height: 82vh; border: 1px solid black; background: #111;"
		role="img"
		aria-label="Gate overlay"
	>
		<image href={imgUrl} width={m.widthPx} height={m.heightPx} />

		{#if gate >= 0}
			{#each m.badges as b (b.detId)}
				<rect
					x={b.bbox[0]}
					y={b.bbox[1]}
					width={b.bbox[2]}
					height={b.bbox[3]}
					fill="none"
					stroke="gold"
					stroke-width={gate === 0 ? 3 : 1.2}
					opacity={gate === 0 ? 1 : 0.55}
				/>
				{#if gate === 0}
					<text x={b.bbox[0]} y={b.bbox[1] - 6} fill="gold" font-size="20" font-family="monospace">
						{b.label ?? '?'} ({b.confidence.toFixed(2)}{b.source === 'dark-plate-recovery' ? ' R' : ''})
					</text>
				{/if}
			{/each}
		{/if}

		{#if gate >= 1}
			{#each m.baskets as k (k.detId)}
				<rect
					x={k.bbox[0]}
					y={k.bbox[1]}
					width={k.bbox[2]}
					height={k.bbox[3]}
					fill="none"
					stroke="#ff5555"
					stroke-width={gate === 1 ? 3 : 1.2}
					opacity={gate === 1 ? 1 : 0.55}
				/>
				<circle cx={k.tipXPx} cy={k.tipYPx} r={gate === 1 ? 5 : 3} fill="#ff5555" />
				{#if gate === 1}
					<text x={k.bbox[0]} y={k.bbox[1] - 6} fill="#ff5555" font-size="18" font-family="monospace">
						{k.score.toFixed(2)}
					</text>
				{/if}
			{/each}
		{/if}

		{#if gate >= 2 && a}
			{#each a.tees as t (t.detId)}
				<circle
					cx={t.xPx}
					cy={t.yPx}
					r={gate === 2 ? 9 : 5}
					fill="none"
					stroke={t.tier === 'ring' ? '#4fd1ff' : t.tier === 'component' ? '#9fd14f' : '#ff9f4f'}
					stroke-width={gate === 2 ? 3 : 1.5}
				/>
				{#if t.angleRad !== null && gate === 2}
					<line
						x1={t.xPx - Math.cos(t.angleRad) * 30}
						y1={t.yPx - Math.sin(t.angleRad) * 30}
						x2={t.xPx + Math.cos(t.angleRad) * 30}
						y2={t.yPx + Math.sin(t.angleRad) * 30}
						stroke="#4fd1ff"
						stroke-width="2"
					/>
				{/if}
				{#if gate === 2}
					<text x={t.xPx + 12} y={t.yPx + 5} fill="#4fd1ff" font-size="16" font-family="monospace">{t.tier}</text>
				{/if}
			{/each}
		{/if}

		{#if gate >= 3 && a}
			{#each a.assignments as own (own.badgeId + own.teeId)}
				{@const badge = byId(m.badges, own.badgeId)}
				{@const tee = byId(a.tees, own.teeId)}
				{#if badge && tee}
					<line
						x1={tee.xPx}
						y1={tee.yPx}
						x2={badge.cxPx}
						y2={badge.cyPx}
						stroke="#7CFC00"
						stroke-width={gate === 3 ? 3.5 : 1.5}
						opacity={gate === 3 ? 0.95 : 0.5}
					/>
					{#if gate === 3}
						<text
							x={(tee.xPx + badge.cxPx) / 2 + 6}
							y={(tee.yPx + badge.cyPx) / 2}
							fill="#7CFC00"
							font-size="18"
							font-family="monospace">{badge.label ?? '?'} · {own.score.toFixed(2)}</text
						>
					{/if}
				{/if}
			{/each}
		{/if}

		{#if gate === 4 && a}
			{#each a.assignments as own (own.badgeId + own.basketId)}
				{@const pair = pairFor(own.badgeId, own.teeId, own.basketId)}
				{@const badge = byId(m.badges, own.badgeId)}
				{#if pair}
					<polyline
						points={poly(pair.teeLeg.path)}
						fill="none"
						stroke="#ffa500"
						stroke-width="3"
						opacity="0.9"
					/>
					<polyline
						points={poly(pair.basketLeg.path)}
						fill="none"
						stroke="#00bfff"
						stroke-width="3"
						opacity="0.9"
					/>
					{#if badge}
						<text
							x={badge.cxPx + 14}
							y={badge.cyPx - 12}
							fill="#ffa500"
							font-size="16"
							font-family="monospace"
						>
							{badge.label ?? '?'} min{pair.supportMin.toFixed(2)} eff{pair.efficiency.toFixed(2)}
							{pair.failureReason ? '⚠' + pair.failureReason : ''}
						</text>
					{/if}
				{/if}
			{/each}
		{/if}
	</svg>
	{#if gate === 4 && a && a.assignments.length === 0}
		<p><strong>No assignments — nothing to route.</strong></p>
	{/if}
{:else if !busy}
	<p>Pick any screenshot. The whole pipeline runs locally; arrows or buttons scrub the gates.</p>
{/if}
