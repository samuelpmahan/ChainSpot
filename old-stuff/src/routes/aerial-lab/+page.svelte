<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		AERIAL_PROVIDERS,
		fetchAerialBoundingBoxWithFallback,
		providerById
	} from '$lib/aerialProviders';
	import type { AerialFetchAttempt, AerialProvider, AerialProviderId } from '$lib/aerialProviders';
	import {
		addTileManifest,
		cellBoundingBox,
		cellKey,
		cellPixelOrigin,
		cellsRequiredForPixelPoints,
		createIncrementalAerialManifest,
		gridLayout,
		manifestBoundingBox,
		metersPerPixel,
		nextDirectionalCell,
		oldRasterShiftAfterAppend,
		parseIncrementalAerialManifest,
		translatePixelPoints
	} from '$lib/incrementalAerialMosaic';
	import type {
		AerialGridCell,
		IncrementalAerialManifest,
		PixelPoint
	} from '$lib/incrementalAerialMosaic';
	import type { EdgeDirection } from '$lib/edgeLoadZones';

	const STORAGE_KEY = 'chainspot:aerial-lab-manifest-v1';
	const DEFAULT_TILE_SIZE_PX = 2048;

	interface RuntimeTile {
		cell: AerialGridCell;
		blob: Blob;
		objectUrl: string;
		providerId: AerialProviderId;
	}

	interface VisualCell {
		key: string;
		cell: AerialGridCell;
		tile: RuntimeTile | null;
		direction: EdgeDirection | null;
	}

	let latInput = $state('33.18103');
	let lonInput = $state('-96.63854');
	let radiusInput = $state('300');
	let manifest = $state<IncrementalAerialManifest>(
		createIncrementalAerialManifest({ lat: 33.18103, lon: -96.63854 }, 300, DEFAULT_TILE_SIZE_PX)
	);
	let tiles = $state.raw<Map<string, RuntimeTile>>(new Map());
	let fetching = $state(false);
	let status = $state('Ready. Fetch a seed tile to probe browser-readable high-resolution imagery.');
	let error = $state<string | null>(null);
	let lastAttempts = $state<readonly AerialFetchAttempt[]>([]);
	let lastProvider = $state<AerialProvider | null>(null);
	let lastShift = $state<PixelPoint>({ xPx: 0, yPx: 0 });
	let coveragePoints = $state<PixelPoint[]>([]);
	let savedManifestAvailable = $state(false);
	let mosaicUrl = $state<string | null>(null);
	let mosaicWidthPx = $state(0);
	let mosaicHeightPx = $state(0);

	const ARROWS: Record<EdgeDirection, string> = {
		north: '↑',
		east: '→',
		south: '↓',
		west: '←'
	};

	let layout = $derived(gridLayout(manifest));
	let bbox = $derived(manifestBoundingBox(manifest));
	let missingCoverageCells = $derived(cellsRequiredForPixelPoints(manifest, coveragePoints));
	let visualCells = $derived.by(() => buildVisualCells(manifest, tiles));
	let visualCols = $derived(layout.cols + 2);

	function buildVisualCells(
		currentManifest: IncrementalAerialManifest,
		currentTiles: Map<string, RuntimeTile>
	): VisualCell[] {
		const currentLayout = gridLayout(currentManifest);
		const directional = new Map<string, EdgeDirection>();
		for (const direction of ['north', 'east', 'south', 'west'] as const) {
			directional.set(cellKey(nextDirectionalCell(currentManifest, direction)), direction);
		}
		const cells: VisualCell[] = [];
		for (let y = currentLayout.maxY + 1; y >= currentLayout.minY - 1; y--) {
			for (let x = currentLayout.minX - 1; x <= currentLayout.maxX + 1; x++) {
				const cell = { x, y };
				const key = cellKey(cell);
				cells.push({
					key,
					cell,
					tile: currentTiles.get(key) ?? null,
					direction: directional.get(key) ?? null
				});
			}
		}
		return cells;
	}

	onMount(() => {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			savedManifestAvailable = raw !== null && parseIncrementalAerialManifest(JSON.parse(raw)) !== null;
		} catch {
			savedManifestAvailable = false;
		}
	});

	onDestroy(() => {
		for (const tile of tiles.values()) URL.revokeObjectURL(tile.objectUrl);
		if (mosaicUrl) URL.revokeObjectURL(mosaicUrl);
	});

	function parseSeed(): { lat: number; lon: number; radius: number } | null {
		const lat = Number(latInput);
		const lon = Number(lonInput);
		const radius = Number(radiusInput);
		if (
			!Number.isFinite(lat) ||
			!Number.isFinite(lon) ||
			!Number.isFinite(radius) ||
			lat < -90 ||
			lat > 90 ||
			lon < -180 ||
			lon > 180 ||
			radius <= 0
		) {
			error = 'Enter valid WGS84 latitude/longitude and a positive tile radius.';
			return null;
		}
		return { lat, lon, radius };
	}

	function clearRuntime(): void {
		for (const tile of tiles.values()) URL.revokeObjectURL(tile.objectUrl);
		tiles = new Map();
		if (mosaicUrl) URL.revokeObjectURL(mosaicUrl);
		mosaicUrl = null;
		mosaicWidthPx = 0;
		mosaicHeightPx = 0;
		coveragePoints = [];
		lastShift = { xPx: 0, yPx: 0 };
		lastAttempts = [];
		lastProvider = null;
	}

	function persistManifest(): void {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(manifest));
			savedManifestAvailable = true;
		} catch {
			// Prototype persistence is best-effort. The live raster remains usable.
		}
	}

	async function decodeBlob(blob: Blob): Promise<HTMLImageElement> {
		const url = URL.createObjectURL(blob);
		const image = new Image();
		try {
			await new Promise<void>((resolve, reject) => {
				image.onload = () => resolve();
				image.onerror = () => reject(new Error('Fetched aerial tile could not be decoded.'));
				image.src = url;
			});
			return image;
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	async function rebuildMosaic(): Promise<void> {
		if (manifest.tiles.length === 0 || tiles.size === 0) return;
		const currentLayout = gridLayout(manifest);
		const canvas = document.createElement('canvas');
		canvas.width = currentLayout.widthPx;
		canvas.height = currentLayout.heightPx;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Could not allocate the prototype mosaic canvas.');
		context.clearRect(0, 0, canvas.width, canvas.height);

		for (const tile of tiles.values()) {
			const image = await decodeBlob(tile.blob);
			const origin = cellPixelOrigin(manifest, tile.cell);
			// 1:1 tile placement: no resampling of the clean-target pixels.
			context.drawImage(
				image,
				origin.xPx,
				origin.yPx,
				manifest.tileSizePx,
				manifest.tileSizePx
			);
		}

		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('Mosaic encoding failed.'))), 'image/png');
		});
		const nextUrl = URL.createObjectURL(blob);
		if (mosaicUrl) URL.revokeObjectURL(mosaicUrl);
		mosaicUrl = nextUrl;
		mosaicWidthPx = canvas.width;
		mosaicHeightPx = canvas.height;
	}

	async function fetchCell(
		cell: AerialGridCell,
		preferredProvider?: AerialProviderId
	): Promise<boolean> {
		if (tiles.has(cellKey(cell))) return true;
		const orderedProviders = preferredProvider
			? [providerById(preferredProvider), ...AERIAL_PROVIDERS.filter((provider) => provider.id !== preferredProvider)]
			: AERIAL_PROVIDERS;
		const result = await fetchAerialBoundingBoxWithFallback(
			cellBoundingBox(manifest, cell),
			{ widthPx: manifest.tileSizePx, heightPx: manifest.tileSizePx },
			{ providers: orderedProviders }
		);
		lastAttempts = result.attempts;
		if (!result.ok) {
			error = result.message;
			return false;
		}

		const before = manifest;
		const nextManifest = addTileManifest(before, cell, result.provider.id);
		const shift = oldRasterShiftAfterAppend(before, nextManifest);
		manifest = nextManifest;
		lastShift = shift;
		if (shift.xPx !== 0 || shift.yPx !== 0) {
			coveragePoints = translatePixelPoints(coveragePoints, shift);
		}
		const nextTiles = new Map(tiles);
		nextTiles.set(cellKey(cell), {
			cell: { ...cell },
			blob: result.blob,
			objectUrl: URL.createObjectURL(result.blob),
			providerId: result.provider.id
		});
		tiles = nextTiles;
		lastProvider = result.provider;
		persistManifest();
		await rebuildMosaic();
		return true;
	}

	async function fetchSeed(): Promise<void> {
		if (fetching) return;
		const seed = parseSeed();
		if (!seed) return;
		fetching = true;
		error = null;
		clearRuntime();
		manifest = createIncrementalAerialManifest(
			{ lat: seed.lat, lon: seed.lon },
			seed.radius,
			DEFAULT_TILE_SIZE_PX
		);
		try {
			const ok = await fetchCell({ x: 0, y: 0 });
			status = ok
				? `Seed loaded from ${lastProvider?.label ?? 'provider'}. Pan is replaced here by literal neighboring-tile growth.`
				: 'Seed fetch failed on every configured provider.';
		} finally {
			fetching = false;
		}
	}

	async function addDirection(direction: EdgeDirection): Promise<void> {
		if (fetching || manifest.tiles.length === 0) return;
		fetching = true;
		error = null;
		try {
			const cell = nextDirectionalCell(manifest, direction);
			const ok = await fetchCell(cell);
			if (ok) {
				status = `Added one ${direction} tile at constant ${metersPerPixel(manifest).toFixed(3)} m/px. Existing target points shifted by (${lastShift.xPx}, ${lastShift.yPx}) px.`;
			}
		} finally {
			fetching = false;
		}
	}

	function simulateSouthCoverageGap(): void {
		if (manifest.tiles.length === 0) return;
		const current = gridLayout(manifest);
		coveragePoints = [0.16, 0.38, 0.62, 0.84].map((fraction, index) => ({
			xPx: current.widthPx * fraction,
			yPx: current.heightPx + 80 + index * 70
		}));
		status = `Injected ${coveragePoints.length} transformed course points south of the raster. The required tile cells are derived directly from their out-of-bounds target pixels.`;
	}

	async function fetchMissingCoverage(): Promise<void> {
		if (fetching || missingCoverageCells.length === 0) return;
		fetching = true;
		error = null;
		try {
			// Snapshot absolute grid cells before any north/west append shifts target pixels.
			const required = [...missingCoverageCells];
			let fetched = 0;
			for (const cell of required) {
				if (await fetchCell(cell)) fetched++;
			}
			status = `Coverage recovery fetched ${fetched}/${required.length} missing tile${required.length === 1 ? '' : 's'} without lowering raster resolution.`;
		} finally {
			fetching = false;
		}
	}

	async function restoreSavedManifest(): Promise<void> {
		if (fetching) return;
		let restored: IncrementalAerialManifest | null = null;
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			restored = raw ? parseIncrementalAerialManifest(JSON.parse(raw)) : null;
		} catch {
			restored = null;
		}
		if (!restored) {
			error = 'No valid saved prototype manifest exists.';
			return;
		}

		fetching = true;
		error = null;
		clearRuntime();
		const savedTiles = [...restored.tiles];
		manifest = { ...restored, tiles: [] };
		latInput = String(restored.seedCenter.lat);
		lonInput = String(restored.seedCenter.lon);
		radiusInput = String(restored.tileRadiusMeters);
		try {
			let fetched = 0;
			for (const tile of savedTiles) {
				if (await fetchCell(tile.cell, tile.providerId)) fetched++;
			}
			status = `Restored geospatial manifest and re-fetched ${fetched}/${savedTiles.length} tile${savedTiles.length === 1 ? '' : 's'}.`;
		} finally {
			fetching = false;
		}
	}
