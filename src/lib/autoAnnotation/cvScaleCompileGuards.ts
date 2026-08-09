import type { CourseDetectionResult, UiScaleInput } from './basketDetection';
import type { CalibratedTeePadDetectionOptions } from './cvCalibratedDetectors';
import type { TemplateScale, UiScalePx } from './cvCalibration';

type AssertFalse<Value extends false> = Value;
type IsAssignable<From, To> = From extends To ? true : false;

/**
 * These aliases intentionally have no runtime behavior. Their only job is to
 * make `npm run check` fail if a future refactor makes the historically-confused
 * scale concepts structurally interchangeable again.
 */
type _TemplateScaleCannotEnterPublicUiScaleInput = AssertFalse<
	IsAssignable<TemplateScale, UiScaleInput>
>;
type _TemplateScaleCannotEnterCalibratedTeeOptions = AssertFalse<
	IsAssignable<TemplateScale, CalibratedTeePadDetectionOptions['uiScalePx']>
>;
type _PublicNumberAnchorScaleCannotBeUiScale = AssertFalse<
	IsAssignable<
		NonNullable<CourseDetectionResult['numberDetection']['anchor']>['scale'],
		UiScalePx
	>
>;

export {};
