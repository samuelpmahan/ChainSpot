import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { basemapGroundScale, fitAlignmentPairs, parseAlignmentPairs } from '../../src/lib/geo/alignmentPairs';
import type { AlignmentPairsFile } from '../../src/lib/geo/alignmentPairs';
import { naipMetersPerPixel } from '../../src/lib/naip';

/** A known similarity: rotate 30 degrees, scale 0.5, translate (400, 120). */
function known(point: { xPx: number; yPx: number }) {
	const angle = Math.PI / 6;
	const s = 0.5;
	return {
		xPx: s * (Math.cos(angle) * point.xPx - Math.sin(angle) * point.yPx) + 400,
		yPx: s * (Math.sin(angle) * point.xPx + Math.cos(angle) * point.yPx) + 120
	};
}

function file(overrides: Partial<AlignmentPairsFile> = {}): AlignmentPairsFile {
	const sources = [
		{ xPx: 100, yPx: 100 },
		{ xPx: 900, yPx: 150 },
		{ xPx: 500, yPx: 1500 },
		{ xPx: 150, yPx: 1900 },
		{ xPx: 1100, yPx: 1800 }
	];
	return {
		format: 'chainspot.alignment-pairs',
		version: 1,
		course: 'synthetic',
		model: 'similarity',
		source: { fileName: 'shot.png', widthPx: 1290, heightPx: 2091 },
		basemap: { fileName: 'naip.png', widthPx: 2048, heightPx: 2048, naip: { center: { lat: 33.1, lon: -96.8 }, radiusMeters: 300, sizePx: 2048 } },
		pairs: sources.map((source, index) => ({ id: `p${index + 1}`, label: `Pair ${index + 1}`, enabled: true, source, target: known(source) })),
		...overrides
	};
}

describe('fitAlignmentPairs', () => {
	test('recovers a known similarity with zero residual, reported in px and in metres', () => {
		const report = fitAlignmentPairs(file());
		expect(report.ok).toBe(true);
		if (!report.ok) return;
		expect(report.transform.majorAxisScale).toBeCloseTo(0.5, 9);
		expect(report.residualsPx.rms).toBeLessThan(1e-9);
		expect(report.residualsM!.rms).toBeLessThan(1e-9);
		expect(report.groundScale!.metersPerPixel).toBe(naipMetersPerPixel(300, 2048));
		expect(report.groundScale!.referent).toContain('300 m radius at 2048 px');
	});

	test('residuals in metres are px times the basemap ground scale', () => {
		const base = file();
		const pairs = base.pairs.map((pair, index) =>
			index === 0 ? { ...pair, target: { xPx: pair.target!.xPx + 10, yPx: pair.target!.yPx } } : pair
		);
		const report = fitAlignmentPairs({ ...base, pairs });
		if (!report.ok) throw new Error('fit failed');
		const mpp = naipMetersPerPixel(300, 2048);
		for (const residual of report.residuals) expect(residual.distanceM).toBeCloseTo(residual.distancePx * mpp, 9);
		expect(report.residualsPx.maxPairId).toBe('p1');
		expect(report.residualsM!.max).toBeCloseTo(report.residualsPx.max * mpp, 9);
	});

	test('a basemap without a ground scale gives px residuals and no metres', () => {
		const base = file();
		const report = fitAlignmentPairs({ ...base, basemap: { fileName: 'tile.png', widthPx: 1290, heightPx: 2796 } });
		if (!report.ok) throw new Error('fit failed');
		expect(report.groundScale).toBeNull();
		expect(report.residualsM).toBeNull();
		expect(report.residuals.every((r) => r.distanceM === null)).toBe(true);
	});

	test('unpicked targets are kept, never used; too few complete pairs is a result, not a throw', () => {
		const base = file();
		const pairs = base.pairs.map((pair, index) => (index > 0 ? { ...pair, target: null } : pair));
		const report = fitAlignmentPairs({ ...base, pairs });
		expect(report.ok).toBe(false);
		if (report.ok) return;
		expect(report.reason).toBe('INSUFFICIENT_PAIRS');
		expect(report.availablePairs).toBe(1);

		const partly = fitAlignmentPairs({ ...base, pairs: base.pairs.map((pair, index) => (index === 4 ? { ...pair, target: null } : pair)) });
		if (!partly.ok) throw new Error('fit failed');
		expect(partly.unusedPairIds).toEqual(['p5']);
	});

	test('affine needs three pairs and fits them', () => {
		const report = fitAlignmentPairs(file({ model: 'affine' }));
		expect(report.ok && report.model).toBe('affine');
	});
});

