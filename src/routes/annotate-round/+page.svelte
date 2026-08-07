<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import ImagePane from '$lib/components/ImagePane.svelte';
	import { ProjectEditor } from '$lib/domain/editor';
	import { findImageByRole } from '$lib/domain/project';
	import type { ImageAsset } from '$lib/domain/project';
	import type { DecodeImageFile, HashBytes } from '$lib/imageIntake';
	import { intakeImageFile } from '$lib/imageIntake';
	import { retainEditor, takeRetainedEditor } from '$lib/editorSession';
	import { consumePendingHandoff, getPendingHandoff } from '$lib/stitch/handoff';
	import type { PendingHandoff } from '$lib/stitch/handoff';
	import { annotatedSourceImageFromAsset, createAnnotatedRound } from '$lib/domain/annotatedRound';
	import { setPendingAnnotatedRound } from '$lib/annotatedRoundSession';

	interface Props {
		editor?: ProjectEditor;
		decode?: DecodeImageFile;
		hash?: HashBytes;
	}

	let { editor: initialEditor, decode, hash }: Props = $props();
	// svelte-ignore state_referenced_locally
	void hash; // Test-seam parity with create-graphics; this page never saves/opens a bundle.

	/**
	 * Only production-created or session-retrieved editors participate in route
	 * retention; explicitly injected editors (tests/harnesses) never touch the
	 * module-level application session. Deliberately captured once at mount: the
	 * injection decision never changes for a given page instance.
	 */
	// svelte-ignore state_referenced_locally
	const participatesInSession = initialEditor === undefined;
	let editor = $state.raw(resolveInitialEditor());

	function resolveInitialEditor(): ProjectEditor {
		// An explicitly injected editor (tests) wins; otherwise reuse the retained
		// in-memory session across SPA navigation, or start a fresh project.
		return initialEditor ?? takeRetainedEditor('annotate-round') ?? new ProjectEditor();
	}

	onDestroy(() => {
		if (participatesInSession) retainEditor('annotate-round', editor);
	});

	let refreshCount = $state(0);

	function sourceImage(): ImageAsset | null {
		void refreshCount;
		return findImageByRole(editor.state.images, 'source-overview') ?? null;
	}

	/** A stitched PNG awaiting explicit import from the Stitch Map page. */
	let pendingHandoff = $state<PendingHandoff | null>(null);
	let importingHandoff = $state(false);
	let handoffError = $state<string | null>(null);

	/**
	 * Duplicated from create-graphics/+page.svelte's handleHandoffImport rather
	 * than shared: same intake path, minus discard-dialog machinery, because an
	 * Annotate Round project never has correspondence pairs to lose —
	 * confirmDiscard is trivially true here.
	 */
	async function handleHandoffImport(): Promise<void> {
		const handoff = pendingHandoff;
		if (!handoff || importingHandoff) return;
		importingHandoff = true;
		handoffError = null;
		try {
			const file = new File([handoff.blob], handoff.fileName, { type: 'image/png' });
			const result = await intakeImageFile({
				editor,
				role: 'source-overview',
				file,
				decode,
				confirmDiscard: () => true
			});
			if (!result.ok) {
				handoffError = result.error.message;
				return;
			}
			consumePendingHandoff();
			pendingHandoff = null;
			refresh();
		} catch (error) {
			handoffError =
				error instanceof Error ? error.message : 'Could not import the stitched image.';
		} finally {
			importingHandoff = false;
		}
	}

	function handleHandoffDismiss(): void {
		consumePendingHandoff();
		pendingHandoff = null;
		handoffError = null;
	}

	let doneRunning = $state(false);
	let doneError = $state<string | null>(null);

	function canFinishAnnotation(): boolean {
		void refreshCount;
		return sourceImage() !== null;
	}

	/**
	 * Builds this ticket's stub AnnotatedRound (source image only — no holes or
	 * walking path; a future ticket populates those) and hands it to Create
	 * Graphics through the pending session slot.
	 */
	async function handleDone(): Promise<void> {
		const asset = sourceImage();
		if (!asset || doneRunning) return;
		doneRunning = true;
		doneError = null;
		try {
			const resource = editor.getAssetResource(asset.id);
			if (!resource) {
				doneError = 'The source image bytes are no longer available.';
				return;
			}
			const round = createAnnotatedRound({
				sourceImage: annotatedSourceImageFromAsset(asset, resource.bytes)
			});
			setPendingAnnotatedRound(round);
			await goto('/create-graphics');
		} finally {
			doneRunning = false;
		}
	}

	onMount(() => {
		// Gated on participatesInSession so injected-editor unit tests never
		// observe cross-test session leakage from the module-level handoff store.
		const handoff = participatesInSession ? getPendingHandoff() : null;
		pendingHandoff = handoff && handoff.targetRole === 'source-overview' ? handoff : null;
	});

	/** Test hook: forces a re-derive after external domain actions. */
	export function refresh(): void {
		refreshCount += 1;
	}

	/** Test hook: the currently active editor. */
	export function getEditor(): ProjectEditor {
		return editor;
	}
