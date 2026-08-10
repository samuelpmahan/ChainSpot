<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { Snippet } from 'svelte';
	import type { ScreenSpacePoint, ViewTransformState } from '$lib/coords';
	import { CLICK_SLOP_PX, ViewportController } from '$lib/viewport.svelte';
	import { panBy, wheelZoomFactor } from '$lib/navigation';

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

	function onWheel(event: WheelEvent): void {
		// Without fitted content there is nothing meaningful to zoom.
		if (!controller.fitTarget) return;
		if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
		// The page must not scroll while the user intentionally zooms over a viewport.
		event.preventDefault();
		controller.zoomAtPointer(controller.pointerIn(event), wheelZoomFactor(event.deltaY));
	}

	function onPointerDown(event: PointerEvent): void {
		if (event.button !== 0) return;
		const pointer = controller.pointerIn(event);
		activePointers.set(event.pointerId, pointer);
		capturePointer(event);

		// A second touch landing — whether or not a single-pointer gesture is
		// already in flight — starts (or re-anchors) a pinch. Any single-pointer
		// pan or claimed gesture is abandoned so the two systems never fight
		// over the same view transform.
		if (activePointers.size >= 2) {
			event.preventDefault();
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
		// before viewport panning begins.
		if (claimPointer?.(pointer, event)) {
			event.preventDefault();
			claimedGesture = { pointerId: event.pointerId };
			window.addEventListener('pointermove', handleClaimedPointerMove);
			window.addEventListener('pointerup', handleClaimedPointerUp);
			window.addEventListener('pointercancel', handleClaimedPointerCancel);
			return;
		}
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

<div
	class="image-viewport"
	class:panning={controller.panning}
	data-testid={testid}
	role={role}
	aria-label={ariaLabel}
	aria-describedby={ariaDescribedby}
	data-view-zoom={controller.view.zoom}
	data-view-pan-x={controller.view.panX}
	data-view-pan-y={controller.view.panY}
	bind:this={controller.container}
>
	{@render content()}
</div>

<style>
	.image-viewport {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
		touch-action: none;
		cursor: grab;
	}

	.image-viewport.panning {
		cursor: grabbing;
	}
</style>
