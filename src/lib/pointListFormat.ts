/**
 * ChainSpot point-pair list presentation helpers (P0-009).
 *
 * Display formatting only: these functions never mutate authoritative state. Native
 * pixel coordinates remain authoritative; normalized coordinates are derived at render
 * time from the referenced image's intrinsic dimensions (never stored, never rounded
 * back into state). Formatting is deterministic and consistent so equal values always
 * render identically without changing the stored values.
 */

import { toNormalizedCoordinates } from './coords';
import type { ImageAsset, ImagePoint } from './domain/project';

export interface SideDisplay {
	readonly xPx: string;
	readonly yPx: string;
	readonly xNorm: string;
	readonly yNorm: string;
}

const MISSING: SideDisplay = { xPx: '–', yPx: '–', xNorm: '–', yNorm: '–' };

/**
 * Formats a number for display at up to `maxDecimals`, trimming trailing zeros so
 * integer values render without a decimal point and fractional values stay consistent.
 */
export function formatDisplayNumber(value: number, maxDecimals: number): string {
	if (!Number.isFinite(value)) return '–';
	const trimmed = value.toFixed(maxDecimals).replace(/\.?0+$/, '');
	return trimmed === '-0' ? '0' : trimmed;
}

/** Native pixel coordinate display (up to two fractional digits). */
export function formatPixel(value: number): string {
	return formatDisplayNumber(value, 2);
}

/** Derived normalized coordinate display (up to four fractional digits). */
export function formatNormalized(value: number): string {
	return formatDisplayNumber(value, 4);
}

/**
 * Derives the display values for one side of a pair. Normalized values are computed
 * from the authoritative pixel coordinates and the referenced image's intrinsic
 * dimensions at render time; a missing image renders a placeholder.
 */
export function sideDisplay(point: ImagePoint, image: ImageAsset | undefined): SideDisplay {
	if (!image) return MISSING;
	const normalized = toNormalizedCoordinates(
		{ xPx: point.xPx, yPx: point.yPx },
		image.widthPx,
		image.heightPx
	);
	return {
		xPx: formatPixel(point.xPx),
		yPx: formatPixel(point.yPx),
		xNorm: formatNormalized(normalized.xNorm),
		yNorm: formatNormalized(normalized.yNorm)
	};
}
