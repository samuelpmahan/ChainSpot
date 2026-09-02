import { describe, expect, test } from 'vitest';
import type { MaterializedBadgeEvidence } from '@chainspot/alg/detectors/threeFactor/badgeEvidence';
import type { MaterializedM1Representation } from '@chainspot/alg/detectors/threeFactor/m1Representation';
import type { RgbaImage } from '@chainspot/alg/detectors/threeFactor/types';
import {
	assessM2FrameSweep,
	decodeMaterializedBadgeM2Representation,
	encodeMaterializedBadgeM2Representation,
	materializeBadgeM2Representation,
	transitionM1ToM2,
	materializeExpandedBadgeRawFrameProbe,
	materializeExpandedBadgeRawFrameProbeWithControl,
	type M2RawSourceProbeInput
} from '@chainspot/alg/detectors/threeFactor/m2Representation';
import { materializeM2RawFrameStatsControl } from '@chainspot/alg/detectors/threeFactor/m2RawFrameStatsControl';

const raster = { width: 12, height: 10 };
const outer = { polarity: 'bright' as const, label: 1, bbox: [3, 3, 4, 4] as const, area: 12 };
const plate = { polarity: 'dark' as const, label: 2, bbox: [4, 4, 2, 2] as const, area: 4 };
const glyph = { polarity: 'bright' as const, label: 3, bbox: [4, 4, 1, 1] as const, area: 1 };

function specimen(
	id: string,
	aaPixels: readonly number[],
	digitCharacter = '1'
): MaterializedBadgeEvidence {
	const ownedBwPixels = Uint32Array.from([39, 40, 41, 42, 51, 54, 63, 64, 65, 66, 75, 76]);
	return {
		schema: 'chainspot.badge-evidence/v1',
		id,
		provenance: {
			imageId: 'same-image',
			paramsHash: 'params',
			detector: 'test',
			detectorVersion: '1'
		},
		badge: {
			detId: id,
			component: {
				label: 1,
				cx: 5,
				cy: 5,
				area: 12,
				bboxX: 3,
				bboxY: 3,
				bboxW: 4,
				bboxH: 4,
				major: 4,
				minor: 4,
				angle: 0,
				fill: 0.75
			},
			cxPx: 5,
			cyPx: 5,
			bbox: [3, 3, 4, 4],
			source: 'bright-family',
			digits: [
				{
					bbox: [4, 4, 1, 1],
					method: 'cc',
					predicted: digitCharacter,
					runnerUp: '7',
					scores: [1],
					margin: 1,
					normalized: new Uint8Array([1])
				}
			],
			rawLabel: digitCharacter,
			digitCount: 1,
			label: digitCharacter,
			bestLabel: digitCharacter,
			labelCandidates: [],
			confidence: 1,
			abstentionReason: null,
			confidenceFloor: 0,
			conflictWith: [],
			notes: []
		},
		raster,
		region: {
			bbox: [2, 2, 6, 6],
			rgba: new Uint8Array(6 * 6 * 4),
			brightMask: new Uint8Array(36),
			darkMask: new Uint8Array(36),
			brightLabels: new Int32Array(36),
			darkLabels: new Int32Array(36)
		},
		components: [outer, plate, glyph],
		ownedBwPixels,
		aaPixels: Uint32Array.from(aaPixels),
		residuePixels: new Uint32Array(),
		measurements: {
			bwOwnedPixelCount: ownedBwPixels.length,
			aaAddedPixelCount: aaPixels.length,
			residueBefore: 0,
			residueAfter: 0
		}
	};
}

