import { describe, expect, it } from 'vitest';
import { createRawSnippet, mount, tick, unmount } from 'svelte';
import ImageViewport from '../../src/lib/components/ImageViewport.svelte';
import { ViewportController } from '../../src/lib/viewport.svelte';

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

function mountViewport(): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const controller = new ViewportController();
	const component = mount(ImageViewport, {
		target: host,
		props: { controller, testid: 'scene', content: emptyContentSnippet() }
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

function pointerDown(scene: HTMLElement, pointerId: number, x: number, y: number): void {
	scene.dispatchEvent(
		new PointerEvent('pointerdown', { button: 0, pointerId, clientX: x, clientY: y, bubbles: true })
	);
}

function pointerMove(pointerId: number, x: number, y: number): void {
	window.dispatchEvent(new PointerEvent('pointermove', { pointerId, clientX: x, clientY: y }));
}

function pointerUp(pointerId: number, x: number, y: number): void {
	window.dispatchEvent(new PointerEvent('pointerup', { pointerId, clientX: x, clientY: y }));
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
});
