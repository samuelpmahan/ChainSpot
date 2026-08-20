<script lang="ts">
	import { onMount } from 'svelte';
	import type { AnnotatedHole } from '$lib/domain/annotatedRound';
	import type { PlayedRoundProposal, UsablePlayedRoundRegistration } from '$lib/playedRoundContract';
	import { detectPlayedRoundLandings } from '$lib/playedRoundDetectionBrowser';
	import { acceptPlayedRoundProposal, createPlayedRoundProposals, proposalCoordinateError, proposalInsertionIndex } from '$lib/playedRoundReview';
	import type { CleanImageBounds } from '$lib/playedRoundReview';
	import { moveShot, reassignShot, removeShot, reorderShot } from '$lib/holeAnnotation';

	interface ProposalDraft {
		holeId: string;
		order: number;
		orderEdited: boolean;
		xPx: number;
		yPx: number;
	}

	interface Props {
		registration: UsablePlayedRoundRegistration;
		holes: readonly AnnotatedHole[];
		cleanImageBounds: CleanImageBounds;
		onHolesChange: (holes: readonly AnnotatedHole[]) => void;
		onShotAccepted?: (shotId: string) => void;
	}

	let { registration, holes, cleanImageBounds, onHolesChange, onShotAccepted }: Props = $props();
	let loading = $state(true);
	let error = $state<string | null>(null);
	let proposals = $state<PlayedRoundProposal[]>([]);
	let drafts = $state<Record<string, ProposalDraft>>({});
	let deferredCount = $state(0);
	let acceptanceErrors = $state<Record<string, string>>({});
	let acceptedEditError = $state<string | null>(null);

	function initialDraft(proposal: PlayedRoundProposal): ProposalDraft {
		const holeId = proposal.suggestedHoleId ?? holes.find((hole) => hole.tee && hole.basket)?.id ?? holes[0]?.id ?? '';
		const hole = holes.find((candidate) => candidate.id === holeId);
		return {
			holeId,
			order: (hole?.shots.length ?? 0) + 1,
			orderEdited: false,
			xPx: proposal.cleanPoint.xPx,
			yPx: proposal.cleanPoint.yPx
		};
	}

	function displayedOrder(draft: ProposalDraft): number {
		if (draft.orderEdited) return draft.order;
		return (holes.find((hole) => hole.id === draft.holeId)?.shots.length ?? 0) + 1;
	}

	function draftError(draft: ProposalDraft): string | null {
		if (!holes.some((hole) => hole.id === draft.holeId)) return 'Choose an available hole before accepting this throw.';
		const coordinateError = proposalCoordinateError({ xPx: draft.xPx, yPx: draft.yPx }, cleanImageBounds);
		if (coordinateError) return coordinateError;
		const order = displayedOrder(draft);
		return Number.isInteger(order) && order >= 1 ? null : 'Order must be a whole number of 1 or greater.';
	}

	function updateDraft(id: string, update: Partial<ProposalDraft>): void {
		drafts = { ...drafts, [id]: { ...drafts[id], ...update } };
	}

	function acceptProposal(proposal: PlayedRoundProposal): void {
		const draft = drafts[proposal.id];
		if (!draft?.holeId) return;
		const validationError = draftError(draft);
		if (validationError) {
			acceptanceErrors = { ...acceptanceErrors, [proposal.id]: validationError };
			return;
		}
		const reviewed = { ...proposal, cleanPoint: { xPx: draft.xPx, yPx: draft.yPx } };
		const shotId = crypto.randomUUID();
		try {
			const next = acceptPlayedRoundProposal(
				holes,
				reviewed,
				draft.holeId,
				() => shotId,
				proposalInsertionIndex(draft.orderEdited ? draft.order : null, holes.find((hole) => hole.id === draft.holeId)?.shots.length ?? 0)
			);
			onHolesChange(next);
			onShotAccepted?.(shotId);
			proposals = proposals.filter((candidate) => candidate.id !== proposal.id);
			const { [proposal.id]: _cleared, ...remainingErrors } = acceptanceErrors;
			acceptanceErrors = remainingErrors;
		} catch (caught) {
			acceptanceErrors = {
				...acceptanceErrors,
				[proposal.id]: caught instanceof Error ? caught.message : 'Could not accept this throw. Review its hole and coordinates.'
			};
		}
	}

	function updateAcceptedLanding(holeId: string, shotId: string, axis: 'xPx' | 'yPx', numeric: number): void {
		const shot = holes.find((hole) => hole.id === holeId)?.shots.find((candidate) => candidate.id === shotId);
		if (!shot) return;
		const landing = { ...shot.landing, [axis]: numeric };
		const validationError = proposalCoordinateError(landing, cleanImageBounds);
		if (validationError) {
			acceptedEditError = validationError;
			return;
		}
		applyAcceptedUpdate(() => moveShot(holes, holeId, shotId, landing));
	}

	function applyAcceptedUpdate(update: () => readonly AnnotatedHole[]): void {
		try {
			onHolesChange(update());
			acceptedEditError = null;
		} catch (caught) {
			acceptedEditError = caught instanceof Error ? caught.message : 'Could not update the accepted throw.';
		}
	}

	onMount(() => {
		let cancelled = false;
		void (async () => {
			try {
				const detected = await detectPlayedRoundLandings(registration.source.blob, registration.source.fileName);
				if (cancelled) return;
				proposals = createPlayedRoundProposals(detected.candidates, registration, holes);
				drafts = Object.fromEntries(proposals.map((proposal) => [proposal.id, initialDraft(proposal)]));
				deferredCount = detected.deferredOverlaps.length;
			} catch (caught) {
				if (!cancelled) error = caught instanceof Error ? caught.message : 'Could not detect played-round landings.';
			} finally {
				if (!cancelled) loading = false;
			}
		})();
		return () => { cancelled = true; };
	});