describe('E representation M2', () => {
	test('preserves M1, distinguishes recurring structural/digit support, and leaves weak candidates unresolved', () => {
		const structural = 2 * raster.width + 3;
		const digit = 4 * raster.width + 4;
		const weak = 7 * raster.width + 7;
		const target = specimen('badge-0', [weak, digit, structural]);
		const peerA = specimen('badge-1', [digit, structural]);
		const peerB = specimen('badge-2', [digit, structural]);
		const peerWrongDigit = specimen('badge-3', [digit, structural], '7');
		const result = materializeBadgeM2Representation(target, [peerA, peerB, peerWrongDigit], {
			registrationMethod: 'same-raster-m1-geometry',
			digitCondition: 'digit-adjacent',
			minimumSupportCount: 2,
			minimumSupportFraction: 1,
			frameSweep: [
				{ marginPx: 1, supportedPixels: [[1, 0]], boundarySupportedPixelCount: 0 },
				{
					marginPx: 2,
					supportedPixels: [[1, 0]],
					boundarySupportedPixelCount: 0,
					unobservedSampleCount: 0
				}
			]
		});

		expect(result.registration).toMatchObject({
			method: 'same-raster-m1-geometry',
			sampleCount: 4,
			alignedSampleCount: 4,
			digitCondition: 'digit-adjacent',
			minimumSupportCount: 2,
			minimumSupportFraction: 1
		});
		expect(result.registration.provenance).toContain('not multisampling');
		expect(result.m1.availablePixels).toEqual(result.m1.explainedPixels);
		expect(result.m1.availablePixels).toHaveLength(12);
		expect(result.aa.candidatePixels).toEqual(Uint32Array.from([structural, digit, weak]));
		expect(result.aa.explainedPixels).toEqual(new Uint32Array());
		expect(result.aa.provisionalPixels).toEqual(new Uint32Array());
		expect(result.aa.observations[1]?.sampleIds).toEqual(['badge-0', 'badge-1', 'badge-2']);
		expect(result.aa.unresolvedPixels).toEqual(
			Uint32Array.from([structural, digit, weak])
		);
		expect(result.aa.observations.map((value) => value.class)).toEqual([
			'structural-common',
			'digit-conditioned',
			'unresolved'
		]);
		expect(result.m2.availablePixels).toHaveLength(15);
		expect(result.m2.explainedPixels).toHaveLength(12);
		expect(result.m2.unexplainedPixels).toEqual(Uint32Array.from([structural, digit, weak]));
		expect(result.transition.preservedPixels).toHaveLength(12);
		expect(result.transition.lostPixels).toHaveLength(0);
		expect(result.transition.discoveredPixels).toEqual(Uint32Array.from([structural, digit, weak]));
		expect(result.transition.newlyExplainedPixels).toEqual(new Uint32Array());
		expect(result.transition.stillUnexplainedPixels).toEqual(
			Uint32Array.from([structural, digit, weak])
		);
		expect(result.transition.regressionLoss).toBe(0);
		expect(result.transition.discoveryLoss).toBe(1);
		expect(result.frame.status).toBe('not-measured');
		const replay = decodeMaterializedBadgeM2Representation(
			encodeMaterializedBadgeM2Representation(result)
		);
		expect(replay).toEqual(result);
	});

	test('does not call same-raster recurrence multisampling and reports frame adequacy as unknown without a sweep', () => {
		const result = materializeBadgeM2Representation(
			specimen('badge-0', [91]),
			[specimen('badge-1', [91])],
			{ registrationMethod: 'same-raster-m1-geometry', minimumSupportCount: 2 }
		);
		expect(result.registration.sampleCount).toBe(2);
		expect(result.registration.provenance).toContain('not multisampling');
		expect(result.frame).toMatchObject({ status: 'not-measured', samples: 0, stableSet: false });
		expect(result.aa.provisionalPixels).toEqual(new Uint32Array());
		expect(result.aa.explainedPixels).toHaveLength(0);
		expect(result.transition.newlyExplainedPixels).toHaveLength(0);
		expect(result.transition.stillUnexplainedPixels).toEqual(Uint32Array.from([91]));
	});

	test('does not promote digit-adjacent support when the emitted digit identity is absent', () => {
		const candidate = 4 * raster.width + 4;
		const base = specimen('badge-0', [candidate]);
		const invalid = {
			...base,
			badge: { ...base.badge, label: null, bestLabel: '1', abstentionReason: 'ambiguous' as const }
		};
		const result = materializeBadgeM2Representation(invalid, [specimen('badge-1', [candidate])], {
			registrationMethod: 'same-raster-m1-geometry',
			digitCondition: 'digit-adjacent',
			minimumSupportCount: 1,
			minimumSupportFraction: 0.5,
			frameSweep: [
				{ marginPx: 1, supportedPixels: [], boundarySupportedPixelCount: 0 },
				{ marginPx: 2, supportedPixels: [], boundarySupportedPixelCount: 0 }
			]
		});
		expect(result.aa.observations[0]?.class).toBe('unsupported');
		expect(result.aa.provisionalPixels).toHaveLength(0);
		expect(result.transition.newlyExplainedPixels).toHaveLength(0);
	});

	test('requires the final expanded support set to stabilize and clear the boundary', () => {
		expect(
			assessM2FrameSweep([
				{ marginPx: 1, supportedPixels: [[2, 0]], boundarySupportedPixelCount: 0 },
				{
					marginPx: 2,
					supportedPixels: [
						[2, 0],
						[3, 0]
					],
					boundarySupportedPixelCount: 0
				}
			])
		).toMatchObject({ status: 'insufficient', stableSet: false, latestMarginPx: 2 });
		expect(
			assessM2FrameSweep([
				{ marginPx: 1, supportedPixels: [[2, 0]], boundarySupportedPixelCount: 0 },
				{ marginPx: 2, supportedPixels: [[2, 0]], boundarySupportedPixelCount: 1 }
			])
		).toMatchObject({ status: 'insufficient', stableSet: true, boundarySupportedPixelCount: 1 });
		// The real neutral-ring probe grew at every observed margin and retained
		// boundary support throughout; it must not graduate AA into M2 ownership.
		const observed = [
			[1, 294, 196],
			[2, 491, 197],
			[3, 687, 196],
			[4, 884, 197],
			[5, 1103, 219],
			[6, 1325, 222]
		].map(([marginPx, _supportedCount, boundarySupportedPixelCount]) => ({
			marginPx,
			supportedPixels: Array.from(
				{ length: _supportedCount },
				(_, index) => [index, 0] as [number, number]
			),
			boundarySupportedPixelCount
		}));
		expect(assessM2FrameSweep(observed)).toMatchObject({
			status: 'insufficient',
			samples: 6,
			stableSet: false,
			latestMarginPx: 6,
			boundarySupportedPixelCount: 222
		});
		expect(
			assessM2FrameSweep([
				{ marginPx: 1, supportedPixels: [[1, 0]], boundarySupportedPixelCount: 0 },
				{
					marginPx: 2,
					supportedPixels: [[1, 0]],
					boundarySupportedPixelCount: 0,
					unobservedSampleCount: 1
				}
			])
		).toMatchObject({ status: 'insufficient', stableSet: true, unobservedSampleCount: 1 });
	});

	test('transition accounting rejects fabricated explanations and handles empty loss denominators', () => {
		expect(() => transitionM1ToM2([1], [2], [], [])).toThrow(/subset of M1 available/);
		expect(() => transitionM1ToM2([], [], [3], [4])).toThrow(/subset of discovered/);
		expect(() => transitionM1ToM2([1], [1], [1], [])).toThrow(/discovered pixels must be new/);
		const empty = transitionM1ToM2([], [], [], []);
		expect(empty.transition.regressionLoss).toBeNull();
		expect(empty.transition.discoveryLoss).toBeNull();
		const historicalResidue = transitionM1ToM2([1, 2], [1], [3], [3]);
		expect(historicalResidue.m2.unexplainedPixels).toEqual(Uint32Array.from([2]));
		expect(historicalResidue.transition.stillUnexplainedPixels).toHaveLength(0);
		expect(historicalResidue.transition.discoveryLoss).toBe(0);
	});
});

