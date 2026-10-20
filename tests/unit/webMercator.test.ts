import { describe, expect, test } from 'vitest';
import { distanceMeters, groundMetersPerPixel, lonLatToMercator, lonLatToPx, mercatorToLonLat, pxToLonLat } from '../../src/lib/geo/webMercator';

/** The extent USDA NAIP rendered for Dash's Track, 400 m radius at 2048 px (recorded from a real fetch). */
const DASH = {
	extent: { xmin: -10782999.128720926, ymin: 3911498.878944569, xmax: -10782043.881146895, ymax: 3912454.1265186006 },
	widthPx: 2048,
	heightPx: 2048
};

describe('webMercator', () => {
	test('round-trips WGS84 through EPSG:3857 and through pixels', () => {
		const p = { lat: 33.12551979622626, lon: -96.86103869229555 };
		const m = lonLatToMercator(p);
		const back = mercatorToLonLat(m.x, m.y);
		expect(back.lat).toBeCloseTo(p.lat, 10);
		expect(back.lon).toBeCloseTo(p.lon, 10);
		const px = lonLatToPx(DASH, p);
		const again = pxToLonLat(DASH, px.xPx, px.yPx);
		expect(again.lat).toBeCloseTo(p.lat, 10);
		expect(again.lon).toBeCloseTo(p.lon, 10);
	});

	test('pixels are square on the ground: 0.3906 m/px both ways for a 400 m radius at 2048 px', () => {
		const g = groundMetersPerPixel(DASH);
		expect(g.x).toBeCloseTo(800 / 2048, 3);
		expect(g.y).toBeCloseTo(g.x, 9);
	});

	test('distance: one pixel step east is the ground scale', () => {
		const a = pxToLonLat(DASH, 1000, 1000);
		const b = pxToLonLat(DASH, 1100, 1000);
		expect(distanceMeters(a, b)).toBeCloseTo(100 * groundMetersPerPixel(DASH).x, 1);
	});
});
