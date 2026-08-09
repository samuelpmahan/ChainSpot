export type TemplateScale = number & { readonly __brand: 'TemplateScale' };
export type UiScalePx = number & { readonly __brand: 'UiScalePx' };

type AssertFalse<Value extends false> = Value;
type _TemplateScaleMustNotBeUiScalePx = AssertFalse<
	TemplateScale extends UiScalePx ? true : false
>;
type _UiScalePxMustNotBeTemplateScale = AssertFalse<
	UiScalePx extends TemplateScale ? true : false
>;

/** One semantic calibration value, re-exported at the scale boundary. */
export const CANONICAL_BADGE_WIDTH_PX = 30;
export const CANONICAL_BADGE_HEIGHT_PX = 23;

export interface CanonicalNumberBadgeCalibration {
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface CvTemplateManifest {
	readonly schemaVersion: 1;
	readonly calibration: {
		readonly canonicalNumberBadge: CanonicalNumberBadgeCalibration;
	};
	readonly templates: {
		readonly holeNumbers: readonly string[];
		readonly basket: string;
	};
}

export interface UDiscCalibrationAnchor {
	readonly templateScale: TemplateScale;
	readonly matchedWidthPx: number;
	readonly matchedHeightPx: number;
}

export interface UDiscCalibration {
	readonly uiScalePx: UiScalePx;
	readonly anchor: UDiscCalibrationAnchor;
}

export interface NumberBadgeAnchorObservation {
	readonly scale: TemplateScale;
	readonly widthPx: number;
	readonly heightPx: number;
}

const DEFAULT_CANONICAL_NUMBER_BADGE: CanonicalNumberBadgeCalibration = {
	widthPx: CANONICAL_BADGE_WIDTH_PX,
	heightPx: CANONICAL_BADGE_HEIGHT_PX
};
const EXPECTED_HOLE_NUMBER_ASSETS = Array.from(
	{ length: 18 },
	(_, index) => `hole-${String(index + 1).padStart(2, '0')}.png`
);

function positiveFinite(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a positive finite number.`);
	}
	return value;
}

function assertCanonicalCalibration(calibration: CanonicalNumberBadgeCalibration): void {
	if (
		calibration.widthPx !== CANONICAL_BADGE_WIDTH_PX ||
		calibration.heightPx !== CANONICAL_BADGE_HEIGHT_PX
	) {
		throw new Error(
			`CV template manifest calibration ${calibration.widthPx}×${calibration.heightPx} does not match the compiled canonical badge geometry ${CANONICAL_BADGE_WIDTH_PX}×${CANONICAL_BADGE_HEIGHT_PX}.`
		);
	}
}

export function asTemplateScale(value: number, name = 'Template scale'): TemplateScale {
	return positiveFinite(value, name) as TemplateScale;
}

export function asUiScalePx(value: number, name = 'UDisc UI scale'): UiScalePx {
	return positiveFinite(value, name) as UiScalePx;
}

/** The sole canonical 30×23 badge-to-UI-scale conversion. */
export function deriveCanonicalUiScalePx(
	matchedWidthPx: number,
	matchedHeightPx: number,
	canonicalNumberBadge: CanonicalNumberBadgeCalibration = DEFAULT_CANONICAL_NUMBER_BADGE
): number {
	const canonical = {
		widthPx: positiveFinite(canonicalNumberBadge.widthPx, 'Canonical number-badge width'),
		heightPx: positiveFinite(canonicalNumberBadge.heightPx, 'Canonical number-badge height')
	};
	assertCanonicalCalibration(canonical);
	const widthPx = positiveFinite(matchedWidthPx, 'Matched number-badge width');
	const heightPx = positiveFinite(matchedHeightPx, 'Matched number-badge height');
	return (widthPx / canonical.widthPx + heightPx / canonical.heightPx) / 2;
}

/**
 * The semantic boundary between raster-template scale and canonical UDisc UI
 * scale. Native template crop dimensions are deliberately absent. The numeric
 * 30×23 conversion itself lives in the already-proven tee calibration helper,
 * so the formula and its canonical geometry have exactly one implementation.
 */
export function deriveUDiscCalibration(
	anchor: NumberBadgeAnchorObservation,
	canonicalNumberBadge: CanonicalNumberBadgeCalibration = DEFAULT_CANONICAL_NUMBER_BADGE
): UDiscCalibration {
	const canonical = {
		widthPx: positiveFinite(canonicalNumberBadge.widthPx, 'Canonical number-badge width'),
		heightPx: positiveFinite(canonicalNumberBadge.heightPx, 'Canonical number-badge height')
	};
	assertCanonicalCalibration(canonical);
	const matchedWidthPx = positiveFinite(anchor.widthPx, 'Matched number-badge width');
	const matchedHeightPx = positiveFinite(anchor.heightPx, 'Matched number-badge height');
	const templateScale = asTemplateScale(anchor.scale, 'Number-badge template scale');
	const derived = deriveCanonicalUiScalePx(matchedWidthPx, matchedHeightPx, canonical);
	const uiScalePx = asUiScalePx(derived, 'Derived UDisc UI scale');
	return { uiScalePx, anchor: { templateScale, matchedWidthPx, matchedHeightPx } };
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
	return value as Record<string, unknown>;
}

function templateAsset(value: unknown, name: string): string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+\.png$/.test(value)) {
		throw new Error(`${name} must be a local PNG filename.`);
	}
	return value;
}

/** Validate semantic calibration metadata without inspecting native PNG sizes. */
export function validateCvTemplateManifest(value: unknown): CvTemplateManifest {
	const root = record(value, 'CV template manifest');
	if (root.schemaVersion !== 1) throw new Error('CV template manifest schemaVersion must be 1.');
	const calibration = record(root.calibration, 'CV template manifest calibration');
	const canonical = record(calibration.canonicalNumberBadge, 'CV template manifest canonicalNumberBadge');
	const canonicalNumberBadge = {
		widthPx: positiveFinite(canonical.widthPx, 'Canonical number-badge width'),
		heightPx: positiveFinite(canonical.heightPx, 'Canonical number-badge height')
	};
	assertCanonicalCalibration(canonicalNumberBadge);

	const templates = record(root.templates, 'CV template manifest templates');
	if (!Array.isArray(templates.holeNumbers) || templates.holeNumbers.length !== 18) {
		throw new Error('CV template manifest must list exactly 18 hole-number templates.');
	}
	const holeNumbers = templates.holeNumbers.map((asset, index) => templateAsset(asset, `Hole-number template ${index + 1}`));
	for (let index = 0; index < EXPECTED_HOLE_NUMBER_ASSETS.length; index += 1) {
		if (holeNumbers[index] !== EXPECTED_HOLE_NUMBER_ASSETS[index]) {
			throw new Error(
				`CV template manifest hole-number asset ${index + 1} must be ${EXPECTED_HOLE_NUMBER_ASSETS[index]}; received ${holeNumbers[index]}.`
			);
		}
	}
	const basket = templateAsset(templates.basket, 'Basket template');
	return { schemaVersion: 1, calibration: { canonicalNumberBadge }, templates: { holeNumbers, basket } };
}