describe('parseAlignmentPairs', () => {
	test('round-trips a file and fills enabled/label defaults', () => {
		const text = JSON.stringify({ ...file(), pairs: [{ id: 'a', source: { xPx: 1, yPx: 2 }, target: null }] });
		const parsed = parseAlignmentPairs(text);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.file.pairs[0]).toEqual({ id: 'a', label: 'a', enabled: true, source: { xPx: 1, yPx: 2 }, target: null });
		expect(basemapGroundScale(parsed.file.basemap)!.metersPerPixel).toBeCloseTo(600 / 2048, 12);
	});

	test.each([
		['format', { format: 'nope' }],
		['model', { model: 'projective' }],
		['basemap.naip.sizePx', { basemap: { fileName: 'n.png', widthPx: 2048, heightPx: 1024, naip: { center: { lat: 1, lon: 1 }, radiusMeters: 300, sizePx: 2048 } } }],
		['pairs[1].id', { pairs: [{ id: 'a', source: { xPx: 0, yPx: 0 }, target: null }, { id: 'a', source: { xPx: 0, yPx: 0 }, target: null }] }],
		['pairs[0].target', { pairs: [{ id: 'a', source: { xPx: 0, yPx: 0 }, target: { xPx: 'x' } }] }]
	])('rejects a bad %s with a structured error', (path, patch) => {
		const parsed = parseAlignmentPairs(JSON.stringify({ ...file(), ...patch }));
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error.path).toBe(path);
	});

	test('not JSON is a structured error', () => {
		expect(parseAlignmentPairs('{').ok).toBe(false);
	});
});

describe('The Rec fixture: stitched composite to its left tile (not NAIP)', () => {
	test('fits the stitch translation back, scale 1, residual 0 px of TheRec-L.PNG', () => {
		const parsed = parseAlignmentPairs(readFileSync('tests/fixtures/alignment-pairs/therec-composite-to-tile-L.pairs.json', 'utf8'));
		if (!parsed.ok) throw new Error(parsed.error.message);
		const report = fitAlignmentPairs(parsed.file);
		if (!report.ok) throw new Error(report.reason);
		const [a, b, c, d, e, f] = report.transform.coefficients;
		expect([a, b, c, d]).toEqual([1, 0, 0, 1].map((v) => expect.closeTo(v, 9)));
		expect(e).toBeCloseTo(0, 6);
		expect(f).toBeCloseTo(330, 6);
		expect(report.residualsPx.max).toBeLessThan(1e-6);
		expect(report.residualsM).toBeNull();
	});
});

describe('fitAlignmentPairs: a source ground scale (C1) carried through the fit', () => {
	test('used only when the basemap has none: source m/px divided by the fit scale', () => {
		const base = file();
		const noScale = { ...base, basemap: { fileName: 'tile.png', widthPx: 1290, heightPx: 2796 } };
		const sourceGroundScale = { metersPerPixel: 10 / 44.5, referent: 'C1 circle, 10 m = 44.5 px (rC1)' };
		const report = fitAlignmentPairs(noScale, { sourceGroundScale });
		if (!report.ok) throw new Error('fit failed');
		expect(report.groundScale!.metersPerPixel).toBeCloseTo(10 / 44.5 / 0.5, 9);
		expect(report.groundScale!.referent).toContain('carried through the similarity fit');
		const withNaip = fitAlignmentPairs(base, { sourceGroundScale });
		if (!withNaip.ok) throw new Error('fit failed');
		expect(withNaip.groundScale!.referent).toContain('USGS NAIP');
	});
});

describe('the slice fixtures: pairs picked by eye on NAIP', () => {
	const load = (name: string) => {
		const parsed = parseAlignmentPairs(readFileSync(`tests/fixtures/alignment-pairs/${name}`, 'utf8'));
		if (!parsed.ok) throw new Error(parsed.error.message);
		return parsed.file;
	};

	test("Dash's Track: 6 pairs on the wide tile fit a similarity to under 1 m RMS, scale in m from the rendered extent", () => {
		const file = load('dashs-track.naip-wide.pairs.json');
		expect(file.basemap.raster?.widthPx).toBe(2048);
		const report = fitAlignmentPairs(file);
		if (!report.ok) throw new Error(report.reason);
		expect(report.groundScale!.referent).toContain('from its rendered extent');
		expect(report.residualsM!.rms).toBeLessThan(1);
		// the C1 cross-check: NAIP m per screenshot px vs 10 m / 44.5 px (golden rC1), within 2%
		const naipShot = Math.sqrt(report.transform.determinant) * report.groundScale!.metersPerPixel;
		expect(Math.abs(naipShot / (10 / 44.5) - 1)).toBeLessThan(0.02);
	});

	test('The Rec: 4 path pairs on the pick tile fit to under 1 m RMS and agree with rC1 94 px within 2%', () => {
		const file = load('therec.naip-pick.pairs.json');
		const report = fitAlignmentPairs(file);
		if (!report.ok) throw new Error(report.reason);
		expect(report.residualsM!.rms).toBeLessThan(1);
		const naipShot = Math.sqrt(report.transform.determinant) * report.groundScale!.metersPerPixel;
		expect(Math.abs(naipShot / (10 / 94) - 1)).toBeLessThan(0.02);
	});
});