</script>

<svelte:head>
	<title>Annotate Round | ChainSpot</title>
</svelte:head>

<main
	data-testid="annotate-round"
	data-source-loaded={sourceImage() ? 'true' : 'false'}
	data-hole-count="0"
>
	{#if pendingHandoff}
		<section
			class="handoff-banner"
			data-testid="pending-handoff"
			aria-label="Pending stitched image"
		>
			<p>Stitched image “{pendingHandoff.fileName}” is ready to import as the UDisc source.</p>
			<div class="handoff-actions">
				<button
					type="button"
					data-testid="handoff-import"
					disabled={importingHandoff}
					onclick={handleHandoffImport}
				>
					Import
				</button>
				<button
					type="button"
					data-testid="handoff-dismiss"
					disabled={importingHandoff}
					onclick={handleHandoffDismiss}
				>
					Dismiss
				</button>
			</div>
			{#if handoffError}
				<p class="error" data-testid="handoff-error" role="alert">{handoffError}</p>
			{/if}
		</section>
	{/if}

	<header class="toolbar">
		<h1>ChainSpot</h1>
		<button
			type="button"
			data-testid="annotate-done"
			disabled={!canFinishAnnotation() || doneRunning}
			onclick={handleDone}
			title="Finish annotating and move to Create Graphics"
		>
			Done
		</button>
	</header>

	{#if doneError}
		<p class="error" data-testid="annotate-done-error" role="alert">{doneError}</p>
	{/if}

	<section class="panes">
		<ImagePane
			title="UDisc source"
			role="source-overview"
			{editor}
			refresh={refreshCount}
			pairs={[]}
			pendingSource={null}
			placementEnabled={false}
			correctionEnabled={false}
			markersVisible={false}
			{decode}
			confirmDiscard={() => true}
			onDomainChanged={() => refresh()}
		/>
	</section>

	<p class="future-note">
		Hole and shot extraction and review tools are coming in a future ticket. This
		page currently only captures and confirms the UDisc source screenshot.
	</p>
</main>

<style>
	main {
		font-family: system-ui, sans-serif;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	:global(button:focus-visible) {
		outline: 3px solid #075985;
		outline-offset: 2px;
	}

	:global(button:disabled) {
		cursor: not-allowed;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}

	h1 {
		font-size: 1.5rem;
		margin: 0;
	}

	.handoff-banner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem 0.8rem;
		border: 1px solid #166534;
		border-radius: 6px;
		background-color: #052e16;
		color: #bbf7d0;
		font-size: 0.9rem;
	}

	.handoff-banner p {
		margin: 0;
	}

	.handoff-actions {
		display: flex;
		gap: 0.5rem;
		margin-left: auto;
	}

	.handoff-banner .error {
		flex-basis: 100%;
	}

	.error {
		margin: 0;
		padding: 0.4rem 0.6rem;
		border-radius: 4px;
		background: #fdecea;
		border: 1px solid #f5c6cb;
		color: #8a1f11;
		font-size: 0.85rem;
	}

	.panes {
		display: grid;
		grid-template-columns: 1fr;
		gap: 1rem;
		max-width: 32rem;
	}

	.future-note {
		margin: 0;
		font-size: 0.85rem;
		opacity: 0.75;
		max-width: 40rem;
	}

	@media (max-width: 900px) {
		main {
			padding: 0.75rem;
		}
	}
</style>
