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
	const HOLE_COLORS = [
		'#d33',
		'#36c',
		'#2a862a',
		'#c70',
		'#849',
		'#087',
		'#b3b',
		'#770',
		'#345'
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

	// project detections into each layer's local (cropped display) pixels
	function projectMarkers(imgs: LoadedImage[]): ViewportMarker[][] {
		return imgs.map((img, i) => {
			const emitted = detections[img.objectUrl];
			if (!emitted) return [] as ViewportMarker[];
			const labelByDet = new Map(
				emitted.filter((e) => e.kind === 'label').map((e) => [e.detId, e.n])
			);
			const left = appliedInsets?.left ?? 0;
			const top = appliedInsets?.top ?? 0;
			const w = rasters[i]?.widthPx ?? img.widthPx;
			const h = rasters[i]?.heightPx ?? img.heightPx;
			const out: ViewportMarker[] = [];
			for (const e of emitted) {
				if (e.kind !== 'object') continue;
				const x = e.xPx - left;
				const y = e.yPx - top;
				if (x < 0 || y < 0 || x > w || y > h) continue;
				if (e.objType === 'hole-badge') {
					const n = labelByDet.get(e.detId);
					out.push({
						xPx: x,
						yPx: y,
						color: n ? HOLE_COLORS[(n - 1) % HOLE_COLORS.length] : '#666',
						label: n ? String(n) : '?',
						title: `badge ${n ?? '?'} (${e.confidence.toFixed(2)})`
					});
				} else if (e.objType === 'basket') {
					out.push({ xPx: x, yPx: y, color: '#222', label: 'B', title: `basket (${e.confidence.toFixed(2)})` });
				} else if (e.objType === 'tee') {
					out.push({ xPx: x, yPx: y, color: '#2c4a2c', label: 'T', title: `tee (${e.confidence.toFixed(2)})` });
				}
			}
			return out;
		});
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

	// AutoCrop + AutoStitch, confidently applied; the user approves or adjusts.
	async function analyze() {
		const tiles = images.filter((_, i) => i !== thrownIdx);
		if (tiles.length < 2) {
			workflowMessage = 'Need at least two course tiles besides the thrown round.';
			return;
		}

		const seq = selectionSeq;
		workflowMessage = 'Analyzing…';
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

		if (proposal) {
			let croppedUrls: string[];
			try {
				croppedUrls = await Promise.all(tiles.map((image) => croppedObjectUrl(image, proposal)));
			} catch (e) {
				workflowMessage = `Crop failed: ${e instanceof Error ? e.message : String(e)}`;
				displayUrls = tiles.map((image) => image.objectUrl);
				runStitch();
				return;
			}
			if (seq !== selectionSeq) {
				for (const url of croppedUrls) URL.revokeObjectURL(url);
				return;
			}
			displayUrls = croppedUrls;
			rasters = rasters.map((raster) => cropRaster(raster, proposal));
			appliedInsets = proposal;
		} else {
			displayUrls = tiles.map((image) => image.objectUrl);
			appliedInsets = null;
		}
		runStitch();
	}

	function runStitch() {
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
		fitKey++;
		dbg('stitch result', { placements: nextPlacements, hadFallback });
		const cropNote = appliedInsets
			? `Cropped ${appliedInsets.top}/${appliedInsets.bottom}px chrome. `
			: 'No crop applied. ';
		workflowMessage = hadFallback
			? cropNote + 'Some tiles could not be matched — drag them into place.'
			: cropNote + 'Auto-stitched — inspect the overlap, then approve or adjust.';
	}

	function moveSelectedBy(deltaX: number, deltaY: number) {
		if (selectedIdx < 0 || !placements[selectedIdx]) return;
		placements = placements.map((placement, index) =>
			index === selectedIdx ? { x: placement.x + deltaX, y: placement.y + deltaY } : placement
		);
		layoutApproved = false;
	}

	function onLayerMove(index: number, deltaX: number, deltaY: number) {
		if (!placements[index]) return;
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
		<button onclick={runStitch}>Re-run stitch</button>
		{#if appliedInsets}
			<button onclick={undoCrop}>Undo crop</button>
		{/if}
		<button onclick={reselectThrownRound}>Re-Select Thrown Round</button>
	</ImageViewport>
{/if}
