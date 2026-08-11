// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createRawSnippet, mount, tick, unmount } from 'svelte';
import ImageViewport from '../../src/lib/components/ImageViewport.svelte';
import { ViewportController } from '../../src/lib/viewport.svelte';
import type { ScreenSpacePoint } from '../../src/lib/coords';

function emptyContentSnippet() {
	return createRawSnippet(() => ({
		render: () => '<div></div>'
	}));
}

/** For T2 (bug #3 pin): a `content` scene with a real interactive control inside it. */
function contentWithButtonSnippet() {
	return createRawSnippet(() => ({
		render: () => '<button type="button" data-testid="inline-button">Choose</button>'
	}));
}

interface Mounted {
	host: HTMLDivElement;
	component: ReturnType<typeof mount>;
	controller: ViewportController;
	scene: HTMLElement;
}

interface ExtraProps {
	claimPointer?: (pointer: ScreenSpacePoint, event: PointerEvent) => boolean;
	onClaimedPointerMove?: (pointer: ScreenSpacePoint, event: PointerEvent) => void;
	onClaimedPointerCancel?: (pointer: ScreenSpacePoint, event: PointerEvent) => void;
	content?: ReturnType<typeof createRawSnippet>;
}

function mountViewport(extraProps: ExtraProps = {}): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const controller = new ViewportController();
	const { content, ...restProps } = extraProps;
	const component = mount(ImageViewport, {
		target: host,
		props: { controller, testid: 'scene', content: content ?? emptyContentSnippet(), ...restProps }
	});
	const scene = host.querySelector<HTMLElement>('[data-testid="scene"]');
	if (!scene) throw new Error('missing scene element');
	Object.defineProperties(scene, {
		clientWidth: { configurable: true, value: 400 },
		clientHeight: { configurable: true, value: 400 },
		clientLeft: { configurable: true, value: 0 },
		clientTop: { configurable: true, value: 0 }
	});
	scene.getBoundingClientRect = () =>
		({ left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400 }) as DOMRect;
	controller.view = { zoom: 1, panX: 0, panY: 0 };
	return { host, component, controller, scene };
}

/**
 * `pointerType` defaults to unset (jsdom itself then reports `''`) to match
 * every pre-existing caller of these helpers. Pass it explicitly to exercise
 * the mouse/touch-asymmetric branches (H2, H6/T4) — jsdom's `''` default is
 * exactly why those paths went untested before.
 */
function pointerDown(
	scene: HTMLElement,
	pointerId: number,
	x: number,
	y: number,
	pointerType?: string
): PointerEvent {
	const event = new PointerEvent('pointerdown', {
		button: 0,
		pointerId,
		clientX: x,
		clientY: y,
		bubbles: true,
		cancelable: true,
		...(pointerType !== undefined ? { pointerType } : {})
	});
	scene.dispatchEvent(event);
	return event;
}

function pointerMove(pointerId: number, x: number, y: number, pointerType?: string): void {
	window.dispatchEvent(
		new PointerEvent('pointermove', {
			pointerId,
			clientX: x,
			clientY: y,
			...(pointerType !== undefined ? { pointerType } : {})
		})
	);
}

function pointerUp(pointerId: number, x: number, y: number, pointerType?: string): void {
	window.dispatchEvent(
		new PointerEvent('pointerup', {
			pointerId,
			clientX: x,
			clientY: y,
			...(pointerType !== undefined ? { pointerType } : {})
		})
	);
}

