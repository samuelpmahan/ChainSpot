import { describe, expect, test } from 'vitest';
import {
	TEE_MIN_AREA_POSE_REQUIRED_VALUES,
	buildTeeMinAreaPoseReceipt,
	teeMinAreaPoseRender
} from '@chainspot/alg/detectors/threeFactor/features/g3.teeMinAreaPoseReceipt';
import type { RunTrace, UnitTrace } from '@chainspot/alg/detectors/threeFactor/features/types';

function unit(): UnitTrace {
	return {
		id: 'teeMinAreaPose',
		featureId: 'teeMinAreaPose',
		featureIds: ['teeMinAreaPose'],
		gate: 'G3',
		enabled: true,
		knobs: {},
		knobsDeviating: [],
		ms: 1,
		measurements: [],
		drawables: [
			{
				type: 'pixelSet',
				pixels: [
					[8, 8],
					[9, 8]
				],
				verdict: 'accepted',
				visualRole: 'tee-visible-pixels',
				ref: 'tee-H5',
				metadata: {
					role: 'target',
					targetRef: 'tee-H5',
					targetComponent: 'component-7'
				},
				values: {
					pixelCount: 16,
					hullVertexCount: 4,
					candidateCount: 1,
					score: 1,
					occupancy: 1,
					rectangleAreaPx2: 16,
					centerXPx: 10,
					centerYPx: 10,
					angleDeg: 0,
					majorPx: 4,
					minorPx: 4,
					producerCornerC0X: 8,
					producerCornerC0Y: 8,
					producerCornerC1X: 12,
					producerCornerC1Y: 8,
					producerCornerC2X: 12,
					producerCornerC2Y: 12,
					producerCornerC3X: 8,
					producerCornerC3Y: 12
				}
			},
			{
				type: 'point',
				xPx: 8,
				yPx: 8,
				verdict: 'info',
				visualRole: 'tee-corner-tick',
				ref: 'tee-H5:tee-corner-tick-0',
				metadata: { role: 'fitted-corner' }
			},
			{
				type: 'polyline',
				path: [
					[8, 8],
					[12, 12]
				],
				verdict: 'info',
				visualRole: 'tee-diagonal',
				ref: 'tee-H5:tee-diagonal-0',
				metadata: { role: 'diagonal' }
			}
		]
	};
}

function run(): RunTrace {
	return {
		configName: 'tee-min-area-pose-on',
		paramsHash: 'params-hash',
		runId: 'run-17',
		imageId: 'TowneLake-full',
		traceHash: 'trace-hash',
		canonicalFrame: 'G0 canonical detector-input pixels',
		execution: ['teeMinAreaPose'],
		features: { teeMinAreaPose: { enabled: true, knobs: {} } },
		units: [],
		heatmaps: {}
	};
}

describe('teeMinAreaPose actual FeatureRender receipt', () => {
	test('forwards the producer target receipt with explicit UNKNOWN for only absent values', () => {
		const receipt = buildTeeMinAreaPoseReceipt(unit(), run());
		const target = receipt.rows[0]!;
		expect(target.values.pixelCount).toBe(16);
		expect(target.values.score).toBe(1);
		expect(target.values.angleDeg).toBe(0);
		for (const key of TEE_MIN_AREA_POSE_REQUIRED_VALUES)
			expect(target.values[key]).toBeDefined();
		expect(receipt.cliText).toContain('runId=run-17');
		expect(receipt.cliText).toContain('coordinateFrame=G0 canonical detector-input pixels');
	});

	test('uses actual Drawable objects once each in the visual plan and preserves trace/CLI/Visual correspondence', () => {
		const source = unit();
		const receipt = buildTeeMinAreaPoseReceipt(source, run());
		expect(receipt.plan.layers.map((layer) => layer.drawables.length)).toEqual([1, 1, 1, 0]);
		expect(receipt.plan.layers[0]!.drawables[0]).toBe(source.drawables[0]);
		expect(receipt.plan.layers[1]!.drawables[0]).toBe(source.drawables[1]);
		expect(receipt.plan.layers[2]!.drawables[0]).toBe(source.drawables[2]);
		expect(receipt.correspondence).toMatchObject({ matched: true });
		expect(teeMinAreaPoseRender.draw(source, run())).toEqual(receipt.plan);
		expect(receipt.plan.notes.join('\n')).toContain('no yellow/orange decoration');
	});
});
