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

/** CHSPT-68: the search fields live in the location modal over the Clean target pane. */
async function openLocationModal(host: HTMLElement): Promise<void> {
	const open = host.querySelector<HTMLButtonElement>('[data-testid="open-location-search"]');
	if (!open) throw new Error('missing open-location-search button');
	open.click();
	await flush();
}

/** A NAIP exportImage response fetch stub can hand back for the auto-fetch after a pick. */
function naipPngResponse(): Response {
	return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
		status: 200,
		headers: { 'content-type': 'image/png' }
	});
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
		await openLocationModal(host);
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

	it('picking a boxless result closes the modal and fetches at the default radius (no confirm step, no script tag)', async () => {
		const fetchSpy = vi.fn(async (url: string | URL | Request) => {
			const href = String(url);
			if (href.includes('nominatim.openstreetmap.org')) {
				return new Response(
					JSON.stringify([
						{ lat: '33.1255', lon: '-96.8610', display_name: "Dash's Track, Frisco, Texas" }
					]),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}
			expect(href).toContain('imagery.nationalmap.gov');
			return naipPngResponse();
		});
		vi.stubGlobal('fetch', fetchSpy);

		const { host, component } = mountPage();
		await openLocationModal(host);
		const nameInput = host.querySelector<HTMLInputElement>('[data-testid="geocode-park-name"]');
		if (!nameInput) throw new Error('missing geocode-park-name input');
		nameInput.value = "Dash's Track";
		nameInput.dispatchEvent(new Event('input', { bubbles: true }));
		host.querySelector<HTMLButtonElement>('[data-testid="geocode-search-button"]')?.click();
		await flush();

		host.querySelector<HTMLButtonElement>('[data-testid="geocode-result-0"]')?.click();
		await flush();

		// CHSPT-68: the pick is the decision — modal closes, the aerial fetch
		// fires immediately, and the in-pane preview is the confirmation step.
		expect(host.querySelector('[data-testid="map-confirm"]')).toBeNull();
		expect(host.querySelector('[data-testid="location-modal"]')).toBeNull();
		const naipCall = fetchSpy.mock.calls
			.map((call) => String(call[0]))
			.find((href) => href.includes('imagery.nationalmap.gov'));
		expect(naipCall).toBeDefined();
		// bbox centered on the picked coordinate; boxless result = default 300m radius.
		const bboxParam = new URL(naipCall as string).searchParams.get('bbox');
		const [minLon, minLat, maxLon, maxLat] = (bboxParam as string).split(',').map(Number);
		expect((minLat + maxLat) / 2).toBeCloseTo(33.1255, 6);
		expect((minLon + maxLon) / 2).toBeCloseTo(-96.861, 6);
		expect(((maxLat - minLat) / 2) * 111_320).toBeCloseTo(300, 3);
		expect(host.querySelector('[data-testid="naip-preview"]')).not.toBeNull();
		expect(googleScriptTag()).toBeNull();

		unmount(component);
		host.remove();
	});

	it('a result with a real bounding box sizes the fetch from the box (CHSPT-68)', async () => {
		const fetchSpy = vi.fn(async (url: string | URL | Request) => {
			const href = String(url);
			if (href.includes('nominatim.openstreetmap.org')) {
				return new Response(
					JSON.stringify([
						{
							lat: '33.1255',
							lon: '-96.8610',
							display_name: "Dash's Track, Frisco, Texas",
							// ~0.008deg tall = ~890m => half-extent ~445m x 1.15 margin.
							boundingbox: ['33.1215', '33.1295', '-96.8660', '-96.8560']
						}
					]),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}
			expect(href).toContain('imagery.nationalmap.gov');
			return naipPngResponse();
		});
		vi.stubGlobal('fetch', fetchSpy);

		const { host, component } = mountPage();
		await openLocationModal(host);
		const nameInput = host.querySelector<HTMLInputElement>('[data-testid="geocode-park-name"]');
		if (!nameInput) throw new Error('missing geocode-park-name input');
		nameInput.value = "Dash's Track";
		nameInput.dispatchEvent(new Event('input', { bubbles: true }));
		host.querySelector<HTMLButtonElement>('[data-testid="geocode-search-button"]')?.click();
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="geocode-result-0"]')?.click();
		await flush();

		const naipCall = fetchSpy.mock.calls
			.map((call) => String(call[0]))
			.find((href) => href.includes('imagery.nationalmap.gov'));
		expect(naipCall).toBeDefined();
		const bboxParam = new URL(naipCall as string).searchParams.get('bbox');
		const [minLon, minLat, maxLon, maxLat] = (bboxParam as string).split(',').map(Number);
		// Center comes from the box; radius from its larger half-extent (the
		// ~930m lon span here) x 1.15 margin — decisively larger than the 300m
		// default a boxless pick would use. Exact numbers are naipCoverage.test.ts's
		// job; this proves the box actually drove the fetch.
		expect((minLat + maxLat) / 2).toBeCloseTo((33.1215 + 33.1295) / 2, 6);
		const radiusMeters = ((maxLat - minLat) / 2) * 111_320;
		expect(radiusMeters).toBeGreaterThan(450);
		expect(radiusMeters).toBeLessThan(600);
		expect(host.querySelector('[data-testid="naip-preview"]')).not.toBeNull();
		expect(googleScriptTag()).toBeNull();

		unmount(component);
		host.remove();
	});

	it('a pasted "lat, lon" coordinate skips geocoding entirely and fetches that spot directly', async () => {
		const fetchSpy = vi.fn(async (url: string | URL | Request) => {
			expect(String(url)).toContain('imagery.nationalmap.gov');
			return naipPngResponse();
		});
		vi.stubGlobal('fetch', fetchSpy);

		const { host, component } = mountPage();
		await openLocationModal(host);
		const nameInput = host.querySelector<HTMLInputElement>('[data-testid="geocode-park-name"]');
		if (!nameInput) throw new Error('missing geocode-park-name input');
		nameInput.value = '33.1255, -96.8610';
		nameInput.dispatchEvent(new Event('input', { bubbles: true }));
		host.querySelector<HTMLButtonElement>('[data-testid="geocode-search-button"]')?.click();
		await flush();

		// The only network contact is the aerial fetch itself — no geocoder call.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0][0])).toContain('imagery.nationalmap.gov');
		expect(host.querySelector('[data-testid="geocode-results"]')).toBeNull();
		expect(host.querySelector('[data-testid="location-modal"]')).toBeNull();
		expect(host.querySelector('[data-testid="naip-preview"]')).not.toBeNull();

		unmount(component);
		host.remove();
	});

	it('dismissing the modal never dead-ends: upload and reopen-search stay available', async () => {
		const { host, component } = mountPage();
		await openLocationModal(host);
		expect(host.querySelector('[data-testid="location-modal"]')).not.toBeNull();

		host.querySelector<HTMLButtonElement>('[data-testid="location-modal-close"]')?.click();
		await flush();

		expect(host.querySelector('[data-testid="location-modal"]')).toBeNull();
		// The pane is usable: the upload affordance and the reopen button are both there.
		expect(host.querySelector('[data-testid="pane-choose-target-basemap"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="open-location-search"]')).not.toBeNull();

		unmount(component);
		host.remove();
	});

	it('Escape closes the modal through the shared dialog keyboard handling', async () => {
		const { host, component } = mountPage();
		await openLocationModal(host);
		const modal = host.querySelector<HTMLElement>('[data-testid="location-modal"]');
		expect(modal).not.toBeNull();

		modal?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await flush();

		expect(host.querySelector('[data-testid="location-modal"]')).toBeNull();
		expect(host.querySelector('[data-testid="open-location-search"]')).not.toBeNull();

		unmount(component);
		host.remove();
	});
});
