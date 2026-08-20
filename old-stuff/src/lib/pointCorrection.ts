import { pointInBounds } from './coords';
import type { ProjectEditor, PointSide } from './domain/editor';
import type { PointCoordinates } from './domain/project';
import type { PointSelection } from './pointSelection';

export type ExactCoordinateResult =
	| { ok: true; coordinates: PointCoordinates }
	| { ok: false; message: string };

/** Parses both fields before any domain mutation is attempted. */
export function parseExactCoordinates(
	xDraft: string,
	yDraft: string,
	widthPx: number,
	heightPx: number
): ExactCoordinateResult {
	const xText = xDraft.trim();
	const yText = yDraft.trim();
	if (xText === '' || yText === '') return { ok: false, message: 'Enter both X and Y coordinates.' };
	const xPx = Number(xText);
	const yPx = Number(yText);
	if (!Number.isFinite(xPx) || !Number.isFinite(yPx)) {
		return { ok: false, message: 'Coordinates must be finite numbers.' };
	}
	const coordinates = { xPx, yPx };
	if (!pointInBounds(coordinates, widthPx, heightPx)) {
		return { ok: false, message: 'Coordinates must be inside the original image bounds.' };
	}
	return { ok: true, coordinates };
}

export function commitPointCorrection(
	editor: ProjectEditor,
	selection: PointSelection,
	coordinates: PointCoordinates
): void {
	editor.movePoint(selection.pairId, selection.side as PointSide, coordinates);
}
