// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import Page from '../../src/routes/create-graphics/+page.svelte';
import { ProjectEditor } from '../../src/lib/domain/editor';
import { createProjectState } from '../../src/lib/domain/project';
import type { DecodeImageFile } from '../../src/lib/imageIntake';
import type { CourseLibraryEntry, CourseLibraryStore } from '../../src/lib/courseLibrary';
import { setGoogleMapsApiKeyForTesting } from '../../src/lib/googleMapsConfig';

/**
 * Everything in this file runs with a Google Maps key injected via
 * `googleMapsConfig.ts`'s test seam. Deliberately its own file (see
 * `geocodeSearchKeyless.test.ts`'s header comment) so `MapConfirm.svelte`'s
 * module-level script-load guard/DOM script tag never leaks into or out of
 * the keyless suite. Test order within this file matters: the
 * "abandoned search injects no script" case must run before any test that
 * actually mounts `MapConfirm`, since the guard (and any appended <script>)
 * persists for the rest of this file's module lifetime once tripped.
 */

const NOW = () => new Date('2026-08-10T00:00:00.000Z');
const TEST_KEY = 'test-google-maps-key';

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

function googleScriptTag(): HTMLScriptElement | null {
	return document.querySelector<HTMLScriptElement>('script[src*="maps.googleapis.com"]');
}

function placesResponse(): Response {
	return new Response(
		JSON.stringify({
			places: [
				{
					displayName: { text: "Dash's Track" },
					formattedAddress: 'Frisco, TX, USA',
					location: { latitude: 33.1255, longitude: -96.861 }
				}
			]
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } }
	);
}

async function search(host: HTMLElement, query: string): Promise<void> {
	const nameInput = host.querySelector<HTMLInputElement>('[data-testid="geocode-park-name"]');
	if (!nameInput) throw new Error('missing geocode-park-name input');
	nameInput.value = query;
	nameInput.dispatchEvent(new Event('input', { bubbles: true }));
	host.querySelector<HTMLButtonElement>('[data-testid="geocode-search-button"]')?.click();
	await flush();
}

afterEach(() => {
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	setGoogleMapsApiKeyForTesting(undefined);
});

