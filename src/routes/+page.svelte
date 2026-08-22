<script lang="ts">
	import { loadImageFromFile, releaseImage, type LoadedImage } from '$lib/image';
	import ImageViewport from '$lib/components/ImageViewport.svelte';
	import {
		cropRaster,
		croppedObjectUrl,
		rasterFromFile,
		type CropInsets,
		type GrayRaster
	} from '$lib/raster';
	import { proposeSharedCrop } from '$lib/autoCrop';
	import { findBestTranslation } from '$lib/stitch';
	import { rgbaFromFile } from '$lib/rgba';
	import { labEndpointDetector } from '$lib/detectors/labEndpoint';
	import type { DetectorEmission } from '$lib/detect';
	import type { ViewportMarker } from '$lib/viewport';

	const LAYER_COLORS = ['red', 'blue', 'green', 'orange', 'purple', 'teal'];
	const MAX_IMAGES = 6;
	const PAGE_MARGIN_PX = 8; // matches the browser's default body margin (sides)

	type Placement = { x: number; y: number };

	let images = $state<LoadedImage[]>([]);
	let thrownIdx = $state(-1);
	let appliedInsets = $state<CropInsets | null>(null);
	let displayUrls = $state<string[]>([]);
	let placements = $state<Placement[]>([]);
	let selectedIdx = $state(-1);
	let rasters: GrayRaster[] = [];
	let error = $state<string | null>(null);
	let workflowMessage = $state<string | null>(null);
	let layoutApproved = $state(false);
	let skipCrop = false;
	let selectionSeq = 0;
	let headerH = $state(0);
	let fitKey = $state(0);

	// detector emissions per image, keyed by objectUrl (stable UI identity)
	let detections = $state<Record<string, DetectorEmission[]>>({});
	// one hue family each — no magenta/purple double-up
	const HOLE_COLORS = [
		'#d33', // red
		'#36c', // blue
		'#2a862a', // green
		'#c70', // orange
		'#849', // purple
		'#087', // teal
		'#853', // brown
		'#770', // olive
		'#345' // navy
	];

	async function runDetection(img: LoadedImage) {
		const seq = selectionSeq;
		try {
			const raster = await rgbaFromFile(img.file);
			const emitted: DetectorEmission[] = [];
			await labEndpointDetector(raster, (e) => emitted.push(e));
			if (seq !== selectionSeq) return;
			detections = { ...detections, [img.objectUrl]: emitted };
			dbg('detector done', img.file.name, {
				objects: emitted.filter((e) => e.kind === 'object').length,
				labels: emitted.filter((e) => e.kind === 'label').length
			});
		} catch (e) {
			dbg('detector failed', img.file.name, e instanceof Error ? e.message : e);
		}
	}

	// Badges only (baskets can FP, badges pretty much can't). Each badge gets a
	// translucent halo in its hole color that "lights up" the glyph; when the
	// SAME hole number from another tile lands within the match radius in
	// composite space — the stitch verified itself right there — the halo
	// flips to the match color.
	const MATCH_RADIUS_PX = 1;
	const MATCH_COLOR = 'gold';

	function projectMarkers(imgs: LoadedImage[]): ViewportMarker[][] {
		const left = appliedInsets?.left ?? 0;
		const top = appliedInsets?.top ?? 0;

		type B = { n: number; x: number; y: number; conf: number };
		const perTile: B[][] = imgs.map((img) => {
			const emitted = detections[img.objectUrl];
			if (!emitted) return [];
			const labelByDet = new Map(
				emitted.filter((e) => e.kind === 'label').map((e) => [e.detId, e.n])
			);
			const out: B[] = [];
			for (const e of emitted) {
				if (e.kind !== 'object' || e.objType !== 'hole-badge') continue;
				const n = labelByDet.get(e.detId);
				if (n === undefined) continue;
				out.push({ n, x: e.xPx - left, y: e.yPx - top, conf: e.confidence });
			}
			return out;
		});

		const matched = new Set<string>();
		if (placements.length === imgs.length) {
			for (let i = 0; i < perTile.length; i++) {
				for (let j = i + 1; j < perTile.length; j++) {
					for (const a of perTile[i]) {
						for (const b of perTile[j]) {
							if (a.n !== b.n) continue;
							const ax = placements[i].x + a.x;
							const ay = placements[i].y + a.y;
							const bx = placements[j].x + b.x;
							const by = placements[j].y + b.y;
							if (Math.hypot(ax - bx, ay - by) <= MATCH_RADIUS_PX) {
								matched.add(`${i}:${a.n}`);
								matched.add(`${j}:${b.n}`);
							}
						}
					}
				}
			}
		}

		return perTile.map((badges, i) =>
			badges.map((b) => ({
				xPx: b.x,
				yPx: b.y,
				color: matched.has(`${i}:${b.n}`)
					? MATCH_COLOR
					: HOLE_COLORS[(b.n - 1) % HOLE_COLORS.length],
				label: '',
				title: `badge ${b.n} (${b.conf.toFixed(2)})${matched.has(`${i}:${b.n}`) ? ' — matched across tiles' : ''}`
			}))
		);
	}

	// temporary instrumentation for the canvas bring-up — grep tag: [stitch]
	function dbg(...args: unknown[]) {
		console.log('[stitch]', ...args);
	}
	if (typeof window !== 'undefined') {
		window.addEventListener('unhandledrejection', (e) => dbg('UNHANDLED REJECTION', e.reason));
		window.addEventListener('error', (e) => dbg('ERROR', e.message));
	}

	let mapImages = $derived(images.filter((_, i) => i !== thrownIdx));
	let thrownRound = $derived(thrownIdx >= 0 ? (images[thrownIdx] ?? null) : null);
	let stitchReady = $derived(
		placements.length > 0 &&
			placements.length === mapImages.length &&
			displayUrls.length === mapImages.length
	);

	let layers = $derived(
		stitchReady
			? mapImages.map((img, i) => ({
					objectUrl: displayUrls[i],
					x: placements[i].x,
					y: placements[i].y,
					widthPx: rasters[i]?.widthPx ?? img.widthPx,
					heightPx: rasters[i]?.heightPx ?? img.heightPx,
					borderColor: selectedIdx === i ? 'yellow' : LAYER_COLORS[i % LAYER_COLORS.length],
					opacity: 1
				}))
			: []
	);

	let markers = $derived(projectMarkers(mapImages));

	// ---- semantic stitch: align tiles geometrically from shared badge numbers.
	// 'spread' placements auto-upgrade when matches exist; any manual drag or
	// pixel-stitch run stops the auto-upgrade from fighting the user.
	let placementSource: 'none' | 'spread' | 'semantic' | 'pixel' | 'manual' = 'none';

	function badgeCentersByN(img: LoadedImage | undefined): Map<number, { x: number; y: number }> {
		const out = new Map<number, { x: number; y: number }>();
		if (!img) return out;
		const emitted = detections[img.objectUrl];
		if (!emitted) return out;
		const labelByDet = new Map(
			emitted.filter((e) => e.kind === 'label').map((e) => [e.detId, e.n])
		);
		for (const e of emitted) {
			if (e.kind !== 'object' || e.objType !== 'hole-badge') continue;
			const n = labelByDet.get(e.detId);
			if (n !== undefined && !out.has(n)) out.set(n, { x: e.xPx, y: e.yPx });
		}
		return out;
	}

	function trySemanticAlign() {
		if (placementSource !== 'spread') return;
		if (mapImages.length < 2 || placements.length !== mapImages.length) return;
		const anchor = badgeCentersByN(mapImages[0]);
		if (anchor.size === 0) return;

		const next = placements.slice();
		const matchedTiles: string[] = [];
		for (let i = 1; i < mapImages.length; i++) {
			const mine = badgeCentersByN(mapImages[i]);
			const offsets: { dx: number; dy: number; n: number }[] = [];
			for (const [n, p] of mine) {
				const ap = anchor.get(n);
				if (ap) offsets.push({ dx: ap.x - p.x, dy: ap.y - p.y, n });
			}
			if (offsets.length === 0) continue;
			// median offset; shared badge positions ARE the transform
			offsets.sort((a, b) => a.dx - b.dx);
			const dx = offsets[Math.floor(offsets.length / 2)].dx;
			offsets.sort((a, b) => a.dy - b.dy);
			const dy = offsets[Math.floor(offsets.length / 2)].dy;
			next[i] = { x: next[0].x + dx, y: next[0].y + dy };
			matchedTiles.push(`tile ${i + 1} via badge${offsets.length > 1 ? 's' : ''} ${offsets.map((o) => o.n).join(', ')}`);
		}
		if (matchedTiles.length === 0) return;
		placements = next;
		placementSource = 'semantic';
		fitKey++;
		dbg('semantic align', matchedTiles);
		workflowMessage = `Aligned geometrically: ${matchedTiles.join('; ')}. Approve or adjust.`;
	}

	$effect(() => {
		void detections;
		void mapImages;
		trySemanticAlign();
	});

	function resetStitchState() {
		for (const [index, url] of displayUrls.entries()) {
			if (url !== mapImages[index]?.objectUrl) URL.revokeObjectURL(url);
		}
		appliedInsets = null;
		displayUrls = [];
		placements = [];
		selectedIdx = -1;
		rasters = [];
		workflowMessage = null;
		layoutApproved = false;
	}

	function markThrownRound(index: number) {
		resetStitchState();
		skipCrop = false;
		thrownIdx = index;
		analyze();
	}

	function reselectThrownRound() {
		resetStitchState();
		thrownIdx = -1;
	}

	function undoCrop() {
		skipCrop = true;
		resetStitchState();
		analyze();
	}

	const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

	// Show the tiles IMMEDIATELY (originals, spread side by side); semantic
	// alignment from badge detections upgrades the layout the moment matches
	// exist; crop swaps in from the background. No pixel search on this path.
	async function analyze() {
		const tiles = images.filter((_, i) => i !== thrownIdx);
		if (tiles.length < 2) {
			workflowMessage = 'Need at least two course tiles besides the thrown round.';
			return;
		}

		const seq = selectionSeq;
		displayUrls = tiles.map((image) => image.objectUrl);
		appliedInsets = null;
		let x = 0;
		placements = tiles.map((img) => {
			const p = { x, y: 0 };
			x += img.widthPx + 120;
			return p;
		});
		selectedIdx = 0;
		layoutApproved = false;
		placementSource = 'spread';
		fitKey++;
		workflowMessage = 'Tiles up. Aligning from badges; cropping in the background…';
		trySemanticAlign();
		await nextFrame();

		// background: rasterize for crop proposal (and the pixel-stitch fallback)
		let nextRasters: GrayRaster[];
		try {
			nextRasters = await Promise.all(tiles.map((image) => rasterFromFile(image.file)));
		} catch (e) {
			workflowMessage = `Analyze failed: ${e instanceof Error ? e.message : String(e)}`;
			return;
		}
		if (seq !== selectionSeq) return;
		rasters = nextRasters;

		const proposal = skipCrop ? null : proposeSharedCrop(rasters);
		dbg('analyze done', { tiles: tiles.length, proposal });
		if (!proposal) return;

		let croppedUrls: string[];
		try {
			croppedUrls = await Promise.all(tiles.map((image) => croppedObjectUrl(image, proposal)));
		} catch (e) {
			dbg('crop failed', e instanceof Error ? e.message : e);
			return;
		}
		if (seq !== selectionSeq) {
			for (const url of croppedUrls) URL.revokeObjectURL(url);
			return;
		}
		displayUrls = croppedUrls;
		rasters = rasters.map((raster) => cropRaster(raster, proposal));
		appliedInsets = proposal;
	}

	// pixel-search fallback, user-invoked only
	function runStitch() {
		if (rasters.length !== mapImages.length || rasters.length < 2) {
			workflowMessage = 'Pixel stitch not ready yet — still reading pixels.';
			return;
		}
		const nextPlacements: Placement[] = [{ x: 0, y: 0 }];
		let hadFallback = false;

		for (let index = 1; index < rasters.length; index++) {
			const previous = nextPlacements[index - 1];
			const offset = findBestTranslation(rasters[index - 1], rasters[index]);
			if (offset) {
				nextPlacements.push({ x: previous.x + offset.dx, y: previous.y + offset.dy });
			} else {
				hadFallback = true;
				nextPlacements.push({ x: previous.x + rasters[index - 1].widthPx + 120, y: previous.y });
			}
		}

		placements = nextPlacements;
		selectedIdx = 0;
		layoutApproved = false;
		placementSource = 'pixel';
		fitKey++;
		dbg('stitch result', { placements: nextPlacements, hadFallback });
		workflowMessage = hadFallback
			? 'Pixel stitch could not match some tiles — drag them into place.'
			: 'Pixel-stitched — inspect the overlap, then approve or adjust.';
	}

	function moveSelectedBy(deltaX: number, deltaY: number) {
		if (selectedIdx < 0 || !placements[selectedIdx]) return;
		placementSource = 'manual';
		placements = placements.map((placement, index) =>
			index === selectedIdx ? { x: placement.x + deltaX, y: placement.y + deltaY } : placement
		);
		layoutApproved = false;
	}

	function onLayerMove(index: number, deltaX: number, deltaY: number) {
		if (!placements[index]) return;
		placementSource = 'manual';
		selectedIdx = index;
		placements = placements.map((placement, placementIndex) =>
			placementIndex === index
				? { x: placement.x + deltaX, y: placement.y + deltaY }
				: placement
		);
		layoutApproved = false;
	}

	function onKeyDown(event: KeyboardEvent) {
		if (!stitchReady) return;
		const numberKey = Number(event.key);
		if (Number.isInteger(numberKey) && numberKey >= 1 && numberKey <= mapImages.length) {
			selectedIdx = numberKey - 1;
			return;
		}

		if (event.key === 'ArrowLeft') moveSelectedBy(-1, 0);
		else if (event.key === 'ArrowRight') moveSelectedBy(1, 0);
		else if (event.key === 'ArrowUp') moveSelectedBy(0, -1);
		else if (event.key === 'ArrowDown') moveSelectedBy(0, 1);
		else return;

		event.preventDefault();
	}

	async function onFileChange(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = '';
		if (files.length == 0) return;

		const seq = ++selectionSeq;
		const results = await Promise.all(files.map(loadImageFromFile));

		if (seq !== selectionSeq) {
			for (const r of results) if (r.ok) releaseImage(r.image);
			return;
		}

		const rejected: string[] = [];
		let addedAny = false;
		for (const [i, r] of results.entries()) {
			if (!r.ok) {
				rejected.push(files[i].name);
			} else if (images.length >= MAX_IMAGES) {
				releaseImage(r.image);
				rejected.push(`${files[i].name} (over the ${MAX_IMAGES} image limit)`);
			} else {
				images.push(r.image);
				addedAny = true;
				runDetection(r.image);
			}
		}
		if (addedAny) {
			resetStitchState();
			skipCrop = false;
			thrownIdx = -1;
		}
		error = rejected.length > 0 ? `Not added: ${rejected.join(', ')}` : null;
	}

	function clearAll() {
		selectionSeq++;
		resetStitchState();
		for (const img of images) releaseImage(img);
		images = [];
		detections = {};
		thrownIdx = -1;
		skipCrop = false;
		error = null;
	}
