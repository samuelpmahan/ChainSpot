/**
 * jsdom deliberately does not implement CanvasRenderingContext2D. Calling its
 * placeholder getContext() reports a noisy "Not implemented" message even when
 * application code correctly treats the null result as unavailable.
 *
 * Component tests do not assert Konva raster output; browser tests own that
 * contract. Return null here so the component follows its existing no-canvas
 * test path without installing a native canvas dependency or hiding real browser
 * failures.
 */
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
	configurable: true,
	writable: true,
	value: () => null
});
