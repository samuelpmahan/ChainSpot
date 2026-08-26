<script lang="ts">
	import { fly } from 'svelte/transition';
	import { loadImageFromFile, releaseImage, type LoadedImage } from '$lib/image';
	import { formatSourceCaptureReceipt, type SourceCaptureReceipt } from '$lib/sourceIntake';
	import { type ScoutThumbnailTrace } from '$lib/scoutThumbnails';
	import type { ScoutThumbnailEvidence } from '$lib/scoutThumbnailEvidence';
	import type { ClassifyAndScoutEvidence } from '$lib/classifyAndScoutEvidence';
	import type { SelectiveFullDecodeEvidence } from '$lib/selectiveFullDecodeEvidence';
	import type { SelectiveFullDecodeTrace } from '$lib/selectiveFullDecode.types';
	import { runIntakeFeatureSet } from '$lib/intakeFeatureSet';
	import ImageViewport from '$lib/components/ImageViewport.svelte';
	import { croppedObjectUrl, rasterFromFile } from '$lib/raster';
	import type { CropInsets, GrayRaster } from '@chainspot/alg';
	import { rgbaFromFile } from '$lib/rgba';
	import { decideThrownRound } from '@chainspot/alg/g0/thrownRound';
	import { applyCrop } from '@chainspot/alg/g0/crop';
	import {
		initialSpreadPlacements,
		solvePixelStitch,
		trySemanticAlign as g0TrySemanticAlign,
		type BadgeCenter
	} from '@chainspot/alg/g0/stitchSolve';
	import { projectToComposite } from '@chainspot/alg/g0/projection';
	import { preReadRound } from '@chainspot/alg/g0/roundPreRead';
	import { labEndpointDetector } from '@chainspot/alg/detectors/labEndpoint';
	import { purpleMassDetector } from '@chainspot/alg/detectors/purpleMass';
	import type { DetectorEmission } from '@chainspot/alg/detect';
	import type { ViewportMarker } from '$lib/viewport';
	import { detectCourse, type SeedBadge } from '$lib/courseDetect';
	import {
		accept,
		createReview,
		replace,
		type Anchor,
		type ReviewHoleState,
		type ReviewState
	} from '$lib/guidedReview';
	import GuidedReviewPanel from '$lib/components/GuidedReviewPanel.svelte';
	import PairPanel from '$lib/components/PairPanel.svelte';
	import { searchPlace, attributionFor, type GeocodeMatch } from '$lib/geocodeSearch';
	import {
		bboxFromCenter,
		fetchGeometryFromViewport,
		fetchSatellite,
		pixelToGeo,
		type GeoBoundingBox
	} from '$lib/satellite';
	import { distanceFt, fitTransform, type CorrespondencePair } from '$lib/geo';
	import { applySimilarity, fitSimilarity, matchByHoleNumber } from '$lib/registration';
	import { setCourseMap, setMappedRound, getMappedRound } from '$lib/session';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { loadMockFixture, type MockCourseFixture } from '$lib/mockBoot';

	const LAYER_COLORS = ['red', 'blue', 'green', 'orange', 'purple', 'teal'];
	const MAX_IMAGES = 6;
	const PAGE_MARGIN_PX = 8; // matches the browser's default body margin (sides)

	type Placement = { x: number; y: number };

	let images = $state<LoadedImage[]>([]);
	let lastIntakeReceipt = $state<SourceCaptureReceipt | null>(null);
	let scoutThumbnailsEnabled = $state(false);
	let scoutTraces = $state<readonly ScoutThumbnailTrace[]>([]);
	let scoutEvidence = $state<readonly ScoutThumbnailEvidence[]>([]);
	let classificationEvidence = $state<readonly ClassifyAndScoutEvidence[]>([]);
	let selectiveFullDecodeTraces = $state<readonly SelectiveFullDecodeTrace[]>([]);
	let selectiveFullDecodeEvidence = $state<readonly SelectiveFullDecodeEvidence[]>([]);
	let intakeAcceptanceReceiptMarkdown = $state<string | null>(null);
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
	let purpleReady = $state<Record<string, boolean>>({});
	// Thrown-round pre-read (fair use: must finish BEFORE confirmAnnotation
	// discards the pixels). Keyed by objectUrl; own store so runDetection's
	// whole-array reassignment of `detections` can never clobber it.
	let preRead = $state<
		Record<
			string,
			{
				readonly walk: readonly { xPx: number; yPx: number }[];
				readonly droplets: readonly { xPx: number; yPx: number }[];
			}
		>
	>({});
	let autoThrownEnabled = true;
	let thrownSelectionSource = $state<'auto' | 'manual' | null>(null);

	// Import Data phases: 'import' (upload -> stitch), 'annotate' (GuidedReview
	// over the composite), 'clean' (UDisc pixels DISCARDED — vectors only)
	let phase = $state<'import' | 'annotate' | 'clean'>('import');
	let review = $state<ReviewState | null>(null);
	let replaceArming = $state<{ holeN: number; anchor: Anchor } | null>(null);
	let cleanHoles = $state<readonly ReviewHoleState[]>([]);

	// DEV-ONLY mock boot: ?mock=<fixture> skips upload/CV/annotation entirely
	// and drops the Import page straight into the finished 'clean' phase with
	// a preloaded course, so the owner can test downstream UI/UX.
	// COACH: import.meta.env.DEV is inlined at build time by Vite (it's not
	// process.env — no server, no runtime toggle), so `if (!import.meta.env.DEV)`
	// becomes `if (true)` and the whole branch (plus mockBoot.ts's dynamic
	// import) is stripped from the production bundle by dead-code elimination.
	onMount(() => {
		if (!import.meta.env.DEV) return;
		const mockName = new URLSearchParams(location.search).get('mock');
		if (!mockName) return;
		loadMockFixture(mockName)
			.then((fixture: MockCourseFixture) => {
				cleanHoles = fixture.holes;
				phase = 'clean';
				workflowMessage = `Mock boot: loaded fixture "${fixture.name}" (${fixture.holes.length} holes).`;
			})
			.catch((e) => console.error('[mockBoot] import page', e));
	});

	// choreography state: spread/grow -> crop drawers -> badges light -> slide to stitch
	let vpAnimate = $state(false);
	let clipInsets = $state<CropInsets | null>(null);
	let clipAnimate = $state(false);
	let showBadges = $state(false);
	let alignEnabled = false;

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
			await purpleMassDetector(raster, (e) => emitted.push(e));
			if (seq !== selectionSeq) return;
			detections = { ...detections, [img.objectUrl]: emitted.slice() };
			purpleReady = { ...purpleReady, [img.objectUrl]: true };
			considerAutoThrownRound();

			await labEndpointDetector(raster, (e) => emitted.push(e));
			if (seq !== selectionSeq) return;
			detections = { ...detections, [img.objectUrl]: emitted };
			const byType: Record<string, number> = {};
			for (const e of emitted) {
				const key = e.kind === 'object' ? e.objType : e.kind;
				byType[key] = (byType[key] ?? 0) + 1;
			}
			dbg('detector done', img.file.name, byType);
		} catch (e) {
			if (seq === selectionSeq) {
				purpleReady = { ...purpleReady, [img.objectUrl]: true };
				considerAutoThrownRound();
			}
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
		if (!showBadges) return imgs.map(() => []);

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
				// crop-adjusted tile-local coords (no placement yet — the layer itself is already positioned at `placements[i]`)
				const p = projectToComposite({ xPx: e.xPx, yPx: e.yPx }, appliedInsets);
				out.push({ n, x: p.xPx, y: p.yPx, conf: e.confidence });
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
							// a.x/a.y are already crop-adjusted — only add each tile's placement to reach composite-space
							const pa = projectToComposite({ xPx: a.x, yPx: a.y }, null, placements[i]);
							const pb = projectToComposite({ xPx: b.x, yPx: b.y }, null, placements[j]);
							if (Math.hypot(pa.xPx - pb.xPx, pa.yPx - pb.yPx) <= MATCH_RADIUS_PX) {
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

	// TEMP DEBUG (remove before merge prep): one-click dump of everything the
	// page knows, for LAB triage. Filenames keyed to the moment.
	function exportDebug() {
		const byType: Record<string, number> = {};
		for (const list of Object.values(detections)) {
			for (const e of list) {
				const key = e.kind === 'object' ? `object:${e.objType}` : e.kind;
				byType[key] = (byType[key] ?? 0) + 1;
			}
		}
		dbg('emission counts', byType);
		const dump = {
			exportedAt: new Date().toISOString(),
			phase,
			imageNames: images.map((i) => i.file.name),
			thrownIdx,
			appliedInsets,
			placements,
			placementSource,
			emissionCountsByType: byType,
			detections,
			preRead,
			cleanHoles,
			pairs
		};
		const blob = new Blob([JSON.stringify(dump, null, 1)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `chainspot-debug-${Date.now()}.json`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 5000);
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

	function releaseScoutThumbnails() {
		for (const trace of scoutTraces) trace.thumbnailBitmap?.close();
		for (const trace of selectiveFullDecodeTraces) trace.bitmap?.close();
		scoutTraces = [];
		scoutEvidence = [];
		classificationEvidence = [];
		selectiveFullDecodeTraces = [];
		selectiveFullDecodeEvidence = [];
	}

	async function scoutParamsHash(): Promise<string> {
		const bytes = new TextEncoder().encode('{"featureId":"scout-thumbnails","maxSidePx":256}');
		const digest = await crypto.subtle.digest('SHA-256', bytes);
		return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
			''
		);
	}

	type ScoutCanvasView = {
		readonly trace: ScoutThumbnailTrace;
		readonly evidence?: ClassifyAndScoutEvidence;
	};

	function scoutThumbnailCanvas(node: HTMLCanvasElement, view: ScoutCanvasView) {
		function draw(value: ScoutCanvasView) {
			const bitmap = value.trace.thumbnailBitmap;
			if (!bitmap || !value.trace.thumbnail) return;
			node.width = value.trace.thumbnail.widthPx;
			node.height = value.trace.thumbnail.heightPx;
			const context = node.getContext('2d');
			if (!context) return;
			context.drawImage(bitmap, 0, 0);
			for (const overlay of value.evidence?.visualRender.overlays ?? []) {
				if (overlay.thumbnailRect === 'UNKNOWN') continue;
				const rect = overlay.thumbnailRect;
				context.strokeStyle = overlay.verdict === 'candidate' ? '#c000ff' : '#ff4040';
				context.lineWidth = 2;
				context.strokeRect(
					rect.leftPx,
					rect.topPx,
					rect.rightPx - rect.leftPx,
					rect.bottomPx - rect.topPx
				);
			}
		}
		draw(view);
		return { update: draw };
	}

	function selectiveFullDecodeCanvas(node: HTMLCanvasElement, trace: SelectiveFullDecodeTrace) {
		function draw(value: SelectiveFullDecodeTrace) {
			const bitmap = value.bitmap;
			if (!bitmap) return;
			node.width = bitmap.width;
			node.height = bitmap.height;
			node.getContext('2d')?.drawImage(bitmap, 0, 0);
		}
		draw(trace);
		return { update: draw };
	}

	// ---- semantic stitch: align tiles geometrically from shared badge numbers.
	// 'spread' placements auto-upgrade when matches exist; any manual drag or
	// pixel-stitch run stops the auto-upgrade from fighting the user.
	let placementSource: 'none' | 'spread' | 'semantic' | 'pixel' | 'manual' = 'none';

	function badgeCentersOf(img: LoadedImage | undefined): BadgeCenter[] {
		if (!img) return [];
		const emitted = detections[img.objectUrl];
		if (!emitted) return [];
		const labelByDet = new Map(
			emitted.filter((e) => e.kind === 'label').map((e) => [e.detId, e.n])
		);
		const seen = new Set<number>();
		const out: BadgeCenter[] = [];
		for (const e of emitted) {
			if (e.kind !== 'object' || e.objType !== 'hole-badge') continue;
			const n = labelByDet.get(e.detId);
			if (n !== undefined && !seen.has(n)) {
				seen.add(n);
				out.push({ n, x: e.xPx, y: e.yPx });
			}
		}
		return out;
	}

	function trySemanticAlign() {
		if (!alignEnabled) return;
		if (placementSource !== 'spread') return;
		if (mapImages.length < 2 || placements.length !== mapImages.length) return;

		const result = g0TrySemanticAlign(mapImages.map(badgeCentersOf), placements);
		if (!result) return;

		const matchedTiles = result.matches.map(
			({ tileIndex, badgeNumbers }) =>
				`tile ${tileIndex + 1} via badge${badgeNumbers.length > 1 ? 's' : ''} ${badgeNumbers.join(', ')}`
		);
		placements = result.placements.slice();
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

	// where the clicked thumbnail sat on screen, so the thrown-round card can
	// slide from there to its corner instead of popping
	let thrownFromRect: DOMRect | null = null;

	function selectThrownRound(index: number, source: 'auto' | 'manual') {
		thrownFromRect = document.getElementById(`thumb-${index}`)?.getBoundingClientRect() ?? null;
		resetStitchState();
		skipCrop = false;
		thrownIdx = index;
		thrownSelectionSource = source;
		const img = images[index];
		if (img) void runRoundPreRead(img);
		analyze();
	}

	// Extract walk trace + landing droplets from the thrown round while its
	// pixels still exist. Results are round-image px; registration onto the
	// composite happens at confirmAnnotation.
	async function runRoundPreRead(img: LoadedImage) {
		if (preRead[img.objectUrl]) return;
		const seq = selectionSeq;
		try {
			const raster = await rgbaFromFile(img.file);
			// preReadRound itself never throws (empty pre-read is a valid
			// result) — this try/catch is only for rgbaFromFile's own decode
			// failures, which fall through to the same empty-and-valid result.
			const result = await preReadRound(raster);
			if (seq !== selectionSeq) return;
			preRead = { ...preRead, [img.objectUrl]: result };
			dbg('round pre-read done', img.file.name, {
				walkVertices: result.walk.length,
				droplets: result.droplets.length
			});
		} catch (e) {
			if (seq !== selectionSeq) return;
			// An empty pre-read is a valid pre-read: confirm may proceed, Map
			// Round simply gets no trace. Never block the pipeline on CV failure.
			preRead = { ...preRead, [img.objectUrl]: { walk: [], droplets: [] } };
			dbg('round pre-read failed', img.file.name, e instanceof Error ? e.message : e);
		}
	}

	function markThrownRound(index: number) {
		autoThrownEnabled = false;
		selectThrownRound(index, 'manual');
	}

	function considerAutoThrownRound() {
		if (!autoThrownEnabled || thrownIdx >= 0 || images.length === 0) return;
		const scores = images.map((image) =>
			purpleReady[image.objectUrl]
				? (detections[image.objectUrl]?.find(
						(emission) => emission.kind === 'classification' && emission.trait === 'thrown-round'
					)?.confidence ?? 0)
				: undefined
		);
		const decision = decideThrownRound(scores);
		if (decision.status === 'auto') {
			selectThrownRound(decision.index, 'auto');
		} else if (decision.status === 'ambiguous') {
			workflowMessage = `${decision.candidates.length} screenshots contain purple path mass — keep them separate until the thrown-round stitch is decided.`;
		}
	}

	function cardFly() {
		if (!thrownFromRect || typeof window === 'undefined') return { x: -600, y: 150, duration: 700 };
		return {
			x: thrownFromRect.left - (window.innerWidth - 140),
			y: thrownFromRect.top - 80,
			duration: 700
		};
	}

	function reselectThrownRound() {
		resetStitchState();
		phase = 'import';
		review = null;
		replaceArming = null;
		vpAnimate = false;
		showBadges = false;
		alignEnabled = false;
		clipInsets = null;
		clipAnimate = false;
		autoThrownEnabled = false;
		thrownIdx = -1;
		thrownSelectionSource = null;
	}

	function undoCrop() {
		skipCrop = true;
		resetStitchState();
		analyze();
	}

	const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
	const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

	// The choreography: tiles appear spread and grow/center; crops slide in like
	// drawers (pre-computed while the grow plays); badges light up one by one;
	// then the tiles slide into their stitched placement.
	async function analyze() {
		const tiles = images.filter((_, i) => i !== thrownIdx);
		if (tiles.length < 2) {
			workflowMessage = 'Need at least two course tiles besides the thrown round.';
			return;
		}

		const seq = selectionSeq;
		vpAnimate = true;
		showBadges = false;
		alignEnabled = false;
		clipInsets = null;
		displayUrls = tiles.map((image) => image.objectUrl);
		appliedInsets = null;
		placements = initialSpreadPlacements(tiles.map((img) => img.widthPx));
		selectedIdx = 0;
		layoutApproved = false;
		placementSource = 'spread';
		fitKey++;
		workflowMessage = 'Reading the tiles…';
		await nextFrame();

		// worked ahead: rasterize + crop proposal + cropped copies while the
		// grow/center transition plays
		let nextRasters: GrayRaster[];
		try {
			nextRasters = await Promise.all(tiles.map((image) => rasterFromFile(image.file)));
		} catch (e) {
			workflowMessage = `Analyze failed: ${e instanceof Error ? e.message : String(e)}`;
			return;
		}
		if (seq !== selectionSeq) return;
		rasters = nextRasters;

		const cropResult = applyCrop(rasters, placements, { skip: skipCrop });
		dbg('analyze done', { tiles: tiles.length, proposal: cropResult.insets });

		if (cropResult.insets) {
			const proposal = cropResult.insets;
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
			// drawers: animate the clip to the proposed insets on the originals…
			workflowMessage = `Cropping ${proposal.top}/${proposal.bottom}px of chrome…`;
			clipAnimate = true;
			await nextFrame();
			clipInsets = proposal;
			await delay(800);
			if (seq !== selectionSeq) return;
			// …then swap in the real cropped images at the same visual position
			clipAnimate = false;
			clipInsets = null;
			displayUrls = croppedUrls;
			rasters = cropResult.rasters.slice();
			appliedInsets = proposal;
			placements = cropResult.placements.slice();
		}

		// badges light up individually (detection ran at upload; usually done)
		workflowMessage = 'Identifying badges…';
		showBadges = true;
		const badgeCount = tiles.reduce(
			(sum, t) =>
				sum +
				(detections[t.objectUrl]?.filter((e) => e.kind === 'object' && e.objType === 'hole-badge')
					.length ?? 0),
			0
		);
		await delay(Math.min(badgeCount, 8) * 150 + 450);
		if (seq !== selectionSeq) return;

		// slide into the stitched placement
		alignEnabled = true;
		trySemanticAlign();
		await delay(900);
		if (seq !== selectionSeq) return;
		vpAnimate = false;
	}

	// pixel-search fallback, user-invoked only
	function runStitch() {
		if (rasters.length !== mapImages.length || rasters.length < 2) {
			workflowMessage = 'Pixel stitch not ready yet — still reading pixels.';
			return;
		}
		const result = solvePixelStitch(rasters)!; // rasters.length >= 2 just checked above

		placements = result.placements.slice();
		selectedIdx = 0;
		layoutApproved = false;
		placementSource = 'pixel';
		fitKey++;
		dbg('stitch result', result);
		workflowMessage = result.hadFallback
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
			placementIndex === index ? { x: placement.x + deltaX, y: placement.y + deltaY } : placement
		);
		layoutApproved = false;
	}

	function onKeyDown(event: KeyboardEvent) {
		if (!stitchReady || phase !== 'import') return;
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
		const seq = ++selectionSeq;
		const selectedFiles = Array.from(input.files ?? []);
		const runId = `selection-${seq}`;
		const intakePromise = scoutParamsHash().then((paramsHash) =>
			runIntakeFeatureSet({
				selectedFiles,
				runId,
				invocation: 'Stitch Map file picker',
				scoutParamsHash: paramsHash,
				classifyParamsHash: paramsHash,
				scoutEnabled: scoutThumbnailsEnabled
			})
		);
		input.value = '';
		const intake = await intakePromise;
		if (seq !== selectionSeq) return;
		const capture = intake.captureReceipt;
		lastIntakeReceipt = capture;
		intakeAcceptanceReceiptMarkdown = intake.acceptanceReceiptMarkdown;
		console.info(intake.acceptanceReceiptMarkdown);
		if (capture.entries.length === 0) return;

		const results = await Promise.all(
			capture.entries.map((entry) => (entry.ok ? loadImageFromFile(entry.source) : null))
		);

		if (seq !== selectionSeq) {
			for (const r of results) if (r?.ok) releaseImage(r.image);
			for (const trace of intake.thumbnailTraces) trace.thumbnailBitmap?.close();
			for (const trace of intake.selectiveFullDecodeTraces) trace.bitmap?.close();
			return;
		}
		releaseScoutThumbnails();
		scoutTraces = intake.thumbnailTraces;
		scoutEvidence = intake.thumbnailEvidence;
		classificationEvidence = intake.classificationEvidence;
		selectiveFullDecodeTraces = intake.selectiveFullDecodeTraces;
		selectiveFullDecodeEvidence = intake.selectiveFullDecodeEvidence;

		const rejected: string[] = [];
		let addedAny = false;
		for (const [i, entry] of capture.entries.entries()) {
			const r = results[i];
			if (!entry.ok) {
				rejected.push(`${entry.file.name} (${entry.reason})`);
			} else if (!r?.ok) {
				rejected.push(entry.source.file.name);
			} else if (images.length >= MAX_IMAGES) {
				releaseImage(r.image);
				rejected.push(`${entry.source.file.name} (over the ${MAX_IMAGES} image limit)`);
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
			thrownSelectionSource = null;
			autoThrownEnabled = true;
			phase = 'import';
			review = null;
			replaceArming = null;
			cleanHoles = [];
		}
		error = rejected.length > 0 ? `Not added: ${rejected.join(', ')}` : null;
	}

	function clearAll() {
		selectionSeq++;
		resetStitchState();
		for (const img of images) releaseImage(img);
		images = [];
		lastIntakeReceipt = null;
		intakeAcceptanceReceiptMarkdown = null;
		releaseScoutThumbnails();
		detections = {};
		purpleReady = {};
		preRead = {};
		thrownIdx = -1;
		thrownSelectionSource = null;
		autoThrownEnabled = true;
		skipCrop = false;
		error = null;
		phase = 'import';
		review = null;
		replaceArming = null;
		cleanHoles = [];
	}

	// ---- Annotate phase: GuidedReview over the approved composite ----

	function enterAnnotate() {
		// seeds: labeled badge detections projected through current placements
		const seeds: SeedBadge[] = [];
		mapImages.forEach((img, i) => {
			const emitted = detections[img.objectUrl];
			if (!emitted || !placements[i]) return;
			const labelByDet = new Map(
				emitted.filter((e) => e.kind === 'label').map((e) => [e.detId, e.n])
			);
			for (const e of emitted) {
				if (e.kind !== 'object' || e.objType !== 'hole-badge') continue;
				const n = labelByDet.get(e.detId);
				if (n === undefined) continue;
				const p = projectToComposite({ xPx: e.xPx, yPx: e.yPx }, appliedInsets, placements[i]);
				seeds.push({ n, xPx: p.xPx, yPx: p.yPx });
			}
		});
		// strong-hole verdicts come FROM the CV service; the app only obeys
		const strongNs = new Set<number>();
		for (const img of mapImages) {
			for (const e of detections[img.objectUrl] ?? []) {
				if (e.kind === 'strong-hole') strongNs.add(e.n);
			}
		}
		let r = createReview(detectCourse(seeds));
		for (const n of strongNs) r = accept(r, n);
		review = r;
		replaceArming = null;
		layoutApproved = true;
		phase = 'annotate';
		const strongNote = strongNs.size > 0 ? ` (${strongNs.size} strong, auto-accepted)` : '';
		workflowMessage =
			review.holes.length > 0
				? `Layout approved — GuidedReview: ${review.holes.length} holes${strongNote}.`
				: 'Layout approved — no labeled badges detected, nothing to review.';
	}

	function onAccept(holeN: number) {
		if (review) review = accept(review, holeN);
	}
	function onArmReplace(holeN: number, anchor: Anchor) {
		replaceArming = { holeN, anchor };
	}
	function onCancelReplace() {
		replaceArming = null;
	}
	function onCanvasClick(p: { x: number; y: number }) {
		if (phase !== 'annotate' || !review || !replaceArming) return;
		review = replace(review, replaceArming.holeN, replaceArming.anchor, { xPx: p.x, yPx: p.y });
		replaceArming = null;
	}

	function confirmAnnotation() {
		if (!review || !review.done) return;

		// Register the thrown round onto the confirmed course BEFORE the pixel
		// discard: after this function, only vectors exist anywhere.
		const thrown = thrownRound;
		let roundNote = '';
		if (thrown) {
			const pre = preRead[thrown.objectUrl];
			if (!pre) {
				workflowMessage = 'Still reading the thrown round — give it a second, then Confirm again.';
				return;
			}
			const emitted = detections[thrown.objectUrl] ?? [];
			const labelByDet = new Map(
				emitted.filter((e) => e.kind === 'label').map((e) => [e.detId, e.n])
			);
			const roundBadges = emitted.flatMap((e) => {
				if (e.kind !== 'object' || e.objType !== 'hole-badge') return [];
				const n = labelByDet.get(e.detId);
				return n === undefined ? [] : [{ n, xPx: e.xPx, yPx: e.yPx }];
			});
			const compositeBadges = review.holes.map((h) => ({
				n: h.n,
				xPx: h.badge.xPx,
				yPx: h.badge.yPx
			}));
			const pairs = matchByHoleNumber(roundBadges, compositeBadges);
			const t = fitSimilarity(pairs);
			if (t) {
				setMappedRound({
					walk: pre.walk.map((p) => applySimilarity(t, p)),
					droplets: pre.droplets.map((p) => applySimilarity(t, p))
				});
				roundNote = ` Round registered (${pairs.length} badge pairs, ${pre.walk.length} walk vertices, ${pre.droplets.length} landings).`;
			} else {
				setMappedRound(null);
				roundNote = ` Round NOT registered — ${pairs.length} unambiguous badge match(es), need 2; Map Round will show the course only.`;
			}
		} else {
			setMappedRound(null);
		}

		cleanHoles = review.holes;
		// FAIR USE: annotation is done — discard every UDisc-derived pixel NOW.
		// Object URLs revoked, rasters dropped, detections cleared; only the
		// vector course survives.
		selectionSeq++;
		resetStitchState();
		for (const img of images) releaseImage(img);
		images = [];
		detections = {};
		purpleReady = {};
		preRead = {};
		thrownIdx = -1;
		thrownSelectionSource = null;
		review = null;
		replaceArming = null;
		phase = 'clean';
		setCourseMap({ holes: cleanHoles, transform: null });
		workflowMessage = `Course annotated. UDisc pixels discarded — vectors only from here.${roundNote}`;
	}

	// clean-course viewBox from the surviving vectors
	let cleanBBox = $derived.by(() => {
		let x0 = Infinity,
			y0 = Infinity,
			x1 = -Infinity,
			y1 = -Infinity;
		const eat = (p: { xPx: number; yPx: number } | null) => {
			if (!p) return;
			x0 = Math.min(x0, p.xPx);
			y0 = Math.min(y0, p.yPx);
			x1 = Math.max(x1, p.xPx);
			y1 = Math.max(y1, p.yPx);
		};
		for (const h of cleanHoles) {
			eat(h.badge);
			eat(h.tee);
			eat(h.basket);
			for (const b of h.bends) eat(b);
		}
		if (x0 === Infinity) return { x: 0, y: 0, w: 100, h: 100 };
		const pad = 80;
		return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
	});

	// ---- Pairs phase: clean course <-> georeferenced satellite ----
	let satQuery = $state('');
	let satNote = $state<string | null>(null);
	let satMatches = $state<GeocodeMatch[]>([]);
	let satProviderName = $state('');
	let satRaster = $state<{
		url: string;
		bbox: GeoBoundingBox;
		widthPx: number;
		heightPx: number;
		provider: string;
	} | null>(null);
	let pairs = $state<CorrespondencePair[]>([]);
	let pairArming = $state<'blank' | 'satellite' | null>(null);
	let pendingBlankPx: { xPx: number; yPx: number } | null = null;

	let worldTransform = $derived(fitTransform(pairs));
	let sampleDistanceFt = $derived.by(() => {
		if (!worldTransform) return null;
		const h = cleanHoles.find((c) => c.tee && c.basket);
		if (!h || !h.tee || !h.basket) return null;
		return distanceFt(worldTransform, h.tee, h.basket);
	});

	async function satSearch() {
		if (!satQuery.trim()) return;
		satNote = 'Searching…';
		satMatches = [];
		const r = await searchPlace(satQuery.trim());
		if (!r.ok) {
			satNote = `Search failed: ${r.reason}`;
			return;
		}
		satMatches = r.matches;
		satProviderName = r.providerName;
		satNote = r.matches.length === 0 ? 'No matches.' : null;
	}

	async function satPick(m: GeocodeMatch) {
		satMatches = [];
		satNote = 'Fetching satellite imagery…';
		const geom = fetchGeometryFromViewport({ lat: m.lat, lon: m.lon }, m.viewport);
		const bbox = bboxFromCenter(geom.center, geom.radiusMeters);
		const r = await fetchSatellite(bbox, 1024);
		if (!r.ok) {
			satNote = 'All imagery providers failed (see console).';
			dbg('satellite fetch failed', r.attempts);
			return;
		}
		if (satRaster) URL.revokeObjectURL(satRaster.url);
		satRaster = {
			url: URL.createObjectURL(r.blob),
			bbox: r.bbox,
			widthPx: r.widthPx,
			heightPx: r.heightPx,
			provider: r.provider
		};
		satNote = null;
		dbg('satellite ready', { provider: r.provider, bbox: r.bbox });
	}

	function onStartPair() {
		pairArming = 'blank';
		pendingBlankPx = null;
	}
	function onCancelPair() {
		pairArming = null;
		pendingBlankPx = null;
	}
	function onRemovePair(index: number) {
		pairs = pairs.filter((_, i) => i !== index);
	}
	function cleanSvgClick(event: MouseEvent) {
		if (pairArming !== 'blank') return;
		const svg = event.currentTarget as SVGSVGElement;
		const ctm = svg.getScreenCTM();
		if (!ctm) return;
		const pt = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
		pendingBlankPx = { xPx: pt.x, yPx: pt.y };
		pairArming = 'satellite';
	}
	function satClick(event: MouseEvent) {
		if (pairArming !== 'satellite' || !satRaster || !pendingBlankPx) return;
		const img = event.currentTarget as HTMLElement;
		const rect = img.getBoundingClientRect();
		const xPx = ((event.clientX - rect.left) / rect.width) * satRaster.widthPx;
		const yPx = ((event.clientY - rect.top) / rect.height) * satRaster.heightPx;
		const g = pixelToGeo(satRaster, { xPx, yPx });
		pairs = [...pairs, { blankPx: pendingBlankPx, latLng: { lat: g.lat, lng: g.lon } }];
		pendingBlankPx = null;
		pairArming = null;
	}
	function pairsDone() {
		setCourseMap({ holes: cleanHoles, transform: worldTransform });
		// DEV-ONLY fixture minting: prints the exact MockCourseFixture this run
		// just produced (derived geometry only, never pixels) so it can be
		// captured into a static/mock/*.json fixture for the mock-boot flow.
		// COACH: a later automated run scrapes this console line to mint
		// static/mock/therec.json the first time TheRec gets annotated — see
		// mockBoot.ts's fromAnnotationJson doc comment for the corpus-side half.
		if (import.meta.env.DEV) {
			const fixture: MockCourseFixture = {
				name: 'therec',
				holes: cleanHoles,
				transform: worldTransform,
				round: getMappedRound() ?? { walk: [], droplets: [] }
			};
			console.log('CHAINSPOT_FIXTURE ' + JSON.stringify(fixture));
		}
		goto('/map-round');
	}
</script>

<svelte:window onkeydown={onKeyDown} />

<div
	bind:clientHeight={headerH}
	style="display: flex; gap: 1rem; align-items: baseline; flex-wrap: wrap;"
>
	<h1 style="margin: 0.25rem 0; font-size: 1.5rem;">Stitch Map</h1>
	<input type="file" accept="image/*" multiple onchange={onFileChange} />
	<label
		><input type="checkbox" bind:checked={scoutThumbnailsEnabled} /> Scout thumbnails (experimental)</label
	>
	<button onclick={clearAll}>Clear all</button>
	<!-- TEMP DEBUG (remove before merge prep): full-state export for LAB triage -->
	<button onclick={exportDebug} title="Downloads detections/pre-read/placements as JSON">
		Export debug JSON
	</button>
	{#if error}<span>{error}</span>{/if}
	{#if workflowMessage}<span>{workflowMessage}</span>{/if}
	{#if stitchReady && selectedIdx >= 0}
		<span>Selected: image {selectedIdx + 1} (number keys select, arrows nudge, drag moves)</span>
	{/if}
	{#if layoutApproved}<strong>Layout approved.</strong>{/if}
</div>

{#if lastIntakeReceipt}
	<details>
		<summary>Intake receipt ({lastIntakeReceipt.entries.length} selected files)</summary>
		<pre>{formatSourceCaptureReceipt(lastIntakeReceipt)}</pre>
	</details>
{/if}

{#if scoutEvidence.length > 0}
	<details open>
		<summary>Tick 3–4 visual + CLI evidence ({scoutEvidence.length} images)</summary>
		{#each scoutEvidence as evidence, i (evidence.visualRender.traceHash)}
			<div style="display: flex; gap: 0.5rem; align-items: start; margin: 0.5rem 0;">
				{#if scoutTraces[i]?.thumbnailBitmap}
					<canvas
						use:scoutThumbnailCanvas={{
							trace: scoutTraces[i],
							evidence: classificationEvidence[i]
						}}
						aria-label={`Scout thumbnail ${i + 1} with classification regions`}
					></canvas>
				{/if}
				<div>
					<strong>Measurement / math description</strong>
					<pre style="margin: 0; white-space: pre-wrap;">{evidence.mathText}</pre>
					{#if classificationEvidence[i]}
						<pre style="margin: 0.5rem 0; white-space: pre-wrap;">{classificationEvidence[i]
								.mathText}</pre>
					{/if}
					<strong>Exact CLI text</strong>
					<pre style="margin: 0; white-space: pre-wrap;">{evidence.cliText}</pre>
					{#if classificationEvidence[i]}
						<pre style="margin: 0.5rem 0 0; white-space: pre-wrap;">{classificationEvidence[i]
								.cliText}</pre>
					{/if}
				</div>
			</div>
		{/each}
	</details>
{/if}

{#if selectiveFullDecodeEvidence.length > 0}
	<details open>
		<summary>Tick 5 Acceptance Receipt: selective full-resolution crops</summary>
		{#each selectiveFullDecodeEvidence as evidence, i (evidence.visualRender.traceHash)}
			<div style="display: flex; gap: 0.5rem; align-items: start; margin: 0.5rem 0;">
				{#if selectiveFullDecodeTraces[i]?.bitmap}
					<canvas
						use:selectiveFullDecodeCanvas={selectiveFullDecodeTraces[i]}
						aria-label={`Selective full-resolution crop ${i + 1}`}
						style="max-width: 320px; height: auto;"
					></canvas>
				{:else}
					<pre style="margin: 0; white-space: pre-wrap;">{JSON.stringify(
							evidence.visualRender,
							null,
							2
						)}</pre>
				{/if}
				<div>
					<strong>Measurement / math description</strong>
					<pre style="margin: 0; white-space: pre-wrap;">{evidence.mathText}</pre>
					<strong>Exact CLI text</strong>
					<pre style="margin: 0; white-space: pre-wrap;">{evidence.cliText}</pre>
				</div>
			</div>
		{/each}
	</details>
{/if}

{#if intakeAcceptanceReceiptMarkdown}
	<details open>
		<summary>Full hashed Acceptance Receipt: math + VisualRender + CLI</summary>
		<pre style="white-space: pre-wrap;">{intakeAcceptanceReceiptMarkdown}</pre>
	</details>
{/if}

{#if thrownIdx < 0}
	{#if images.length > 0}
		<p>
			<strong>Click the screenshot that shows your throws.</strong> The rest become the course blank.
		</p>
	{/if}
	<div style="display: flex; gap: 1rem; overflow-x: auto;">
		{#each images as img, i (img.objectUrl)}
			{@const thrownScore = detections[img.objectUrl]?.find(
				(emission) => emission.kind === 'classification' && emission.trait === 'thrown-round'
			)?.confidence}
			<div>
				<img
					id={`thumb-${i}`}
					src={img.objectUrl}
					alt={img.file.name}
					style="height: 33vh; width: auto;"
				/>
				<p>
					<button onclick={() => markThrownRound(i)}>Mark as Thrown Round</button><br />
					{img.file.name} - {img.widthPx} x {img.heightPx} px<br />
					{#if thrownScore !== undefined}
						<strong>Thrown-round score: {thrownScore.toFixed(3)}</strong>
					{/if}
				</p>
			</div>
		{/each}
	</div>
{/if}

{#if stitchReady && phase !== 'clean'}
	<ImageViewport
		{layers}
		selectedIndex={selectedIdx}
		{onLayerMove}
		{onCanvasClick}
		cropPreview={null}
		height={`calc(100vh - ${headerH + PAGE_MARGIN_PX * 2 + 2}px)`}
		{fitKey}
		{markers}
		animate={vpAnimate}
		{clipInsets}
		{clipAnimate}
	>
		{#if thrownRound}
			<div
				in:fly={cardFly()}
				style="background: rgba(255,255,255,0.9); border: 1px solid black; padding: 0.25rem; text-align: center;"
			>
				<img
					src={thrownRound.objectUrl}
					alt={thrownRound.file.name}
					style="width: 60px; display: block; margin: 0 auto;"
				/>
				<small
					>Thrown Round{thrownSelectionSource === 'auto' ? ' — purple path detected' : ''}</small
				>
			</div>
		{/if}
		{#if phase === 'import'}
			<button class="vp-btn" onclick={enterAnnotate}><strong>Approve layout</strong></button>
			<button class="vp-btn" onclick={runStitch}>Pixel stitch (fallback)</button>
			{#if appliedInsets}
				<button class="vp-btn" onclick={undoCrop}>Undo crop</button>
			{/if}
			<button class="vp-btn" onclick={reselectThrownRound}>Re-Select Thrown Round</button>
		{:else if phase === 'annotate' && review}
			<GuidedReviewPanel
				{review}
				{replaceArming}
				{onAccept}
				{onArmReplace}
				{onCancelReplace}
				onConfirmAll={confirmAnnotation}
			/>
			<button class="vp-btn" disabled title="Not implemented">Detect bends (this hole)</button>
			<button class="vp-btn" disabled title="Not implemented">Snap to best point</button>
		{/if}
	</ImageViewport>
{/if}

{#if phase === 'clean'}
	<div
		style={`position: relative; display: flex; gap: 6px; height: calc(100vh - ${headerH + PAGE_MARGIN_PX * 2 + 2}px);`}
	>
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<svg
			style="flex: 1; min-width: 0; height: 100%; border: 1px solid black; background: #f2efe6;"
			viewBox={`${cleanBBox.x} ${cleanBBox.y} ${cleanBBox.w} ${cleanBBox.h}`}
			role="img"
			aria-label="Clean course map"
			onclick={cleanSvgClick}
		>
			{#each cleanHoles as h (h.n)}
				{#if h.tee && h.basket}
					<path
						d={`M ${h.tee.xPx} ${h.tee.yPx} ${h.bends.length ? `Q ${h.bends[0].xPx} ${h.bends[0].yPx}` : 'L'} ${h.basket.xPx} ${h.basket.yPx}`}
						stroke="#465446"
						fill="none"
						stroke-width="4"
					/>
				{/if}
				{#if h.tee}
					<path
						d={`M ${h.tee.xPx} ${h.tee.yPx - 14} L ${h.tee.xPx - 14} ${h.tee.yPx + 12} L ${h.tee.xPx + 14} ${h.tee.yPx + 12} Z`}
						fill="#2c4a2c"
					/>
				{/if}
				{#if h.basket}
					<circle
						cx={h.basket.xPx}
						cy={h.basket.yPx}
						r="13"
						fill="none"
						stroke="#2c4a2c"
						stroke-width="5"
					/>
					<circle cx={h.basket.xPx} cy={h.basket.yPx} r="4" fill="#2c4a2c" />
				{/if}
				{#each h.bends as b (b.xPx + ':' + b.yPx)}
					<circle cx={b.xPx} cy={b.yPx} r="6" fill="#465446" />
				{/each}
				<rect
					x={h.badge.xPx - 16}
					y={h.badge.yPx - 16}
					width="32"
					height="32"
					fill="#ffffff"
					stroke="#2c4a2c"
					stroke-width="3"
				/>
				<text x={h.badge.xPx} y={h.badge.yPx + 8} font-size="24" fill="#2c4a2c" text-anchor="middle"
					>{h.n}</text
				>
			{/each}
			{#each pairs as pair, i (i)}
				<circle
					cx={pair.blankPx.xPx}
					cy={pair.blankPx.yPx}
					r="10"
					fill="none"
					stroke="red"
					stroke-width="4"
				/>
				<text x={pair.blankPx.xPx + 14} y={pair.blankPx.yPx + 6} font-size="20" fill="red"
					>P{i + 1}</text
				>
			{/each}
		</svg>

		<div
			style="flex: 1; min-width: 0; height: 100%; border: 1px solid black; background: #9db89d; position: relative; overflow: hidden;"
		>
			{#if satRaster}
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<div style="position: relative; width: 100%; height: 100%;" onclick={satClick}>
					<img
						src={satRaster.url}
						alt="Satellite imagery"
						style="width: 100%; height: 100%; object-fit: fill; display: block;"
						draggable="false"
					/>
					{#each pairs as pair, i (i)}
						{@const sp = {
							xPx:
								((pair.latLng.lng - satRaster.bbox.minLon) /
									(satRaster.bbox.maxLon - satRaster.bbox.minLon)) *
								100,
							yPx:
								((satRaster.bbox.maxLat - pair.latLng.lat) /
									(satRaster.bbox.maxLat - satRaster.bbox.minLat)) *
								100
						}}
						<div
							style={`position: absolute; left: ${sp.xPx}%; top: ${sp.yPx}%; transform: translate(-50%, -50%); width: 18px; height: 18px; border: 4px solid red; border-radius: 50%; pointer-events: none;`}
						></div>
						<span
							style={`position: absolute; left: ${sp.xPx}%; top: ${sp.yPx}%; transform: translate(12px, -8px); color: red; font-weight: bold; pointer-events: none;`}
							>P{i + 1}</span
						>
					{/each}
				</div>
				<small
					style="position: absolute; left: 4px; bottom: 4px; background: rgba(255,255,255,0.85); padding: 1px 5px;"
				>
					{satRaster.provider} · {attributionFor(satProviderName)}
				</small>
			{:else}
				<div
					style="padding: 1rem; background: rgba(255,255,255,0.92); margin: 1rem; border: 1px solid black;"
				>
					<strong>Find the course's satellite imagery</strong><br />
					<input
						placeholder="Course name or address"
						bind:value={satQuery}
						style="width: 60%;"
						onkeydown={(e) => e.key === 'Enter' && satSearch()}
					/>
					<button onclick={satSearch}>Search</button>
					{#if satNote}<p>{satNote}</p>{/if}
					{#each satMatches as m (m.displayName)}
						<p><button onclick={() => satPick(m)}>{m.displayName}</button></p>
					{/each}
					{#if satMatches.length > 0}<small>Results: {attributionFor(satProviderName)}</small>{/if}
				</div>
			{/if}

			<div style="position: absolute; top: 0.5rem; right: 0.5rem;">
				<PairPanel
					{pairs}
					arming={pairArming}
					transform={worldTransform}
					{sampleDistanceFt}
					{onStartPair}
					{onCancelPair}
					{onRemovePair}
					onDone={pairsDone}
				/>
			</div>
		</div>
	</div>
{/if}

<style>
	.vp-btn {
		width: 14rem;
		padding: 0.55rem 0.75rem;
		font-size: 1rem;
	}
</style>