</script>

<svelte:head>
	<title>ChainSpot Aerial Tile Lab</title>
</svelte:head>

<main>
	<header>
		<div>
			<p class="eyebrow">CHAINSPOT PROTOTYPE</p>
			<h1>Incremental high-resolution aerial mosaic</h1>
			<p class="lede">
				One fixed-resolution geographic tile at a time. No widening/refetch downsampling.
			</p>
		</div>
		{#if savedManifestAvailable}
			<button type="button" onclick={() => void restoreSavedManifest()} disabled={fetching}>
				Restore saved geo manifest
			</button>
		{/if}
	</header>

	<section class="controls" aria-label="Seed tile controls">
		<label>Latitude <input bind:value={latInput} inputmode="decimal" /></label>
		<label>Longitude <input bind:value={lonInput} inputmode="decimal" /></label>
		<label>Tile radius (m) <input bind:value={radiusInput} inputmode="decimal" /></label>
		<button class="primary" type="button" onclick={() => void fetchSeed()} disabled={fetching}>
			{fetching ? 'Fetching…' : 'Fetch seed tile'}
		</button>
	</section>

	<p class="status" role="status">{status}</p>
	{#if error}<p class="error" role="alert">{error}</p>{/if}

	<section class="facts" aria-label="Raster facts">
		<div><strong>{manifest.tiles.length}</strong><span>loaded tiles</span></div>
		<div><strong>{layout.cols} × {layout.rows}</strong><span>canvas cells</span></div>
		<div><strong>{metersPerPixel(manifest).toFixed(3)} m/px</strong><span>constant ground scale</span></div>
		<div><strong>{mosaicWidthPx || layout.widthPx} × {mosaicHeightPx || layout.heightPx}</strong><span>assembled pixels</span></div>
		<div><strong>{lastShift.xPx}, {lastShift.yPx}</strong><span>last old-raster shift</span></div>
	</section>

	<section class="tile-stage-section">
		<div class="section-heading">
			<div>
				<h2>Literal neighboring tiles</h2>
				<p>The large dashed square is the exact geographic cell that will be fetched.</p>
			</div>
			<div class="coverage-actions">
				<button type="button" onclick={simulateSouthCoverageGap} disabled={manifest.tiles.length === 0}>
					Simulate 4 points south
				</button>
				<button
					type="button"
					class="primary"
					onclick={() => void fetchMissingCoverage()}
					disabled={fetching || missingCoverageCells.length === 0}
				>
					Fetch {missingCoverageCells.length} missing coverage tile{missingCoverageCells.length === 1 ? '' : 's'}
				</button>
			</div>
		</div>

		<div class="tile-scroll">
			<div
				class="tile-grid"
				style={`grid-template-columns: repeat(${visualCols}, var(--tile-display));`}
			>
				{#each visualCells as item (item.key)}
					<div class:loaded={item.tile !== null} class:ghost={item.direction !== null} class="tile-cell">
						{#if item.tile}
							<img src={item.tile.objectUrl} alt={`Aerial tile ${item.key}`} />
							<span class="tile-label">{item.key} · {item.tile.providerId}</span>
						{:else if item.direction}
							<button
								type="button"
								class="ghost-button"
								disabled={fetching}
								onclick={() => void addDirection(item.direction!)}
								aria-label={`Load neighboring aerial tile ${item.direction}`}
							>
								<span aria-hidden="true">{ARROWS[item.direction]}</span>
								<small>{item.key}</small>
							</button>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	</section>

	<section class="assembled">
		<div class="section-heading">
			<div>
				<h2>1:1 assembled clean target</h2>
				<p>Fetched Blobs are decoded locally and copied to the canvas at integer tile offsets.</p>
			</div>
			{#if bbox}
				<code>{bbox.minLon.toFixed(6)}, {bbox.minLat.toFixed(6)} → {bbox.maxLon.toFixed(6)}, {bbox.maxLat.toFixed(6)}</code>
			{/if}
		</div>
		<div class="mosaic-frame">
			{#if mosaicUrl}
				<img src={mosaicUrl} alt="Locally assembled aerial mosaic" />
			{:else}
				<p>Fetch a seed tile.</p>
			{/if}
			{#each coveragePoints as point, index (`${point.xPx},${point.yPx},${index}`)}
				{#if mosaicWidthPx > 0 && mosaicHeightPx > 0}
					<span
						class="coverage-point"
						style={`left:${(point.xPx / mosaicWidthPx) * 100}%; top:${(point.yPx / mosaicHeightPx) * 100}%;`}
						title={`Synthetic course point ${index + 1}: ${Math.round(point.xPx)}, ${Math.round(point.yPx)}`}
					></span>
				{/if}
			{/each}
		</div>
	</section>

	<section class="provider-log">
		<h2>Browser provider probe</h2>
		<p>
			The first provider whose response is both CORS-readable and an image wins. A display-only
			cross-origin image does not count because ChainSpot must read the bytes to mosaic/export it.
		</p>
		{#if lastProvider}
			<p class="winner">Winner: <strong>{lastProvider.label}</strong> ({lastProvider.dynamic ? 'dynamic imagery' : 'cached fallback'})</p>
		{/if}
		{#if lastAttempts.length > 0}
			<ol>
				{#each lastAttempts as attempt}
					<li class:ok={attempt.ok}>
						<strong>{attempt.providerLabel}</strong> — {attempt.ok ? 'readable image bytes' : `${attempt.kind}: ${attempt.message}`}
					</li>
				{/each}
			</ol>
		{/if}
	</section>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #09090b;
		color: #e4e4e7;
		font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	}
	main { max-width: 1500px; margin: 0 auto; padding: 1.25rem; }
	header, .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
	h1, h2, p { margin-top: 0; }
	h1 { margin-bottom: .25rem; font-size: clamp(1.5rem, 3vw, 2.25rem); }
	h2 { margin-bottom: .25rem; font-size: 1.1rem; }
	.eyebrow { margin-bottom: .2rem; color: #7dd3fc; font-size: .72rem; font-weight: 800; letter-spacing: .14em; }
	.lede, .section-heading p, .provider-log > p { color: #a1a1aa; }
	.controls { display: flex; flex-wrap: wrap; gap: .75rem; align-items: end; margin: 1rem 0; padding: 1rem; border: 1px solid #27272a; border-radius: 10px; background: #111113; }
	label { display: grid; gap: .25rem; color: #a1a1aa; font-size: .8rem; }
	input { min-width: 9rem; border: 1px solid #3f3f46; border-radius: 6px; padding: .55rem .65rem; background: #18181b; color: #fafafa; }
	button { border: 1px solid #3f3f46; border-radius: 7px; padding: .55rem .8rem; background: #27272a; color: #f4f4f5; cursor: pointer; }
	button:hover:not(:disabled), button:focus-visible { border-color: #7dd3fc; }
	button:disabled { opacity: .5; cursor: wait; }
	button.primary { border-color: #0284c7; background: #0369a1; }
	.status { padding: .65rem .8rem; border-left: 3px solid #38bdf8; background: #0c4a6e33; }
	.error { padding: .65rem .8rem; border-left: 3px solid #fb7185; background: #88133744; color: #fecdd3; }
	.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .5rem; margin: 1rem 0; }
	.facts div { display: grid; gap: .15rem; padding: .75rem; border: 1px solid #27272a; border-radius: 8px; background: #111113; }
	.facts strong { color: #f8fafc; }
	.facts span { color: #71717a; font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; }
	.tile-stage-section, .assembled, .provider-log { margin-top: 1rem; padding: 1rem; border: 1px solid #27272a; border-radius: 10px; background: #111113; }
	.coverage-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
	.tile-scroll { margin-top: 1rem; overflow: auto; padding: .5rem; border-radius: 8px; background-color: #111827; background-image: linear-gradient(45deg,#18181b 25%,transparent 25%),linear-gradient(-45deg,#18181b 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#18181b 75%),linear-gradient(-45deg,transparent 75%,#18181b 75%); background-size: 24px 24px; background-position: 0 0,0 12px,12px -12px,-12px 0; }
	.tile-grid { --tile-display: clamp(9rem, 18vw, 14rem); display: grid; gap: 6px; width: max-content; margin: 0 auto; }
	.tile-cell { position: relative; width: var(--tile-display); aspect-ratio: 1; border: 1px solid transparent; }
	.tile-cell.loaded { overflow: hidden; border-color: #3f3f46; background: #09090b; }
	.tile-cell img { display: block; width: 100%; height: 100%; object-fit: cover; }
	.tile-label { position: absolute; left: .3rem; bottom: .3rem; max-width: calc(100% - .6rem); padding: .2rem .35rem; border-radius: 4px; background: #09090bcc; color: #e0f2fe; font-size: .62rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.tile-cell.ghost { border: 2px dashed #7dd3fccc; border-radius: 10px; background: #08334426; box-shadow: inset 0 0 40px #38bdf81a; }
	.ghost-button { width: 100%; height: 100%; border: 0; background: transparent; color: #e0f2fe; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .4rem; }
	.ghost-button span { font-size: clamp(3rem, 8vw, 5rem); line-height: 1; text-shadow: 0 0 18px #38bdf8aa; }
	.ghost-button small { color: #7dd3fc; }
	.mosaic-frame { position: relative; min-height: 180px; max-height: 680px; overflow: auto; margin-top: 1rem; background-color: #18181b; background-image: linear-gradient(45deg,#27272a 25%,transparent 25%),linear-gradient(-45deg,#27272a 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#27272a 75%),linear-gradient(-45deg,transparent 75%,#27272a 75%); background-size: 20px 20px; background-position: 0 0,0 10px,10px -10px,-10px 0; }
	.mosaic-frame > img { display: block; width: min(100%, 1100px); height: auto; margin: 0 auto; image-rendering: auto; }
	.coverage-point { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border: 2px solid white; border-radius: 50%; background: #f97316; box-shadow: 0 0 0 3px #f9731666; }
	code { color: #7dd3fc; font-size: .72rem; }
	.provider-log ol { margin-bottom: 0; }
	.provider-log li { margin: .35rem 0; color: #fda4af; }
	.provider-log li.ok, .winner { color: #86efac; }
	@media (max-width: 760px) {
		header, .section-heading { flex-direction: column; }
		.controls { align-items: stretch; }
	}
</style>
