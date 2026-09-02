import { describe, expect, test } from 'vitest';
import {
	BADGE_M2_AA_FEATURE_ID,
	badgeM2AaFeature,
	badgeM2AaOperation,
	decodeMaterializedBadgeM2Library,
	encodeMaterializedBadgeM2Library
} from '@chainspot/alg/detectors/threeFactor/features/g5.badgeM2Aa';
import {
	compileABFeatureSet,
	createExecBoard,
	createMemorySink,
	executeABFeatureSet,
	type ABFeatureSet
} from '@chainspot/alg/exec';
import { nullFeatureContext, type FeatureContext } from '@chainspot/alg/detectors/threeFactor/features/types';

const width = 20;
const height = 16;

function px(x: number, y: number): number {
	return y * width + x;
}

function specimen(index: number): any {
	const x = 4 + index * 4;
	const y = 6;
	const owned = Uint32Array.from([px(x, y), px(x + 1, y), px(x + 1, y + 1)]);
	return {
		schema: 'chainspot.badge-evidence/v1',
		id: `badge-${index}`,
		provenance: { imageId: 'partial', paramsHash: 'partial', detector: 'test', detectorVersion: '1' },
		badge: { detId: `badge-${index}`, component: {}, cxPx: x + 1, cyPx: y + 1, bbox: [x, y, 2, 2], source: 'bright-family', digits: [], rawLabel: '', digitCount: 0, label: null, bestLabel: null, labelCandidates: [], confidence: 0, abstentionReason: null, confidenceFloor: 0, conflictWith: [], notes: [] },
		raster: { width, height },
		region: { bbox: [x - 1, y - 1, 4, 4], rgba: new Uint8Array(64), brightMask: new Uint8Array(16), darkMask: new Uint8Array(16), brightLabels: new Int32Array(16), darkLabels: new Int32Array(16) },
		components: [],
		ownedBwPixels: owned,
		aaPixels: new Uint32Array(),
		residuePixels: new Uint32Array(),
		measurements: { bwOwnedPixelCount: owned.length, aaAddedPixelCount: 0, residueBefore: 0, residueAfter: 0 }
	};
}

function input() {
	const badges = [specimen(0), specimen(1), specimen(2)];
	return {
		badges,
		m1: {
			provenance: { imageId: 'partial', paramsHash: 'partial' },
			raster: { width, height, topPx: 0 },
			components: [],
			objects: badges.map((badge: any) => ({
				id: badge.id,
				kind: 'badge',
				componentUses: [],
				accounting: { status: 'known', availablePixels: badge.ownedBwPixels, explainedPixels: badge.ownedBwPixels, unexplainedPixels: new Uint32Array() }
			}))
		}
	};
}

function context(enabled: boolean): FeatureContext {
	return {
		...nullFeatureContext,
		resolve: (feature) => feature.id === BADGE_M2_AA_FEATURE_ID ? { enabled, knobs: {} } : nullFeatureContext.resolve(feature)
	};
}

const set: ABFeatureSet = {
	id: 'badge-m2-raw-frame-partial-sample-gateway-test',
	features: [badgeM2AaFeature],
	operations: [{ operation: badgeM2AaOperation }],
	seededSlots: ['image', 'badgeEvidence.library']
};

describe('badgeM2Aa production ABFeature gateway', () => {
	test('OFF stays inert and ON refuses to treat a partial badge set as an all-18 result', async () => {
		const image = { width, height, data: new Uint8Array(width * height * 4).fill(127) };
		const offBoard = createExecBoard();
		offBoard.set('image', image);
		offBoard.set('badgeEvidence.library', input());
		const off = await executeABFeatureSet(
			compileABFeatureSet(set, { [BADGE_M2_AA_FEATURE_ID]: { enabled: false } }),
			offBoard,
			context(false),
			{ runId: 'off', invocation: 'test' }
		);
		expect(off.operations[0]?.actualConsumes).toEqual(['image', 'badgeEvidence.library']);
		expect(offBoard.get('badgeEvidence.m2Library')).toMatchObject({ state: 'disabled' });

		const onBoard = createExecBoard();
		onBoard.set('image', image);
		onBoard.set('badgeEvidence.library', input());
		const sink = createMemorySink();
		const on = await executeABFeatureSet(
			compileABFeatureSet(set, { [BADGE_M2_AA_FEATURE_ID]: { enabled: true } }),
			onBoard,
			context(true),
			{ runId: 'on', invocation: 'test' },
			sink
		);
		expect(on.operations[0]?.actualConsumes).toEqual(['image', 'badgeEvidence.library']);
		const artifact = on.operations[0]?.artifacts.find((value) => value.kind === 'measurementTable');
		const result = decodeMaterializedBadgeM2Library(sink.blobs.get(artifact!.id)!);
		expect(result.state).toBe('insufficient');
		expect(result.rawProbe?.trace.final).toMatchObject({ status: 'unknown' });
		expect(result.rawProbe?.trace.final.reason).toMatch(/exactly 18/i);
	});

	test('a library whose estimated serialized size exceeds V8s max string length gets a loud size-guard artifact instead of a JSON.stringify crash', () => {
		// A real oversized library would need ~180K real observations to trip
		// the guard; a `{length}` stand-in exercises the guard's estimate
		// (which only reads `.observations.length`) without materializing them.
		const hugeMarginObservationCount = 200_000;
		const oversized: any = {
			schema: 'chainspot.badge-m2-raw-frame-library/v2',
			featureId: BADGE_M2_AA_FEATURE_ID,
			state: 'materialized',
			provenance: { imageId: 'huge', paramsHash: 'huge', source: 'full source RGBA expanded-frame recurrence' },
			rawProbe: {
				trace: {
					margins: [{ marginPx: 99, observations: { length: hugeMarginObservationCount } }],
					final: { finalMarginPx: 99, status: 'insufficient', reason: 'fixture: safety cap reached' }
				}
			},
			representations: []
		};
		const bytes = encodeMaterializedBadgeM2Library(oversized);
		const decoded = JSON.parse(new TextDecoder().decode(bytes));
		expect(decoded.sizeGuard).toMatchObject({
			status: 'UNKNOWN',
			observationCount: hugeMarginObservationCount,
			bytesPerObservation: 3000,
			marginCount: 1,
			finalMarginPx: 99,
			finalStatus: 'insufficient',
			finalReason: 'fixture: safety cap reached'
		});
		expect(decoded.sizeGuard.estimatedBytes).toBe(hugeMarginObservationCount * decoded.sizeGuard.bytesPerObservation);
		expect(decoded.sizeGuard.estimatedBytes).toBeGreaterThan(decoded.sizeGuard.limitBytes);
		expect(decoded.rawProbe).toBeUndefined();
		expect(decoded.representations).toEqual([]);
		// A small library never trips the guard and encodes/decodes normally.
		const tiny: any = {
			...oversized,
			rawProbe: {
				trace: {
					margins: [{ marginPx: 2, observations: { length: 10 } }],
					final: { finalMarginPx: 2, status: 'adequate', reason: 'fixture: stabilized' }
				}
			}
		};
		const tinyDecoded = decodeMaterializedBadgeM2Library(encodeMaterializedBadgeM2Library(tiny));
		expect((tinyDecoded as any).sizeGuard).toBeUndefined();
	});
});