async function flush(): Promise<void> {
	for (let i = 0; i < 8; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe('ImageViewport pinch-to-zoom', () => {
	it('zooms in as two touches move apart, anchored at their midpoint', async () => {
		const { component, host, controller, scene } = mountViewport();
		await flush();

		pointerDown(scene, 1, 100, 100);
		pointerDown(scene, 2, 200, 100);
		await flush();
		expect(controller.view.zoom).toBeCloseTo(1, 5);

		// Spread the two touches from 100px apart to 200px apart around the
		// same midpoint (150, 100) — zoom should roughly double.
		pointerMove(1, 50, 100);
		pointerMove(2, 250, 100);
		await flush();

		expect(controller.view.zoom).toBeCloseTo(2, 5);

		pointerUp(1, 50, 100);
		pointerUp(2, 250, 100);
		await flush();

		unmount(component);
		host.remove();
	});

	it('pans as two touches translate together at a constant distance', async () => {
		const { component, host, controller, scene } = mountViewport();
		await flush();

		pointerDown(scene, 1, 100, 100);
		pointerDown(scene, 2, 200, 100);
		await flush();

		pointerMove(1, 130, 100);
		pointerMove(2, 230, 100);
		await flush();

		expect(controller.view.zoom).toBeCloseTo(1, 5);
		expect(controller.view.panX).toBeCloseTo(30, 5);
		expect(controller.view.panY).toBeCloseTo(0, 5);

		pointerUp(1, 130, 100);
		pointerUp(2, 230, 100);
		await flush();

		unmount(component);
		host.remove();
	});

	it('a second touch interrupts a single-finger pan instead of fighting it, and ending the pinch does not resume the old pan', async () => {
		const { component, host, controller, scene } = mountViewport();
		await flush();

		pointerDown(scene, 1, 100, 100);
		await flush();
		pointerMove(1, 130, 100);
		await flush();
		expect(controller.view.panX).toBeCloseTo(30, 5);

		pointerDown(scene, 2, 300, 100);
		await flush();
		pointerMove(1, 100, 100);
		pointerMove(2, 330, 100);
		await flush();

		// Pinch took over cleanly: zoom changed from the two-finger spread, no crash.
		expect(controller.view.zoom).toBeGreaterThan(1);

		pointerUp(1, 100, 100);
		pointerUp(2, 330, 100);
		await flush();

		const afterPinch = { ...controller.view };
		pointerMove(1, 999, 999);
		await flush();
		expect(controller.view).toEqual(afterPinch);

		unmount(component);
		host.remove();
	});

	it('re-anchors on the remaining two touches instead of stalling when a third pointer arrives and an original pinch finger lifts', async () => {
		const { component, host, controller, scene } = mountViewport();
		await flush();

		pointerDown(scene, 1, 100, 100);
		pointerDown(scene, 2, 200, 100);
		await flush();

		// A third touch lands mid-pinch (e.g. an accidental palm touch) while
		// pointers 1 and 2 keep driving the gesture.
		pointerDown(scene, 3, 300, 300);
		await flush();

		// One of the original two pinch fingers lifts; pointer 3 (still down)
		// keeps the tracked count at 2, so the stale-pinch bug never clears via
		// the `< 2` branch — it must re-anchor here instead.
		pointerUp(1, 100, 100);
		await flush();

		// The gesture should now be anchored on pointers 2 and 3. Move them
		// apart and confirm zoom still responds instead of silently no-oping.
		pointerMove(2, 100, 100);
		pointerMove(3, 500, 300);
		await flush();

		expect(controller.view.zoom).toBeGreaterThan(1);

		pointerUp(2, 100, 100);
		pointerUp(3, 500, 300);
		await flush();

		unmount(component);
		host.remove();
	});

	it('does not preventDefault a mouse pointerdown that arrives as the second (pinch-triggering) pointer (H2)', async () => {
		// Mirrors cc7924e (the claimed-gesture branch, `ImageViewport.svelte`
		// step [E]) one branch over, in the pinch branch (step [C]): a touch
		// already down plus a mouse press must not kill the mouse's
		// compatibility mousemove/mouseup, or a Konva mouse-driven drag dies
		// exactly like bug #1 did.
		const { component, host, scene } = mountViewport();
		await flush();

		pointerDown(scene, 1, 100, 100, 'touch');
		await flush();

		const mouseDown = pointerDown(scene, 2, 200, 100, 'mouse');
		await flush();
		expect(mouseDown.defaultPrevented).toBe(false);

		pointerUp(1, 100, 100, 'touch');
		pointerUp(2, 200, 100, 'mouse');
		await flush();

		unmount(component);
		host.remove();
	});

	it('still preventDefaults a touch pointerdown that arrives as the second pinch pointer', async () => {
		// Regression guard alongside the mouse case above: only mouse is
		// exempted, so a genuine two-finger pinch must keep preventing default
		// (blocking scroll/selection) exactly as before this change.
		const { component, host, scene } = mountViewport();
		await flush();

		pointerDown(scene, 1, 100, 100, 'touch');
		await flush();

		const secondTouchDown = pointerDown(scene, 2, 200, 100, 'touch');
		await flush();
		expect(secondTouchDown.defaultPrevented).toBe(true);

		pointerUp(1, 100, 100, 'touch');
		pointerUp(2, 200, 100, 'touch');
		await flush();

		unmount(component);
		host.remove();
	});

	it('does not strand a pointer in activePointers after a mismatched pointermove tears down a pan gesture, so the next lone pointer pans instead of phantom-pinching (H3)', async () => {
		const { component, host, controller, scene } = mountViewport();
		await flush();

		pointerDown(scene, 1, 100, 100, 'mouse');
		await flush();

		// A pointermove for an id that was never pressed inside this viewport
		// (e.g. it belongs to a sibling viewport's gesture on a dual-viewport
		// page — see H3) mismatches gesture.pointerId and tears the gesture
		// down. Before the H3 fix, pointer 1 stayed in activePointers forever.
		pointerMove(2, 150, 100, 'mouse');
		await flush();
		pointerUp(1, 100, 100, 'mouse');
		await flush();

		// A brand-new, lone pointer arrives. If pointer 1 leaked, activePointers
		// would already contain it, so this pointerdown would push size to 2 and
		// wrongly enter the pinch branch anchored on the stale phantom point.
		pointerDown(scene, 3, 300, 100, 'mouse');
		await flush();
		pointerMove(3, 340, 100, 'mouse');
		await flush();

		// A real single-pointer pan: zoom untouched, panX tracks the pointer 1:1.
		expect(controller.view.zoom).toBeCloseTo(1, 5);
		expect(controller.view.panX).toBeCloseTo(40, 5);
		expect(controller.view.panY).toBeCloseTo(0, 5);

		pointerUp(3, 340, 100, 'mouse');
		await flush();

		unmount(component);
		host.remove();
	});

	it('does not strand a pointer in activePointers after a mismatched pointermove tears down a claimed gesture (H3)', async () => {
		const claimPointer = () => true;
		const { component, host, controller, scene } = mountViewport({ claimPointer });
		await flush();

		pointerDown(scene, 1, 100, 100, 'mouse');
		await flush();

		// Same mismatch as the pan case, but through the claimed-gesture bail-out
		// (handleClaimedPointerMove) instead of the pan one.
		pointerMove(2, 150, 100, 'mouse');
		await flush();
		pointerUp(1, 100, 100, 'mouse');
		await flush();

		pointerDown(scene, 3, 300, 100, 'mouse');
		await flush();
		pointerMove(3, 340, 100, 'mouse');
		await flush();

		// claimPointer always returns true, so pointer 3 alone should still be a
		// claimed (non-panning) gesture, not a phantom pinch driven off a leaked
		// pointer 1.
		expect(controller.view.zoom).toBeCloseTo(1, 5);
		expect(controller.view.panX).toBeCloseTo(0, 5);

		pointerUp(3, 340, 100, 'mouse');
		await flush();

		unmount(component);
		host.remove();
	});

	it('invokes onClaimedPointerCancel when a second pointer arrives during a claimed gesture, and the claim stops receiving further moves (H1)', async () => {
		const claimPointer = () => true;
		const onClaimedPointerCancel = vi.fn();
		const onClaimedPointerMove = vi.fn();
		const { component, host, scene } = mountViewport({
			claimPointer,
			onClaimedPointerMove,
			onClaimedPointerCancel
		});
		await flush();

		pointerDown(scene, 1, 100, 100, 'touch');
		await flush();
		expect(onClaimedPointerCancel).not.toHaveBeenCalled();

		pointerDown(scene, 2, 300, 100, 'touch');
		await flush();
		expect(onClaimedPointerCancel).toHaveBeenCalledTimes(1);
		expect(onClaimedPointerCancel).toHaveBeenCalledWith(
			expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
			expect.any(PointerEvent)
		);

		// The claim ended: further moves on pointer 1 must not reach the
		// (now-stale) claimed-move callback.
		pointerMove(1, 120, 100, 'touch');
		await flush();
		expect(onClaimedPointerMove).not.toHaveBeenCalled();

		pointerUp(1, 120, 100, 'touch');
		pointerUp(2, 300, 100, 'touch');
		await flush();

		unmount(component);
		host.remove();
	});

	it('T1 — a claimed mouse pointerdown is not defaultPrevented; a claimed touch pointerdown is (pins bug #1 / cc7924e, step [E])', async () => {
		const claimPointer = () => true;
		const { component, host, scene } = mountViewport({ claimPointer });
		await flush();

		const mouseDown = pointerDown(scene, 1, 100, 100, 'mouse');
		await flush();
		expect(mouseDown.defaultPrevented).toBe(false);
		pointerUp(1, 100, 100, 'mouse');
		await flush();

		const touchDown = pointerDown(scene, 2, 100, 100, 'touch');
		await flush();
		expect(touchDown.defaultPrevented).toBe(true);
		pointerUp(2, 100, 100, 'touch');
		await flush();

		unmount(component);
		host.remove();
	});

	it('T2 — an unclaimed pointerdown on a button inside content takes no capture and does not preventDefault (pins bug #3)', async () => {
		const { component, host, scene } = mountViewport({ content: contentWithButtonSnippet() });
		await flush();

		const button = host.querySelector<HTMLButtonElement>('[data-testid="inline-button"]');
		if (!button) throw new Error('missing inline button');

		// jsdom does not implement pointer capture at all, so define a spy in its
		// place rather than trying to spy on a nonexistent method.
		const setPointerCaptureSpy = vi.fn();
		Object.defineProperty(scene, 'setPointerCapture', {
			configurable: true,
			value: setPointerCaptureSpy
		});

		const down = new PointerEvent('pointerdown', {
			button: 0,
			pointerId: 1,
			clientX: 10,
			clientY: 10,
			bubbles: true,
			cancelable: true
		});
		button.dispatchEvent(down);
		await flush();

		expect(down.defaultPrevented).toBe(false);
		expect(setPointerCaptureSpy).not.toHaveBeenCalled();

		window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 10, clientY: 10 }));
		await flush();

		unmount(component);
		host.remove();
	});
});
