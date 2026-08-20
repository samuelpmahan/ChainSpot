<script lang="ts">
	/**
	 * ChainSpot front door (`/`): one consolidated entry surface replacing the
	 * old unconditional redirect to `/annotate-course`. A visitor picks image(s)
	 * here and this page figures out where they belong, so the four existing
	 * stage pages stay available (linked below, secondary) but are no longer
	 * the mandatory starting point.
	 *
	 * Routing summary (see the branch functions below for the exact rules):
	 * - Exactly one file: decoded and classified (`classifyImageIntent`).
	 *   - `'likely-thrown'`: run course detection + a Course Memory lookup right
	 *     here. A confident library match hands the round straight to Map
	 *     Round; no match keeps the round aside and asks for a clean course
	 *     map; a detection/lookup failure never dead-ends — it falls back to
	 *     depositing the file at Stitch Map like an ordinary map screenshot.
	 *   - `'likely-map'`: deposited at Stitch Map directly, no picker needed.
	 *   - `'uncertain'`: asks via `ThrownRoundPrompt` rather than guessing.
	 * - Two or more files (or any fall-through above): `ThrownRoundPrompt` asks
	 *   which one (if any) is the thrown round; the rest deposit at Stitch Map.
	 *
	 * "Deposit at Stitch Map" always means the same three steps: arm
	 * `setFrontDoorAutoAdvance()`, hand the files to `setPendingStitchCaptures`,
	 * then `goto` Stitch Map — which claims them, runs its pipeline
	 * immediately, and (on an auto-confidence result) continues straight on to
	 * Annotate Course with no extra click.
	 *
	 * Course Memory geometry is never applied from this page: a confident
	 * match only ever produces a handoff (`setPendingHandoff`) for Map Round's
	 * own existing banner to confirm — the same import gate every other entry
	 * path into that geometry already goes through.
	 */
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import ThrownRoundPrompt from '$lib/components/ThrownRoundPrompt.svelte';
	import { classifyImageIntent } from '$lib/imageHeuristics';
	import type { ImageIntent } from '$lib/imageHeuristics';
	import { readFileBytes } from '$lib/imageIntake';
	import { detectCourseCandidates } from '$lib/autoAnnotation/basketDetection';
	import { badgesToLabeledPoints, findFuzzyMatches, getDefaultCourseLibraryStore } from '$lib/courseLibrary';
	import {
		setFrontDoorAutoAdvance,
		setPendingHandoff,
		setPendingStitchCaptures,
		setThrownRoundSource
	} from '$lib/session';
	import type { LabeledPoint } from '$lib/session';
	import type { HoleNumberBadgeAnchor } from '$lib/domain/project';

	interface PromptItem {
		readonly file: File;
		readonly url: string;
	}

	type Stage =
		| { readonly kind: 'pick' }
		| { readonly kind: 'busy'; readonly fileName: string; readonly message: string }
		| { readonly kind: 'prompt'; readonly items: readonly PromptItem[] }
		| { readonly kind: 'add-clean-map'; readonly note: string };

	let stage = $state<Stage>({ kind: 'pick' });

	function makeItems(files: readonly File[]): PromptItem[] {
		return files.map((file) => ({ file, url: URL.createObjectURL(file) }));
	}

	function revokeItems(items: readonly PromptItem[]): void {
		for (const item of items) URL.revokeObjectURL(item.url);
	}

	onDestroy(() => {
		if (stage.kind === 'prompt') revokeItems(stage.items);
	});

	/** Deposit = the three-step Stitch Map handoff shared by every branch below. */
	function deposit(files: readonly File[]): void {
		setFrontDoorAutoAdvance();
		setPendingStitchCaptures(files);
		void goto(`${base}/stitch-map`);
	}

	function openPrompt(files: readonly File[]): void {
		if (stage.kind === 'prompt') revokeItems(stage.items);
		stage = { kind: 'prompt', items: makeItems(files) };
	}

	/**
	 * Decodes `file` into raw RGBA pixels the way `classifyImageIntent` needs:
	 * `createImageBitmap` -> canvas -> `ImageData`, mirroring the existing
	 * bitmap-to-canvas pattern in `badgeGlyphClassifier.ts`'s `rasterizeTemplate`.
	 * The bitmap is closed in `finally` regardless of outcome.
	 */
	async function decodeToImageData(
		file: File
	): Promise<{ data: Uint8ClampedArray; widthPx: number; heightPx: number }> {
		const bitmap = await createImageBitmap(file);
		try {
			const canvas = document.createElement('canvas');
			canvas.width = bitmap.width;
			canvas.height = bitmap.height;
			const context = canvas.getContext('2d', { willReadFrequently: true });
			if (!context) throw new Error(`Could not read image data for "${file.name}".`);
			context.drawImage(bitmap, 0, 0);
			const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
			return { data: imageData.data, widthPx: bitmap.width, heightPx: bitmap.height };
		} finally {
			bitmap.close();
		}
	}

	/**
	 * Runs course detection on `file` (already classified `'likely-thrown'`)
	 * and looks it up against Course Memory, mirroring exactly how
	 * `AnnotationWorkspace.svelte`'s `recognizeCourse` derives labeled
	 * badges/baskets from a `detectCourseCandidates` result: every
	 * `grammar.holes` proposal that resolved a `numberBadge` contributes a
	 * `HoleNumberBadgeAnchor`, every proposal that resolved a `basket`
	 * contributes a `LabeledPoint` — captured independently of the proposal's
	 * overall ready/incomplete status, since badge and basket ownership each
	 * succeed on their own.
	 *
	 * Confidence criterion: `findFuzzyMatches` already filters its results to
	 * `matched: true` (fit residual within `CONFIDENT_MATCH_NORMALIZED_RMS`)
	 * and sorts by descending confidence, so a non-empty result list's first
	 * entry is by construction the best confident match — no separate
	 * threshold to apply here.
	 *
	 * Never dead-ends: any failure (byte read, detection, or lookup) falls
	 * back to depositing this file at Stitch Map exactly like an ordinary
	 * unmatched map screenshot.
	 */
	async function handleLikelyThrown(file: File, widthPx: number, heightPx: number): Promise<void> {
		stage = { kind: 'busy', fileName: file.name, message: `Checking "${file.name}" against Course Memory…` };
		try {
			const bytes = await readFileBytes(file);
			const result = await detectCourseCandidates(bytes, file.type || 'image/png', widthPx, heightPx, (progress) => {
				if (stage.kind === 'busy') stage = { ...stage, message: progress.message };
			});

			const numberBadges: HoleNumberBadgeAnchor[] = result.grammar.holes
				.filter((proposal) => proposal.numberBadge !== undefined)
				.map((proposal) => ({
					number: proposal.number,
					xPx: proposal.numberBadge!.xPx,
					yPx: proposal.numberBadge!.yPx,
					confidence: proposal.numberBadge!.confidence
				}));
			const labeledBaskets: LabeledPoint[] = result.grammar.holes
				.filter((proposal) => proposal.basket !== undefined)
				.map((proposal) => ({
					holeNumber: proposal.number,
					xPx: proposal.basket!.xPx,
					yPx: proposal.basket!.yPx
				}));

			const matches = await findFuzzyMatches(getDefaultCourseLibraryStore(), {
				badges: badgesToLabeledPoints(numberBadges),
				baskets: labeledBaskets
			});

			if (matches.length > 0) {
				setPendingHandoff({
					blob: file,
					fileName: file.name,
					targetRole: 'source-overview',
					destination: 'map-round'
				});
				await goto(`${base}/map-round`);
				return;
			}

			// No confident match: keep this as the thrown round and ask for the
			// clean course map next, rather than guessing or silently dropping it.
			setThrownRoundSource({ blob: file, fileName: file.name });
			stage = {
				kind: 'add-clean-map',
				note: `We set your round screenshot aside — now add clean course map screenshot(s).`
			};
		} catch {
			stage = {
				kind: 'busy',
				fileName: file.name,
				message: `Couldn't check "${file.name}" against Course Memory — sending it to Stitch Map instead.`
			};
			deposit([file]);
		}
	}

	/** Branch A: exactly one selected file. Never dead-ends on a decode failure either — same Stitch Map fallback as a detection/lookup failure. */
	async function handleSingleFile(file: File): Promise<void> {
		stage = { kind: 'busy', fileName: file.name, message: `Looking at "${file.name}"…` };
		let widthPx: number;
		let heightPx: number;
		let intent: ImageIntent;
		try {
			const decoded = await decodeToImageData(file);
			widthPx = decoded.widthPx;
			heightPx = decoded.heightPx;
			intent = classifyImageIntent(decoded.data, widthPx, heightPx).intent;
		} catch {
			stage = {
				kind: 'busy',
				fileName: file.name,
				message: `Couldn't analyze "${file.name}" — sending it to Stitch Map instead.`
			};
			deposit([file]);
			return;
		}

		if (intent === 'likely-map') {
			// A single map screenshot can't contain a thrown round by the user's
			// own choice (the split only ever happens across multiple files) —
			// deposit directly with no picker.
			deposit([file]);
			return;
		}
		if (intent === 'uncertain') {
			// Ask, never silently route.
			openPrompt([file]);
			return;
		}
		await handleLikelyThrown(file, widthPx, heightPx);
	}

	/** Branch B: 2+ files, or any single-file fall-through above. */
	function handlePromptChoose(index: number | null): void {
		if (stage.kind !== 'prompt') return;
		const items = stage.items;
		const files = items.map((item) => item.file);
		revokeItems(items);
		stage = { kind: 'pick' };

		if (index === null) {
			deposit(files);
			return;
		}
		const chosen = files[index];
		if (!chosen) return;
		setThrownRoundSource({ blob: chosen, fileName: chosen.name });
		const remaining = files.filter((_, candidate) => candidate !== index);
		if (remaining.length === 0) {
			stage = {
				kind: 'add-clean-map',
				note: `We set your round screenshot aside — now add clean course map screenshot(s).`
			};
			return;
		}
		deposit(remaining);
	}

	function handlePromptCancel(): void {
		if (stage.kind !== 'prompt') return;
		revokeItems(stage.items);
		stage = { kind: 'pick' };
	}

	async function handleFileInput(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = '';
		if (files.length === 0) return;
		if (files.length === 1) {
			await handleSingleFile(files[0]);
		} else {
			openPrompt(files);
		}
	}

	/** The add-clean-map sub-step's own input: selection skips classification entirely and deposits straight to Stitch Map, per the plan. */
	function handleAddCleanMapInput(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = '';
		if (files.length === 0) return;
		deposit(files);
	}
