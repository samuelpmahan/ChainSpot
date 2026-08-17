import { describe, expect, it } from 'vitest';
import {
	deriveLocalSnapSearchGeometry,
	localFeatureSnapDetailed,
	LOCAL_SNAP_MAX_ABSOLUTE_RADIUS_PX,
	LOCAL_TEE_SNAP_SCALE_FACTORS,
	TEE_PAD_MAX_FOOTPRINT_UI_SCALE_MULTIPLE
} from '../../src/lib/cv/localSnap';
import { asUiScalePx } from '../../src/lib/autoAnnotation/cvCalibration';
import type { LocalSnapCalibration, LocalSnapCv, LocalSnapRaster } from '../../src/lib/cv/localSnap';

const calibration: LocalSnapCalibration = { uiScalePx: asUiScalePx(1) };

describe('deriveLocalSnapSearchGeometry', () => {
	it('widens the tee search crop across the world-scale bank while keeping movement hard-capped', () => {
		const geometry = deriveLocalSnapSearchGeometry('tee', { xPx: 100, yPx: 100 }, calibration)!;
		const maxFactor = Math.max(...LOCAL_TEE_SNAP_SCALE_FACTORS);
		expect(geometry.featureFootprintPx).toBe(TEE_PAD_MAX_FOOTPRINT_UI_SCALE_MULTIPLE * maxFactor);
		expect(geometry.snapRadiusPx).toBe(LOCAL_SNAP_MAX_ABSOLUTE_RADIUS_PX);
		expect(geometry.calibrationSource).toContain('tee-multiscale');
	});

	it('records whether an already-known full-course recommendation lies inside the local acceptance radius', () => {
		const geometry = deriveLocalSnapSearchGeometry(
			'tee',
			{ xPx: 100, yPx: 100 },
			{
				uiScalePx: asUiScalePx(1),
				knownRecommendation: {
					point: { xPx: 112, yPx: 100 },
					featureFootprintPx: 60
				}
			}
		)!;
		expect(geometry.knownRecommendationDistancePx).toBe(12);
		expect(geometry.knownRecommendationInRadius).toBe(true);
		expect(geometry.calibrationSource).toContain('full-course-footprint');
	});
});

describe('localFeatureSnapDetailed rejection taxonomy', () => {
	it('reports invalid click before invoking CV', () => {
		const raster: LocalSnapRaster = { widthPx: 10, heightPx: 10, sourceScale: 1, rgba: new Uint8Array(400) };
		const outcome = localFeatureSnapDetailed(
			'tee',
			{} as LocalSnapCv,
			raster,
			{ xPx: Number.NaN, yPx: 2 },
			calibration
		);
		expect(outcome.point).toBeNull();
		expect(outcome.trace).toMatchObject({ accepted: false, rejectReason: 'invalid-click' });
	});

	it('reports the missing raster channel instead of collapsing it to null-without-cause', () => {
		const raster: LocalSnapRaster = { widthPx: 400, heightPx: 400, sourceScale: 1 };
		const outcome = localFeatureSnapDetailed(
			'tee',
			{} as LocalSnapCv,
			raster,
			{ xPx: 200, yPx: 200 },
			calibration
		);
		expect(outcome.point).toBeNull();
		expect(outcome.trace).toMatchObject({
			attempted: true,
			accepted: false,
			rejectReason: 'missing-raster-channel'
		});
	});
});
