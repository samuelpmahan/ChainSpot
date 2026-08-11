export type TemplateScale = number & { readonly __brand: 'TemplateScale' };
export type NumberTemplateScale = TemplateScale & { readonly __templateFamily: 'hole-number' };
export type BasketTemplateScale = TemplateScale & { readonly __templateFamily: 'basket' };
export type UiScalePx = number & { readonly __brand: 'UiScalePx' };

type AssertFalse<Value extends false> = Value;
type _TemplateScaleMustNotBeUiScalePx = AssertFalse<
	TemplateScale extends UiScalePx ? true : false
>;
type _UiScalePxMustNotBeTemplateScale = AssertFalse<
	UiScalePx extends TemplateScale ? true : false
>;
type _NumberTemplateScaleMustNotBeBasketTemplateScale = AssertFalse<
	NumberTemplateScale extends BasketTemplateScale ? true : false
>;
type _BasketTemplateScaleMustNotBeNumberTemplateScale = AssertFalse<
	BasketTemplateScale extends NumberTemplateScale ? true : false
>;

/** One semantic calibration value, re-exported at the scale boundary. */
export const CANONICAL_BADGE_WIDTH_PX = 30;
export const CANONICAL_BADGE_HEIGHT_PX = 23;

export interface CanonicalNumberBadgeCalibration {
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface CvTemplateCalibration {
	readonly canonicalNumberBadge: CanonicalNumberBadgeCalibration;
	/** Basket-template scale produced per detected hole-number template scale. */
	readonly basketTemplateScalePerNumberTemplateScale: number;
}

export interface CvTemplateManifest {
	readonly schemaVersion: 1;
	readonly calibration: CvTemplateCalibration;
	readonly templates: {
		readonly holeNumbers: readonly string[];
		readonly basket: string;
	};
}

export interface UDiscCalibrationAnchor {
	readonly templateScale: NumberTemplateScale;
	readonly matchedWidthPx: number;
	readonly matchedHeightPx: number;
}

export interface UDiscCalibration {
	readonly uiScalePx: UiScalePx;
	readonly anchor: UDiscCalibrationAnchor;
}

export interface NumberBadgeAnchorObservation {
	readonly scale: NumberTemplateScale;
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

export function asNumberTemplateScale(
	value: number,
	name = 'Hole-number template scale'
): NumberTemplateScale {
	return positiveFinite(value, name) as NumberTemplateScale;
}

export function asBasketTemplateScale(
	value: number,
	name = 'Basket template scale'
): BasketTemplateScale {
	return positiveFinite(value, name) as BasketTemplateScale;
}

/**
 * Which raster a `TemplateScale` was measured against. Two detectors can
 * disagree on this for the exact same numeric value: a scale measured on a
 * downscaled analysis raster (`CvRaster.sourceScale > 1`) is a different
 * real-world multiplier than the same number measured on the full-resolution
 * source raster (`sourceScale === 1`). A TypeScript brand alone cannot carry
 * this distinction across a Web Worker boundary -- `postMessage`'s
 * structured-clone algorithm erases brands, keeping only plain data -- so
 * this tag is deliberately real, serializable data, not just a type.
 */
export type RasterSpace = 'source' | 'analysis';

/** A template-match scale paired with the raster space it was measured in. */
export interface SpacedTemplateScale<Scale extends TemplateScale = TemplateScale> {
	readonly value: Scale;
	readonly space: RasterSpace;
}

/**
 * Resolves a spaced scale into the value that is valid for `targetSpace`.
 *
 * The only supported conversion is analysis -> source, via `sourceScale`
 * (source pixels per analysis pixel -- the reciprocal of the analysis
 * raster's own `CvRaster.sourceScale`). Every other mismatch is refused: a
 * scale already declared for `targetSpace` needs no conversion, and there is
 * no correct way to convert source -> analysis here, so asking for one is a
 * caller bug, not a value this function can produce. The thrown message
 * names both spaces so the failure reads as its cause, not a downstream
 * symptom (a mis-scaled search window, a template match that never fires).
 */
export function resolveTemplateScale<Scale extends TemplateScale>(
	scaled: SpacedTemplateScale<Scale>,
	targetSpace: RasterSpace,
	sourceScale: number
): Scale {
	if (scaled.space === targetSpace) return scaled.value;
	if (scaled.space === 'analysis' && targetSpace === 'source') {
		return (scaled.value * positiveFinite(sourceScale, 'Source scale')) as Scale;
	}
	throw new Error(
		`Scale measured in ${scaled.space} space cannot be used against a ${targetSpace}-space raster.`
	);
}

/**
 * Converts the detected hole-number template scale into the basket-template
 * family using the template pack's measured semantic calibration.
 */
export function deriveBasketTemplateScale(
	numberTemplateScale: NumberTemplateScale,
	calibration: CvTemplateCalibration
): BasketTemplateScale {
	const numberScale = positiveFinite(numberTemplateScale, 'Number template scale');
	const ratio = positiveFinite(
		calibration.basketTemplateScalePerNumberTemplateScale,
		'Basket template scale per number template scale'
	);
	return asBasketTemplateScale(numberScale * ratio, 'Derived basket template scale');
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
	const templateScale = asNumberTemplateScale(anchor.scale, 'Number-badge template scale');
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
	const basketTemplateScalePerNumberTemplateScale = positiveFinite(
		calibration.basketTemplateScalePerNumberTemplateScale,
		'Basket template scale per number template scale'
	);

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
	return {
		schemaVersion: 1,
		calibration: { canonicalNumberBadge, basketTemplateScalePerNumberTemplateScale },
		templates: { holeNumbers, basket }
	};
}
