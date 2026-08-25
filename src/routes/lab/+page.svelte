<script lang="ts">
	// LAB gate scrubber — dev tooling, not product UI. Load ANY image, run the
	// local threeFactor pipeline, and step through the sweep gates with the
	// same vocabulary as the CLI: G1 Badges -> G2 Baskets -> G3 Tees ->
	// G4 Tee->Badge -> G5 Path. Arrow keys scrub.
	import { rgbaFromFile } from '$lib/rgba';
	import { rasterFromFile } from '$lib/raster';
	import { cropRaster, type CropInsets } from '@chainspot/alg';
	import {
		DEFAULT_EXECUTION,
		canonicalJson,
		parseConfig,
		resolveConfig,
		sha256Hex,
		type ResolvedConfig,
		type RunTrace
	} from '@chainspot/alg/detectors/threeFactor';
	import defaultConfigJson from '@chainspot/alg/detectors/threeFactor/configs/default.json';
	import TracePanel from './TracePanel.svelte';
	import CommandHistory, { type HistoryEntry } from './CommandHistory.svelte';
	import { proposeSharedCrop } from '@chainspot/alg/autoCrop';
	import { findBestTranslation } from '@chainspot/alg/stitch';
	import { labEndpointDetector } from '@chainspot/alg/detectors/labEndpoint';
	import { purpleMassDetector } from '@chainspot/alg/detectors/purpleMass';
	import type { RgbaRaster, DetectorEmission } from '@chainspot/alg/detect';
	import type { ThreeFactorRun } from '@chainspot/alg/detectors/threeFactor';

	// `cli` is the id `lab gates N` takes, and it is NOT the digit in `id`.
	// Two numberings coexist in this repo and they disagree:
	//   - GateId in packages/alg (G1..G5) — what these buttons show, what the
	//     trace units carry, what dashsTrackSweep calls G1..G4.
	//   - the `lab gates` registry (0..7) — a longer pipeline that also numbers
	//     Crop+Stitch (0), Endpoint Recovery (4) and Bend Refinement (7).
	// So alg G4 (ownership) is registry 6 Assignment, and registry 4 is a
	// different stage entirely. Echoing `cli` is what makes the copied line
	// actually run; `cliName` is shown beside it so the offset is visible
	// rather than something you rediscover by pasting the wrong number.
	const GATES = [
		{ id: 'G1', name: 'Badges', cli: 1, cliName: 'Badges', note: 'bright-family + dark-plate recovery; label + candidates' },
		{ id: 'G2', name: 'Baskets', cli: 2, cliName: 'Baskets', note: 'sprite matches; tip marks the route endpoint' },
		{ id: 'G3', name: 'Tees', cli: 3, cliName: 'Tees', note: 'ring/component/recovered tiers; axis where known' },
		{ id: 'G4', name: 'Tee→Badge', cli: 6, cliName: 'Assignment', note: 'one-to-one tee→badge ownership — no basket knowledge' },
		{ id: 'G5', name: 'Path', cli: 5, cliName: 'Straight Test', note: 'known tee → known badge → candidate basket, recovered route' }
	] as const;

	// `lab compile --help` prints this exact path as its example.
	const DEFAULT_CONFIG_PATH = 'packages/alg/src/detectors/threeFactor/configs/default.json';

	// ---- command echo -------------------------------------------------------
	// Every UI action appends the LAB command that would have done the same
	// thing. Lines are what `lab run-script FILE` accepts: a real command, or a
	// `#` comment. An action with no CLI form echoes a `#` line saying so —
	// a silent click would be exactly the missing-consequence this panel exists
	// to remove.
	let history = $state<HistoryEntry[]>([
		{ cmd: '# LAB session recorded in the browser gate scrubber' },
		{ cmd: `compile ${DEFAULT_CONFIG_PATH}`, note: 'page load: frozen baseline is the starting config' }
	]);
	// the config token used by every `sweep` line; tracks the loaded config file
	let configArg = $state(DEFAULT_CONFIG_PATH);

	function echo(cmd: string, note?: string) {
		history = [...history, { cmd, note }];
	}

	// bin/lab.mjs splitCommandLine understands quotes and backslash escapes
	function arg(value: string): string {
		return /[\s"'\\]/.test(value) ? `"${value.replace(/(["\\])/g, '\\$1')}"` : value;
	}

	function clearHistory() {
		history = [{ cmd: '# cleared' }];
	}

	// Every checkbox in the layer row carries data-echo; one delegated change
	// handler covers show.*, the heatmap, and every per-unit trace toggle.
	function onViewToggle(event: Event) {
		const el = event.target as HTMLInputElement | null;
		if (!el || el.type !== 'checkbox' || !el.dataset.echo) return;
		echo(`# view-only: ${el.dataset.echo} ${el.checked ? 'on' : 'off'} (overlay state, no LAB command)`);
	}

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

	// engine config: default = frozen baseline; load any config JSON to deviate
	let labConfig = $state<ResolvedConfig>(resolveConfig(parseConfig(defaultConfigJson), DEFAULT_EXECUTION));
	let labParamsHash = $state('');
	let configError = $state<string | null>(null);
	let traceLayerShow = $state<Record<string, { accepted: boolean; rejected: boolean }>>({});
	let heatmapUrl = $state<string | null>(null);
	let heatmapShow = $state(false);
	let heatmapMeta = $state<{ x: number; y: number; w: number; h: number } | null>(null);

	async function hashConfig(resolved: ResolvedConfig): Promise<string> {
		return sha256Hex(canonicalJson(resolved));
	}

	$effect(() => {
		if (labParamsHash === '') {
			hashConfig(labConfig).then((hash) => (labParamsHash = hash));
		}
	});

	async function onConfigFile(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		try {
			const resolved = resolveConfig(parseConfig(JSON.parse(await file.text())), DEFAULT_EXECUTION);
			labConfig = resolved;
			labParamsHash = await hashConfig(resolved);
			configError = null;
			configArg = file.name;
			echo(
				`compile ${arg(file.name)}`,
				`${resolved.name} · paramsHash ${labParamsHash.slice(0, 12)}… · every sweep below uses it`
			);
		} catch (e) {
			configError = e instanceof Error ? e.message : String(e);
			echo(`# compile ${arg(file.name)} rejected: ${configError}`);
		}
	}

	function heatmapDataUrl(data: Float32Array, w: number, h: number): string {
		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx2d = canvas.getContext('2d');
		if (!ctx2d) return '';
		const img = ctx2d.createImageData(w, h);
		for (let i = 0; i < data.length; i++) {
			const v = Math.max(0, Math.min(1, data[i]));
			img.data[i * 4] = Math.round(255 * v);
			img.data[i * 4 + 1] = Math.round(160 * v);
			img.data[i * 4 + 2] = Math.round(255 * (1 - v));
			img.data[i * 4 + 3] = Math.round(60 + 140 * v);
		}
		ctx2d.putImageData(img, 0, 0);
		return canvas.toDataURL();
	}

	function onTraceArrived(trace: RunTrace) {
		const show: Record<string, { accepted: boolean; rejected: boolean }> = {};
		for (const unit of trace.units) {
			if (unit.drawables.length > 0) show[unit.id] = { accepted: false, rejected: false };
		}
		traceLayerShow = show;
		heatmapUrl = null;
		heatmapMeta = null;
		const field = trace.heatmaps['supportField'];
		const heatmapDrawable = trace.units
			.flatMap((u) => u.drawables)
			.find((d) => d.type === 'heatmap' && d.key === 'supportField');
		if (field && heatmapDrawable && heatmapDrawable.type === 'heatmap') {
			heatmapUrl = heatmapDataUrl(field, heatmapDrawable.widthCells, heatmapDrawable.heightCells);
			heatmapMeta = {
				x: heatmapDrawable.originXPx,
				y: heatmapDrawable.originYPx,
				w: heatmapDrawable.widthCells * heatmapDrawable.cellPx,
				h: heatmapDrawable.heightCells * heatmapDrawable.cellPx
			};
		}
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
				if (run.trace) onTraceArrived(run.trace);
			} else {
				busy = `Failed: ${msg.data.error}`;
			}
		};
		worker.onerror = (e) => {
			stopTicker();
			busy = `Worker error: ${e.message}`;
		};
		// $state proxies are not structured-cloneable — post a plain snapshot
		worker.postMessage({ raster, config: $state.snapshot(labConfig), paramsHash: labParamsHash });
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
		// GAP-CLOSED (CHSPT-82 Sprint 1 Chunk B): this Date.now() imageId
		// fabrication is no longer the only option — @chainspot/alg/g0/composite
		// (materializeComposite) now does this same flatten as pure, headless
		// array math with a real content-addressed imageId (sha256 over
		// [u32be width][u32be height][raw RGBA]). Not wired in here: this
		// chunk's app-rewiring priority was the Import page
		// (src/routes/+page.svelte), and /lab is a separate, lower-priority
		// path. Left as a pointer rather than touched, per that chunk's scope.
		return { imageId: 'composite-' + Date.now().toString(16).padStart(64, '0'), widthPx: w, heightPx: h, rgba: data };
	}

	let heldOut = $state('');
	// The image token a `scope` line can name. A stitched composite exists only
	// in this tab, so it is null and clicks say that instead of naming a file
	// that is not on disk.
	let scopeTarget = $state<string | null>(null);

	// `lab sweep` is the only LAB command that executes the algorithm plan, so
	// loading an image here IS a sweep. Echo exactly the inputs that reached it.
	function echoSweep(names: string[], held: string[]) {
		for (const name of held) echo(`# held out (thrown round, purple mass): ${name} — not passed to sweep`);
		echo(
			`sweep ${configArg} ${names.map(arg).join(' ')}`,
			names.length > 1 ? 'multi-tile: sweep does StripChrome → AutoStitch → algorithm' : undefined
		);
	}

	async function onFile(event: Event) {
		const files = Array.from((event.currentTarget as HTMLInputElement).files ?? []);
		if (files.length === 0) return;
		run = null;
		heldOut = '';
		scopeTarget = null;
		worker?.terminate();
		stopTicker();
		try {
			if (files.length === 1) {
				if (imgUrl) URL.revokeObjectURL(imgUrl);
				imgUrl = URL.createObjectURL(files[0]);
				imgName = files[0].name;
				scopeTarget = files[0].name;
				echoSweep([files[0].name], []);
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
				for (const name of held) echo(`# held out (thrown round, purple mass): ${name}`);
				echo('# nothing left to sweep');
				return;
			}
			if (tiles.length === 1) {
				if (imgUrl) URL.revokeObjectURL(imgUrl);
				imgUrl = URL.createObjectURL(tiles[0].file);
				imgName = tiles[0].file.name;
				scopeTarget = tiles[0].file.name;
				echoSweep([tiles[0].file.name], held);
				startWorker(tiles[0].rgba);
				return;
			}
			imgName = tiles.map((t) => t.file.name).join(' + ');
			echoSweep(tiles.map((t) => t.file.name), held);
			const composite = await buildComposite(
				tiles.map((t) => t.file),
				tiles.map((t) => t.rgba)
			);
			startWorker(composite);
		} catch (e) {
			stopTicker();
			busy = `Failed: ${e instanceof Error ? e.message : String(e)}`;
			echo(`# sweep failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// layer toggles — the gate stepper is just a preset that sets these
	let show = $state({ badges: true, baskets: false, tees: false, ownership: false, path: false });

	function setGate(i: number) {
		// clicking the current gate still re-applies its layer preset (the old
		// behavior); it just is not a move, so it echoes nothing — which also
		// keeps a held arrow key at either end from spamming the panel
		const moved = i !== gate;
		gate = i;
		show = { badges: i >= 0, baskets: i >= 1, tees: i >= 2, ownership: i >= 3, path: i >= 4 };
		const g = GATES[i];
		if (moved) echo(`gates ${g.cli}`, `UI ${g.id} ${g.name} = registry gate ${g.cli} ${g.cliName}`);
	}

	function onKey(event: KeyboardEvent) {
		if (event.key === 'ArrowRight') setGate(Math.min(GATES.length - 1, gate + 1));
		else if (event.key === 'ArrowLeft') setGate(Math.max(0, gate - 1));
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

	// Click any pixel of the overlay -> `scope IMAGE x,y`, the same stateless
	// raster inspection the CLI does. getScreenCTM inverts the viewBox fit, so
	// the coordinates are canonical raster pixels regardless of how the SVG is
	// letterboxed on screen — the same frame `lab scope` expects.
	function onScopeClick(event: MouseEvent) {
		const svg = event.currentTarget as SVGSVGElement;
		const ctm = svg.getScreenCTM();
		if (!ctm) return;
		const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
		const px = Math.round(p.x);
		const py = Math.round(p.y);
		// preserveAspectRatio letterboxes the raster inside the element, so the
		// margins are real clicks at coordinates that are not in the raster.
		// Emitting `scope IMAGE -9,150` would hand over a command that cannot
		// run; say what happened instead of fabricating an in-bounds pixel.
		if (!m || px < 0 || py < 0 || px >= m.widthPx || py >= m.heightPx) {
			echo(`# click at ${px},${py} falls outside the ${m ? `${m.widthPx}x${m.heightPx}` : 'canonical'} raster — no scope command`);
			return;
		}
		const at = `${px},${py}`;
		if (scopeTarget) echo(`scope ${arg(scopeTarget)} ${at}`);
		else echo(`# scope ${at} — canonical raster is the in-tab composite of ${imgName}; no file to name`);
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
	<label style="font-family: monospace; font-size: 12px;">
		config <input type="file" accept=".json,application/json" onchange={onConfigFile} />
	</label>
	<span style="font-family: monospace; font-size: 12px;">
		{labConfig.name}{labParamsHash ? ` · ${labParamsHash.slice(0, 12)}…` : ''}
	</span>
	{#if configError}<strong style="color: #a00;">config: {configError}</strong>{/if}
	<a href="/">← Import Data</a>
</div>

<CommandHistory entries={history} onclear={clearHistory} />

{#if imgUrl && !run}
	<!-- the input (or composite) stays visible while the worker crunches -->
	<img src={imgUrl} alt="processing" style="max-width: 100%; max-height: 78vh; border: 1px solid black; opacity: 0.75;" />
{/if}

{#if run && m}
	<div style="display: flex; gap: 0.75rem; align-items: center; margin: 0.4rem 0; flex-wrap: wrap;">
		<button onclick={() => setGate(Math.max(0, gate - 1))} disabled={gate === 0}>◀</button>
		{#each GATES as g, i (g.id)}
			<button
				onclick={() => setGate(i)}
				style={i === gate ? 'font-weight: bold; outline: 2px solid black;' : ''}
			>
				{g.id} {g.name}
			</button>
		{/each}
		<button onclick={() => setGate(Math.min(GATES.length - 1, gate + 1))} disabled={gate === GATES.length - 1}>▶</button>
		<em>{GATES[gate].note}</em>
	</div>
	<!-- one delegated change handler; every checkbox names itself via data-echo -->
	<div
		style="display: flex; gap: 1rem; margin: 0.2rem 0; font-family: monospace; font-size: 13px; flex-wrap: wrap;"
		onchange={onViewToggle}
	>
		<label><input type="checkbox" data-echo="badges" bind:checked={show.badges} /> badges</label>
		<label><input type="checkbox" data-echo="baskets" bind:checked={show.baskets} /> baskets</label>
		<label><input type="checkbox" data-echo="tees" bind:checked={show.tees} /> tees</label>
		<label><input type="checkbox" data-echo="tee→badge" bind:checked={show.ownership} /> tee→badge</label>
		<label><input type="checkbox" data-echo="paths" bind:checked={show.path} /> paths</label>
		{#if run?.trace}
			<span>| trace:</span>
			{#if heatmapUrl}
				<label><input type="checkbox" data-echo="support heatmap" bind:checked={heatmapShow} /> support heatmap</label>
			{/if}
			{#each Object.keys(traceLayerShow) as unitId (unitId)}
				<span>
					{unitId}
					<label>✓<input type="checkbox" data-echo={`${unitId} accepted`} bind:checked={traceLayerShow[unitId].accepted} /></label>
					<label>✗<input type="checkbox" data-echo={`${unitId} rejected`} bind:checked={traceLayerShow[unitId].rejected} /></label>
				</span>
			{/each}
		{/if}
	</div>
	<div style="font-family: monospace; font-size: 13px; margin-bottom: 0.3rem;">
		badges {counts?.badges} · baskets {counts?.baskets} · tees {counts?.tees} · owned {counts?.owned} · raw pairs {counts?.pairs}
	</div>

	<!-- the overlay is an image; clicking it is an additive shortcut that only
	     writes a `scope` line to the history panel, so it stays role="img" and
	     changes nothing a keyboard user can otherwise reach -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<svg
		viewBox={`0 0 ${m.widthPx} ${m.heightPx}`}
		style="width: 100%; max-height: 82vh; border: 1px solid black; background: #111; cursor: crosshair;"
		role="img"
		aria-label="Gate overlay — click any pixel to echo its scope command"
		onclick={onScopeClick}
	>
		<image href={imgUrl} width={m.widthPx} height={m.heightPx} />

		{#if heatmapShow && heatmapUrl && heatmapMeta}
			<image
				href={heatmapUrl}
				x={heatmapMeta.x}
				y={heatmapMeta.y}
				width={heatmapMeta.w}
				height={heatmapMeta.h}
				preserveAspectRatio="none"
				style="image-rendering: pixelated;"
			/>
		{/if}

		{#if run.trace}
			{#each run.trace.units as unit (unit.id)}
				{@const layer = traceLayerShow[unit.id]}
				{#if layer}
					{#each unit.drawables as d, di (di)}
						{@const visible =
							d.type !== 'heatmap' &&
							((d.verdict === 'accepted' && layer.accepted) ||
								(d.verdict === 'rejected' && layer.rejected) ||
								(d.verdict === 'info' && (layer.accepted || layer.rejected)))}
						{#if visible}
							{@const color = d.verdict === 'accepted' ? '#7CFC00' : d.verdict === 'rejected' ? '#ff4444' : '#ffffff'}
							{#if d.type === 'box'}
								<rect
									x={d.bbox[0]}
									y={d.bbox[1]}
									width={d.bbox[2]}
									height={d.bbox[3]}
									fill="none"
									stroke={color}
									stroke-width="2"
									stroke-dasharray={d.verdict === 'rejected' ? '4 3' : undefined}
								>
									<title>{unit.id} {d.verdict}{d.reason ? `: ${d.reason}` : ''} {d.ref ?? ''}</title>
								</rect>
							{:else if d.type === 'point'}
								<circle cx={d.xPx} cy={d.yPx} r="4" fill={color}>
									<title>{unit.id} {d.verdict}{d.reason ? `: ${d.reason}` : ''}</title>
								</circle>
							{:else if d.type === 'polyline'}
								<polyline
									points={d.path.map(([x, y]) => `${x},${y}`).join(' ')}
									fill="none"
									stroke={color}
									stroke-width="2"
								>
									<title>{unit.id} {d.verdict}{d.reason ? `: ${d.reason}` : ''}</title>
								</polyline>
							{/if}
						{/if}
					{/each}
				{/if}
			{/each}
		{/if}

		{#if show.badges}
			{#each m.badges as b (b.detId)}
				<rect
					x={b.bbox[0]}
					y={b.bbox[1]}
					width={b.bbox[2]}
					height={b.bbox[3]}
					fill="none"
					stroke="gold"
					stroke-width="3"
				/>
				{#if show.badges}
					<text x={b.bbox[0]} y={b.bbox[1] - 6} fill="gold" font-size="20" font-family="monospace">
						{b.label ?? '?'} ({b.confidence.toFixed(2)}{b.source === 'dark-plate-recovery' ? ' R' : ''})
					</text>
				{/if}
			{/each}
		{/if}

		{#if show.baskets}
			{#each m.baskets as k (k.detId)}
				<rect
					x={k.bbox[0]}
					y={k.bbox[1]}
					width={k.bbox[2]}
					height={k.bbox[3]}
					fill="none"
					stroke="#ff5555"
					stroke-width="3"
				/>
				<circle cx={k.tipXPx} cy={k.tipYPx} r="5" fill="#ff5555" />
				{#if show.baskets}
					<text x={k.bbox[0]} y={k.bbox[1] - 6} fill="#ff5555" font-size="18" font-family="monospace">
						{k.score.toFixed(2)}
					</text>
				{/if}
			{/each}
		{/if}

		{#if show.tees && a}
			{#each a.tees as t (t.detId)}
				<circle
					cx={t.xPx}
					cy={t.yPx}
					r="9"
					fill="none"
					stroke={t.tier === 'ring' ? '#4fd1ff' : t.tier === 'component' ? '#9fd14f' : '#ff9f4f'}
					stroke-width="3"
				/>
				{#if t.angleRad !== null}
					<line
						x1={t.xPx - Math.cos(t.angleRad) * 30}
						y1={t.yPx - Math.sin(t.angleRad) * 30}
						x2={t.xPx + Math.cos(t.angleRad) * 30}
						y2={t.yPx + Math.sin(t.angleRad) * 30}
						stroke="#4fd1ff"
						stroke-width="2"
					/>
				{/if}
				{#if show.tees}
					<text x={t.xPx + 12} y={t.yPx + 5} fill="#4fd1ff" font-size="16" font-family="monospace">{t.tier}</text>
				{/if}
			{/each}
		{/if}

		{#if show.ownership && a}
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
						stroke-width="3.5"
						opacity="0.95"
					/>
					{#if show.ownership}
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

		{#if show.path && a}
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
	{#if show.path && a && a.assignments.length === 0}
		<p><strong>No assignments — nothing to route.</strong></p>
	{/if}
	{#if run.trace}
		<TracePanel trace={run.trace} />
	{/if}
{:else if !busy}
	<p>Pick any screenshot. The whole pipeline runs locally; arrows or buttons scrub the gates.</p>
{/if}
