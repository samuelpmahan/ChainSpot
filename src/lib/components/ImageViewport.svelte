<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { Snippet } from 'svelte';
	import type { ScreenSpacePoint, ViewTransformState } from '$lib/coords';
	import { CLICK_SLOP_PX, ViewportController } from '$lib/viewport.svelte';
	import {
		KEYBOARD_PAN_STEP_PX,
		KEYBOARD_PAN_STEP_SHIFT_MULTIPLIER,
		KEYBOARD_ZOOM_STEP_FACTOR,
		PINCH_GAIN,
		panBy,
		wheelZoomFactor
	} from '$lib/navigation';

	/** Wheel deltaMode 1 ("line" units, e.g. some non-Chromium browsers/mice): approximate CSS pixels per line. */
	const WHEEL_LINE_HEIGHT_PX = 16;

	/**
	 * Appended to whatever `ariaLabel` a consumer supplies (or used alone when
	 * none is given) so every viewport announces the keyboard contract, even the
	 * three consumers that pass their own `ariaLabel`/`role` and are out of this
	 * change's reach — see `docs/imageviewport-event-contract.md` Part 1.7.
	 */
	const KEYBOARD_HINT =
		'Arrow keys pan, hold Shift to pan further. Plus or minus zoom. 0 fits the image.';

	interface Props {
		/** Shared controller; the consumer also reads/writes its view directly. */
		controller: ViewportController;
		testid?: string;
		ariaLabel?: string;
		ariaDescribedby?: string;
		role?: string;
		/**
		 * Called on primary pointer-down inside the viewport. Returning true claims
		 * the gesture for the editor: the viewport performs no panning and no click
		 * for that gesture. The consumer then owns pointer handling (for example a
		 * marker drag or a tile drag) through its own listeners.
		 */
		claimPointer?: (pointer: ScreenSpacePoint, event: PointerEvent) => boolean;
		/**
		 * Called for a normal click (no drag beyond the shared threshold) that the
		 * editor did not claim.
		 */
		onViewportClick?: (pointer: ScreenSpacePoint, event: PointerEvent) => void;
		/**
		 * Optional move/up plumbing for a claimed pointer gesture. The viewport owns
		 * the pointer lifecycle; consumers only receive viewport-local coordinates.
		 */
		onClaimedPointerMove?: (pointer: ScreenSpacePoint, event: PointerEvent) => void;
		onClaimedPointerUp?: (pointer: ScreenSpacePoint, event: PointerEvent) => void;
		onClaimedPointerCancel?: (pointer: ScreenSpacePoint, event: PointerEvent) => void;
		/** The editor-specific scene content; renders inside the viewport container. */
		content: Snippet;
	}

	let {
		controller,
		testid,
		ariaLabel,
		ariaDescribedby,
		role,
		claimPointer,
		onViewportClick,
		onClaimedPointerMove,
		onClaimedPointerUp,
		onClaimedPointerCancel,
		content
	}: Props = $props();

	interface PanGesture {
		pointerId: number;
		start: ScreenSpacePoint;
		transform: ViewTransformState;
		panning: boolean;
	}

	interface PinchGesture {
		pointerIds: [number, number];
		lastDistance: number;
		lastMidpoint: ScreenSpacePoint;
	}

	/**
	 * Default role is `application`, not `img`: the container is now a focusable,
	 * keyboard-operable widget (Arrow pan, +/-/0 zoom/fit — see `onKeyDown`
	 * below), and `role="img"` tells assistive tech the opposite — static,
	 * non-interactive content, with no guarantee that a screen reader's browse
	 * mode even forwards Arrow keys to the page instead of using them itself.
	 * `role="application"` is the standard escape hatch for exactly this
	 * (Google Maps, Figma's canvas): it hands all key events straight to this
	 * component. Consumers may still override via the `role` prop — three do,
	 * unavoidably (see the contract doc) — so `aria-roledescription` below is
	 * added unconditionally as a second, independent layer that improves the
	 * announced semantics even when `role` stays `img`.
	 */
	let effectiveRole = $derived(role ?? 'application');
	let effectiveAriaLabel = $derived(ariaLabel ? `${ariaLabel} ${KEYBOARD_HINT}` : `Image viewport. ${KEYBOARD_HINT}`);

	let gesture: PanGesture | null = null;
	let claimedGesture: { pointerId: number } | null = null;
	let resizeObserver: ResizeObserver | null = null;
	/** Every pointer currently down inside the viewport, tracked regardless of which gesture (if any) owns it — the only way to detect a second touch arriving mid-gesture. */
	let activePointers = new Map<number, ScreenSpacePoint>();
	let pinch: PinchGesture | null = null;

	function distanceBetween(a: ScreenSpacePoint, b: ScreenSpacePoint): number {
		return Math.hypot(a.x - b.x, a.y - b.y);
	}

	function midpointOf(a: ScreenSpacePoint, b: ScreenSpacePoint): ScreenSpacePoint {
		return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	}

	/**
	 * Explicit capture so every subsequent event for this pointer keeps
	 * targeting the viewport no matter where the finger physically wanders —
	 * relying on implicit touch capture alone is inconsistent enough across
	 * mobile browsers that a second finger's move/up events can otherwise go
	 * missing mid-pinch. Capture can throw for a pointer the browser already
	 * released (e.g. a fast double-tap); never let that abort the gesture.
	 */
	function capturePointer(event: PointerEvent): void {
		try {
			controller.container?.setPointerCapture(event.pointerId);
		} catch {
			// Best-effort; move/up still work uncaptured on browsers that reject it.
		}
	}

	function releasePointerCapture(pointerId: number): void {
		try {
			controller.container?.releasePointerCapture(pointerId);
		} catch {
			// Already released (pointer up/cancel typically releases implicitly).
		}
	}

	/**
	 * Normalizes a wheel event's deltas to CSS pixels regardless of `deltaMode`:
	 * mode 0 already reports pixels; mode 1 ("line" units — some non-Chromium
	 * browsers/mice) is scaled by an approximate line height; mode 2 ("page"
	 * units) is scaled by the viewport's own height. Non-finite results (e.g. a
	 * malformed synthetic event) collapse to 0 rather than propagating NaN into
	 * the view transform.
	 */
	function normalizedWheelDelta(event: WheelEvent): ScreenSpacePoint {
		const scale =
			event.deltaMode === 1
				? WHEEL_LINE_HEIGHT_PX
				: event.deltaMode === 2
					? controller.size.height
					: 1;
		const rawX = event.deltaX * scale;
		const rawY = event.deltaY * scale;
		return {
			x: Number.isFinite(rawX) ? rawX : 0,
			y: Number.isFinite(rawY) ? rawY : 0
		};
	}

	/**
	 * macOS trackpad wheel model (mirrors Figma/Google Maps): a plain two-finger
	 * scroll pans, ctrl/meta+wheel (how Chromium reports trackpad pinch, and how
	 * Cmd+scroll is conventionally offered as a zoom modifier) zooms at the
	 * pointer. Any nonzero wheel over the viewport is always consumed via
	 * `preventDefault`, independent of which branch runs below — this is the key
	 * fix: previously a horizontal-only scroll (deltaY === 0) fell through
	 * unprevented and was interpreted by macOS as a history back-swipe, which
	 * destroyed the in-memory session.
	 */
	function onWheel(event: WheelEvent): void {
		// Without fitted content there is nothing meaningful to zoom or pan.
		if (!controller.fitTarget) return;
		const { x: dx, y: dy } = normalizedWheelDelta(event);
		if (dx === 0 && dy === 0) return;
		event.preventDefault();
		if (event.ctrlKey || event.metaKey) {
			// Chromium reports trackpad pinch as ctrl+wheel with deltaY scaled down
			// to roughly a third of an equivalent two-finger scroll; PINCH_GAIN
			// restores a zoom that feels proportionate to the physical gesture.
			controller.zoomAtPointer(controller.pointerIn(event), wheelZoomFactor(dy * PINCH_GAIN));
			return;
		}
		controller.panBy(-dx, -dy);
	}

	/** Zooms about the viewport's own center — what both the on-canvas zoom buttons and keyboard +/- use, since neither has a pointer position to anchor on. Clamped identically to wheel/pinch zoom via `controller.zoomAtCenter` → `zoomLimits()` (`zoomLimitsForFit`). */
	function zoomAboutCenter(factor: number): void {
		controller.zoomAtCenter(factor);
	}

	function handleZoomInClick(): void {
		zoomAboutCenter(KEYBOARD_ZOOM_STEP_FACTOR);
	}

	function handleZoomOutClick(): void {
		zoomAboutCenter(1 / KEYBOARD_ZOOM_STEP_FACTOR);
	}

	function handleFitClick(): void {
		controller.fit();
	}

	/**
	 * Keyboard pan/zoom/fit. Bound directly on this container (not delegated),
	 * so `event.currentTarget` is always this div; bailing when
	 * `event.target !== event.currentTarget` means a keypress that actually
	 * landed on a focusable descendant — the empty-state "Choose image" button
	 * some consumers render inside `content` is the one case in this codebase —
	 * is left alone rather than double-handled. This is the same pattern
	 * stitch-map's `handleAlignmentKeyDown` already uses for its outer
	 * `role="group"` wrapper, which is also why the two nest without conflict:
	 * that wrapper's own guard already rejects events whose target is this
	 * (descendant) element, so Arrow keys act on exactly one of "nudge the
	 * selected tile" or "pan this viewport" depending on which element has
	 * focus, never both (see the contract doc, Part 1.7).
	 *
	 * `preventDefault()` is called for every key this handler recognizes
	 * (pan/zoom/fit) regardless of whether a modifier is held and regardless of
	 * whether `controller.fitTarget` exists — that is deliberate: it is what
	 * stops Cmd/Ctrl+Plus/Minus/0 from triggering the browser's own page-zoom
	 * while this viewport has focus (the Figma/Google Maps convention). The
	 * scoping is entirely via focus: this handler only runs when this element
	 * (or, per the guard above, one of its non-focusable descendants) is the
	 * event target, so the browser's native zoom shortcut is untouched anywhere
	 * else on the page, including every other viewport that isn't focused.
	 */
	function onKeyDown(event: KeyboardEvent): void {
		if (event.target !== event.currentTarget) return;
		switch (event.key) {
			case 'ArrowLeft':
			case 'ArrowRight':
			case 'ArrowUp':
			case 'ArrowDown': {
				event.preventDefault();
				if (!controller.fitTarget) return;
				const step = event.shiftKey
					? KEYBOARD_PAN_STEP_PX * KEYBOARD_PAN_STEP_SHIFT_MULTIPLIER
					: KEYBOARD_PAN_STEP_PX;
				// Mirrors the wheel model's sign convention exactly (`onWheel`
				// pans by `-dx, -dy`): Down/Right behave like scrolling down/right
				// — content shifts up/left, revealing what's below/to the right.
				let dx = 0;
				let dy = 0;
				if (event.key === 'ArrowLeft') dx = step;
				else if (event.key === 'ArrowRight') dx = -step;
				else if (event.key === 'ArrowUp') dy = step;
				else dy = -step;
				controller.panBy(dx, dy);
				return;
			}
			case '+':
			case '=':
				event.preventDefault();
				if (!controller.fitTarget) return;
				zoomAboutCenter(KEYBOARD_ZOOM_STEP_FACTOR);
				return;
			case '-':
			case '_':
				event.preventDefault();
				if (!controller.fitTarget) return;
				zoomAboutCenter(1 / KEYBOARD_ZOOM_STEP_FACTOR);
				return;
			case '0':
				event.preventDefault();
				controller.fit();
				return;
			default:
				return;
		}
	}

	/**
	 * Interactive controls a consumer renders inside `content` (for example the
	 * empty-state "Choose image" button) must keep their native click behavior.
	 * Below, an unclaimed pointerdown calls `setPointerCapture` on this
	 * container to drive panning; that capture retargets the browser's
	 * synthesized click event to the container itself instead of the element
	 * the user actually pressed, so the control's own click handler would never
	 * run. Bail out before any of that when the pointerdown started on (or
	 * inside) a real form control or link.
	 */
	function isInteractiveControl(target: EventTarget | null): boolean {
		return target instanceof Element && target.closest('button, a[href], input, select, textarea, label') !== null;
	}

	function onPointerDown(event: PointerEvent): void {
		if (event.button !== 0) return;
		if (isInteractiveControl(event.target)) return;
		const pointer = controller.pointerIn(event);
		activePointers.set(event.pointerId, pointer);

		// A second touch landing — whether or not a single-pointer gesture is
		// already in flight — starts (or re-anchors) a pinch. Any single-pointer
		// pan or claimed gesture is abandoned so the two systems never fight
		// over the same view transform.
		if (activePointers.size >= 2) {
			capturePointer(event);
			// Mirror cc7924e's mouse/touch asymmetry here too: preventDefault on a
			// mouse-origin pointerdown suppresses compatibility mousemove/mouseup for
			// the rest of that gesture, which would break a mouse-driven Konva drag
			// arriving while a touch is already down.
			if (event.pointerType !== 'mouse') event.preventDefault();
			if (gesture) endGesture();
			if (claimedGesture) {
				onClaimedPointerCancel?.(pointer, event);
				endClaimedGesture();
			}
			startPinch();
			window.addEventListener('pointermove', onAnyPointerMove);
			window.addEventListener('pointerup', onAnyPointerUp);
			window.addEventListener('pointercancel', onAnyPointerUp);
			return;
		}

		if (gesture || claimedGesture) return;
		// The editor may claim the gesture (marker drag, tile drag, crop handle)
		// before viewport panning begins. A claimed gesture must not capture the
		// pointer on this container: some claimants (Konva's own draggable
		// shapes, used by the crop handles) drive their drag entirely through
		// the browser's native mouse events dispatched on their own element,
		// not through this viewport's pointer plumbing. Calling
		// preventDefault() on a mouse-origin pointerdown suppresses every
		// compatibility mouse event (mousemove, mouseup) for the rest of that
		// pointer's gesture, which would silently kill that native drag before
		// it starts; touch input has no such compatibility-event dependency
		// here, so it still gets preventDefault to block scroll/selection.
		if (claimPointer?.(pointer, event)) {
			if (event.pointerType !== 'mouse') event.preventDefault();
			claimedGesture = { pointerId: event.pointerId };
			window.addEventListener('pointermove', handleClaimedPointerMove);
			window.addEventListener('pointerup', handleClaimedPointerUp);
			window.addEventListener('pointercancel', handleClaimedPointerCancel);
			return;
		}
		capturePointer(event);
		event.preventDefault();
		gesture = {
			pointerId: event.pointerId,
			start: pointer,
			transform: { ...controller.view },
			panning: false
		};
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', onPointerCancel);
	}

	/** (Re)anchors the pinch on the first two currently-down pointers. */
	function startPinch(): void {
		const points = [...activePointers.entries()].slice(0, 2);
		if (points.length < 2) {
			pinch = null;
			return;
		}
		const [[idA, a], [idB, b]] = points;
		pinch = { pointerIds: [idA, idB], lastDistance: distanceBetween(a, b), lastMidpoint: midpointOf(a, b) };
	}

	/** Pinch-zoom (about the two-finger midpoint) plus pan-with-midpoint, mirroring native touch editors. */
	function onAnyPointerMove(event: PointerEvent): void {
		if (!activePointers.has(event.pointerId)) return;
		activePointers.set(event.pointerId, controller.pointerIn(event));
		if (!pinch) return;
		const a = activePointers.get(pinch.pointerIds[0]);
		const b = activePointers.get(pinch.pointerIds[1]);
		if (!a || !b) return;
		event.preventDefault();
		const distance = distanceBetween(a, b);
		const midpoint = midpointOf(a, b);
		if (pinch.lastDistance > 0 && distance > 0) {
			controller.zoomAtPointer(midpoint, distance / pinch.lastDistance);
		}
		controller.panBy(midpoint.x - pinch.lastMidpoint.x, midpoint.y - pinch.lastMidpoint.y);
		pinch.lastDistance = distance;
		pinch.lastMidpoint = midpoint;
	}

	function onAnyPointerUp(event: PointerEvent): void {
		activePointers.delete(event.pointerId);
		releasePointerCapture(event.pointerId);
		if (activePointers.size < 2) {
			pinch = null;
			window.removeEventListener('pointermove', onAnyPointerMove);
			window.removeEventListener('pointerup', onAnyPointerUp);
			window.removeEventListener('pointercancel', onAnyPointerUp);
		} else if (pinch && pinch.pointerIds.includes(event.pointerId)) {
			// One of the two pointers the pinch was anchored on just lifted, but a
			// third (e.g. a palm touch) is still down, keeping the count at 2+.
			// Re-anchor onto whichever two pointers remain instead of leaving
			// `pinch` referencing a now-missing finger, which would silently
			// freeze the gesture (onAnyPointerMove no-ops once `a`/`b` is undefined).
			startPinch();
		}
	}

	function onPointerMove(event: PointerEvent): void {
		if (!gesture) return;
		if (event.pointerId !== gesture.pointerId) {
			// The owning pointer never gets another event once these listeners are
			// torn down below; leaving it in activePointers would strand it there
			// forever, letting a later single touch masquerade as a phantom pinch.
			activePointers.delete(gesture.pointerId);
			endGesture();
			return;
		}
		const pointer = controller.pointerIn(event);
		activePointers.set(event.pointerId, pointer);
		const dx = pointer.x - gesture.start.x;
		const dy = pointer.y - gesture.start.y;
		if (!gesture.panning && Math.hypot(dx, dy) > CLICK_SLOP_PX) gesture.panning = true;
		if (gesture.panning) {
			// Pan against the gesture-start transform so a click never drifts.
			controller.view = panBy(gesture.transform, dx, dy);
			controller.panning = true;
		}
	}

	function onPointerUp(event: PointerEvent): void {
		if (!gesture) return;
		if (event.pointerId !== gesture.pointerId) {
			// See onPointerMove: without this the owning pointer is stranded in
			// activePointers forever.
			activePointers.delete(gesture.pointerId);
			endGesture();
			return;
		}
		const active = gesture;
		const pointer = controller.pointerIn(event);
		const isClick =
			!active.panning &&
			Math.hypot(pointer.x - active.start.x, pointer.y - active.start.y) <= CLICK_SLOP_PX &&
			controller.containsPoint(event);
		activePointers.delete(event.pointerId);
		releasePointerCapture(event.pointerId);
		endGesture();
		if (isClick) onViewportClick?.(pointer, event);
	}

	function handleClaimedPointerMove(event: PointerEvent): void {
		if (!claimedGesture) return;
		if (event.pointerId !== claimedGesture.pointerId) {
			// See onPointerMove: without this the owning pointer is stranded in
			// activePointers forever.
			activePointers.delete(claimedGesture.pointerId);
			endClaimedGesture();
			return;
		}
		const pointer = controller.pointerIn(event);
		activePointers.set(event.pointerId, pointer);
		onClaimedPointerMove?.(pointer, event);
	}

	function handleClaimedPointerUp(event: PointerEvent): void {
		if (!claimedGesture) return;
		if (event.pointerId !== claimedGesture.pointerId) {
			// See onPointerMove: without this the owning pointer is stranded in
			// activePointers forever.
			activePointers.delete(claimedGesture.pointerId);
			endClaimedGesture();
			return;
		}
		onClaimedPointerUp?.(controller.pointerIn(event), event);
		activePointers.delete(event.pointerId);
		releasePointerCapture(event.pointerId);
		endClaimedGesture();
	}

	function handleClaimedPointerCancel(event: PointerEvent): void {
		if (!claimedGesture) return;
		if (event.pointerId === claimedGesture.pointerId) {
			onClaimedPointerCancel?.(controller.pointerIn(event), event);
		}
		activePointers.delete(event.pointerId);
		releasePointerCapture(event.pointerId);
		endClaimedGesture();
	}

	function onPointerCancel(event: PointerEvent): void {
		activePointers.delete(event.pointerId);
		releasePointerCapture(event.pointerId);
		endGesture();
	}

	function endGesture(): void {
		gesture = null;
		controller.panning = false;
		if (typeof window === 'undefined') return;
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
		window.removeEventListener('pointercancel', onPointerCancel);
	}

	function endClaimedGesture(): void {
		claimedGesture = null;
		if (typeof window === 'undefined') return;
		window.removeEventListener('pointermove', handleClaimedPointerMove);
		window.removeEventListener('pointerup', handleClaimedPointerUp);
		window.removeEventListener('pointercancel', handleClaimedPointerCancel);
	}

	function handleResize(entries: ResizeObserverEntry[]): void {
		const entry = entries[0];
		if (!entry) return;
		controller.setSize({
			width: entry.contentRect.width > 0 ? entry.contentRect.width : 1,
			height: entry.contentRect.height > 0 ? entry.contentRect.height : 1
		});
	}

	$effect(() => {
		const container = controller.container;
		if (!container) return;
		// Capture the geometry used by the initial fit before ResizeObserver's first
		// asynchronous callback, exactly as the Phase 0 panes did.
		controller.setSize({
			width: container.clientWidth || 1,
			height: container.clientHeight || 1
		});
		if (typeof ResizeObserver !== 'undefined' && !resizeObserver) {
			resizeObserver = new ResizeObserver(handleResize);
			resizeObserver.observe(container);
		}
		// Non-passive wheel so the page never scrolls while zooming.
		container.addEventListener('wheel', onWheel, { passive: false });
		container.addEventListener('pointerdown', onPointerDown);
		return () => {
			container.removeEventListener('wheel', onWheel);
			container.removeEventListener('pointerdown', onPointerDown);
		};
	});

	onDestroy(() => {
		endGesture();
		endClaimedGesture();
		activePointers.clear();
		pinch = null;
		if (typeof window !== 'undefined') {
			window.removeEventListener('pointermove', onAnyPointerMove);
			window.removeEventListener('pointerup', onAnyPointerUp);
			window.removeEventListener('pointercancel', onAnyPointerUp);
		}
		resizeObserver?.disconnect();
		resizeObserver = null;
	});
