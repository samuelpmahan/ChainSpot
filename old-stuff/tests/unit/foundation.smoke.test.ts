// @vitest-environment jsdom

import Konva from 'konva';
import { mount, unmount } from 'svelte';
import { describe, expect, it } from 'vitest';
import Page from '../../src/routes/create-graphics/+page.svelte';

describe('application foundation smoke', () => {
	it('imports Konva without a browser context', () => {
		expect(typeof Konva.Stage).toBe('function');
		expect(typeof Konva.Layer).toBe('function');
		expect(typeof Konva.Image).toBe('function');
		expect(typeof Konva.Circle).toBe('function');
	});

	it('mounts the application shell with native Svelte APIs', () => {
		const host = document.createElement('div');
		document.body.appendChild(host);

		const component = mount(Page, { target: host });

		const shell = host.querySelector('[data-testid="app-shell"]');
		expect(shell).not.toBeNull();
		expect(shell?.textContent).toContain('ChainSpot');

		unmount(component);
		host.remove();
	});
});
