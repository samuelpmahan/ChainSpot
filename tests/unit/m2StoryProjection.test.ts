import { describe, expect, test } from 'vitest';
import {
	assertM2ProjectionSource,
	assertM2RawFrameCorrespondence,
	assertM2RawFrameTrace,
	adaptM2RawFrameStatsControl,
	formatM2RawFrameCliText,
	materializeM2RawFrameTrace,
	M2_PROJECTIONS,
	projectM2Image,
	projectM2RawFrameVisual,
	type M2BadgeProjectionSubject,
	type M2RawFrameTrace
} from '../../src/lib/evidence-workbench/m2Projection';

const subject: M2BadgeProjectionSubject = {
	id: 'badge-0',
	title: 'Badge 0 · M1 → M2',
	crop: { x: 1, y: 1, width: 3, height: 2 },
	rasterWidth: 5,
	m2: {
		m1: { availablePixels: [6, 7], explainedPixels: [6, 7], unexplainedPixels: [] },
		m2: { availablePixels: [6, 7, 8], explainedPixels: [6, 7, 8], unexplainedPixels: [] },
		transition: {
			preservedPixels: [6, 7],
			lostPixels: [],
			discoveredPixels: [8],
			newlyExplainedPixels: [8],
			stillUnexplainedPixels: [],
			regressionLoss: 0,
			discoveryLoss: 0
		},
		aa: {
			candidatePixels: [8],
			explainedPixels: [8],
			provisionalPixels: [8],
			unresolvedPixels: []
		},
		registration: {
			method: 'same-raster-m1-geometry',
			sampleCount: 3,
			alignedSampleCount: 3,
			digitCondition: 'all',
			minimumSupportCount: 2,
			minimumSupportFraction: 1,
			provenance: 'registered separate objects in one raster'
		},
		frame: {
			status: 'adequate',
			samples: 2,
			latestMarginPx: 2,
			stableSet: true,
			boundarySupportedPixelCount: 0,
			reason: 'stable'
		}
	}
};

const rawTrace: M2RawFrameTrace = {
	identity: {
		runId: 'run-m2-0',
		imageId: 'image-m2-0',
		paramsHash: 'params-m2-0',
		featureId: 'badgeM2Aa',
		traceHash: 'trace-m2-0'
	},
	objectId: 'badge-0',
	coordinateFrame: 'm1-owned-bbox-local',
	crop: { x: 10, y: 20, width: 4, height: 3 },
	marginPx: 2,
	rawRgba: new Uint8ClampedArray(4 * 3 * 4).fill(128),
	exactBaselinePixels: [[1, 1], [2, 1], [1, 2], [2, 2]],
	partition: {
		'm1-owned': [[1, 1]],
		'old-aa': [[2, 1]],
		'old-residue': [[1, 2]],
		exterior: [[2, 2]]
	},
	glyph: { exactPixels: [[1, 1]], haloPixels: [[0, 1], [2, 1]] },
	support: {
		exactCount: 4,
		minimumSupportCount: 2,
		minimumSupportFraction: 0.5,
		sampleCount: 5,
		alignedSampleCount: 4,
		registration: 'exact-m1-owned-bbox-local'
	},
	boundaryByMargin: [
		{ marginPx: 2, status: 'clear', supportedPixelCount: 4, boundarySupportedPixelCount: 0, unobservedSampleCount: 0 },
		{ marginPx: 3, status: 'touching', supportedPixelCount: 5, boundarySupportedPixelCount: 1, unobservedSampleCount: 0 },
		{ marginPx: 4, status: 'unknown-truncated', supportedPixelCount: 5, boundarySupportedPixelCount: 0, unobservedSampleCount: 1 }
	],
	frameBoundary: [0, 0, 4, 3],
	jpegCaveat: 'JPEG values are decoded samples in this fixture.'
};

