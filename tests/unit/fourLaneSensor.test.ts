import { describe, expect, test } from 'vitest';
import {
	DEFAULT_FOUR_LANE_SENSOR_KNOBS,
	fourLaneSensorFeature,
	observeFourLaneCrossSection,
	sampleFourLaneBand,
	type FourLaneOccluder,
	type FourLaneState
} from '$lib/detectors/threeFactor/features/st.fourLaneSensor';
import type { RgbaImage } from '$lib/detectors/threeFactor/types';

function stripeRaster(insideGray = 95, groundGray = 50): RgbaImage {
	const width = 48;
	const height = 48;
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const gray = y >= 18 && y <= 30 ? insideGray : groundGray;
			const p = (y * width + x) * 4;
			data[p] = gray;
			data[p + 1] = gray;
			data[p + 2] = gray;
			data[p + 3] = 255;
		}
	}
	return { width, height, data };
}

const state: FourLaneState = {
	xPx: 24,
	yPx: 24,
	headingRad: 0,
	corridorWidthPx: 12
};

describe('ST four-lane cross-section sensor', () => {
	test('is a default-off deviation with the LAB knob defaults', () => {
		expect(fourLaneSensorFeature.kind).toBe('deviation');
		expect(fourLaneSensorFeature.defaultEnabled).toBe(false);
		expect(Object.fromEntries(Object.entries(fourLaneSensorFeature.knobs).map(([k, v]) => [k, v.default]))).toEqual(
			DEFAULT_FOUR_LANE_SENSOR_KNOBS
		);
	});

	test('uses the exact four-lane geometry and paired=min(left,right)', () => {
		const observation = observeFourLaneCrossSection(stripeRaster(), state);
		expect(observation.laneWidthPx).toBe(4);
		expect(observation.laneOffsetsPx).toEqual([-6, -2, 2, 6]);
		expect(observation.railMode).toBe('paired');
		expect(observation.leftRail).toBe(1);
		expect(observation.rightRail).toBe(1);
		expect(observation.railScore).toBe(1);
		expect(observation.innerScore).toBe(1);
		expect(observation.score).toBe(1);
	});

	test('keeps one visible rail as one-sided evidence when the other is known-occluded', () => {
		const occluder: FourLaneOccluder = {
			bboxX: 20,
			bboxY: 27,
			bboxW: 8,
			bboxH: 7,
			kind: 'badge'
		};
		const observation = observeFourLaneCrossSection(stripeRaster(), state, [occluder]);
		expect(observation.railMode).toBe('one-sided');
		expect(observation.leftRailOccluded).toBe(false);
		expect(observation.rightRailOccluded).toBe(true);
		expect(observation.railScore).toBe(1);
		expect(observation.score).toBe(1);
	});

	test('returns UNKNOWN rather than zero when the whole cross-section is hidden', () => {
		const occluder: FourLaneOccluder = {
			bboxX: 20,
			bboxY: 14,
			bboxW: 8,
			bboxH: 22,
			kind: 'badge'
		};
		const observation = observeFourLaneCrossSection(stripeRaster(), state, [occluder]);
		expect(observation.railMode).toBe('occluded');
		expect(observation.railScore).toBeNull();
		expect(observation.innerScore).toBeNull();
		expect(observation.score).toBeNull();
	});

	test('marks a band unknown when a majority of its five expected samples are blocked', () => {
		const occluder: FourLaneOccluder = {
			bboxX: 19,
			bboxY: 23,
			bboxW: 5,
			bboxH: 2
		};
		const sample = sampleFourLaneBand(
			stripeRaster(),
			{ xPx: 24, yPx: 24 },
			0,
			0,
			[occluder],
			DEFAULT_FOUR_LANE_SENSOR_KNOBS
		);
		expect(sample.occluded).toBe(true);
		// The two visible samples still retain their measured value; occlusion,
		// not a fabricated zero, decides whether callers may use it.
		expect(sample.mean).toBe(95);
	});

	test('transcribes normalized lift exactly: (inside - outside) / liftReference', () => {
		const observation = observeFourLaneCrossSection(stripeRaster(72, 50), state);
		const expected = 22 / 45;
		expect(observation.leftRail).toBeCloseTo(expected, 12);
		expect(observation.rightRail).toBeCloseTo(expected, 12);
		expect(observation.innerLeft).toBeCloseTo(expected, 12);
		expect(observation.innerRight).toBeCloseTo(expected, 12);
		expect(observation.score).toBeCloseTo(expected, 12);
	});
});
