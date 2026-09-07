<script lang="ts">
	import { onMount } from 'svelte';
	import DiscCard from './DiscCard.svelte';
	import DiscImage from './DiscImage.svelte';
	import BattleView from './BattleView.svelte';
	import PreviewStage from './PreviewStage.svelte';
	import { createSampleWorkspace } from './samples';
	import { loadDraft, saveDraft, readPhoto } from './localDraft';
	import {
		flightKeys,
		formatNumber,
		newId,
		setScore,
		removeEntry,
		moveEntry,
		deleteDisc,
		parseWorkspace,
		type Disc,
		type CardState
	} from './model';

	let workspace = $state(createSampleWorkspace());
	let mode = $state<'card' | 'battle'>('battle');
	let selectedDiscId = $state('sample-buzzz-mint');
	let selectedEntryId = $state<string | null>('entry-1');
	let query = $state('');
	let stateOpen = $state(false);
	let compare = $state(false);
	let clean = $state(false);
	let cardState = $state<CardState>({ highlighted: false, emphasis: 'none' });
	let battleWidth = $state(960);
	let cardWidth = $state(280);
	let actualSize = $state(false);
	let surface = $state<'neutral' | 'light' | 'dark' | 'busy'>('neutral');
	let lastChange = $state<{ entryId: string; from: number; to: number } | null>(null);
	let showDelta = $state(true);
	let ready = $state(false);
	let autoSave = $state(true);
	let saveStatus = $state('Session only');
	let message = $state('');
	let error = $state('');
	let photoBusy = $state(false);
	let photoInput = $state<HTMLInputElement>();
	let draftInput = $state<HTMLInputElement>();
	let selectedDisc = $derived(workspace.discs.find((d) => d.id === selectedDiscId));
	let selectedEntry = $derived(workspace.battle.entries.find((e) => e.id === selectedEntryId));
	let selectedEntryDisc = $derived(workspace.discs.find((d) => d.id === selectedEntry?.discId));
	let cardsAcross = $derived(
		workspace.battleAppearance.layout === 'row'
			? workspace.battle.entries.length
			: workspace.battleAppearance.layout === 'grid'
				? 2
				: 1
	);
	let filteredDiscs = $derived(
		workspace.discs.filter((d) =>
			`${d.manufacturer} ${d.mold} ${d.variant}`.toLowerCase().includes(query.toLowerCase())
		)
	);
	let inspectJson = $derived(
		JSON.stringify(
			{
				domain: workspace.discs.map((d) => ({
					...d,
					image: d.image
						? { alt: d.image.alt, src: `[embedded image: ${d.image.src.length} characters]` }
						: null
				})),
				composition: workspace.battle,
				presentation: {
					card: workspace.cardAppearance,
					battle: workspace.battleAppearance,
					visual: workspace.battleVisual
				},
				editorOnly: {
					mode,
					selectedDiscId,
					selectedEntryId,
					cardState,
					previewWidth: mode === 'battle' ? battleWidth : cardWidth,
					surface,
					actualSize,
					lastChange,
					showDelta
				}
			},
			null,
			2
		)
	);

	onMount(() => {
		try {
			const restored = loadDraft();
			if (restored) {
				workspace = restored;
				selectFirst();
				message = 'Restored this browser’s draft.';
			}
		} catch (e) {
			autoSave = false;
			error = `${(e as Error).message} The stored draft has not been overwritten.`;
			saveStatus = 'Not saved · session only';
		}
		ready = true;
		return () => {
			ready = false;
		};
	});
	$effect(() => {
		const snapshot = JSON.stringify(workspace);
		if (!ready || !autoSave) return;
		saveStatus = 'Saving locally…';
		const timer = setTimeout(() => {
			try {
				saveDraft(JSON.parse(snapshot));
				saveStatus = 'Saved in this browser';
			} catch (e) {
				saveStatus = 'Not saved · session only';
				error = `${(e as Error).message} Your current work is still open; download a draft to keep it.`;
			}
		}, 300);
		return () => clearTimeout(timer);
	});
	function selectFirst() {
		selectedDiscId = workspace.discs[0]?.id ?? '';
		selectedEntryId = workspace.battle.entries[0]?.id ?? null;
		lastChange = null;
	}
	function inspectEntry(id: string) {
		selectedEntryId = id;
		selectedDiscId = workspace.battle.entries.find((e) => e.id === id)?.discId ?? selectedDiscId;
	}
	function updateDisc(patch: Partial<Disc>, id = selectedDiscId) {
		workspace.discs = workspace.discs.map((d) => (d.id === id ? { ...d, ...patch } : d));
	}
	function addDisc() {
		if (workspace.discs.length >= 100) {
			error =
				'This prototype supports 100 local specimens. Save a draft before starting another shelf.';
			return;
		}
		const disc: Disc = {
			id: newId('disc'),
			manufacturer: '',
			mold: '',
			variant: '',
			image: null,
			flight: { speed: null, glide: null, turn: null, fade: null }
		};
		workspace.discs = [...workspace.discs, disc];
		selectedDiscId = disc.id;
		query = '';
		mode = 'card';
		message = 'New disc ready. Add a photo and the facts you know.';
	}
	function duplicate() {
		if (!selectedDisc) return;
		if (workspace.discs.length >= 100) {
			error =
				'This prototype supports 100 local specimens. Save a draft before starting another shelf.';
			return;
		}
		const disc = JSON.parse(JSON.stringify(selectedDisc)) as Disc;
		disc.id = newId('disc');
		disc.variant = `${disc.variant.slice(0, 185)} · copy`;
		workspace.discs = [...workspace.discs, disc];
		selectedDiscId = disc.id;
		query = '';
	}
	function removeDisc() {
		if (!selectedDisc) return;
		try {
			workspace = deleteDisc(workspace, selectedDisc.id);
			selectedDiscId = workspace.discs[0]?.id ?? '';
			message = 'Removed from the local shelf.';
		} catch (e) {
			error = (e as Error).message;
		}
	}
	function addToBattle() {
		if (!selectedDisc || workspace.battle.entries.length >= 4) return;
		const entry = { id: newId('entry'), discId: selectedDisc.id, score: 0 };
		workspace.battle.entries = [...workspace.battle.entries, entry];
		selectedEntryId = entry.id;
		mode = 'battle';
	}
	function replaceInBattle() {
		if (!selectedDisc || !selectedEntry) return;
		workspace.battle.entries = workspace.battle.entries.map((e) =>
			e.id === selectedEntryId ? { ...e, discId: selectedDiscId } : e
		);
		message = 'Disc replaced. Entry score and emphasis are unchanged.';
	}
	function removeFromBattle(id: string) {
		workspace = removeEntry(workspace, id);
		if (selectedEntryId === id) selectedEntryId = workspace.battle.entries[0]?.id ?? null;
		if (lastChange?.entryId === id) lastChange = null;
	}
	function changeScore(id: string, score: number) {
		const entry = workspace.battle.entries.find((e) => e.id === id);
		if (!entry || !Number.isFinite(score)) return;
		lastChange = { entryId: id, from: entry.score, to: score };
		workspace.battle = setScore(workspace.battle, id, score);
	}
	function toggleWinner(id: string) {
		workspace.battleVisual.emphasizedEntryIds = workspace.battleVisual.emphasizedEntryIds.includes(
			id
		)
			? workspace.battleVisual.emphasizedEntryIds.filter((e) => e !== id)
			: [...workspace.battleVisual.emphasizedEntryIds, id];
	}
	function clearVisuals() {
		workspace.battleVisual = { highlightedEntryId: null, emphasizedEntryIds: [] };
		lastChange = null;
	}
	async function uploadPhoto(event: Event) {
		const input = event.currentTarget as HTMLInputElement,
			file = input.files?.[0],
			targetId = selectedDiscId;
		if (!file || !selectedDisc) return;
		photoBusy = true;
		error = '';
		try {
			const image = await readPhoto(file);
			updateDisc({ image }, targetId);
			message = 'Photo added locally as a resized copy. Contain shows the full frame.';
		} catch (e) {
			error = (e as Error).message;
		} finally {
			photoBusy = false;
			input.value = '';
		}
	}
	function downloadDraft() {
		const blob = new Blob([JSON.stringify(workspace, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = 'chainspot-disc-studio.json';
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
		message =
			'Draft contains your discs, photos, composition and appearance. Share only photos you intend to share.';
	}
	async function importDraft(event: Event) {
		const input = event.currentTarget as HTMLInputElement,
			file = input.files?.[0];
		if (!file) return;
		try {
			if (file.size > 4_500_000) throw new Error('Draft is too large (maximum 4.5 MB).');
			const imported = parseWorkspace(await file.text());
			if (!confirm('Replace this workspace with the imported draft?')) return;
			workspace = imported;
			selectFirst();
			autoSave = true;
			error = '';
			message = 'Draft loaded. All states remain manually controlled.';
		} catch (e) {
			error = `${(e as Error).message} The current workspace was not changed.`;
		} finally {
			input.value = '';
		}
	}
	function reset() {
		if (
			confirm(
				'Reset this workspace to sample discs? Download your draft first to keep photos and edits.'
			)
		) {
			workspace = createSampleWorkspace();
			selectFirst();
			autoSave = true;
			error = '';
			message = 'Samples restored.';
		}
	}
</script>

<svelte:head
	><title>ChainSpot · Disc Studio</title><meta
		name="description"
		content="A local design workbench for DiscCard and DiscBattle. No accounts, timing or workflow assumptions."
	/></svelte:head
>

<div class="studio" class:clean>
	<header class="topbar">
		<div class="brand">
			<span class="brand-mark" aria-hidden="true">◎</span><strong>CHAINSPOT</strong><span
				class="divider"
			></span><span>DISC STUDIO</span><small>v0.0</small>
		</div>
		<div class="top-actions">
			<span class="save-status" aria-live="polite"
				><i class:unsaved={saveStatus.startsWith('Not saved')}></i>{saveStatus}</span
			><button class="quiet" onclick={() => (stateOpen = !stateOpen)} aria-expanded={stateOpen}
				>⌘ State</button
			><button class="quiet" onclick={downloadDraft}>Save draft ↓</button><button
				class="quiet"
				onclick={() => draftInput?.click()}>Load</button
			><button class="quiet" onclick={reset}>Reset</button>
		</div>
	</header>
	<input
		type="file"
		accept="application/json,.json"
		bind:this={draftInput}
		onchange={importDraft}
		class="hidden"
		aria-label="Load workspace draft"
	/>
	{#if error}<div class="notice error" role="alert">
			<span>{error}</span><button onclick={() => (error = '')} aria-label="Dismiss error">×</button>
		</div>{/if}
	{#if message}<div class="notice" role="status">
			<span>{message}</span><button onclick={() => (message = '')} aria-label="Dismiss notice"
				>×</button
			>
		</div>{/if}
	<div class="workspace">
		<aside class="shelf panel" aria-label="Disc shelf">
			<div class="panel-heading">
				<div>
					<span class="eyebrow">YOUR RAW MATERIAL</span>
					<h2>Disc shelf <span>{workspace.discs.length}</span></h2>
				</div>
				<button class="round" onclick={addDisc} aria-label="Create a disc">+</button>
			</div>
			<label class="search"
				><span aria-hidden="true">⌕</span><input
					placeholder="Find a disc…"
					aria-label="Search discs"
					bind:value={query}
				/></label
			>
			<div class="shelf-list">
				{#each filteredDiscs as disc (disc.id)}<button
						class="shelf-item"
						class:chosen={selectedDiscId === disc.id}
						onclick={() => (selectedDiscId = disc.id)}
						aria-pressed={selectedDiscId === disc.id}
						data-testid="shelf-disc"
						><div class="thumb"><DiscImage {disc} /></div>
						<div class="shelf-copy">
							<small>{disc.manufacturer || 'NEW DISC'}</small><strong
								>{disc.mold || 'Untitled disc'}</strong
							><span>{disc.variant || 'Add specimen details'}</span><code
								>{flightKeys.map((k) => formatNumber(disc.flight[k])).join(' / ')}</code
							>
						</div>
						{#if disc.image}<span
								class="photo-dot"
								title="Local photo"
								aria-label="Has a local photo"
							></span>{/if}</button
					>{/each}
				{#if filteredDiscs.length === 0}<div class="empty-shelf">
						{workspace.discs.length ? 'No matching discs.' : 'Start with one disc.'}<button
							class="text-button"
							onclick={addDisc}>Create a disc</button
						>
					</div>{/if}
			</div>
			<div class="shelf-footer">
				<button
					class="primary full"
					onclick={addToBattle}
					disabled={!selectedDisc || workspace.battle.entries.length >= 4}
					>+ Add selected to battle</button
				>{#if selectedEntry}<button
						class="outline full"
						onclick={replaceInBattle}
						disabled={!selectedDisc || selectedDiscId === selectedEntry.discId}
						>Replace “{selectedEntryDisc?.mold || 'selected entry'}”</button
					>{/if}
				<p>
					A local shelf, not an account.<br />Samples are illustrations. Add your exact disc photo
					in the inspector.
				</p>
			</div>
		</aside>

		<main class="main">
			<div class="main-heading">
				<div>
					<span class="eyebrow">LESS SETUP. MORE DISC.</span>
					<h1>Make it yours.</h1>
				</div>
				<div class="mode-switch" aria-label="Workbench mode">
					<button
						class:active={mode === 'card'}
						aria-pressed={mode === 'card'}
						onclick={() => (mode = 'card')}>DiscCard</button
					><button
						class:active={mode === 'battle'}
						aria-pressed={mode === 'battle'}
						onclick={() => (mode = 'battle')}
						>DiscBattle <small>{workspace.battle.entries.length}</small></button
					>
				</div>
			</div>
			<div class="preview-toolbar">
				<div class="view-label">{mode === 'battle' ? 'THE COMPOSITION' : 'THE DISC CARD'}</div>
				<div class="toolbar-controls">
					{#if mode === 'battle'}<div class="segmented">
							{#each ['row', 'stack', 'grid'] as layout}<button
									class:active={workspace.battleAppearance.layout === layout}
									onclick={() => {
										workspace.battleAppearance.layout = layout as 'row' | 'stack' | 'grid';
										if (layout === 'stack') battleWidth = 320;
										else battleWidth = 960;
									}}
									aria-label={`Layout ${layout}`}
									aria-pressed={workspace.battleAppearance.layout === layout}>{layout}</button
								>{/each}
						</div>{:else}<div class="segmented">
							<button
								class:active={!cardState.highlighted && cardState.emphasis === 'none'}
								onclick={() => (cardState = { highlighted: false, emphasis: 'none' })}>Idle</button
							><button
								class:active={cardState.highlighted && cardState.emphasis === 'none'}
								onclick={() => (cardState = { highlighted: true, emphasis: 'none' })}
								>Highlight</button
							><button
								class:active={cardState.emphasis === 'winner'}
								onclick={() => (cardState = { highlighted: false, emphasis: 'winner' })}
								>Winner</button
							>
						</div>{/if}<button class="text-button" onclick={() => (clean = !clean)}
						>{clean ? 'Show controls' : 'Preview only ↗'}</button
					>
				</div>
			</div>
			<PreviewStage width={mode === 'battle' ? battleWidth : cardWidth} {surface} {actualSize}>
				{#if mode === 'battle'}
					{#if workspace.battle.entries.length}<BattleView
							{workspace}
							selectedEntryId={clean ? null : selectedEntryId}
							onselect={clean ? undefined : inspectEntry}
							change={lastChange}
							{showDelta}
						/>{:else}<div class="empty-preview">
							<strong>Your battle starts with a disc.</strong>
							<p>Select a disc in the shelf, then add it here.</p>
						</div>{/if}
				{:else if selectedDisc}<DiscCard
						disc={selectedDisc}
						appearance={workspace.cardAppearance}
						state={cardState}
					/>{:else}<div class="empty-preview">Create or select a disc to preview.</div>{/if}
			</PreviewStage>
			<div class="preview-options">
				<label
					>Preview width <select
						aria-label="Preview width"
						value={mode === 'battle' ? battleWidth : cardWidth}
						onchange={(e) => {
							if (mode === 'battle') battleWidth = Number(e.currentTarget.value);
							else cardWidth = Number(e.currentTarget.value);
						}}
						>{#each mode === 'battle' ? [320, 480, 720, 960, 1280] : [180, 240, 280, 360, 420] as w}<option
								value={w}>{w} px</option
							>{/each}</select
					></label
				><label
					>Backdrop <select aria-label="Preview backdrop" bind:value={surface}
						><option value="neutral">Neutral</option><option value="light">Light</option><option
							value="dark">Dark</option
						><option value="busy">Busy</option></select
					></label
				><label class="check-label"
					><input type="checkbox" bind:checked={actualSize} /> 1:1 pixels</label
				>
			</div>
			{#if mode === 'battle' && battleWidth / Math.max(1, cardsAcross) < 180}<p
					class="density-note"
				>
					Density probe: {cardsAcross} cards across {battleWidth} px. Small text may be unreadable; inspect
					at 1:1 or try a wider composition.
				</p>{/if}
			{#if !clean}
				{#if mode === 'battle'}
					<section class="battle-controls" aria-label="Manual battle controls">
						<div class="section-heading">
							<div>
								<span class="eyebrow">MANUAL CONTROLS</span>
								<h2>Try a different moment.</h2>
							</div>
							<button class="text-button" onclick={clearVisuals}>Clear emphasis</button>
						</div>
						<p class="section-note">
							Nothing advances automatically. Select to inspect; highlight to change the graphic.
						</p>
						<div class="entry-table">
							<div class="entry-table-head">
								<span>DISC / ORDER</span><span>SCORE</span><span>ON THE GRAPHIC</span>
							</div>
							{#each workspace.battle.entries as entry, index (entry.id)}{@const disc =
									workspace.discs.find((d) => d.id === entry.discId)}
								<div
									class="entry-row"
									class:selected={selectedEntryId === entry.id}
									data-testid="entry-control"
								>
									<div class="entry-identity">
										<span class="entry-index">{String(index + 1).padStart(2, '0')}</span><button
											class="entry-name"
											onclick={() => inspectEntry(entry.id)}
											aria-label={`Select ${disc?.mold || 'disc'} entry`}
											><strong>{disc?.mold || 'Untitled disc'}</strong><small
												>{selectedEntryId === entry.id ? 'Inspecting' : disc?.manufacturer}</small
											></button
										>
										<div class="order-buttons">
											<button
												onclick={() =>
													(workspace.battle = moveEntry(workspace.battle, entry.id, -1))}
												disabled={index === 0}
												aria-label={`Move ${disc?.mold} earlier`}>↑</button
											><button
												onclick={() =>
													(workspace.battle = moveEntry(workspace.battle, entry.id, 1))}
												disabled={index === workspace.battle.entries.length - 1}
												aria-label={`Move ${disc?.mold} later`}>↓</button
											>
										</div>
									</div>
									<div class="score-stepper">
										<button
											onclick={() => changeScore(entry.id, entry.score - 1)}
											aria-label={`Decrease ${disc?.mold} score`}>−</button
										><input
											type="number"
											step="any"
											value={entry.score}
											aria-label={`${disc?.mold} score`}
											oninput={(e) => {
												if (e.currentTarget.value !== '')
													changeScore(entry.id, e.currentTarget.valueAsNumber);
											}}
											onblur={(e) => (e.currentTarget.value = String(entry.score))}
										/><button
											onclick={() => changeScore(entry.id, entry.score + 1)}
											aria-label={`Increase ${disc?.mold} score`}>+</button
										>
									</div>
									<div class="entry-state">
										<button
											class:pressed={workspace.battleVisual.highlightedEntryId === entry.id}
											aria-pressed={workspace.battleVisual.highlightedEntryId === entry.id}
											onclick={() =>
												(workspace.battleVisual.highlightedEntryId =
													workspace.battleVisual.highlightedEntryId === entry.id ? null : entry.id)}
											aria-label={`Highlight ${disc?.mold}`}>Highlight</button
										><button
											class:winner-on={workspace.battleVisual.emphasizedEntryIds.includes(entry.id)}
											aria-pressed={workspace.battleVisual.emphasizedEntryIds.includes(entry.id)}
											onclick={() => toggleWinner(entry.id)}
											aria-label={`Winner emphasis for ${disc?.mold}`}>★</button
										><button
											class="remove-entry"
											onclick={() => removeFromBattle(entry.id)}
											aria-label={`Remove ${disc?.mold} from battle`}>×</button
										>
									</div>
								</div>{/each}
						</div>
						<div class="controls-footer">
							<label class="check-label"
								><input type="checkbox" bind:checked={workspace.battleAppearance.showScores} /> Show scores</label
							><label class="check-label"
								><input type="checkbox" bind:checked={showDelta} /> Show last score delta</label
							>{#if lastChange}<span class="last-change"
									>{formatNumber(lastChange.from)} → {formatNumber(lastChange.to)}
									<button onclick={() => (lastChange = null)} aria-label="Clear last score delta"
										>×</button
									></span
								>{/if}
						</div>
						<p class="hint">
							★ is a manual winner treatment, not a calculated result. Score direction and video
							workflow are deliberately undefined.
						</p>
					</section>
				{:else}<section class="single-notes">
						<div class="section-heading">
							<div>
								<span class="eyebrow">ONE OBJECT, DIFFERENT STATES</span>
								<h2>The disc stays the disc.</h2>
							</div>
							<button class="text-button" onclick={() => (compare = !compare)}
								>{compare ? 'Hide comparison' : 'Compare states'}</button
							>
						</div>
						<p>
							Change the layout or state without changing the disc’s facts. Your photo belongs to
							this specimen, not every copy of its mold.
						</p>
						{#if compare && selectedDisc}<div class="state-comparison">
								{#each ['Idle', 'Highlight', 'Winner'] as label}<div>
										<span class="eyebrow">{label}</span><DiscCard
											disc={selectedDisc}
											appearance={workspace.cardAppearance}
											state={{
												highlighted: label === 'Highlight',
												emphasis: label === 'Winner' ? 'winner' : 'none'
											}}
										/>
									</div>{/each}
							</div>{/if}
					</section>{/if}
			{/if}
		</main>

		<aside class="inspector panel" aria-label="Disc inspector">
			<div class="panel-heading">
				<div>
					<span class="eyebrow">INSPECT & CHANGE</span>
					<h2>{selectedDisc?.mold || 'Disc details'}</h2>
				</div>
				<span class="live-label">LIVE</span>
			</div>
			{#if selectedDisc}
				<section class="inspector-section">
					<div class="photo-well">
						<DiscImage disc={selectedDisc} /><span
							>{selectedDisc.image ? 'EXACT DISC PHOTO' : 'SAMPLE · NO PHOTO YET'}</span
						>
					</div>
					<input
						type="file"
						accept="image/jpeg,image/png,image/webp"
						bind:this={photoInput}
						onchange={uploadPhoto}
						class="hidden"
						aria-label="Exact disc photo"
					/><button class="outline full" onclick={() => photoInput?.click()} disabled={photoBusy}
						>{photoBusy
							? 'Preparing photo…'
							: selectedDisc.image
								? 'Replace exact photo'
								: '↑ Add exact disc photo'}</button
					>{#if selectedDisc.image}<button
							class="text-button full"
							onclick={() => updateDisc({ image: null })}>Remove photo</button
						>{/if}
					<p class="hint">Stays in this browser. No upload, cutout or recognition.</p>
				</section>
				<section class="inspector-section facts">
					<h3>Disc facts <span>DOMAIN</span></h3>
					<label
						>Manufacturer<input
							aria-label="Disc manufacturer"
							maxlength="200"
							value={selectedDisc.manufacturer}
							oninput={(e) => updateDisc({ manufacturer: e.currentTarget.value })}
							placeholder="e.g. Discraft"
						/></label
					><label
						>Mold / disc name<input
							aria-label="Disc name"
							maxlength="200"
							value={selectedDisc.mold}
							oninput={(e) => updateDisc({ mold: e.currentTarget.value })}
							placeholder="e.g. Buzzz"
						/></label
					><label
						>Specimen details<input
							aria-label="Specimen details"
							maxlength="200"
							value={selectedDisc.variant}
							oninput={(e) => updateDisc({ variant: e.currentTarget.value })}
							placeholder="Plastic, stamp, color, nickname…"
						/></label
					>
					<div class="flight-inputs">
						{#each flightKeys as key}<label
								>{key}<input
									type="number"
									step="any"
									aria-label={`Flight ${key}`}
									value={selectedDisc.flight[key] ?? ''}
									placeholder="—"
									oninput={(e) => {
										if (!selectedDisc) return;
										const v = e.currentTarget.value === '' ? null : e.currentTarget.valueAsNumber;
										if (v === null || Number.isFinite(v))
											updateDisc({ flight: { ...selectedDisc.flight, [key]: v } });
									}}
								/></label
							>{/each}
					</div>
					<div class="fact-actions">
						<button class="text-button" onclick={duplicate}>Duplicate disc</button><button
							class="text-button danger"
							onclick={removeDisc}>Remove</button
						>
					</div>
				</section>
			{/if}
			<section class="inspector-section appearance">
				<h3>Card appearance <span>VIEW</span></h3>
				<p class="hint">Shared across this preview. Does not edit disc facts.</p>
				<label
					>Layout<select aria-label="Card layout" bind:value={workspace.cardAppearance.layout}
						><option value="showcase">Showcase · photo first</option><option value="compact"
							>Compact · score-bug size</option
						></select
					></label
				><label
					>Hierarchy<select
						aria-label="Card hierarchy"
						bind:value={workspace.cardAppearance.hierarchy}
						><option value="name">Name first</option><option value="flight"
							>Flight numbers first</option
						></select
					></label
				><label
					>Surface<select aria-label="Card surface" bind:value={workspace.cardAppearance.theme}
						><option value="ink">Forest ink</option><option value="paper">Warm paper</option
						></select
					></label
				><label
					>Photo framing<select
						aria-label="Photo framing"
						bind:value={workspace.cardAppearance.imageFit}
						><option value="contain">Contain · full photo</option><option value="cover"
							>Fill · crop to fit</option
						></select
					></label
				><label class="check-label"
					><input type="checkbox" bind:checked={workspace.cardAppearance.showVariant} /> Show specimen
					details</label
				>
			</section>
			{#if !autoSave}<button class="outline full" onclick={() => (autoSave = true)}
					>Use this as the local draft</button
				>{/if}
			<div class="inspector-foot">FACTS ≠ APPEARANCE ≠ SELECTION</div>
		</aside>
	</div>
	{#if stateOpen}<section class="state-panel" aria-label="State inspector">
			<div class="section-heading">
				<div>
					<span class="eyebrow">THE ACTUAL RENDER INPUTS</span>
					<h2>No hidden sequence.</h2>
				</div>
				<button class="outline" onclick={() => (stateOpen = false)}>Close state</button>
			</div>
			<p>
				Domain → composition → presentation. Editor-only state is shown separately and is not saved
				in the draft. Image bytes are abbreviated here, not in your draft.
			</p>
			<pre data-testid="state-json">{inspectJson}</pre>
		</section>{/if}
	<footer class="app-footer">
		<span>CHAINSPOT / SMALL TOOLS FOR GOOD DISC STORIES</span><span
			>Local prototype · no accounts · no automatic sequencing</span
		>
	</footer>
</div>

<style>
	:global(body:has(.studio)) {
		margin: 0;
		background: #f5f4ed;
		color: #253c32;
		font-family: Arial, Helvetica, sans-serif;
		font-size: 13px;
	}
	.studio,
	.studio :global(*) {
		box-sizing: border-box;
	}
	.studio {
		--line: #dce0d4;
		--muted: #778579;
		--green: #254333;
		--paper: #fbfaf5;
		min-height: 100vh;
	}
	.studio button,
	.studio input,
	.studio select {
		font: inherit;
	}
	.studio button {
		cursor: pointer;
		transition: background 0.12s;
		touch-action: manipulation;
	}
	.studio button:disabled {
		opacity: 0.38;
		cursor: not-allowed;
	}
	.studio button:focus-visible,
	.studio input:focus-visible,
	.studio select:focus-visible {
		outline: 2px solid #698d41;
		outline-offset: 3px;
	}
	.studio input,
	.studio select {
		color: #253c32;
		background: #fffef9;
		border: 1px solid #d7dcd0;
		border-radius: 6px;
		min-width: 0;
	}
	.studio input {
		padding: 9px 10px;
	}
	.studio select {
		padding: 8px 9px;
	}
	.studio input[type='checkbox'] {
		accent-color: #37533b;
		min-width: 14px;
		width: 14px;
		height: 14px;
		margin: 0;
	}
	.hidden {
		display: none;
	}
	.topbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 14px;
		min-height: 72px;
		padding: 15px 27px;
		border-bottom: 1px solid var(--line);
		background: #fbfaf6;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 11px;
		letter-spacing: 0.1em;
		white-space: nowrap;
		font-size: 11px;
	}
	.brand strong {
		font-size: 16px;
		letter-spacing: 0.12em;
	}
	.brand-mark {
		font-size: 32px;
		line-height: 1;
	}
	.brand .divider {
		width: 1px;
		height: 19px;
		background: #cbd2c5;
		margin: 0 5px;
	}
	.brand small {
		font:
			10px ui-monospace,
			monospace;
		background: #e7ebdf;
		padding: 4px 6px;
		border-radius: 4px;
		letter-spacing: 0;
	}
	.top-actions {
		display: flex;
		gap: 9px;
		align-items: center;
	}
	.quiet {
		background: none;
		border: 0;
		color: #4b604e;
		padding: 7px;
		font-size: 11px !important;
		white-space: nowrap;
	}
	.quiet:hover {
		background: #e9eddf;
		border-radius: 6px;
	}
	.save-status {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 10px;
		color: var(--muted);
		margin-right: 12px;
	}
	.save-status i {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: #698c4e;
	}
	.save-status .unsaved {
		background: #b64e3c;
	}
	.workspace {
		display: grid;
		grid-template-columns: 242px minmax(0, 1fr) 278px;
		max-width: 1920px;
		margin: auto;
	}
	.panel {
		background: #faf9f3;
		min-width: 0;
	}
	.shelf {
		border-right: 1px solid var(--line);
		padding: 25px 16px 20px;
	}
	.inspector {
		border-left: 1px solid var(--line);
		padding: 25px 20px 20px;
	}
	.panel-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin: 0 0 20px;
		gap: 8px;
	}
	.eyebrow {
		font-size: 9px;
		letter-spacing: 0.13em;
		font-weight: 700;
		color: #68775d;
	}
	.panel h2 {
		font-size: 17px;
		letter-spacing: -0.035em;
		margin: 7px 0 0;
		overflow-wrap: anywhere;
	}
	.panel h2 span {
		font-size: 11px;
		margin-left: 4px;
		color: #82917e;
	}
	.round {
		border: 1px solid #cdd5c6;
		background: #fafcf4;
		border-radius: 50%;
		width: 29px;
		height: 29px;
		font-size: 20px !important;
		color: #37563a;
		flex: none;
	}
	.search {
		display: flex;
		gap: 4px;
		align-items: center;
		border: 1px solid var(--line);
		border-radius: 7px;
		padding-left: 10px;
		background: #fffef8;
		margin-bottom: 14px;
	}
	.search input {
		border: 0;
		background: transparent;
		width: 100%;
		font-size: 11px;
	}
	.search span {
		font-size: 21px;
		color: #85927e;
	}
	.shelf-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.shelf-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		border: 1px solid transparent;
		border-radius: 9px;
		background: transparent;
		text-align: left;
		padding: 8px 5px;
		position: relative;
		color: #293f32;
	}
	.shelf-item:hover {
		background: #f0f1e7;
	}
	.shelf-item.chosen {
		background: #e9eedf;
		border-color: #c7d3b5;
	}
	.thumb {
		height: 55px;
		width: 55px;
		flex-shrink: 0;
	}
	.shelf-copy {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}
	.shelf-copy small {
		font-size: 8px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: #70816e;
	}
	.shelf-copy strong {
		font-size: 15px;
		letter-spacing: -0.02em;
		overflow-wrap: anywhere;
	}
	.shelf-copy span {
		font-size: 9px;
		color: #74816e;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}
	.shelf-copy code {
		font:
			9px ui-monospace,
			monospace;
		color: #63755d;
		margin-top: 1px;
	}
	.photo-dot {
		position: absolute;
		right: 7px;
		top: 7px;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #6d8d41;
	}
	.shelf-footer {
		border-top: 1px solid var(--line);
		padding-top: 18px;
		margin-top: 19px;
	}
	.shelf-footer p {
		font-size: 10px;
		color: #66775b;
		line-height: 1.7;
		margin: 14px 0 0;
	}
	.shelf-footer .outline {
		margin-top: 7px;
	}
	.primary,
	.outline {
		border-radius: 7px;
		padding: 10px 12px;
		font-size: 11px !important;
		font-weight: 600 !important;
	}
	.primary {
		background: var(--green);
		color: #fafcf2;
		border: 1px solid var(--green);
	}
	.primary:hover {
		background: #35523c;
	}
	.outline {
		background: transparent;
		color: #36513b;
		border: 1px solid #ccd5c2;
	}
	.outline:hover {
		background: #edf0e2;
	}
	.full {
		width: 100%;
	}
	.text-button {
		color: #64764f;
		background: none;
		border: 0;
		font-size: 11px !important;
		padding: 5px 0;
		text-align: left;
	}
	.text-button:hover {
		color: #223f2c;
		text-decoration: underline;
	}
	.text-button.full {
		text-align: center;
	}
	.danger {
		color: #9b6859 !important;
	}
	.main {
		padding: 26px 28px 30px;
		min-width: 0;
	}
	.main-heading {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 15px;
		margin-bottom: 28px;
	}
	h1 {
		font-family: Georgia, serif;
		font-size: 33px;
		letter-spacing: -0.045em;
		font-weight: 400;
		margin: 7px 0 0;
	}
	.mode-switch {
		display: flex;
		gap: 4px;
		padding: 4px;
		border: 1px solid var(--line);
		background: #eeefe6;
		border-radius: 8px;
	}
	.mode-switch button {
		border: 0;
		background: none;
		color: #819076;
		padding: 9px 13px;
		font-size: 11px;
		border-radius: 5px;
		white-space: nowrap;
	}
	.mode-switch button.active {
		background: #fffef7;
		color: #304833;
		box-shadow: 0 1px 3px #263c3214;
		font-weight: bold;
	}
	.mode-switch small {
		margin-left: 5px;
		color: #829076;
	}
	.preview-toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 10px;
		margin-bottom: 13px;
	}
	.view-label {
		font-size: 9px;
		font-weight: bold;
		letter-spacing: 0.1em;
		color: #7d8973;
	}
	.toolbar-controls {
		display: flex;
		align-items: center;
		gap: 15px;
	}
	.segmented {
		display: flex;
		gap: 2px;
		padding: 3px;
		background: #e9ebdf;
		border-radius: 5px;
	}
	.segmented button {
		border: 0;
		background: transparent;
		color: #7b886f;
		padding: 5px 9px;
		font-size: 10px !important;
		border-radius: 3px;
		text-transform: capitalize;
	}
	.segmented button.active {
		background: #fdfcf6;
		color: #364e37;
		box-shadow: 0 1px 2px #0001;
	}
	.preview-options {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 16px;
		padding: 14px 0;
		color: #66765c;
		font-size: 10px;
	}
	.preview-options label {
		display: flex;
		gap: 7px;
		align-items: center;
	}
	.preview-options select {
		padding: 5px;
		font-size: 10px;
		background: #f7f7ed;
	}
	.section-heading {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
	}
	.section-heading h2 {
		font-size: 18px;
		letter-spacing: -0.035em;
		font-weight: 500;
		margin: 6px 0 0;
	}
	.section-note {
		font-size: 12px;
		color: #65725b;
		margin: 10px 0 19px;
		line-height: 1.5;
	}
	.battle-controls {
		padding-top: 19px;
		border-top: 1px solid var(--line);
		margin-top: 7px;
	}
	.entry-table {
		border: 1px solid #d6ddce;
		border-radius: 10px;
		background: #fafbf3;
		overflow: hidden;
	}
	.entry-table-head,
	.entry-row {
		display: grid;
		grid-template-columns: minmax(115px, 1fr) 106px 142px;
		gap: 14px;
		align-items: center;
	}
	.entry-table-head {
		font-size: 8px;
		letter-spacing: 0.1em;
		color: #8a957e;
		padding: 12px 16px;
		border-bottom: 1px solid #dde2d4;
		background: #eff1e6;
	}
	.entry-row {
		padding: 11px 16px;
		border-bottom: 1px solid #e2e6d9;
	}
	.entry-row:last-child {
		border-bottom: 0;
	}
	.entry-row.selected {
		background: #eaf0df;
	}
	.entry-identity {
		display: flex;
		gap: 10px;
		align-items: center;
		min-width: 0;
	}
	.entry-index {
		font:
			10px ui-monospace,
			monospace;
		color: #9ba58f;
	}
	.entry-name {
		border: 0;
		background: none;
		text-align: left;
		color: #365239;
		min-width: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex: 1;
	}
	.entry-name strong {
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.entry-name small {
		font-size: 9px;
		color: #859476;
	}
	.order-buttons {
		display: flex;
		flex-direction: column;
	}
	.order-buttons button {
		border: 0;
		background: none;
		padding: 0 4px;
		font-size: 12px !important;
		color: #7c8f6b;
	}
	.score-stepper {
		display: flex;
		align-items: center;
		border: 1px solid #d1dbc5;
		border-radius: 6px;
		overflow: hidden;
		background: #fffff8;
		height: 30px;
	}
	.score-stepper button {
		border: 0;
		background: none;
		padding: 0;
		width: 28px;
		color: #7b8d68;
		font-size: 15px !important;
		flex-shrink: 0;
	}
	.score-stepper input {
		padding: 2px 0;
		border: 0;
		background: none;
		width: 48px;
		text-align: center;
		font-size: 15px;
		font-variant-numeric: tabular-nums;
		border-radius: 0;
		appearance: textfield;
		-moz-appearance: textfield;
	}
	.score-stepper input::-webkit-inner-spin-button {
		-webkit-appearance: none;
	}
	.entry-state {
		display: flex;
		gap: 5px;
		align-items: center;
		justify-content: flex-end;
	}
	.entry-state button {
		border: 1px solid #d6dfc9;
		background: transparent;
		padding: 6px 7px;
		color: #94a080;
		border-radius: 5px;
		font-size: 9px !important;
		min-height: 28px;
	}
	.entry-state button.pressed {
		background: #d4e6a4;
		border-color: #b9d579;
		color: #456130;
	}
	.entry-state button.winner-on {
		background: #f1dfad;
		border-color: #d5bc77;
		color: #765820;
	}
	.entry-state button.remove-entry {
		border: 0;
		font-size: 16px !important;
		padding: 3px;
		color: #a2aa95;
	}
	.controls-footer {
		display: flex;
		gap: 16px;
		align-items: center;
		margin-top: 14px;
		flex-wrap: wrap;
	}
	.check-label {
		display: flex !important;
		align-items: center;
		gap: 7px !important;
		font-size: 10px;
		color: #7a896b;
	}
	.last-change {
		font:
			10px ui-monospace,
			monospace;
		color: #638047;
		margin-left: auto;
	}
	.last-change button {
		background: none;
		border: 0;
		color: #7e8e71;
		font-size: 14px;
	}
	.hint {
		font-size: 11px;
		line-height: 1.6;
		color: #65755b;
		margin: 10px 0 0;
	}
	.live-label {
		font:
			8px ui-monospace,
			monospace;
		color: #79905c;
		padding: 4px 5px;
		border: 1px solid #d6dfc8;
		border-radius: 3px;
		letter-spacing: 0.1em;
	}
	.photo-well {
		height: 145px;
		background: #e8ecdf;
		border-radius: 10px;
		position: relative;
		overflow: hidden;
		margin-bottom: 9px;
		padding: 7px 28px 17px;
	}
	.photo-well > span {
		position: absolute;
		bottom: 7px;
		left: 0;
		right: 0;
		text-align: center;
		font:
			7px ui-monospace,
			monospace;
		color: #849274;
		letter-spacing: 0.1em;
	}
	.inspector-section {
		padding: 0 0 20px;
		margin: 0 0 20px;
		border-bottom: 1px solid var(--line);
	}
	.inspector-section h3 {
		font-size: 12px;
		font-weight: 500;
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin: 0 0 14px;
	}
	.inspector-section h3 span {
		font:
			8px ui-monospace,
			monospace;
		color: #91a083;
	}
	.inspector-section label {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 11px;
		font-size: 11px;
		color: #5f7156;
	}
	.inspector-section label:last-child {
		margin-bottom: 0;
	}
	.inspector-section input,
	.inspector-section select {
		width: 100%;
		font-size: 11px;
	}
	.flight-inputs {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 6px;
	}
	.flight-inputs label {
		text-transform: capitalize;
		font-size: 9px;
	}
	.flight-inputs input {
		padding: 7px 3px;
		text-align: center;
	}
	.fact-actions {
		display: flex;
		justify-content: space-between;
	}
	.appearance .hint {
		margin: -4px 0 15px;
	}
	.appearance .check-label {
		flex-direction: row;
		margin-top: 15px;
	}
	.appearance .check-label input {
		width: 14px;
	}
	.inspector-foot {
		font:
			8px ui-monospace,
			monospace;
		color: #9aa58f;
		text-align: center;
		letter-spacing: 0.04em;
	}
	.notice {
		padding: 10px 28px;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 14px;
		background: #e9efdf;
		color: #60754c;
		border-bottom: 1px solid #d3e0c4;
		font-size: 11px;
		line-height: 1.5;
	}
	.notice.error {
		background: #f8e9df;
		color: #9c503c;
		border-color: #efd2c2;
	}
	.notice button {
		background: none;
		border: 0;
		color: inherit;
		font-size: 18px;
	}
	.empty-shelf {
		padding: 25px 10px;
		display: flex;
		flex-direction: column;
		gap: 10px;
		color: #7c8d6f;
		font-size: 12px;
	}
	.empty-preview {
		padding: 60px 40px;
		text-align: center;
		color: #65775b;
		background: #fbfff0a8;
		border: 1px dashed #8b9a7b;
		border-radius: 10px;
	}
	.empty-preview strong {
		font:
			26px Georgia,
			serif;
	}
	.empty-preview p {
		font-size: 14px;
	}
	.single-notes {
		padding-top: 22px;
		border-top: 1px solid var(--line);
		margin-top: 8px;
	}
	.single-notes p {
		font-size: 12px;
		line-height: 1.7;
		color: #859078;
		max-width: 600px;
	}
	.state-comparison {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 15px;
		margin-top: 24px;
	}
	.state-comparison > div > .eyebrow {
		display: block;
		margin-bottom: 9px;
	}
	.state-panel {
		margin: 20px 28px;
		padding: 24px;
		border: 1px solid #cdd8c0;
		border-radius: 12px;
		background: #fffef7;
	}
	.state-panel p {
		color: #879579;
		line-height: 1.6;
		font-size: 12px;
	}
	.state-panel pre {
		max-height: 550px;
		overflow: auto;
		padding: 20px;
		background: #1d322a;
		color: #d6e6b8;
		border-radius: 8px;
		font:
			11px/1.6 ui-monospace,
			monospace;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.app-footer {
		display: flex;
		justify-content: space-between;
		gap: 15px;
		padding: 16px 28px;
		border-top: 1px solid var(--line);
		font:
			8px ui-monospace,
			monospace;
		color: #9ba38e;
		letter-spacing: 0.03em;
	}
	.clean .workspace {
		grid-template-columns: minmax(0, 1fr);
		max-width: 1440px;
	}
	.clean .panel {
		display: none;
	}
	.clean .main-heading {
		display: none;
	}
	.clean .main {
		padding: 28px;
	}
	.clean .topbar .save-status {
		display: none;
	}
	.density-note {
		font-size: 11px;
		line-height: 1.5;
		color: #85672f;
		background: #eee6d1;
		padding: 10px 12px;
		border-radius: 6px;
		margin: 0 0 12px;
	}
	@media (min-width: 1600px) {
		.workspace {
			grid-template-columns: 264px minmax(0, 1fr) 304px;
		}
		.main {
			padding: 30px 40px;
		}
		.inspector {
			padding: 28px 25px;
		}
	}
	@media (max-width: 1250px) {
		.workspace {
			grid-template-columns: 215px minmax(0, 1fr) 245px;
		}
		.main {
			padding: 24px 18px;
		}
		.shelf {
			padding: 23px 12px;
		}
		.inspector {
			padding: 23px 14px;
		}
		.main-heading {
			flex-direction: column;
			align-items: flex-start;
			gap: 14px;
		}
		.entry-table-head,
		.entry-row {
			grid-template-columns: minmax(90px, 1fr) 88px 123px;
			gap: 7px;
			padding-left: 10px;
			padding-right: 10px;
		}
		.score-stepper button {
			width: 23px;
		}
		.score-stepper input {
			width: 38px;
		}
		.entry-state {
			gap: 3px;
		}
		.entry-state button {
			padding: 6px 4px;
		}
		.entry-index {
			display: none;
		}
		.topbar {
			padding: 14px 18px;
		}
		.save-status {
			display: none;
		}
		.preview-options {
			gap: 8px;
			flex-wrap: wrap;
		}
		.preview-toolbar {
			flex-wrap: wrap;
		}
	}
	@media (max-width: 1020px) {
		.workspace {
			grid-template-columns: 210px minmax(0, 1fr);
		}
		.inspector {
			grid-column: 1/-1;
			border-left: 0;
			border-top: 1px solid var(--line);
			display: grid;
			grid-template-columns: 1fr 1fr 1fr;
			gap: 22px;
			padding: 22px;
		}
		.inspector .panel-heading {
			grid-column: 1/-1;
			margin-bottom: 0;
		}
		.inspector-foot {
			grid-column: 1/-1;
		}
		.main-heading {
			flex-direction: row;
			align-items: center;
		}
		h1 {
			font-size: 29px;
		}
		.top-actions {
			gap: 3px;
		}
		.brand .divider,
		.brand > span:not(.brand-mark) {
			display: none;
		}
	}
	@media (max-width: 760px) {
		.workspace {
			display: flex;
			flex-direction: column;
		}
		.main {
			order: 0;
			padding: 22px 14px;
		}
		.shelf {
			order: 1;
			border-right: 0;
			border-top: 1px solid var(--line);
		}
		.inspector {
			order: 2;
			display: block;
			padding: 22px 18px;
		}
		.shelf-list {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.shelf-footer {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 9px;
		}
		.shelf-footer .outline {
			margin: 0;
		}
		.shelf-footer p {
			grid-column: 1/-1;
		}
		.topbar {
			padding: 12px 14px;
			gap: 7px;
			flex-wrap: wrap;
		}
		.brand strong {
			font-size: 14px;
		}
		.brand-mark {
			font-size: 25px;
		}
		.top-actions {
			margin-left: auto;
		}
		.quiet {
			font-size: 10px !important;
			padding: 5px;
		}
		.main-heading {
			gap: 10px;
		}
		h1 {
			font-size: 27px;
		}
		.eyebrow {
			font-size: 8px;
		}
		.mode-switch button {
			padding: 8px;
			font-size: 10px;
		}
		.preview-options {
			justify-content: flex-start;
		}
		.entry-table-head,
		.entry-row {
			grid-template-columns: minmax(80px, 1fr) 83px 122px;
			gap: 5px;
		}
		.entry-name strong {
			font-size: 11px;
		}
		.order-buttons button {
			padding: 1px 2px;
		}
		.entry-identity {
			gap: 3px;
		}
		.entry-state button {
			font-size: 8px !important;
		}
		.score-stepper input {
			width: 35px;
		}
		.controls-footer {
			gap: 10px;
		}
		.app-footer {
			padding: 15px;
			flex-wrap: wrap;
			font-size: 7px;
		}
		.state-panel {
			margin: 10px;
			padding: 15px;
		}
		.state-comparison {
			gap: 8px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.studio button {
			transition: none;
		}
	}
</style>