describe('E-backed M2 Storybook projections', () => {
	test('exposes only supplied M1/M2 identity-set projections', () => {
		assertM2ProjectionSource(subject);
		for (const projection of M2_PROJECTIONS) {
			const image = projectM2Image(subject, projection);
			expect([image.width, image.height]).toEqual([3, 2]);
		}
	});

	test('maps global E pixel identities into the crop without recomputing ownership', () => {
		const image = projectM2Image(subject, 'transition');
		// Global pixels 6, 7, 8 map to local crop pixels 0, 1, 2.
		expect([...image.rgba.slice(0, 4)]).toEqual([22, 163, 74, 255]);
		expect([...image.rgba.slice(4, 8)]).toEqual([22, 163, 74, 255]);
		expect([...image.rgba.slice(8, 12)]).toEqual([6, 182, 212, 255]);
	});

	test('keeps candidate control distinct from the explained transition', () => {
		const candidate = projectM2Image(subject, 'discovered');
		const explained = projectM2Image(subject, 'newly-explained');
		expect([...candidate.rgba.slice(8, 12)]).toEqual([124, 58, 237, 255]);
		expect([...explained.rgba.slice(8, 12)]).toEqual([6, 182, 212, 255]);
	});

	test('renders recurrence support as provisional when supplied separately from M2 ownership', () => {
		const provisional = projectM2Image(subject, 'provisional');
		expect([...provisional.rgba.slice(8, 12)]).toEqual([99, 102, 241, 255]);
	});

	test('keeps provisional candidates unresolved when the frame is insufficient', () => {
		const insufficient: M2BadgeProjectionSubject = {
			...subject,
			m2: {
				...subject.m2,
				m2: { availablePixels: [6, 7, 8], explainedPixels: [6, 7], unexplainedPixels: [8] },
				transition: {
					...subject.m2.transition,
					newlyExplainedPixels: [],
					stillUnexplainedPixels: [8],
					discoveryLoss: 1
				},
				aa: { ...subject.m2.aa, explainedPixels: [], unresolvedPixels: [8] },
				frame: { ...subject.m2.frame, status: 'insufficient', stableSet: false }
			}
		};
		assertM2ProjectionSource(insufficient);
		expect(insufficient.m2.m2.explainedPixels.length).toBe(2);
		expect(insufficient.m2.transition.stillUnexplainedPixels).toEqual([8]);
		expect([...projectM2Image(insufficient, 'newly-explained').rgba]).toEqual(
			new Array(3 * 2 * 4).fill(0)
		);
	});

	test('rejects a receipt that contradicts supplied exact transition identities', () => {
		expect(() =>
			assertM2ProjectionSource({
				...subject,
				m2: {
					...subject.m2,
					aa: { ...subject.m2.aa, candidatePixels: [8, 9] }
				}
			})
		).toThrow(/candidate and discovered sets/);
	});

	test('projects the supplied raw frame and never recomputes candidate recurrence', () => {
		const visual = projectM2RawFrameVisual(rawTrace, 'badge-0');
		expect([...visual.rawRgba]).toEqual(Array.from(rawTrace.rawRgba));
		expect(visual.layers.map((layer) => layer.name)).toEqual([
			'exact baseline · M1 owned',
			'exact baseline · old AA',
			'exact baseline · old residue',
			'exact baseline · new exterior',
			'glyph halo/support',
			'glyph exact mask'
		]);
		expect(visual.partitionCounts).toEqual({ 'm1-owned': 1, 'old-aa': 1, 'old-residue': 1, exterior: 1 });
		expect(visual.boundaryByMargin.map((value) => value.status)).toEqual([
			'clear',
			'touching',
			'unknown-truncated'
		]);
	});

	test('CLI text carries exact identity, support, all margins, partition, and caveat', () => {
		const cliText = formatM2RawFrameCliText(rawTrace);
		expect(cliText).toContain('exact baseline RGBA=4');
		expect(cliText).toContain('minimum support count=2');
		expect(cliText).toContain('glyph exact mask=1');
		expect(cliText).toContain('glyph halo/support=2');
		expect(cliText).toContain('margin 2px: boundary=clear');
		expect(cliText).toContain('margin 3px: boundary=touching');
		expect(cliText).toContain('margin 4px: boundary=unknown-truncated');
		expect(cliText).toContain('final support partition: M1 owned=1 old AA=1 old residue=1 new exterior=1');
		expect(cliText).toContain('CAVEAT: JPEG values');
		assertM2RawFrameCorrespondence({ trace: rawTrace, cliText });
	});

	test('rejects missing or mismatched trace identity before rendering', () => {
		expect(() => assertM2RawFrameTrace({ ...rawTrace, identity: { ...rawTrace.identity, traceHash: '' } })).toThrow(
			/missing trace identity 'traceHash'/
		);
		expect(() => projectM2RawFrameVisual(rawTrace, 'badge-1')).toThrow(/does not match subject/);
		expect(() =>
			assertM2RawFrameCorrespondence({
				trace: rawTrace,
				cliText: formatM2RawFrameCliText({ ...rawTrace, identity: { ...rawTrace.identity, traceHash: 'other' } })
			})
		).toThrow(/traceHash/);
	});

	test('labels quantized appearance as a non-authoritative diagnostic', () => {
		const quantized = {
			...rawTrace,
			quantizedDiagnostic: { rgba: new Uint8ClampedArray(rawTrace.rawRgba.length).fill(64), binWidth: 16 }
		};
		const visual = projectM2RawFrameVisual(quantized, 'badge-0', 'quantized-diagnostic');
		expect(visual.appearanceLabel).toContain('NON-AUTHORITATIVE');
		expect(visual.appearanceLabel).toContain('floor(c/16)');
		expect(visual.boundaryByMargin).toEqual(rawTrace.boundaryByMargin);
	});

	test('seals behavior trace with RunTrace identity and copies raw crop once', () => {
		const behavior = {
			objectId: rawTrace.objectId,
			coordinateFrame: rawTrace.coordinateFrame,
			crop: rawTrace.crop,
			marginPx: rawTrace.marginPx,
			rawRgba: rawTrace.rawRgba,
			exactBaselinePixels: rawTrace.exactBaselinePixels,
			targetPartitions: rawTrace.partition,
			glyph: rawTrace.glyph,
			registrations: rawTrace.support,
			margins: rawTrace.boundaryByMargin,
			frameBoundary: rawTrace.frameBoundary
		};
		const sealed = materializeM2RawFrameTrace({ identity: rawTrace.identity, behavior });
		expect(sealed.rawRgba).not.toBe(rawTrace.rawRgba);
		expect(Array.from(sealed.rawRgba)).toEqual(Array.from(rawTrace.rawRgba));
		expect(sealed.identity).toEqual(rawTrace.identity);
	});

	test('prints supplied empirical null controls without recomputing or hiding ownership gate', () => {
		const withNull = {
			...rawTrace,
			statistics: {
				assumedP: 0.5,
				allSamplesExactCount: 18,
				sampleTotal: 18,
				empiricalNull: {
					controlSeed: 7,
					B: 999,
					ownershipSignificant: false,
					thresholds: [{
						threshold: 2,
						globalMaxOverlap: { observed: 18, nullMean: 2, nullSd: 1, nullQuantiles: { p95: 4 }, nullMax: 7, empiricalP: 0.01, verdict: 'significant' as const },
						largest8ConnectedCluster: { observed: 3, nullMean: 1, nullSd: 0.5, nullQuantiles: { p95: 2 }, nullMax: 4, empiricalP: 0.4, verdict: 'not-significant' as const }
					}],
					outermostClearedRingNegativeControl: { observed: 0, nullMean: 1, nullSd: 1, nullQuantiles: { p95: 3 }, nullMax: 4, empiricalP: 0.9, verdict: 'not-significant' as const }
				}
			}
		};
		const visual = projectM2RawFrameVisual(withNull);
		const text = formatM2RawFrameCliText(withNull);
		expect(visual.ownershipDisplayAllowed).toBe(false);
		expect(text).toContain('controlSeed=7 B=999');
		expect(text).toContain('threshold=2 global-max-overlap');
		expect(text).toContain('largest-8-connected-cluster');
		expect(text).toContain('outermost-cleared-ring negative control');
		expect(text).toContain('18/18 => 0.5^18');
	});

	test('adapts producer null-control rows field-for-field', () => {
		const summary = adaptM2RawFrameStatsControl({
			controlSeed: 'deadbeef',
			replicateCount: 999,
			margins: [{ marginPx: 2, bySupportThreshold: {
				'2': {
					globalMaxExactOverlap: { observed: 18, nullMean: 1, nullSampleSd: 0.5, nullQuantiles: { p50: 1, p95: 2, p99: 3 }, nullMaximum: 4, empiricalP: 0.01 },
					largestEightConnectedCluster: { observed: 5, nullMean: 1, nullSampleSd: 0.5, nullQuantiles: { p50: 1, p95: 2, p99: 3 }, nullMaximum: 4, empiricalP: 0.02 }
				}
			}, outermostClearedRing: undefined }]
		});
		expect(summary).toMatchObject({ controlSeed: 'deadbeef', B: 999, thresholds: [{ threshold: 2, globalMaxOverlap: { observed: 18, nullSd: 0.5, nullMax: 4, empiricalP: 0.01 } }] });
	});
});