</script>

<svelte:window onkeydown={onKeyDown} />

<div bind:clientHeight={headerH} style="display: flex; gap: 1rem; align-items: baseline; flex-wrap: wrap;">
	<h1 style="margin: 0.25rem 0; font-size: 1.5rem;">Stitch Map</h1>
	<input type="file" accept="image/*" multiple onchange={onFileChange} />
	<button onclick={clearAll}>Clear all</button>
	{#if error}<span>{error}</span>{/if}
	{#if workflowMessage}<span>{workflowMessage}</span>{/if}
	{#if stitchReady && selectedIdx >= 0}
		<span>Selected: image {selectedIdx + 1} (number keys select, arrows nudge, drag moves)</span>
	{/if}
	{#if layoutApproved}<strong>Layout approved.</strong>{/if}
</div>

{#if thrownIdx < 0}
	{#if images.length > 0}
		<p><strong>Click the screenshot that shows your throws.</strong> The rest become the course blank.</p>
	{/if}
	<div style="display: flex; gap: 1rem; overflow-x: auto;">
		{#each images as img, i (img.objectUrl)}
			<div>
				<img src={img.objectUrl} alt={img.file.name} style="height: 33vh; width: auto;" />
				<p>
					<button onclick={() => markThrownRound(i)}>Mark as Thrown Round</button><br />
					{img.file.name} - {img.widthPx} x {img.heightPx} px
				</p>
			</div>
		{/each}
	</div>
{/if}

{#if stitchReady}
	<ImageViewport
		{layers}
		selectedIndex={selectedIdx}
		{onLayerMove}
		cropPreview={null}
		height={`calc(100vh - ${headerH + PAGE_MARGIN_PX * 2 + 2}px)`}
		{fitKey}
		{markers}
	>
		{#if thrownRound}
			<div style="background: rgba(255,255,255,0.9); border: 1px solid black; padding: 0.25rem; text-align: center;">
				<img src={thrownRound.objectUrl} alt={thrownRound.file.name} style="width: 60px; display: block; margin: 0 auto;" />
				<small>Thrown Round</small>
			</div>
		{/if}
		<button onclick={() => (layoutApproved = true)}><strong>Approve layout</strong></button>
		<button onclick={runStitch}>Pixel stitch (fallback)</button>
		{#if appliedInsets}
			<button onclick={undoCrop}>Undo crop</button>
		{/if}
		<button onclick={reselectThrownRound}>Re-Select Thrown Round</button>
	</ImageViewport>
{/if}
