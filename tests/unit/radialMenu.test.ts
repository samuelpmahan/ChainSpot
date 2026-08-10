import { describe, expect, it } from 'vitest';
import { radialWedges } from '../../src/lib/radialMenu';

describe('radialWedges', () => {
	it('lays out one wedge per requested count, each with a path and a label point', () => {
		for (const count of [1, 2, 3, 4]) {
			const layout = radialWedges(count);
			expect(layout.wedges).toHaveLength(count);
			for (const wedge of layout.wedges) {
				expect(wedge.path.startsWith('M ')).toBe(true);
				expect(wedge.path.trim().endsWith('Z')).toBe(true);
				expect(Number.isFinite(wedge.labelX)).toBe(true);
				expect(Number.isFinite(wedge.labelY)).toBe(true);
			}
		}
	});

	it('places wedge labels at increasing distance from the hub as the outer radius grows', () => {
		const tight = radialWedges(4, { hubRadius: 10, outerRadius: 20 });
		const wide = radialWedges(4, { hubRadius: 10, outerRadius: 100 });
		const tightDistance = Math.hypot(tight.wedges[0].labelX, tight.wedges[0].labelY);
		const wideDistance = Math.hypot(wide.wedges[0].labelX, wide.wedges[0].labelY);
		expect(wideDistance).toBeGreaterThan(tightDistance);
	});

	it('a single wedge still renders as a closed path (a full ring around the hub)', () => {
		const layout = radialWedges(1);
		expect(layout.wedges).toHaveLength(1);
		expect(layout.wedges[0].path).toContain('A');
	});

	it('degenerate counts (zero or negative) fall back to a single wedge', () => {
		expect(radialWedges(0).wedges).toHaveLength(1);
		expect(radialWedges(-3).wedges).toHaveLength(1);
	});

	it('respects custom hub/outer radii', () => {
		const layout = radialWedges(2, { hubRadius: 5, outerRadius: 50 });
		expect(layout.hubRadius).toBe(5);
		expect(layout.outerRadius).toBe(50);
	});
});