</script>

<section class="review" data-testid="played-round-proposal-review" aria-labelledby="played-round-review-heading">
	<header>
		<div>
			<h2 id="played-round-review-heading">Review detected throws</h2>
			<p>Detector results are proposals. Correct the hole, landing, and explicit order before accepting them.</p>
		</div>
		{#if loading}<span role="status">Detecting landing droplets…</span>{/if}
	</header>

	{#if error}
		<p class="error" role="alert">{error}</p>
	{:else if !loading}
		<p class="summary" data-testid="played-round-proposal-summary">
			{proposals.length} proposal{proposals.length === 1 ? '' : 's'} pending · {deferredCount} overlap region{deferredCount === 1 ? '' : 's'} deferred for manual review
		</p>
		<div class="proposal-list">
			{#each proposals as proposal (proposal.id)}
				{@const draft = drafts[proposal.id]}
				{#if draft}
					{@const coordinateError = draftError(draft)}
					<article data-testid="played-round-proposal-{proposal.id}">
						<strong>{proposal.evidence.markerKind.toUpperCase()} landing</strong>
						<label>Hole
							<select value={draft.holeId} onchange={(event) => updateDraft(proposal.id, { holeId: event.currentTarget.value })}>
								<option value="">Choose hole</option>
								{#each holes as hole (hole.id)}<option value={hole.id}>Hole {hole.number}</option>{/each}
							</select>
						</label>
						<label>Order <input type="number" min="1" step="1" value={displayedOrder(draft)} oninput={(event) => updateDraft(proposal.id, { order: event.currentTarget.valueAsNumber, orderEdited: true })} /></label>
						<label>X <input type="number" value={draft.xPx} oninput={(event) => updateDraft(proposal.id, { xPx: event.currentTarget.valueAsNumber })} /></label>
						<label>Y <input type="number" value={draft.yPx} oninput={(event) => updateDraft(proposal.id, { yPx: event.currentTarget.valueAsNumber })} /></label>
						<button type="button" disabled={!draft.holeId || coordinateError !== null} onclick={() => acceptProposal(proposal)}>Accept throw</button>
						<button type="button" onclick={() => (proposals = proposals.filter((candidate) => candidate.id !== proposal.id))}>Reject</button>
						{#if coordinateError}<p class="error" role="alert">{coordinateError}</p>{/if}
						{#if acceptanceErrors[proposal.id]}<p class="error" role="alert">{acceptanceErrors[proposal.id]}</p>{/if}
					</article>
				{/if}
			{/each}
		</div>
	{/if}

	{#if holes.some((hole) => hole.shots.length > 0)}
		<section class="accepted" aria-label="Accepted editable throws">
			<h3>Accepted throws</h3>
			{#if acceptedEditError}<p class="error" role="alert">{acceptedEditError}</p>{/if}
			{#each holes as hole (hole.id)}
				{#each hole.shots as shot, index (shot.id)}
					<div class="accepted-row" data-testid="accepted-shot-{shot.id}">
						<strong>Hole {hole.number} · shot {index + 1}</strong>
						<label>X <input type="number" value={shot.landing.xPx} oninput={(event) => updateAcceptedLanding(hole.id, shot.id, 'xPx', event.currentTarget.valueAsNumber)} /></label>
						<label>Y <input type="number" value={shot.landing.yPx} oninput={(event) => updateAcceptedLanding(hole.id, shot.id, 'yPx', event.currentTarget.valueAsNumber)} /></label>
						<button type="button" disabled={index === 0} onclick={() => applyAcceptedUpdate(() => reorderShot(holes, hole.id, shot.id, index - 1))}>↑</button>
						<button type="button" disabled={index === hole.shots.length - 1} onclick={() => applyAcceptedUpdate(() => reorderShot(holes, hole.id, shot.id, index + 1))}>↓</button>
						<select aria-label="Assign accepted shot to hole" value={hole.id} onchange={(event) => applyAcceptedUpdate(() => reassignShot(holes, hole.id, event.currentTarget.value, shot.id))}>
							{#each holes as target (target.id)}<option value={target.id}>Hole {target.number}</option>{/each}
						</select>
						<button type="button" onclick={() => applyAcceptedUpdate(() => removeShot(holes, hole.id, shot.id))}>Remove</button>
					</div>
				{/each}
			{/each}
		</section>
	{/if}
</section>

<style>
	.review { display: flex; flex-direction: column; gap: 0.7rem; padding: 0.8rem; border: 1px solid #2563eb; border-radius: 8px; background: #111827; }
	header, article, .accepted-row { display: flex; align-items: center; gap: 0.65rem; flex-wrap: wrap; }
	header { justify-content: space-between; }
	h2, h3, p { margin: 0; }
	h2 { font-size: 1.05rem; }
	h3 { font-size: 0.9rem; }
	p, label, .summary { font-size: 0.8rem; }
	.proposal-list, .accepted { display: flex; flex-direction: column; gap: 0.45rem; }
	article, .accepted-row { padding: 0.5rem; border: 1px solid #374151; border-radius: 6px; background: #0f172a; }
	input { width: 6.5rem; }
	select { max-width: 9rem; }
	.error { color: #fca5a5; }
</style>
