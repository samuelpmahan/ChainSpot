import { describe, expect, test } from 'vitest';
import {
	DEFAULT_EXECUTION,
	parseConfig,
	resolveConfig,
	runThreeFactor,
	type ThreeFactorConfig
} from '@chainspot/alg/detectors/threeFactor';
import { compileExecutionPlan } from '@chainspot/alg/exec';
import defaultConfigJson from '@chainspot/alg/detectors/threeFactor/configs/default.json';
import minAreaPoseOnJson from '@chainspot/alg/detectors/threeFactor/configs/tee-min-area-pose-on.json';
import type { RgbaRaster } from '@chainspot/alg/detect';

/**
 * Small detector-input scene with one intact hollow tee.  This intentionally
 * uses the same detector surface as the production front door: the integration
 * assertions below do not call the pose unit directly or seed its private
 * `stage`/`tees` slots.
 */
function syntheticRaster(): RgbaRaster {
	const widthPx = 160;
	const heightPx = 220;
	const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
	const put = (x: number, y: number, value: number): void => {
		const offset = (y * widthPx + x) * 4;
		rgba[offset] = value;
		rgba[offset + 1] = value;
		rgba[offset + 2] = value;
		rgba[offset + 3] = 255;
	};
	for (let y = 0; y < heightPx; y++)
		for (let x = 0; x < widthPx; x++) put(x, y, 120);

	// A badge-like bright plate keeps the normal detector chronology intact.
	for (let y = 30; y < 62; y++)
		for (let x = 40; x < 86; x++) put(x, y, 250);
	for (let y = 38; y < 54; y++)
		for (let x = 50; x < 58; x++) put(x, y, 20);
	for (let y = 38; y < 54; y++)
		for (let x = 66; x < 74; x++) put(x, y, 20);

	// One intact hollow bright tee ring, matching the frozen detector fixture.
	for (let y = 120; y < 140; y++) {
		for (let x = 40; x < 64; x++) {
			const edge = y < 124 || y >= 136 || x < 44 || x >= 60;
			if (edge) put(x, y, 250);
		}
	}

	// A separate bright component exercises the ordinary basket stage.
	for (let y = 170; y < 200; y++)
		for (let x = 90; x < 112; x++) put(x, y, 250);

	return { imageId: 'tee-min-area-pose-integration', widthPx, heightPx, rgba };
}

describe('teeMinAreaPose production integration', () => {
	test('default config omits the post-freeze operation and preserves the visible-tee schema', () => {
		const resolved = resolveConfig(defaultConfigJson as ThreeFactorConfig, DEFAULT_EXECUTION);
		const plan = compileExecutionPlan(resolved);

		expect(resolved.features.teeMinAreaPose).toBeUndefined();
		expect(plan.ops.map((operation) => operation.id)).not.toContain('teeMinAreaPose');

		const run = runThreeFactor(syntheticRaster(), {
			config: resolved,
			paramsHash: 'tee-min-area-pose-default'
		});
		expect(run.trace?.units.map((unit) => unit.id)).not.toContain('teeMinAreaPose');
		expect(run.measurement.tees[0]?.pad).not.toHaveProperty('minAreaPose');
	});

	test('explicit A/B config inserts the pose operation after visible-tee assembly', () => {
		const resolved = resolveConfig(parseConfig(minAreaPoseOnJson), DEFAULT_EXECUTION);
		const plan = compileExecutionPlan(resolved);
		const ids = plan.ops.map((operation) => operation.id);

		expect(resolved.features.teeMinAreaPose).toEqual({ enabled: true, knobs: {} });
		expect(ids).toContain('teeFamily');
		expect(ids).toContain('teeMinAreaPose');
		expect(ids.indexOf('teeMinAreaPose')).toBeGreaterThan(ids.indexOf('teeFamily'));

		const run = runThreeFactor(syntheticRaster(), {
			config: resolved,
			paramsHash: 'tee-min-area-pose-on'
		});
		const poseUnit = run.trace?.units.find((unit) => unit.id === 'teeMinAreaPose');
		expect(poseUnit).toMatchObject({
			featureId: 'teeMinAreaPose',
			enabled: true
		});
		expect(poseUnit?.drawables.some((drawable) => drawable.visualRole === 'tee-visible-pixels')).toBe(
			true
		);
		expect(run.measurement.tees[0]?.pad?.minAreaPose).toMatchObject({
			// The fitter encloses complete detector cells, so the pose center is
			// the cell-envelope center (51.5, 129.5), not OpenCV contour-point
			// center rounding (52, 130).
			centerXPx: 51.5,
			centerYPx: 129.5,
			angleRad: 0,
			majorPx: 24,
			minorPx: 20
		});
	});
});
