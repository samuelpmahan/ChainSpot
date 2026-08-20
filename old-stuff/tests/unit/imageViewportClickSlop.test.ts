// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createRawSnippet, mount, tick, unmount } from 'svelte';
import ImageViewport from '../../src/lib/components/ImageViewport.svelte';
import { ViewportController, clickSlopPx, CLICK_SLOP_PX } from '../../src/lib/viewport.svelte';
import type { ScreenSpacePoint } from '../../src/lib/coords';

function emptyContentSnippet() {
	return createRawSnippet(() => ({
		render: () => '<div></div>'
	}));
}

interface Mounted {
	host: HTMLDivElement;
	component: ReturnType<typeof mount>;
	controller: ViewportController;
	scene: HTMLElement;
}

interface ExtraProps {
	onViewportClick?: (pointer: ScreenSpacePoint, event: PointerEvent) => void;
}

function mountViewport(extraProps: ExtraProps = {}): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const controller = new ViewportController();
	const component = mount(ImageViewport, {
		target: host,
		props: { controller, testid: 'scene', content: emptyContentSnippet(), ...extraProps }
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
 * every pre-existing caller of these helpers — extended here, not replaced,
 * so existing call shapes throughout the suite keep working unmodified. Pass
 * it explicitly to exercise the pointer-type-aware `clickSlopPx` boundary.
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

describe('clickSlopPx', () => {
	it('returns the mouse value for mouse, unknown, and empty-string pointer types', () => {
		expect(clickSlopPx('mouse')).toBe(4);
		expect(clickSlopPx(undefined)).toBe(4);
		expect(clickSlopPx('')).toBe(4);
		expect(clickSlopPx('bogus')).toBe(4); // any unrecognized pointerType also falls back
	});

	it('returns 6 for pen and 10 for touch', () => {
		expect(clickSlopPx('pen')).toBe(6);
		expect(clickSlopPx('touch')).toBe(10);
	});

	it('CLICK_SLOP_PX remains the mouse value for any external reference', () => {
		expect(CLICK_SLOP_PX).toBe(4);
		expect(clickSlopPx('mouse')).toBe(CLICK_SLOP_PX);
	});
});

describe('ImageViewport click-vs-pan threshold (pointer-type-aware)', () => {
	it('mouse: a 5px move promotes to a pan, so onViewportClick does not fire', async () => {
		const onViewportClick = vi.fn();
		const { component, host, controller, scene } = mountViewport({ onViewportClick });
		await flush();

		pointerDown(scene, 1, 100, 100, 'mouse');
		await flush();
		pointerMove(1, 105, 100, 'mouse'); // 5px > mouse slop (4px)
		await flush();
		pointerUp(1, 105, 100, 'mouse');
		await flush();

		expect(onViewportClick).not.toHaveBeenCalled();
		expect(controller.view.panX).toBeCloseTo(5, 5);

		unmount(component);
		host.remove();
	});

	it("default/unset pointerType (jsdom's '') behaves exactly like mouse: a 5px move is a pan, not a click", async () => {
		const onViewportClick = vi.fn();
		const { component, host, controller, scene } = mountViewport({ onViewportClick });
		await flush();

		pointerDown(scene, 1, 100, 100); // no pointerType — jsdom defaults to ''
		await flush();
		pointerMove(1, 105, 100);
		await flush();
		pointerUp(1, 105, 100);
		await flush();

		expect(onViewportClick).not.toHaveBeenCalled();
		expect(controller.view.panX).toBeCloseTo(5, 5);

		unmount(component);
		host.remove();
	});

	it('touch: an 8px move stays under the touch slop (10px), so onViewportClick fires and the view does not pan', async () => {
		const onViewportClick = vi.fn();
		const { component, host, controller, scene } = mountViewport({ onViewportClick });
		await flush();

		pointerDown(scene, 1, 100, 100, 'touch');
		await flush();
		pointerMove(1, 108, 100, 'touch'); // 8px < touch slop (10px)
		await flush();
		pointerUp(1, 108, 100, 'touch');
		await flush();

		expect(onViewportClick).toHaveBeenCalledTimes(1);
		// No pan crept in while the gesture was still under the click threshold.
		expect(controller.view.panX).toBeCloseTo(0, 5);

		unmount(component);
		host.remove();
	});

	it('touch: an 11px move exceeds the touch slop (10px), so it pans instead of clicking', async () => {
		const onViewportClick = vi.fn();
		const { component, host, controller, scene } = mountViewport({ onViewportClick });
		await flush();

		pointerDown(scene, 1, 100, 100, 'touch');
		await flush();
		pointerMove(1, 111, 100, 'touch'); // 11px > touch slop (10px)
		await flush();
		pointerUp(1, 111, 100, 'touch');
		await flush();

		expect(onViewportClick).not.toHaveBeenCalled();
		expect(controller.view.panX).toBeCloseTo(11, 5);

		unmount(component);
		host.remove();
	});
});