</script>

<!-- The dynamic `role` (default `application`, see the comment above `effectiveRole`)
     makes this a deliberately keyboard-operable non-native widget, matching
     stitch-map's `alignment-workspace` wrapper (`role="group"`, same two ignores).
     tabindex="0" also serves consumers that restore focus here programmatically
     (e.g. annotate-round's radial menu returning focus on Escape). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="image-viewport"
	class:panning={controller.panning}
	data-testid={testid}
	role={effectiveRole}
	aria-label={effectiveAriaLabel}
	aria-describedby={ariaDescribedby}
	aria-roledescription="zoomable image viewport"
	tabindex="0"
	data-view-zoom={controller.view.zoom}
	data-view-pan-x={controller.view.panX}
	data-view-pan-y={controller.view.panY}
	bind:this={controller.container}
	onkeydown={onKeyDown}
>
	{@render content()}
	{#if controller.fitTarget}
		<div class="viewport-controls" data-testid="viewport-controls">
			<button
				type="button"
				class="viewport-control"
				data-testid="viewport-zoom-in"
				aria-label="Zoom in"
				onclick={handleZoomInClick}
			>
				<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
					<path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
				</svg>
			</button>
			<button
				type="button"
				class="viewport-control"
				data-testid="viewport-zoom-out"
				aria-label="Zoom out"
				onclick={handleZoomOutClick}
			>
				<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
					<path d="M2 8h12" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
				</svg>
			</button>
			<button
				type="button"
				class="viewport-control"
				data-testid="viewport-zoom-fit"
				aria-label="Fit image to viewport"
				onclick={handleFitClick}
			>
				<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
					<path
						d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			</button>
		</div>
	{/if}
</div>

<style>
	.image-viewport {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
		touch-action: none;
		overscroll-behavior: none;
		cursor: grab;
	}

	.image-viewport.panning {
		cursor: grabbing;
	}

	.image-viewport:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 3px #38bdf8;
	}

	.viewport-controls {
		position: absolute;
		right: 8px;
		bottom: 8px;
		z-index: 10;
		display: flex;
		gap: 4px;
		padding: 4px;
		border-radius: 8px;
		background: rgba(24, 24, 27, 0.85);
		border: 1px solid #52525b;
	}

	.viewport-control {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 2.25rem;
		min-height: 2.25rem;
		border-radius: 5px;
		border: 1px solid #52525b;
		background: #27272a;
		color: #f4f4f5;
		cursor: pointer;
		touch-action: manipulation;
	}

	.viewport-control:hover {
		background: #3f3f46;
	}

	.viewport-control:focus-visible {
		outline: 3px solid #38bdf8;
		outline-offset: 2px;
	}
</style>
