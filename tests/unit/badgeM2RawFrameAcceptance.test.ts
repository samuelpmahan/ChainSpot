import { describe, expect, test } from 'vitest';
import {
	BADGE_M2_AA_FEATURE_ID,
	badgeM2AaFeature,
	badgeM2AaOperation,
	decodeMaterializedBadgeM2Library
} from '@chainspot/alg/detectors/threeFactor/features/g5.badgeM2Aa';
import {
	compileABFeatureSet,
	createExecBoard,
	createMemorySink,
	executeABFeatureSet,
	type ABFeatureSet
} from '@chainspot/alg/exec';
import { nullFeatureContext, type FeatureContext } from '@chainspot/alg/detectors/threeFactor/features/types';

/**
 * Acceptance seam for the approved M2 experiment.  It is intentionally
 * integration-shaped: the raw RGBA image, M1 glyph evidence, and old M1/AA/
 * residue labels all reach the production ABFeature gateway.
 */
const width = 96;
const height = 60;

function pixel(x: number, y: number): number {
	return y * width + x;
}

function makeImage(): { width: number; height: number; data: Uint8Array } {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = pixel(x, y) * 4;
			// Every background cell is deliberately distinct: repeating source
			// evidence below is therefore caused by the stamped badge-local image,
			// not by a uniform padded background.
			data[offset] = (x * 19 + y * 7) % 251;
			data[offset + 1] = (x * 3 + y * 29) % 251;
			data[offset + 2] = (x * 11 + y * 5) % 251;
			data[offset + 3] = 255;
		}
	}
	for (let index = 0; index < 18; index++) {
		const x0 = 8 + (index % 6) * 14;
		const y0 = 8 + Math.floor(index / 6) * 14;
		// The old M1 crop ended at local ±1.  Shared raw structure ends there;
		// the new symmetric margin=2 boundary must therefore clear.
		for (let ly = -1; ly <= 4; ly++) {
			for (let lx = -1; lx <= 4; lx++) {
				const offset = pixel(x0 + lx, y0 + ly) * 4;
				data[offset] = 120 + lx * 5 + ly;
				data[offset + 1] = 80 + lx + ly * 5;
				data[offset + 2] = 30 + lx * 3 + ly * 2;
				data[offset + 3] = 255;
			}
		}
	}
	return { width, height, data };
}

function badge(index: number, aa = true, residue = true): any {
	const x = 8 + (index % 6) * 14;
	const y = 8 + Math.floor(index / 6) * 14;
	const owned = Uint32Array.from([
		pixel(x, y),
		pixel(x + 1, y), // plate/M1 control: must remain observable
		pixel(x + 2, y + 2) // exact digit glyph; its one-pixel support is masked
	]);
	return {
		schema: 'chainspot.badge-evidence/v1',
		id: `badge-${index}`,
		provenance: { imageId: 'raw-frame-test', paramsHash: 'raw-frame-test', detector: 'test', detectorVersion: '1' },
		badge: {
			detId: `badge-${index}`,
			component: {},
			cxPx: x + 2,
			cyPx: y + 2,
			bbox: [x, y, 4, 4],
			source: 'bright-family',
			digits: [{ bbox: [x + 2, y + 2, 1, 1], predicted: '1' }],
			rawLabel: '1',
			digitCount: 1,
			label: '1',
			bestLabel: '1',
			labelCandidates: [],
			confidence: 1,
			abstentionReason: null,
			confidenceFloor: 0,
			conflictWith: [],
			notes: []
		},
		raster: { width, height },
		region: { bbox: [x - 1, y - 1, 6, 6], rgba: new Uint8Array(6 * 6 * 4), brightMask: new Uint8Array(36), darkMask: new Uint8Array(36), brightLabels: new Int32Array(36), darkLabels: new Int32Array(36) },
		components: [],
		ownedBwPixels: owned,
		aaPixels: Uint32Array.from(aa ? [pixel(x - 1, y)] : []),
		residuePixels: Uint32Array.from(residue ? [pixel(x, y - 1)] : []),
		measurements: { bwOwnedPixelCount: owned.length, aaAddedPixelCount: aa ? 1 : 0, residueBefore: residue ? 1 : 0, residueAfter: residue ? 1 : 0 }
	};
}

function library(aa = true, residue = true): any {
	const badges = Array.from({ length: 18 }, (_, index) => badge(index, aa, residue));
	return {
		badges,
		m1: {
			provenance: { imageId: 'raw-frame-test', paramsHash: 'raw-frame-test' },
			raster: { width, height, topPx: 0 },
			objects: badges.map((specimen: any) => ({
				id: specimen.id,
				kind: 'badge',
				componentUses: [{ componentId: `glyph.${specimen.id}`, role: 'glyph' }],
				accounting: {
					status: 'known',
					availablePixels: specimen.ownedBwPixels,
					explainedPixels: specimen.ownedBwPixels,
					unexplainedPixels: new Uint32Array()
				}
			})),
			components: badges.map((specimen: any) => {
				const glyph = specimen.ownedBwPixels[2];
				return { id: `glyph.${specimen.id}`, polarity: 'bright', label: 1, bbox: [0, 0, 1, 1], area: 1, pixels: Uint32Array.from([glyph]), producedBy: 'test', consumers: [] };
			})
		}
	};
}

