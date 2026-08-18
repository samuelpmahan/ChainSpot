<script lang="ts">
	import { onMount } from 'svelte';

	/**
	 * Small cross-route keyboard affordance layer for two controls whose existing
	 * click paths are already authoritative:
	 *
	 * - Enter in Create Graphics' Clean Target location fields clicks the existing
	 *   Search button. No search/provider logic is duplicated here.
	 * - During Annotate Course's final corridor-bends pass, Tab accepts the
	 *   current hole even when it has zero bends (the normal straight-hole case),
	 *   then selects the next not-yet-accepted hole. Once every displayed hole
	 *   has been accepted, it invokes the existing Finish bends action.
	 *
	 * This component deliberately delegates through the existing DOM controls;
	 * it never mutates ProjectEditor/domain geometry itself.
	 */

	let activeBendHoleNumber = $state<number | null>(null);
	let finalBendPassActive = $state(false);
	let acceptedBendHoleNumbers = $state<Set<number>>(new Set());
	let observer: MutationObserver | null = null;

	function testIdNumber(element: Element, prefix: string): number | null {
		const testId = element.getAttribute('data-testid');
		if (!testId?.startsWith(prefix)) return null;
		const value = Number(testId.slice(prefix.length));
		return Number.isInteger(value) && value > 0 ? value : null;
	}

	function currentBendHoleFromIndicator(): number | null {
		const indicator = document.querySelector<HTMLElement>('[data-testid="review-step-indicator"]');
		const text = indicator?.textContent ?? '';
		if (!/\bBENDS\b/i.test(text)) return null;
		const match = text.match(/\bHOLE\s+(\d+)\b/i);
		if (!match) return null;
		const number = Number(match[1]);
		return Number.isInteger(number) && number > 0 ? number : null;
	}

	function bendHoleButtons(): HTMLButtonElement[] {
		const panel = document.querySelector<HTMLElement>('[data-testid="bend-phase-panel"]');
		if (!panel) return [];
		return Array.from(
			panel.querySelectorAll<HTMLButtonElement>('button[data-testid^="bend-phase-hole-"]')
		);
	}

	function syncAcceptedBendButtons(): void {
		for (const button of bendHoleButtons()) {
			const number = testIdNumber(button, 'bend-phase-hole-');
			const accepted = number !== null && acceptedBendHoleNumbers.has(number);
			button.dataset.bendTabAccepted = accepted ? 'true' : 'false';
		}
	}

	function refreshBendState(): void {
		const panelPresent = document.querySelector('[data-testid="bend-phase-panel"]') !== null;
		if (!panelPresent) {
			finalBendPassActive = false;
			activeBendHoleNumber = null;
			if (acceptedBendHoleNumbers.size > 0) acceptedBendHoleNumbers = new Set();
			return;
		}
		finalBendPassActive = true;
		activeBendHoleNumber = currentBendHoleFromIndicator();
		syncAcceptedBendButtons();
	}

	function isCleanTargetSearchField(target: EventTarget | null): target is HTMLInputElement {
		return (
			target instanceof HTMLInputElement &&
			(target.dataset.testid === 'geocode-park-name' || target.dataset.testid === 'geocode-city-state')
		);
	}

	function handleCleanTargetEnter(event: KeyboardEvent): boolean {
		if (
			event.key !== 'Enter' ||
			event.isComposing ||
			event.repeat ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey ||
			!isCleanTargetSearchField(event.target)
		) {
			return false;
		}
		const search = document.querySelector<HTMLButtonElement>('[data-testid="geocode-search-button"]');
		if (!search || search.disabled) return false;
		event.preventDefault();
		search.click();
		return true;
	}

	function orderedBendHoleNumbers(): number[] {
		return bendHoleButtons()
			.map((button) => testIdNumber(button, 'bend-phase-hole-'))
			.filter((number): number is number => number !== null)
			.sort((left, right) => left - right);
	}

	function nextUnacceptedBendHole(after: number): number | null {
		const numbers = orderedBendHoleNumbers();
		const wrapped = [...numbers.filter((number) => number > after), ...numbers.filter((number) => number <= after)];
		return wrapped.find((number) => !acceptedBendHoleNumbers.has(number)) ?? null;
	}

	function acceptCurrentBendsWithTab(event: KeyboardEvent): boolean {
		if (
			event.key !== 'Tab' ||
			event.shiftKey ||
			event.repeat ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey ||
			!finalBendPassActive
		) {
			return false;
		}
		const current = currentBendHoleFromIndicator();
		if (current === null) return false;

		// Own this one Tab before AnnotationWorkspace's window listener sees it.
		// The existing final bends phase has no domain-level per-hole acceptance
		// state; its Finish button is already the authoritative phase completion.
		event.preventDefault();
		event.stopImmediatePropagation();
		acceptedBendHoleNumbers = new Set([...acceptedBendHoleNumbers, current]);
		syncAcceptedBendButtons();

		const next = nextUnacceptedBendHole(current);
		if (next !== null) {
			document
				.querySelector<HTMLButtonElement>(`[data-testid="bend-phase-hole-${next}"]`)
				?.click();
		} else {
			document.querySelector<HTMLButtonElement>('[data-testid="finish-bends"]')?.click();
		}
		queueMicrotask(refreshBendState);
		return true;
	}

	function handleKeyDown(event: KeyboardEvent): void {
		if (handleCleanTargetEnter(event)) return;
		acceptCurrentBendsWithTab(event);
	}

	onMount(() => {
		window.addEventListener('keydown', handleKeyDown, true);
		observer = new MutationObserver(refreshBendState);
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ['class']
		});
		refreshBendState();
		return () => {
			window.removeEventListener('keydown', handleKeyDown, true);
			observer?.disconnect();
			observer = null;
		};
	});
</script>

{#if finalBendPassActive}
	<!-- Explicit instruction missing from the existing bends prompt. This is
	     visible only during that phase and follows the same keyboard contract
	     as the Tab handler above. -->
	<p class="bend-tab-help" data-testid="bend-tab-help" role="status">
		<strong>Tab accepts bends.</strong> Zero bends means a straight hole.
	</p>
{/if}

<style>
	.bend-tab-help {
		position: fixed;
		left: 50%;
		bottom: 1rem;
		z-index: 45;
		transform: translateX(-50%);
		margin: 0;
		padding: 0.45rem 0.75rem;
		border: 1px solid #f59e0b;
		border-radius: 999px;
		background: rgb(24 24 27 / 94%);
		color: #f4f4f5;
		font-size: 0.78rem;
		box-shadow: 0 3px 14px rgb(0 0 0 / 35%);
		pointer-events: none;
	}

	.bend-tab-help strong {
		color: #fbbf24;
	}

	:global(button[data-bend-tab-accepted='true'] .tb span) {
		background: #4fd1c5 !important;
		color: #04211f !important;
	}

	@media (max-width: 640px) {
		.bend-tab-help {
			bottom: max(0.75rem, env(safe-area-inset-bottom));
			max-width: calc(100vw - 2rem);
			white-space: nowrap;
		}
	}
</style>
