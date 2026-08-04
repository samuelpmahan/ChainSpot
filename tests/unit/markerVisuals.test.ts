import { describe, expect, it } from 'vitest';
import {
	MARKER_ANCHOR_RADIUS,
	MARKER_HIT_RADIUS,
	MARKER_ORDINAL_FONT_SIZE,
	MARKER_SELECTED_RING_RADIUS,
	MARKER_SYMBOL_RADIUS,
	markerVisualScale,
	markerVisualSpec
} from '../../src/lib/scene';
import type { MarkerSceneData } from '../../src/lib/scene';

function marker(overrides: Partial<MarkerSceneData> = {}): MarkerSceneData {
	return {
		id: 'marker-1',
		pairId: 'pair-1',
		side: 'source',
		ordinal: 1,
		xPx: 10,
		yPx: 20,
		kind: 'complete',
		selected: false,
		enabled: true,
		...overrides
	};
}

function screenRadius(spec: { symbolRadius: number; anchorRadius: number; hitRadius: number }, zoom: number): {
	symbol: number;
	anchor: number;
	hit: number;
} {
	// The group zoom and the 1/zoom marker scale cancel exactly, so the net screen
	// radius equals the declared constant radius at every zoom level.
	const scale = markerVisualScale(zoom).x;
	return {
		symbol: spec.symbolRadius * scale * zoom,
		anchor: spec.anchorRadius * scale * zoom,
		hit: spec.hitRadius * scale * zoom
	};
}

describe('P0-012 marker visual spec', () => {
	it('keeps a smaller exact anchor, the symbol, the selected ring, and the hit target ordered', () => {
		const spec = markerVisualSpec(marker());
		expect(spec.anchorRadius).toBeLessThan(spec.symbolRadius);
		expect(spec.symbolRadius).toBeLessThan(spec.selectedRingRadius);
		expect(spec.selectedRingRadius).toBeLessThan(spec.hitRadius);
		expect(spec.anchorRadius).toBe(MARKER_ANCHOR_RADIUS);
		expect(spec.symbolRadius).toBe(MARKER_SYMBOL_RADIUS);
		expect(spec.hitRadius).toBe(MARKER_HIT_RADIUS);
	});

	it('stays screen-constant across representative zoom levels', () => {
		const spec = markerVisualSpec(marker());
		for (const zoom of [0.01, 0.25, 1, 2, 64]) {
			const screen = screenRadius(spec, zoom);
			expect(screen.symbol).toBeCloseTo(MARKER_SYMBOL_RADIUS, 9);
			expect(screen.anchor).toBeCloseTo(MARKER_ANCHOR_RADIUS, 9);
			expect(screen.hit).toBeCloseTo(MARKER_HIT_RADIUS, 9);
		}
		// The 1/zoom cancellation is exact for the supported range.
		expect(markerVisualScale(64).x).toBeCloseTo(1 / 64, 12);
		expect(() => markerVisualScale(0)).toThrow();
	});

	it('distinguishes pending, enabled, disabled, and selected states', () => {
		const enabled = markerVisualSpec(marker());
		expect(enabled.symbolFill).toBe('#075985');
		expect(enabled.symbolDashed).toBe(false);
		expect(enabled.symbolOpacity).toBe(1);

		const pending = markerVisualSpec(marker({ kind: 'pending', pairId: null }));
		expect(pending.symbolFill).toBe('#b45309');
		expect(pending.symbolDashed).toBe(true);

		const disabled = markerVisualSpec(marker({ enabled: false }));
		expect(disabled.symbolFill).toBe('#64748b');
		expect(disabled.symbolDashed).toBe(true);
		expect(disabled.symbolOpacity).toBe(0.75);

		const selected = markerVisualSpec(marker({ selected: true }));
		expect(selected.anchorStroke).toBe('#facc15');
		expect(selected.anchorStrokeWidth).toBe(2);
		expect(selected.selectedRingStroke).toBe('#facc15');
	});

	it('keeps the ordinal readable over bright and dark imagery with a contrasting stroke', () => {
		const spec = markerVisualSpec(marker());
		expect(spec.ordinalFontSize).toBe(MARKER_ORDINAL_FONT_SIZE);
		expect(spec.ordinalFill).toBe('#ffffff');
		expect(spec.ordinalStroke.length).toBeGreaterThan(0);
		expect(spec.ordinalStrokeWidth).toBeGreaterThan(0);
	});
});