describe('M2 expanded-frame raw-source probe', () => {
	function rawFixture(candidatePixels: readonly number[] = []): M2RawSourceProbeInput {
		const width = 180;
		const height = 24;
		const data = new Uint8Array(width * height * 4);
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
			const p = (y * width + x) * 4;
			data[p] = (x * 17 + y * 3) % 251;
			data[p + 1] = (x * 7 + y * 11) % 251;
			data[p + 2] = (x * 13 + y * 5) % 251;
			data[p + 3] = 255;
		}
		const image: RgbaImage = { width, height, data };
		const positions = Array.from({ length: 18 }, (_, index) => [5 + index * 9, 8] as const);
		const specimens = positions.map(([x0, y0], index) => {
			const base = specimen(`raw-${String(index).padStart(2, '0')}`, candidatePixels);
			const owned = Uint32Array.from(Array.from({ length: 16 }, (_, offset) => {
				const x = offset % 4;
				const y = Math.floor(offset / 4);
				return (y0 + y) * width + x0 + x;
			}));
			return {
				...base,
				raster: { width, height },
				badge: { ...base.badge, bbox: [x0, y0, 4, 4] as const, component: { ...base.badge.component, bboxX: x0, bboxY: y0, bboxW: 4, bboxH: 4 } },
				ownedBwPixels: owned,
				aaPixels: Uint32Array.from(candidatePixels.map((pixel) => pixel + x0 - 3)),
				residuePixels: new Uint32Array(),
				measurements: { ...base.measurements, bwOwnedPixelCount: owned.length, aaAddedPixelCount: candidatePixels.length }
			};
		});
		// These appearances recur in all 18 raw crops. They include a plate cell,
		// an old-AA cell outside the M1 bbox, and one interior M1 cell.
		for (const [x0, y0] of positions) for (const [dx, dy, rgba] of [
			[0, 0, [12, 34, 56, 255]],
			[1, 0, [21, 43, 65, 255]],
			[4, 0, [31, 53, 75, 255]]
		] as const) {
			const p = ((y0 + dy) * width + x0 + dx) * 4;
			data.set(rgba, p);
		}
		for (const [value, positionIndex] of [[10, 0], [11, 1]] as const) {
			const [x0, y0] = positions[positionIndex]!;
			data.set([value, value, value, 255], (y0 * width + x0 + 3) * 4);
		}
		for (let index = 2; index < positions.length; index++) {
			const [x0, y0] = positions[index]!;
			const value = 24 + index * 13;
			data.set([value, value, value, 255], (y0 * width + x0 + 3) * 4);
		}
		const components = positions.map(([x0, y0], index) => ({
			id: `component.bright.${index + 10}`,
			polarity: 'bright' as const,
			label: index + 10,
			bbox: [x0 + 2, y0 + 2, 1, 1] as const,
			area: 1,
			pixels: Uint32Array.from([(y0 + 2) * width + x0 + 2]),
			producedBy: 'badgeStage.components' as const,
			consumers: []
		}));
		const m1: MaterializedM1Representation = {
			schema: 'chainspot.object-representation-m1/v1',
			provenance: { imageId: 'raw', paramsHash: 'raw', detector: 'test', detectorVersion: '1' },
			raster: { width, height, topPx: 0 },
			components,
			relationships: [],
			basketShellFamilies: [],
			objects: positions.map(([x0, y0], index) => {
				const id = `raw-${String(index).padStart(2, '0')}`;
				const owned = Uint32Array.from(Array.from({ length: 16 }, (_, offset) => (y0 + Math.floor(offset / 4)) * width + x0 + offset % 4));
				return { id, kind: 'badge' as const, detectorId: id, assemblyStatus: 'assembled' as const, componentUses: [{ componentId: `component.bright.${index + 10}`, role: 'glyph' as const }], relationshipIds: [], accounting: { status: 'known' as const, universe: 'selected-bw-component-pixels' as const, availablePixels: owned, explainedPixels: owned, unexplainedPixels: new Uint32Array() }, consumedBy: 'component-backed-object-assembly-v1' as const };
			})
		};
		return { image, specimens, m1, options: { safetyCapMarginPx: 4, quantizedBinWidth: 8 } };
	}

	test('discovers raw recurrence with empty candidates and records deterministic registration/masks', () => {
		const input = rawFixture();
		const result = materializeExpandedBadgeRawFrameProbe(input);
		expect(result.state).toBe('materialized');
		expect(result.trace.algorithm.exact).toMatchObject({ authoritative: true, equality: 'exact-rgba-tuple', minimumSupportCount: 2 });
		expect(result.trace.registrations).toHaveLength(18);
		expect(result.trace.registrations[0]).toMatchObject({ ownedBbox: [5, 8, 4, 4], translation: [5, 8], glyphExactCount: 1, glyphHaloCount: 8 });
		expect(result.trace.final.targets[0]?.partition.counts['m1-owned']).toBeGreaterThan(0);
	});

	test('raw discovery is invariant when old candidate membership changes', () => {
		const empty = materializeExpandedBadgeRawFrameProbe(rawFixture());
		const candidates = materializeExpandedBadgeRawFrameProbe(rawFixture([5 + 4 + 8 * 180]));
		expect(candidates.trace.margins.map((margin) => margin.exactSupportedCoordinates)).toEqual(empty.trace.margins.map((margin) => margin.exactSupportedCoordinates));
	});

	test('glyph mask excludes glyph and halo only; plate and exterior cells remain eligible', () => {
		// Schema v2: only the final margin retains full per-pixel observations
		// (superseded margins keep summaries only), so this reads the margin
		// keyed by trace.final.finalMarginPx rather than an arbitrary index.
		// Local pixels are owned-bbox-relative and identify the same source
		// pixel at any margin >= 2, so the expected values are unchanged.
		const result = materializeExpandedBadgeRawFrameProbe(rawFixture());
		const margin = result.trace.margins.find((value) => value.marginPx === result.trace.final.finalMarginPx)!;
		expect(margin.observations?.find((value) => value.localPixel.join(',') === '1,0')?.exactSupported).toBe(true);
		expect(margin.observations?.find((value) => value.localPixel.join(',') === '2,2')?.eligibleSampleIds).toHaveLength(0);
		expect(margin.observations?.find((value) => value.localPixel.join(',') === '4,0')?.exactSupported).toBe(true);
	});

	test('frame grows, clears exact boundaries, and quantized diagnostics never control exact support', () => {
		const result = materializeExpandedBadgeRawFrameProbe(rawFixture());
		expect(result.trace.margins[0]?.frameSize).toEqual([8, 8]);
		expect(result.trace.margins[1]?.frameSize).toEqual([10, 10]);
		expect(result.trace.final.status).toBe('adequate');
		expect(result.trace.algorithm.quantized.authoritative).toBe(false);
		// Schema v2: superseded margins (all but the final one) no longer carry
		// `observations`; look the diagnostic coordinate up on the final margin.
		const finalMargin = result.trace.margins.find((value) => value.marginPx === result.trace.final.finalMarginPx);
		expect(result.trace.margins.some((value) => value.marginPx !== result.trace.final.finalMarginPx && value.observations !== undefined)).toBe(false);
		const diagnosticOnly = finalMargin?.observations?.find((value) => value.localPixel.join(',') === '3,0');
		expect(diagnosticOnly).toMatchObject({ exactSupported: false, quantizedSupported: true });
		expect(diagnosticOnly?.nullModel).toMatchObject({ p: 0.5, probabilityAllMatch: 3.814697265625e-6, percentAllMatch: 0.0003814697265625 });
		expect(diagnosticOnly?.sampleSdDenominator).toBe('n-1');
	});

	test('only adequate exact 18/18 support promotes raw M2 ownership', () => {
		// rawFixture translates legacy AA pixels by x0 - 3; this value lands at
		// the recurring exterior coordinate local (4,0) for the first badge.
		const input = rawFixture([5 + 4 + 8 * 180]);
		const gated = materializeExpandedBadgeRawFrameProbe({ ...input, options: { ...input.options, ownershipGate: { status: 'measured', significant: true, criterion: 'test control passed' } } });
		const target = gated.trace.final.targets[0]!;
		expect(target.exactOwnedCoordinates).toContainEqual([4, 0]);
		expect(gated.representations[0]?.transition.newlyExplainedPixels.length).toBeGreaterThan(0);
		const ungated = materializeExpandedBadgeRawFrameProbe(input);
		expect(ungated.trace.final.targets[0]?.exactOwnedCoordinates).toEqual([]);
		expect(ungated.representations[0]?.transition.newlyExplainedPixels).toHaveLength(0);
	});

	test('circular-shift control retains per-sample shifts and rejects invalid geometry', () => {
		const input = rawFixture();
		const probe = materializeExpandedBadgeRawFrameProbe(input);
		const control = materializeM2RawFrameStatsControl(probe.trace, { imageId: 'raw', paramsHash: 'raw', featureId: 'badgeM2Aa', replicates: 3 });
		expect(control.status).toBe('measured');
		expect(control.margins[0]?.replicateShifts).toHaveLength(3);
		expect(control.margins[0]?.replicateShifts[0]?.[0]).toEqual([0, 0]);
		expect(control.margins[0]?.replicateShifts[0]?.slice(1).every(([x, y]) => x !== 0 && y !== 0)).toBe(true);
		expect(control.margins[0]?.bySupportThreshold['18']?.globalMaxExactOverlap.nullSamples).toHaveLength(3);
		const unequal = { ...probe.trace, registrations: probe.trace.registrations.map((value, index) => index === 1 ? { ...value, ownedBbox: [value.ownedBbox[0], value.ownedBbox[1], value.ownedBbox[2] + 1, value.ownedBbox[3]] as const } : value) };
		expect(materializeM2RawFrameStatsControl(unequal, { imageId: 'raw', paramsHash: 'raw', featureId: 'badgeM2Aa', replicates: 3 }).status).toBe('unknown');
	});

	test('one-call control seam attaches auditable control and gates compatibility ownership', () => {
		// rawFixture translates legacy AA pixels by x0 - 3; this value lands at
		// the recurring exterior coordinate local (4,0) for the first badge.
		const input = rawFixture([5 + 2 + 8 * 180]);
		const result = materializeExpandedBadgeRawFrameProbeWithControl({
			...input,
			options: {
				...input.options,
				control: { replicates: 1, supportThresholds: [18], alpha: 1 }
			}
		});
		expect(result.statistics?.status).toBe('measured');
		expect(result.trace.control).toBe(result.statistics);
		expect(result.trace.final.ownership).toMatchObject({ promoted: true });
		expect(result.trace.final.ownership.criterion).toContain('global-max empirical p<=1');
		expect(result.representations[0]?.aa.explainedPixels.length).toBeGreaterThan(0);
		expect(result.representations[0]?.transition.newlyExplainedPixels.length).toBeGreaterThan(0);
	});

	test('source clipping and safety cap are loud UNKNOWN/insufficient outcomes', () => {
		const input = rawFixture();
		const clippedM1 = { ...input.m1, objects: input.m1.objects.map((value, index) => index === 0 ? { ...value, accounting: { ...value.accounting, availablePixels: Uint32Array.from([0]), explainedPixels: Uint32Array.from([0]), unexplainedPixels: new Uint32Array() } } : value) };
		const clipped = { ...input, m1: clippedM1, options: { safetyCapMarginPx: 2 } };
		const result = materializeExpandedBadgeRawFrameProbe(clipped);
		expect(result.state).toBe('insufficient');
		expect(result.trace.final.status).toBe('unknown');
		expect(result.trace.margins[0]?.exactBoundary.left.status).toBe('unknown');
		expect(result.trace.final.reason).toMatch(/18|clipping|registration/i);
	});

	test('a non-18 specimen set is explicitly UNKNOWN', () => {
		const input = rawFixture();
		const result = materializeExpandedBadgeRawFrameProbe({ ...input, specimens: input.specimens.slice(0, 17) });
		expect(result.state).toBe('insufficient');
		expect(result.trace.final.status).toBe('unknown');
		expect(result.trace.final.reason).toContain('exactly 18');
	});
});
