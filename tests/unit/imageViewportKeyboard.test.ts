// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createRawSnippet, mount, tick, unmount } from 'svelte';
import ImageViewport from '../../src/lib/components/ImageViewport.svelte';
import { ViewportController } from '../../src/lib/viewport.svelte';
import {
	KEYBOARD_PAN_STEP_PX,
	KEYBOARD_PAN_STEP_SHIFT_MULTIPLIER,
	KEYBOARD_ZOOM_STEP_FACTOR,
	zoomLimitsForFit
} from '../../src/lib/navigation';

/**
 * Keyboard pan/zoom/fit and the on-canvas zoom controls (P05-003). Mirrors the
 * mount/dispatch helpers in `imageViewportPinchZoom.test.ts` — duplicated
 * rather than imported so that file's pinning tests stay byte-for-byte
 * unchanged, per the task's explicit requirement.
 */

function emptyContentSnippet() {
	return createRawSnippet(() => ({
		render: () => '<div></div>'
	}));
}

/** A content scene with a focusable descendant, to pin the target/currentTarget keyboard guard. */
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

/** A 200x100 fit target with a comfortably-sized fit zoom, established through the real fit path. */
function setFitTarget(controller: ViewportController): void {
	controller.setSize({ width: 400, height: 400 });
	controller.setFitTarget({ xPx: 0, yPx: 0, widthPx: 200, heightPx: 100 });
}

function keydown(
	target: HTMLElement,
	key: string,
	options: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean } = {}
): KeyboardEvent {
	const event = new KeyboardEvent('keydown', {
		key,
		bubbles: true,
		cancelable: true,
		shiftKey: options.shiftKey ?? false,
		ctrlKey: options.ctrlKey ?? false,
		metaKey: options.metaKey ?? false
	});
	target.dispatchEvent(event);
	return event;
}

async function flush(): Promise<void> {
	for (let i = 0; i < 8; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe('ImageViewport keyboard focus and role', () => {
	it('is focusable (tabindex 0) and defaults to role="application" with aria-roledescription', async () => {
		const { component, host, scene } = mountViewport();
		await flush();

		expect(scene.getAttribute('tabindex')).toBe('0');
		expect(scene.getAttribute('role')).toBe('application');
		expect(scene.getAttribute('aria-roledescription')).toBe('zoomable image viewport');
		expect(scene.getAttribute('aria-label')).toContain('Arrow keys pan');

		unmount(component);
		host.remove();
	});

	it('an explicit role prop still wins over the application default', async () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const controller = new ViewportController();
		const component = mount(ImageViewport, {
			target: host,
			props: { controller, testid: 'scene', role: 'img', content: emptyContentSnippet() }
		});
		const scene = host.querySelector<HTMLElement>('[data-testid="scene"]');
		if (!scene) throw new Error('missing scene element');
		await flush();

		expect(scene.getAttribute('role')).toBe('img');

		unmount(component);
		host.remove();
	});

	it('appends the keyboard hint to a consumer-supplied ariaLabel rather than replacing it', async () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const controller = new ViewportController();
		const component = mount(ImageViewport, {
			target: host,
			props: {
				controller,
				testid: 'scene',
				ariaLabel: 'Ribbon edge editor.',
				content: emptyContentSnippet()
			}
		});
		const scene = host.querySelector<HTMLElement>('[data-testid="scene"]');
		if (!scene) throw new Error('missing scene element');
		await flush();

		const label = scene.getAttribute('aria-label') ?? '';
		expect(label.startsWith('Ribbon edge editor.')).toBe(true);
		expect(label).toContain('Arrow keys pan');

		unmount(component);
		host.remove();
	});
});

describe('ImageViewport keyboard pan', () => {
	it('pans by KEYBOARD_PAN_STEP_PX per Arrow key, matching the wheel sign convention', async () => {
		const { component, host, controller, scene } = mountViewport();
		setFitTarget(controller);
		await flush();
		const before = { ...controller.view };

		keydown(scene, 'ArrowRight');
		await flush();
		expect(controller.view.panX).toBeCloseTo(before.panX - KEYBOARD_PAN_STEP_PX, 9);
		expect(controller.view.panY).toBeCloseTo(before.panY, 9);
		expect(controller.view.zoom).toBe(before.zoom);

		keydown(scene, 'ArrowLeft');
		await flush();
		expect(controller.view.panX).toBeCloseTo(before.panX, 9);

		keydown(scene, 'ArrowDown');
		await flush();
		expect(controller.view.panY).toBeCloseTo(before.panY - KEYBOARD_PAN_STEP_PX, 9);

		keydown(scene, 'ArrowUp');
		await flush();
		expect(controller.view.panY).toBeCloseTo(before.panY, 9);

		unmount(component);
		host.remove();
	});

	it('Shift+Arrow pans by the larger step', async () => {
		const { component, host, controller, scene } = mountViewport();
		setFitTarget(controller);
		await flush();
		const before = { ...controller.view };

		keydown(scene, 'ArrowRight', { shiftKey: true });
		await flush();
		expect(controller.view.panX).toBeCloseTo(
			before.panX - KEYBOARD_PAN_STEP_PX * KEYBOARD_PAN_STEP_SHIFT_MULTIPLIER,
			9
		);

		unmount(component);
		host.remove();
	});

	it('preventDefaults Arrow keys and does nothing to the view without a fit target', async () => {
		const { component, host, controller, scene } = mountViewport();
		await flush();
		const before = { ...controller.view };

		const event = keydown(scene, 'ArrowRight');
		await flush();
		expect(event.defaultPrevented).toBe(true);
		expect(controller.view).toEqual(before);

		unmount(component);
		host.remove();
	});
});

