import type { PointSide } from './domain/editor';

export interface PointSelection {
	readonly pairId: string;
	readonly side: PointSide;
}

export interface NudgeDelta {
	readonly xPx: number;
	readonly yPx: number;
}

export function selectionMatches(
	selection: PointSelection | null,
	pairId: string,
	side: PointSide
): boolean {
	return selection?.pairId === pairId && selection.side === side;
}

export function nudgeDelta(key: string, shiftKey: boolean): NudgeDelta | null {
	const amount = shiftKey ? 10 : 1;
	switch (key) {
		case 'ArrowLeft':
			return { xPx: -amount, yPx: 0 };
		case 'ArrowRight':
			return { xPx: amount, yPx: 0 };
		case 'ArrowUp':
			return { xPx: 0, yPx: -amount };
		case 'ArrowDown':
			return { xPx: 0, yPx: amount };
		default:
			return null;
	}
}

export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.isContentEditable ||
		target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null
	);
}
