// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import Page from '../../src/routes/create-graphics/+page.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import type { CourseLibraryEntry, CourseLibraryStore } from '../../src/lib/courseLibrary';

/**
 * Everything in this file runs with NO Google Maps key configured anywhere
 * (the `googleMapsConfig.ts` test seam is never touched here), matching the
 * default keyless clone. Deliberately its own file so its module registry
 * (and therefore `MapConfirm.svelte`'s module-level script-load guard) is
 * never shared with `geocodeSearchKeyed.test.ts` — vitest isolates each test
 * file's module graph, so a script tag injected by a keyed test elsewhere can
 * never leak into this file's "no script tag, ever" assertions.
 */

const NOW = () => new Date('2026-08-10T00:00:00.000Z');

function decodeOf(widthPx: number, heightPx: number): DecodeImageFile {
	return async () => ({ image: document.createElement('img'), widthPx, heightPx });
}

function makeEditor(): ProjectEditor {
	const state = createProjectState({ createId: () => 'project-1', now: NOW });
	return new ProjectEditor({ state, now: NOW });
}

function fakeStore(): CourseLibraryStore {
	const entries = new Map<string, CourseLibraryEntry>();
	return {
		async getAll() {
			return [...entries.values()];
		},
		async put(entry) {
			entries.set(entry.id, entry);
		},
		async delete(id) {
			entries.delete(id);
		}
	};
}

interface Mounted {
	component: ReturnType<typeof mount>;
	host: HTMLDivElement;
}

function mountPage(): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const component = mount(Page, {
		target: host,
		props: { editor: makeEditor(), decode: decodeOf(2000, 2000), courseLibraryStore: fakeStore() }
	});
	return { component, host };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 16; i += 1) {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function googleScriptTag(): Element | null {
	return document.querySelector('script[src*="maps.googleapis.com"]');
}

afterEach(() => {
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

describe('create-graphics geocode search — keyless', () => {
	it('rendering the page alone never adds a Google Maps script tag', async () => {
		const { host, component } = mountPage();
		await flush();
		expect(googleScriptTag()).toBeNull();
		unmount(component);
		host.remove();
	});

	it('Search uses the Nominatim path and shows OpenStreetMap attribution, with no Google contact', async () => {
		const fetchSpy = vi.fn(async (url: string | URL | Request) => {
			expect(String(url)).toContain('nominatim.openstreetmap.org');
			return new Response(
				JSON.stringify([
					{ lat: '33.1255', lon: '-96.8610', display_name: "Dash's Track, Frisco, Texas" }
				]),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const { host, component } = mountPage();
		const nameInput = host.querySelector<HTMLInputElement>('[data-testid="geocode-park-name"]');
		if (!nameInput) throw new Error('missing geocode-park-name input');
		nameInput.value = "Dash's Track";
		nameInput.dispatchEvent(new Event('input', { bubbles: true }));

		host.querySelector<HTMLButtonElement>('[data-testid="geocode-search-button"]')?.click();
		await flush();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const results = host.querySelector('[data-testid="geocode-results"]');
		expect(results).not.toBeNull();
		expect(results?.textContent).toContain("Dash's Track");

		const attribution = host.querySelector('[data-testid="geocode-attribution"]');
		expect(attribution?.textContent).toContain('OpenStreetMap');
		expect(attribution?.textContent).not.toContain('Google');

		expect(googleScriptTag()).toBeNull();

		unmount(component);
		host.remove();
	});

	it('picking a result writes lat/lon directly (no confirm step) and still injects no script tag', async () => {
		const fetchSpy = vi.fn(async () =>
			new Response(
				JSON.stringify([{ lat: '33.1255', lon: '-96.8610', display_name: "Dash's Track, Frisco, Texas" }]),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
		);
		vi.stubGlobal('fetch', fetchSpy);

		const { host, component } = mountPage();
		const nameInput = host.querySelector<HTMLInputElement>('[data-testid="geocode-park-name"]');
		if (!nameInput) throw new Error('missing geocode-park-name input');
		nameInput.value = "Dash's Track";
		nameInput.dispatchEvent(new Event('input', { bubbles: true }));
		host.querySelector<HTMLButtonElement>('[data-testid="geocode-search-button"]')?.click();
		await flush();

		host.querySelector<HTMLButtonElement>('[data-testid="geocode-result-0"]')?.click();
		await flush();

		expect(host.querySelector('[data-testid="map-confirm"]')).toBeNull();
		const latInput = host.querySelector<HTMLInputElement>('[data-testid="naip-lat"]');
		const lonInput = host.querySelector<HTMLInputElement>('[data-testid="naip-lon"]');
		expect(latInput?.value).toBe('33.1255');
		expect(lonInput?.value).toBe('-96.861');
		expect(googleScriptTag()).toBeNull();

		unmount(component);
		host.remove();
	});

	it('a pasted "lat, lon" coordinate skips geocoding entirely and selects the location directly', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);

		const { host, component } = mountPage();
		const nameInput = host.querySelector<HTMLInputElement>('[data-testid="geocode-park-name"]');
		if (!nameInput) throw new Error('missing geocode-park-name input');
		nameInput.value = '33.1255, -96.8610';
		nameInput.dispatchEvent(new Event('input', { bubbles: true }));
		host.querySelector<HTMLButtonElement>('[data-testid="geocode-search-button"]')?.click();
		await flush();

		expect(fetchSpy).not.toHaveBeenCalled();
		const latInput = host.querySelector<HTMLInputElement>('[data-testid="naip-lat"]');
		const lonInput = host.querySelector<HTMLInputElement>('[data-testid="naip-lon"]');
		expect(latInput?.value).toBe('33.1255');
		expect(lonInput?.value).toBe('-96.861');
		expect(host.querySelector('[data-testid="geocode-results"]')).toBeNull();

		unmount(component);
		host.remove();
	});
});