function context(enabled: boolean): FeatureContext {
	return {
		...nullFeatureContext,
		resolve(feature) {
			return feature.id === BADGE_M2_AA_FEATURE_ID
				? { enabled, knobs: {} }
				: nullFeatureContext.resolve(feature);
		}
	};
}

const set: ABFeatureSet = {
	id: 'badge-m2-raw-frame-production-gateway-test',
	features: [badgeM2AaFeature],
	operations: [{ operation: badgeM2AaOperation }],
	seededSlots: ['image', 'badgeEvidence.library']
};

async function execute(enabled: boolean, evidence = library()): Promise<any> {
	const board = createExecBoard();
	board.set('image', makeImage());
	board.set('badgeEvidence.library', evidence);
	const sink = createMemorySink();
	const compiled = compileABFeatureSet(set, { [BADGE_M2_AA_FEATURE_ID]: { enabled } });
	const manifest = await executeABFeatureSet(
		compiled,
		board,
		context(enabled),
		{ runId: enabled ? 'on' : 'off', invocation: 'test' },
		sink
	);
	return {
		board,
		sink,
		manifest
	};
}

describe('badgeM2Aa raw expanded-frame receipt', () => {
	test('runs through the production ABFeature, scans raw pixels beyond the old boundary, and preserves OFF', async () => {
		const input = library();
		const before = JSON.stringify(input, (_key, value) => value instanceof Uint32Array ? [...value] : value);
		const off = await execute(false, input);
		expect(JSON.stringify(input, (_key, value) => value instanceof Uint32Array ? [...value] : value)).toBe(before);
		expect(off.board.get('badgeEvidence.m2Library')).toMatchObject({ state: 'disabled' });

		const on = await execute(true);
		const receipt = on.manifest.operations[0];
		expect(receipt?.actualConsumes).toEqual(['image', 'badgeEvidence.library']);
		const artifact = receipt?.artifacts.find((value: any) => value.kind === 'measurementTable');
		expect(artifact).toBeDefined();
		const materialized = decodeMaterializedBadgeM2Library(on.sink.blobs.get(artifact.id)! as Uint8Array) as any;
		expect(materialized).toMatchObject({ state: 'materialized', featureId: BADGE_M2_AA_FEATURE_ID });
		const trace = materialized.rawProbe.trace;
		expect(trace.registrations).toHaveLength(18);
		expect(trace.registrations[0]).toMatchObject({
			sourceFrame: 'full-rgba-image',
			glyphExactCount: 1,
			glyphHaloCount: 8
		});
		expect(trace.algorithm.exact).toMatchObject({ authoritative: true, equality: 'exact-rgba-tuple' });
		expect(trace.algorithm.quantized).toMatchObject({ authoritative: false, equality: 'floor-channel-bin' });
		expect(trace.margins[0]).toMatchObject({ marginPx: 2 });
		expect(trace.final.status).toBe('adequate');

		const final = trace.final.targets.find((value: any) => value.targetId === 'badge-0');
		expect(final.partition.counts).toMatchObject({
			'm1-owned': expect.any(Number),
			'old-aa': expect.any(Number),
			'old-residue': expect.any(Number),
			exterior: expect.any(Number)
		});
		// Exact glyph support is absent, while nearby plate/M1 structure remains
		// a raw-image recurrence. A digit bbox mask would wrongly erase this.
		expect(final.partition.counts['m1-owned']).toBeGreaterThan(0);
		expect(trace.registrations[0].glyphExactCount + trace.registrations[0].glyphHaloCount).toBe(9);
	});

	test('uses AA/residue only after discovery as labels, never as the raw support search universe', async () => {
		const withLabelsRun = await execute(true, library(true, true));
		const withoutLabelsRun = await execute(true, library(false, false));
		const withLabels = decodeMaterializedBadgeM2Library(
			withLabelsRun.sink.blobs.values().next().value as Uint8Array
		) as any;
		const withoutLabels = decodeMaterializedBadgeM2Library(
			withoutLabelsRun.sink.blobs.values().next().value as Uint8Array
		) as any;
		const left = withLabels.rawProbe.trace.final.targets.find((value: any) => value.targetId === 'badge-0');
		const right = withoutLabels.rawProbe.trace.final.targets.find((value: any) => value.targetId === 'badge-0');
		expect(left.finalExactSupportedCoordinates).toEqual(right.finalExactSupportedCoordinates);
		expect(left.partition.counts['old-aa']).toBeGreaterThan(right.partition.counts['old-aa']);
		expect(left.partition.counts['old-residue']).toBeGreaterThan(right.partition.counts['old-residue']);
	});
});
