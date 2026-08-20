<script module lang="ts">
	/**
	 * Minimal local typing for the slice of the Google Maps JavaScript API this
	 * component uses. No `@types/google.maps` package is added (this repo adds
	 * no new npm dependencies for this feature), so these are hand-rolled and
	 * intentionally narrow — just enough to construct a satellite `Map` and read
	 * its center back.
	 */
	interface GoogleLatLngLike {
		lat(): number;
		lng(): number;
	}
	interface GoogleMapInstance {
		getCenter(): GoogleLatLngLike | undefined;
	}
	interface GoogleMapsNamespace {
		maps: {
			Map: new (el: HTMLElement, opts: Record<string, unknown>) => GoogleMapInstance;
		};
	}

	declare global {
		interface Window {
			google?: GoogleMapsNamespace;
		}
	}

	/**
	 * Module-level session guard so the Dynamic Maps JS is injected and loaded
	 * at most once per page session, however many times a confirm step mounts
	 * (search → pick → cancel → pick again must not re-inject the script) — the
	 * "one map load, however many confirms" half of `docs/google-maps-setup.md`'s
	 * cost model. A load failure clears the guard so a later retry (reopening
	 * the confirm step) gets a fresh attempt instead of replaying the same
	 * rejected promise forever.
	 */
	let scriptLoadPromise: Promise<GoogleMapsNamespace> | null = null;
	let callbackSeq = 0;

	function loadGoogleMapsScript(apiKey: string): Promise<GoogleMapsNamespace> {
		if (scriptLoadPromise) return scriptLoadPromise;
		scriptLoadPromise = new Promise((resolve, reject) => {
			callbackSeq += 1;
			const callbackName = `__chainspotGoogleMapsInit${callbackSeq}`;
			// Google's callback-based loader API requires a named global function;
			// there is no npm-package-free alternative that avoids `window` here.
			const globalWindow = window as unknown as Record<string, () => void>;
			globalWindow[callbackName] = () => {
				delete globalWindow[callbackName];
				if (window.google?.maps) {
					resolve(window.google);
				} else {
					reject(new Error('Google Maps did not initialize.'));
				}
			};
			const script = document.createElement('script');
			script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async&callback=${callbackName}`;
			script.async = true;
			script.onerror = () => {
				delete globalWindow[callbackName];
				scriptLoadPromise = null;
				reject(new Error('Could not load Google Maps.'));
			};
			document.head.appendChild(script);
		});
		return scriptLoadPromise;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import type { GeoPoint } from '$lib/naip';

	interface Props {
		/** Public Google Maps Platform key — only ever passed when one is configured; this component never checks env itself. */
		apiKey: string;
		/** Initial map center: the selected search match's coordinate. */
		center: GeoPoint;
		/** The selected match's display name, shown above the map for context. */
		label?: string;
		onUse: (point: GeoPoint) => void;
		onCancel: () => void;
	}

	let { apiKey, center, label = '', onUse, onCancel }: Props = $props();

	const DEFAULT_ZOOM = 16;

	let mapDiv = $state<HTMLDivElement | null>(null);
	let mapInstance: GoogleMapInstance | null = null;
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	onMount(() => {
		let cancelled = false;
		loadGoogleMapsScript(apiKey)
			.then((google) => {
				if (cancelled || !mapDiv) return;
				mapInstance = new google.maps.Map(mapDiv, {
					center: { lat: center.lat, lng: center.lon },
					zoom: DEFAULT_ZOOM,
					mapTypeId: 'satellite',
					streetViewControl: false,
					fullscreenControl: false
				});
				loading = false;
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				loading = false;
				loadError =
					error instanceof Error
						? error.message
						: 'Could not load Google Maps. You can still use the searched coordinate directly.';
			});
		return () => {
			cancelled = true;
		};
	});

	/**
	 * Crosshair pattern, not a draggable marker (deliberately avoids both the
	 * deprecated `google.maps.Marker` and Advanced Markers, which require a
	 * Map ID): the pin overlay is a fixed, `pointer-events: none` CSS element
	 * centered over the map div; the user pans/zooms the map under it, and
	 * "Use this location" simply reads the map's current center. Falls back to
	 * the original searched coordinate when the map never loaded (`mapInstance`
	 * null) — the map is a nicety, never a gate on completing the flow.
	 */
	function handleUse(): void {
		const mapCenter = mapInstance?.getCenter();
		onUse(mapCenter ? { lat: mapCenter.lat(), lon: mapCenter.lng() } : center);
	}
</script>

<div class="map-confirm" data-testid="map-confirm">
	{#if label}
		<p class="map-confirm-label">{label}</p>
	{/if}
	<p class="map-confirm-hint">Pan and zoom the satellite map until the crosshair sits on the course, then confirm.</p>
	<div class="map-confirm-frame">
		<div class="map-confirm-map" data-testid="map-confirm-map" bind:this={mapDiv}></div>
		<div class="map-confirm-crosshair" aria-hidden="true"></div>
	</div>
	{#if loading}
		<p class="map-confirm-status" data-testid="map-confirm-loading">Loading map…</p>
	{/if}
	{#if loadError}
		<p class="error map-confirm-error" data-testid="map-confirm-error" role="alert">{loadError}</p>
	{/if}
	<div class="map-confirm-actions">
		<button type="button" data-testid="map-confirm-cancel" onclick={onCancel}>Cancel</button>
		<button type="button" data-testid="map-confirm-use" disabled={loading} onclick={handleUse}>
			{loadError ? 'Use the coordinate anyway' : 'Use this location'}
		</button>
	</div>
</div>

<style>
	.map-confirm {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem 1rem;
		border: 1px solid #ccc;
		border-radius: 6px;
	}

	.map-confirm-label {
		margin: 0;
		font-weight: 600;
		font-size: 0.9rem;
	}

	.map-confirm-hint {
		margin: 0;
		font-size: 0.85rem;
		opacity: 0.8;
	}

	.map-confirm-frame {
		position: relative;
		width: 100%;
		max-width: 100%;
		height: 360px;
	}

	.map-confirm-map {
		width: 100%;
		height: 100%;
		max-width: 100%;
		border-radius: 4px;
		background: #e5e7eb;
	}

	/* A fixed pin overlay, tip anchored exactly at the map's visual center. Never
	   intercepts pointer events -- the map underneath must stay fully pannable/zoomable. */
	.map-confirm-crosshair {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 0;
		height: 0;
		pointer-events: none;
		transform: translate(-50%, -100%);
	}

	.map-confirm-crosshair::before {
		content: '';
		position: absolute;
		bottom: 8px;
		left: -9px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: #ef4444;
		border: 2px solid #fff;
		box-shadow: 0 1px 3px rgb(0 0 0 / 40%);
	}

	.map-confirm-crosshair::after {
		content: '';
		position: absolute;
		bottom: -2px;
		left: -4px;
		width: 0;
		height: 0;
		border-left: 5px solid transparent;
		border-right: 5px solid transparent;
		border-top: 10px solid #ef4444;
	}

	.map-confirm-status {
		margin: 0;
		font-size: 0.85rem;
		opacity: 0.8;
	}

	.map-confirm-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