describe('ImageViewport keyboard zoom and fit', () => {
	it('+/- zoom about the viewport center by KEYBOARD_ZOOM_STEP_FACTOR and its reciprocal', async () => {
		const { component, host, controller, scene } = mountViewport();
		setFitTarget(controller);
		await flush();
		const fitZoom = controller.view.zoom;
		const center = { x: 200, y: 200 };
		const anchorBefore = {
			x: (center.x - controller.view.panX) / controller.view.zoom,
			y: (center.y - controller.view.panY) / controller.view.zoom
		};

		keydown(scene, '+');
		await flush();
		expect(controller.view.zoom).toBeCloseTo(fitZoom * KEYBOARD_ZOOM_STEP_FACTOR, 9);
		// The viewport-center image point is invariant across a center-anchored zoom.
		const anchorAfterIn = {
			x: (center.x - controller.view.panX) / controller.view.zoom,
			y: (center.y - controller.view.panY) / controller.view.zoom
		};
		expect(anchorAfterIn.x).toBeCloseTo(anchorBefore.x, 6);
		expect(anchorAfterIn.y).toBeCloseTo(anchorBefore.y, 6);

		keydown(scene, '-');
		await flush();
		expect(controller.view.zoom).toBeCloseTo(fitZoom, 9);

		unmount(component);
		host.remove();
	});

	it('= and _ are accepted as the unshifted/shifted forms of +/-', async () => {
		const { component, host, controller, scene } = mountViewport();
		setFitTarget(controller);
		await flush();
		const fitZoom = controller.view.zoom;

		keydown(scene, '=');
		await flush();
		expect(controller.view.zoom).toBeCloseTo(fitZoom * KEYBOARD_ZOOM_STEP_FACTOR, 9);

		keydown(scene, '_');
		await flush();
		expect(controller.view.zoom).toBeCloseTo(fitZoom, 9);

		unmount(component);
		host.remove();
	});

	it('clamps keyboard zoom-in at the zoomLimitsForFit maximum', async () => {
		const { component, host, controller, scene } = mountViewport();
		setFitTarget(controller);
		await flush();
		const limits = zoomLimitsForFit(controller.fitView.zoom);

		for (let i = 0; i < 60; i += 1) {
			keydown(scene, '+');
		}
		await flush();
		expect(controller.view.zoom).toBeCloseTo(limits.max, 6);
		expect(controller.view.zoom).toBeLessThanOrEqual(limits.max + 1e-9);

		unmount(component);
		host.remove();
	});

	it('clamps keyboard zoom-out at the zoomLimitsForFit minimum', async () => {
		const { component, host, controller, scene } = mountViewport();
		setFitTarget(controller);
		await flush();
		const limits = zoomLimitsForFit(controller.fitView.zoom);

		for (let i = 0; i < 60; i += 1) {
			keydown(scene, '-');
		}
		await flush();
		expect(controller.view.zoom).toBeCloseTo(limits.min, 6);
		expect(controller.view.zoom).toBeGreaterThanOrEqual(limits.min - 1e-9);

		unmount(component);
		host.remove();
	});

	it('0 restores the exact fit transform after a pan and zoom', async () => {
		const { component, host, controller, scene } = mountViewport();
		setFitTarget(controller);
		await flush();
		const fit = { ...controller.fitView };

		keydown(scene, '+');
		keydown(scene, 'ArrowRight');
		keydown(scene, 'ArrowRight');
		await flush();
		expect(controller.view).not.toEqual(fit);

		keydown(scene, '0');
		await flush();
		expect(controller.view.zoom).toBeCloseTo(fit.zoom, 9);
		expect(controller.view.panX).toBeCloseTo(fit.panX, 9);
		expect(controller.view.panY).toBeCloseTo(fit.panY, 9);

		unmount(component);
		host.remove();
	});

	it('0 is a harmless no-op without a fit target', async () => {
		const { component, host, controller, scene } = mountViewport();
		await flush();
		const before = { ...controller.view };

		const event = keydown(scene, '0');
		await flush();
		expect(event.defaultPrevented).toBe(true);
		expect(controller.view).toEqual(before);

		unmount(component);
		host.remove();
	});
});