</script>

<main>
	<h2>Start a course</h2>

	{#if stage.kind === 'pick'}
		<section class="intake-panel" aria-labelledby="intake-heading">
			<h3 id="intake-heading">Import screenshots</h3>
			<p class="section-note">
				Select one or more UDisc screenshots — a played round, a clean course map, or a mix. We'll
				work out where each one belongs.
			</p>
			<div class="intake-row">
				<label class="file-label">
					Choose screenshots
					<input
						class="file-input"
						type="file"
						accept="image/png,image/jpeg"
						multiple
						data-testid="front-door-input"
						onchange={handleFileInput}
					/>
				</label>
			</div>
		</section>
	{:else if stage.kind === 'busy'}
		<div class="processing-panel" data-testid="front-door-busy">
			<div class="spinner" aria-hidden="true"></div>
			<p role="status">{stage.message}</p>
		</div>
	{:else if stage.kind === 'prompt'}
		<ThrownRoundPrompt items={stage.items} onChoose={handlePromptChoose} onCancel={handlePromptCancel} />
	{:else if stage.kind === 'add-clean-map'}
		<section class="intake-panel" aria-labelledby="clean-map-heading">
			<h3 id="clean-map-heading">Add the course map</h3>
			<p class="section-note">{stage.note}</p>
			<div class="intake-row">
				<label class="file-label">
					Choose course map screenshot(s)
					<input
						class="file-input"
						type="file"
						accept="image/png,image/jpeg"
						multiple
						data-testid="clean-map-input"
						onchange={handleAddCleanMapInput}
					/>
				</label>
			</div>
		</section>
	{/if}

	<nav class="secondary-links" aria-label="Existing workflow pages">
		<span class="secondary-links-label">Or go straight to a stage:</span>
		<a href="{base}/stitch-map">Stitch Map</a>
		<a href="{base}/annotate-course">Annotate Course</a>
		<a href="{base}/map-round">Map Round</a>
		<a href="{base}/create-graphics">Create Graphics</a>
	</nav>
</main>

<style>
	main {
		font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		background-color: #121214;
		color: #e4e4e7;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		max-width: 720px;
		margin: 0 auto;
	}

	h2 {
		margin: 0;
		font-size: 1.35rem;
		color: #f4f4f5;
	}

	h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
		color: #f4f4f5;
	}

	.section-note {
		margin: 0;
		font-size: 0.9rem;
		color: #a1a1aa;
		line-height: 1.5;
	}

	.intake-panel {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1.25rem;
		border: 1px solid #27272a;
		border-radius: 14px;
		background: #18181b;
	}

	.intake-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.file-label {
		display: inline-flex;
		align-items: center;
		padding: 0.5rem 0.9rem;
		border: 1px solid #3f3f46;
		border-radius: 6px;
		background-color: #27272a;
		color: #e4e4e7;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.file-input {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}

	.processing-panel {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		padding: 3rem 1.25rem;
		min-height: 220px;
		border: 1px solid #27272a;
		border-radius: 14px;
		background: #18181b;
	}

	.spinner {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		border: 3px solid #3f3f46;
		border-top-color: #fbbf24;
		animation: front-door-spin 0.9s linear infinite;
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2.4s;
		}
	}

	@keyframes front-door-spin {
		to {
			transform: rotate(360deg);
		}
	}

	.secondary-links {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 0.75rem;
		font-size: 0.78rem;
	}

	.secondary-links-label {
		color: #71717a;
	}

	.secondary-links a {
		color: #a1a1aa;
		text-decoration: none;
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
	}

	.secondary-links a:hover {
		color: #f4f4f5;
		background-color: #27272a;
	}
</style>
