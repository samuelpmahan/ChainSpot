export type TemplateScale = number & { readonly __brand: 'TemplateScale' };
export type UiScalePx = number & { readonly __brand: 'UiScalePx' };

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

function positiveFinite(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a positive finite number.`);
	}
	return value;
}

export function asTemplateScale(value: number, name = 'Template scale'): TemplateScale {
	return positiveFinite(value, name) as TemplateScale;
}

export function asUiScalePx(value: number, name = 'UDisc UI scale'): UiScalePx {
	return positiveFinite(value, name) as UiScalePx;
}

/**
 * The one conversion boundary between raster-template scale and semantic UDisc
 * UI scale. Native template crop dimensions are deliberately absent from the
 * formula: only the matched physical badge dimensions and independent semantic
 * calibration are allowed to define UiScalePx.
 */
export function deriveUDiscCalibration(
	anchor: NumberBadgeAnchorObservation,
	canonicalNumberBadge: CanonicalNumberBadgeCalibration = DEFAULT_CANONICAL_NUMBER_BADGE
): UDiscCalibration {
	const canonicalWidthPx = positiveFinite(
		canonicalNumberBadge.widthPx,
		'Canonical number-badge width'
	);
	const canonicalHeightPx = positiveFinite(
		canonicalNumberBadge.heightPx,
		'Canonical number-badge height'
	);
	const matchedWidthPx = positiveFinite(anchor.widthPx, 'Matched number-badge width');
	const matchedHeightPx = positiveFinite(anchor.heightPx, 'Matched number-badge height');
	const templateScale = asTemplateScale(anchor.scale, 'Number-badge template scale');
	const uiScalePx = asUiScalePx(
		(matchedWidthPx / canonicalWidthPx + matchedHeightPx / canonicalHeightPx) / 2,
		'Derived UDisc UI scale'
	);
	return {
		uiScalePx,
		anchor: { templateScale, matchedWidthPx, matchedHeightPx }
	};
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${name} must be an object.`);
	}
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
	if (root.schemaVersion !== 1) {
		throw new Error('CV template manifest schemaVersion must be 1.');
	}
	const calibration = record(root.calibration, 'CV template manifest calibration');
	const canonical = record(
		calibration.canonicalNumberBadge,
		'CV template manifest canonicalNumberBadge'
	);
	const canonicalNumberBadge = {
		widthPx: positiveFinite(canonical.widthPx, 'Canonical number-badge width'),
		heightPx: positiveFinite(canonical.heightPx, 'Canonical number-badge height')
	};

	const templates = record(root.templates, 'CV template manifest templates');
	if (!Array.isArray(templates.holeNumbers) || templates.holeNumbers.length !== 18) {
		throw new Error('CV template manifest must list exactly 18 hole-number templates.');
	}
	const holeNumbers = templates.holeNumbers.map((asset, index) =>
		templateAsset(asset, `Hole-number template ${index + 1}`)
	);
	if (new Set(holeNumbers).size !== holeNumbers.length) {
		throw new Error('CV template manifest hole-number template filenames must be unique.');
	}
	const basket = templateAsset(templates.basket, 'Basket template');

	return {
		schemaVersion: 1,
		calibration: { canonicalNumberBadge },
		templates: { holeNumbers, basket }
	};
}
