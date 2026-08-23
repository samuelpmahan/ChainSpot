<script lang="ts">
	// LAB gate scrubber — dev tooling, not product UI. Load ANY image, run the
	// local threeFactor pipeline, and step through the sweep gates with the
	// same vocabulary as the CLI: G1 Badges -> G2 Baskets -> G3 Tees ->
	// G4 Tee->Badge -> G5 Path. Arrow keys scrub.
	import { rgbaFromFile } from '$lib/rgba';
	import { rasterFromFile, cropRaster, type CropInsets } from '$lib/raster';
	import { proposeSharedCrop } from '$lib/autoCrop';
	import { findBestTranslation } from '$lib/stitch';
	import { labEndpointDetector } from '$lib/detectors/labEndpoint';
	import { purpleMassDetector } from '$lib/detectors/purpleMass';
	import type { RgbaRaster, DetectorEmission } from '$lib/detect';
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

	function startWorker(raster: RgbaRaster) {
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
	}

	function badgeCenters(emitted: DetectorEmission[]): Map<number, { x: number; y: number }> {
		const labels = new Map(emitted.filter((e) => e.kind === 'label').map((e) => [e.detId, e.n]));
		const out = new Map<number, { x: number; y: number }>();
		for (const e of emitted) {
			if (e.kind !== 'object' || e.objType !== 'hole-badge') continue;
			const n = labels.get(e.detId);
			if (n !== undefined && !out.has(n)) out.set(n, { x: e.xPx, y: e.yPx });
		}
		return out;
	}

	// Multi-image: autocrop -> stitch (badges first, pixel fallback) -> flatten
	// to the CANONICAL post-stitch composite -> threeFactor on the composite.
	// The thrown round (purple mass) is held OUT — it is not course chrome and
	// would pixel-chain into nonsense.
	async function buildComposite(files: File[], rgbas: RgbaRaster[]): Promise<RgbaRaster> {
		busy = 'AutoCrop…';
		const grays = await Promise.all(files.map(rasterFromFile));
		const insets: CropInsets = proposeSharedCrop(grays) ?? { top: 0, right: 0, bottom: 0, left: 0 };

		busy = 'Badge pass for semantic stitch…';
		const centers: Map<number, { x: number; y: number }>[] = [];
		for (const r of rgbas) {
			const emitted: DetectorEmission[] = [];
			await labEndpointDetector(r, (e) => emitted.push(e));
			centers.push(badgeCenters(emitted));
		}

		busy = 'Stitching…';
		const cropped = grays.map((g) => cropRaster(g, insets));
		const placements = [{ x: 0, y: 0 }];
		for (let i = 1; i < files.length; i++) {
			const offsets: { dx: number; dy: number }[] = [];
			for (const [n, p] of centers[i]) {
				const anchor = centers[0].get(n);
				if (anchor) offsets.push({ dx: anchor.x - p.x, dy: anchor.y - p.y });
			}
			if (offsets.length > 0) {
				offsets.sort((a, b) => a.dx - b.dx);
				const dx = offsets[(offsets.length / 2) | 0].dx;
				offsets.sort((a, b) => a.dy - b.dy);
				const dy = offsets[(offsets.length / 2) | 0].dy;
				placements.push({ x: dx, y: dy });
			} else {
				const off = findBestTranslation(cropped[i - 1], cropped[i]);
				placements.push(
					off
						? { x: placements[i - 1].x + off.dx, y: placements[i - 1].y + off.dy }
						: { x: placements[i - 1].x + cropped[i - 1].widthPx + 40, y: placements[i - 1].y }
				);
			}
		}

		busy = 'Flattening composite…';
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		placements.forEach((p, i) => {
			x0 = Math.min(x0, p.x);
			y0 = Math.min(y0, p.y);
			x1 = Math.max(x1, p.x + cropped[i].widthPx);
			y1 = Math.max(y1, p.y + cropped[i].heightPx);
		});
		const w = Math.ceil(x1 - x0);
		const h = Math.ceil(y1 - y0);
		const canvas = new OffscreenCanvas(w, h);
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('no 2d context');
		for (let i = 0; i < files.length; i++) {
			const bitmap = await createImageBitmap(files[i]);
			ctx.drawImage(
				bitmap,
				insets.left,
				insets.top,
				cropped[i].widthPx,
				cropped[i].heightPx,
				Math.round(placements[i].x - x0),
				Math.round(placements[i].y - y0),
				cropped[i].widthPx,
				cropped[i].heightPx
			);
			bitmap.close();
		}
		const blob = await canvas.convertToBlob({ type: 'image/png' });
		if (imgUrl) URL.revokeObjectURL(imgUrl);
		imgUrl = URL.createObjectURL(blob);
		const { data } = ctx.getImageData(0, 0, w, h);
		return { imageId: 'composite-' + Date.now().toString(16).padStart(64, '0'), widthPx: w, heightPx: h, rgba: data };
	}

	let heldOut = $state('');

	async function onFile(event: Event) {
		const files = Array.from((event.currentTarget as HTMLInputElement).files ?? []);
		if (files.length === 0) return;
		run = null;
		heldOut = '';
		worker?.terminate();
		stopTicker();
		try {
			if (files.length === 1) {
				if (imgUrl) URL.revokeObjectURL(imgUrl);
				imgUrl = URL.createObjectURL(files[0]);
				imgName = files[0].name;
				busy = 'Rasterizing…';
				startWorker(await rgbaFromFile(files[0]));
				return;
			}
			busy = 'Classifying (purple mass)…';
			const rgbas = await Promise.all(files.map(rgbaFromFile));
			const tiles: { file: File; rgba: RgbaRaster }[] = [];
			const held: string[] = [];
			for (let i = 0; i < files.length; i++) {
				let thrownScore = 0;
				await purpleMassDetector(rgbas[i], (e) => {
					if (e.kind === 'classification' && e.trait === 'thrown-round') thrownScore = e.confidence;
				});
				if (thrownScore > 0) held.push(files[i].name);
				else tiles.push({ file: files[i], rgba: rgbas[i] });
			}
			heldOut = held.join(', ');
			if (tiles.length === 0) {
				busy = 'Every file classified as thrown round — nothing to stitch.';
				return;
			}
			if (tiles.length === 1) {
				if (imgUrl) URL.revokeObjectURL(imgUrl);
				imgUrl = URL.createObjectURL(tiles[0].file);
				imgName = tiles[0].file.name;
				startWorker(tiles[0].rgba);
				return;
			}
			imgName = tiles.map((t) => t.file.name).join(' + ');
			const composite = await buildComposite(
				tiles.map((t) => t.file),
				tiles.map((t) => t.rgba)
			);
			startWorker(composite);
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
	<input type="file" accept="image/*" multiple onchange={onFile} />
	{#if busy}<strong>{busy} {elapsedS > 0 ? `(${elapsedS}s)` : ''}</strong>{/if}
	{#if run}<span>{imgName} · ran in {runMs}ms</span>{/if}
	{#if heldOut}<span style="color: #849;">held out (thrown round): {heldOut}</span>{/if}
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