describe('ImageViewport Cmd/Ctrl+zoom preventDefault scoping', () => {
	it('Cmd/Ctrl+Plus, +Minus, and +0 are all prevented while the viewport has focus', async () => {
		const { component, host, controller, scene } = mountViewport();
		setFitTarget(controller);
		await flush();

		const plus = keydown(scene, '+', { ctrlKey: true });
		expect(plus.defaultPrevented).toBe(true);
		const minus = keydown(scene, '-', { metaKey: true });
		expect(minus.defaultPrevented).toBe(true);
		const zero = keydown(scene, '0', { ctrlKey: true });
		expect(zero.defaultPrevented).toBe(true);
		await flush();

		unmount(component);
		host.remove();
	});

	it('a keydown targeting a focusable descendant is left alone (not double-handled)', async () => {
		const { component, host, controller, scene } = mountViewport({
			content: contentWithButtonSnippet()
		});
		setFitTarget(controller);
		await flush();
		const button = host.querySelector<HTMLButtonElement>('[data-testid="inline-button"]');
		if (!button) throw new Error('missing inline button');
		const before = { ...controller.view };

		// Dispatched on the descendant button, bubbling up through the container's
		// keydown listener — event.target (button) !== event.currentTarget
		// (container), so onKeyDown must bail without calling preventDefault or
		// touching the view, exactly as it does for stitch-map's outer wrapper.
		const event = keydown(button, 'ArrowRight');
		await flush();
		expect(event.defaultPrevented).toBe(false);
		expect(controller.view).toEqual(before);

		unmount(component);
		host.remove();
	});

	it('an unrecognized key is left alone', async () => {
		const { component, host, controller, scene } = mountViewport();
		setFitTarget(controller);
		await flush();
		const before = { ...controller.view };

		const event = keydown(scene, 'Tab');
		await flush();
		expect(event.defaultPrevented).toBe(false);
		expect(controller.view).toEqual(before);

		unmount(component);
		host.remove();
	});
});

describe('ImageViewport on-canvas zoom controls', () => {
	it('are hidden when there is no fit target', async () => {
		const { component, host } = mountViewport();
		await flush();

		expect(host.querySelector('[data-testid="viewport-controls"]')).toBeNull();
		expect(host.querySelector('[data-testid="viewport-zoom-in"]')).toBeNull();

		unmount(component);
		host.remove();
	});

	it('appear once a fit target is set, and zoom-in/zoom-out/fit drive the same math as the keyboard', async () => {
		const { component, host, controller } = mountViewport();
		setFitTarget(controller);
		await flush();

		const zoomIn = host.querySelector<HTMLButtonElement>('[data-testid="viewport-zoom-in"]');
		const zoomOut = host.querySelector<HTMLButtonElement>('[data-testid="viewport-zoom-out"]');
		const fitButton = host.querySelector<HTMLButtonElement>('[data-testid="viewport-zoom-fit"]');
		if (!zoomIn || !zoomOut || !fitButton) throw new Error('missing viewport controls');

		expect(zoomIn.getAttribute('aria-label')).toBe('Zoom in');
		expect(zoomOut.getAttribute('aria-label')).toBe('Zoom out');
		expect(fitButton.getAttribute('aria-label')).toBe('Fit image to viewport');

		const fitZoom = controller.view.zoom;
		zoomIn.click();
		await flush();
		expect(controller.view.zoom).toBeCloseTo(fitZoom * KEYBOARD_ZOOM_STEP_FACTOR, 9);

		zoomOut.click();
		zoomOut.click();
		await flush();
		expect(controller.view.zoom).toBeLessThan(fitZoom);

		fitButton.click();
		await flush();
		expect(controller.view.zoom).toBeCloseTo(fitZoom, 9);
		expect(controller.view.panX).toBeCloseTo(controller.fitView.panX, 9);
		expect(controller.view.panY).toBeCloseTo(controller.fitView.panY, 9);

		unmount(component);
		host.remove();
	});

	it('clamps repeated zoom-in clicks at the zoomLimitsForFit maximum', async () => {
		const { component, host, controller } = mountViewport();
		setFitTarget(controller);
		await flush();
		const limits = zoomLimitsForFit(controller.fitView.zoom);
		const zoomIn = host.querySelector<HTMLButtonElement>('[data-testid="viewport-zoom-in"]');
		if (!zoomIn) throw new Error('missing zoom-in control');

		for (let i = 0; i < 60; i += 1) zoomIn.click();
		await flush();
		expect(controller.view.zoom).toBeCloseTo(limits.max, 6);

		unmount(component);
		host.remove();
	});

	it('a pointerdown on a zoom button takes no capture and is not prevented (f38b13c guard, verified for the new controls)', async () => {
		const { component, host, controller } = mountViewport();
		setFitTarget(controller);
		await flush();
		const zoomIn = host.querySelector<HTMLButtonElement>('[data-testid="viewport-zoom-in"]');
		if (!zoomIn) throw new Error('missing zoom-in control');

		const scene = host.querySelector<HTMLElement>('[data-testid="scene"]');
		if (!scene) throw new Error('missing scene element');
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
		zoomIn.dispatchEvent(down);
		await flush();

		expect(down.defaultPrevented).toBe(false);
		expect(setPointerCaptureSpy).not.toHaveBeenCalled();

		window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 10, clientY: 10 }));
		await flush();

		unmount(component);
		host.remove();
	});
});