describe('create-graphics geocode search — keyed', () => {
	it('an abandoned search (Places result shown, nothing picked) injects no Google script tag', async () => {
		setGoogleMapsApiKeyForTesting(TEST_KEY);
		const fetchSpy = vi.fn(async (url: string | URL | Request) => {
			expect(String(url)).toContain('places.googleapis.com');
			return placesResponse();
		});
		vi.stubGlobal('fetch', fetchSpy);

		const { host, component } = mountPage();
		await search(host, "Dash's Track");

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(host.querySelector('[data-testid="geocode-results"]')).not.toBeNull();
		expect(googleScriptTag()).toBeNull();

		unmount(component);
		host.remove();
	});

	// Must run before any test below that actually mounts `MapConfirm` (see this
	// file's header comment): the script tag it injects persists in
	// `document.head` for the rest of this file's module lifetime, which would
	// make this test's "no script tag" assertion a false negative if it ran later.
	it('a Places HTTP error (e.g. a key rejected by Google — bad restriction, revoked, disabled API) fails soft: inline error, loading resets, no silent Nominatim fallback, no crash', async () => {
		setGoogleMapsApiKeyForTesting(TEST_KEY);
		const fetchSpy = vi.fn(async (url: string | URL | Request) => {
			expect(String(url)).toContain('places.googleapis.com');
			// A syntactically valid but rejected key (referrer/API restriction
			// mismatch, revoked, or billing disabled) surfaces from Places as a
			// non-200, same as any other HTTP error — there is no distinct
			// "bad key" response shape to special-case.
			return new Response('', { status: 403 });
		});
		vi.stubGlobal('fetch', fetchSpy);

		const { host, component } = mountPage();
		await search(host, "Dash's Track");

		// Unlike a `no-results` response, an HTTP-error response never falls back
		// to Nominatim — exactly one request was made.
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		const error = host.querySelector('[data-testid="geocode-error"]');
		expect(error?.textContent).toContain('403');
		expect(host.querySelector('[data-testid="geocode-results"]')).toBeNull();
		expect(host.querySelector('[data-testid="map-confirm"]')).toBeNull();
		expect(googleScriptTag()).toBeNull();

		// The loading state must resolve either way (`finally`) — no stuck spinner.
		const searchButton = host.querySelector<HTMLButtonElement>('[data-testid="geocode-search-button"]');
		expect(searchButton?.disabled).toBe(false);
		expect(searchButton?.textContent?.trim()).toBe('Search');

		// The rest of the page is still usable: manual lat/lon entry never depended
		// on the search succeeding.
		expect(host.querySelector('[data-testid="naip-lat"]')).not.toBeNull();
		expect(host.querySelector('[data-testid="naip-fetch-button"]')).not.toBeNull();

		unmount(component);
		host.remove();
	});

	it('Search calls Places (not Nominatim), shows the Google attribution, and picking a result mounts MapConfirm + injects the script tag', async () => {
		setGoogleMapsApiKeyForTesting(TEST_KEY);
		const fetchSpy = vi.fn(async (url: string | URL | Request) => {
			expect(String(url)).toContain('places.googleapis.com');
			return placesResponse();
		});
		vi.stubGlobal('fetch', fetchSpy);

		const { host, component } = mountPage();
		await search(host, "Dash's Track");

		const attribution = host.querySelector('[data-testid="geocode-attribution"]');
		expect(attribution?.textContent).toContain('Google');

		expect(googleScriptTag()).toBeNull();

		host.querySelector<HTMLButtonElement>('[data-testid="geocode-result-0"]')?.click();
		await flush();

		expect(host.querySelector('[data-testid="map-confirm"]')).not.toBeNull();
		const script = googleScriptTag();
		expect(script).not.toBeNull();
		expect(script?.src).toContain(`key=${TEST_KEY}`);

		unmount(component);
		host.remove();
	});

	it('Cancel closes the confirm step without writing lat/lon', async () => {
		setGoogleMapsApiKeyForTesting(TEST_KEY);
		vi.stubGlobal('fetch', vi.fn(async () => placesResponse()));

		const { host, component } = mountPage();
		await search(host, "Dash's Track");
		const latInputBefore = host.querySelector<HTMLInputElement>('[data-testid="naip-lat"]')?.value;

		host.querySelector<HTMLButtonElement>('[data-testid="geocode-result-0"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="map-confirm"]')).not.toBeNull();

		host.querySelector<HTMLButtonElement>('[data-testid="map-confirm-cancel"]')?.click();
		await flush();

		expect(host.querySelector('[data-testid="map-confirm"]')).toBeNull();
		expect(host.querySelector<HTMLInputElement>('[data-testid="naip-lat"]')?.value).toBe(latInputBefore);

		unmount(component);
		host.remove();
	});

	it('a script load failure surfaces an inline error and "use the coordinate anyway" still writes lat/lon', async () => {
		setGoogleMapsApiKeyForTesting(TEST_KEY);
		vi.stubGlobal('fetch', vi.fn(async () => placesResponse()));

		const { host, component } = mountPage();
		await search(host, "Dash's Track");
		host.querySelector<HTMLButtonElement>('[data-testid="geocode-result-0"]')?.click();
		await flush();

		const script = googleScriptTag();
		expect(script).not.toBeNull();
		// jsdom never actually fetches the script's src; simulate a load failure
		// (the real-world case this button exists for) by firing the same
		// `error` event the browser would dispatch on a network failure.
		script?.dispatchEvent(new Event('error'));
		await flush();

		expect(host.querySelector('[data-testid="map-confirm-error"]')).not.toBeNull();
		const useButton = host.querySelector<HTMLButtonElement>('[data-testid="map-confirm-use"]');
		expect(useButton?.disabled).toBe(false);
		expect(useButton?.textContent).toContain('anyway');

		useButton?.click();
		await flush();

		expect(host.querySelector('[data-testid="map-confirm"]')).toBeNull();
		expect(host.querySelector<HTMLInputElement>('[data-testid="naip-lat"]')?.value).toBe('33.1255');
		expect(host.querySelector<HTMLInputElement>('[data-testid="naip-lon"]')?.value).toBe('-96.861');

		unmount(component);
		host.remove();
	});

	it('"Use this location" on the map confirm step fetches the aerial preview immediately, with no separate "Fetch aerial map" press', async () => {
		setGoogleMapsApiKeyForTesting(TEST_KEY);
		const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		const fetchSpy = vi.fn(async (url: string | URL | Request) => {
			const href = String(url);
			if (href.includes('places.googleapis.com')) return placesResponse();
			if (href.includes('imagery.nationalmap.gov')) {
				return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } });
			}
			throw new Error(`unexpected fetch: ${href}`);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const { host, component } = mountPage();
		await search(host, "Dash's Track");
		host.querySelector<HTMLButtonElement>('[data-testid="geocode-result-0"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="map-confirm"]')).not.toBeNull();

		// jsdom never actually loads the Google Maps script; simulate the load
		// failure (same technique as the "use the coordinate anyway" test above)
		// so "Use this location" becomes enabled with the picked coordinate. Take
		// the *last* matching tag, not the first: earlier tests in this file leave
		// their own (already-dead) script tags in `document.head`, which afterEach
		// never clears since it only resets `document.body`.
		const scriptTags = document.querySelectorAll<HTMLScriptElement>('script[src*="maps.googleapis.com"]');
		const script = scriptTags[scriptTags.length - 1] ?? null;
		script?.dispatchEvent(new Event('error'));
		await flush();

		// The map confirm step should already be gone and the aerial preview
		// already fetched — no press of the separate "Fetch aerial map" button.
		host.querySelector<HTMLButtonElement>('[data-testid="map-confirm-use"]')?.click();
		await flush();

		expect(host.querySelector('[data-testid="map-confirm"]')).toBeNull();
		expect(host.querySelector<HTMLInputElement>('[data-testid="naip-lat"]')?.value).toBe('33.1255');
		expect(host.querySelector<HTMLInputElement>('[data-testid="naip-lon"]')?.value).toBe('-96.861');
		expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes('imagery.nationalmap.gov'))).toBe(true);
		expect(host.querySelector('[data-testid="naip-preview"]')).not.toBeNull();

		unmount(component);
		host.remove();
	});

	it("a Places no-results falls back to one Nominatim attempt before reporting failure", async () => {
		setGoogleMapsApiKeyForTesting(TEST_KEY);
		const fetchSpy = vi.fn(async (url: string | URL | Request) => {
			const href = String(url);
			if (href.includes('places.googleapis.com')) {
				return new Response(JSON.stringify({ places: [] }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
			expect(href).toContain('nominatim.openstreetmap.org');
			return new Response(
				JSON.stringify([{ lat: '33.1255', lon: '-96.8610', display_name: "Dash's Track, Frisco, Texas" }]),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		});
		vi.stubGlobal('fetch', fetchSpy);

		const { host, component } = mountPage();
		await search(host, "Dash's Track");

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const attribution = host.querySelector('[data-testid="geocode-attribution"]');
		expect(attribution?.textContent).toContain('OpenStreetMap');

		unmount(component);
		host.remove();
	});
});
