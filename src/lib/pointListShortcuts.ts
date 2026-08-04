/**
 * ChainSpot point-pair management keyboard shortcut detection (P0-009).
 *
 * Pure key-combination predicates used by the page's window keydown handler. The
 * caller owns editable-target suppression, pending-correspondence cancellation, and
 * whether a handler is actually available; these helpers only answer "is this the
 * undo/redo/delete/reorder combination".
 */

export type HistoryShortcut = 'undo' | 'redo';

/**
 * Undo/redo combinations:
 * - Cmd/Ctrl+Z            -> undo
 * - Cmd/Ctrl+Shift+Z      -> redo
 * - Ctrl+Y                -> redo (Ctrl only; Cmd+Y is intentionally not bound)
 */
export function historyShortcut(event: KeyboardEvent): HistoryShortcut | null {
	const key = event.key.toLowerCase();
	if (!event.ctrlKey && !event.metaKey) return null;
	if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
	if (event.ctrlKey && !event.metaKey && key === 'y' && !event.shiftKey) return 'redo';
	return null;
}

/** Cmd/Ctrl+ArrowUp/Down reorders the selected pair; returns -1 (up) or +1 (down). */
export function reorderShortcut(event: KeyboardEvent): -1 | 1 | null {
	if (!event.ctrlKey && !event.metaKey) return null;
	if (event.key === 'ArrowUp') return -1;
	if (event.key === 'ArrowDown') return 1;
	return null;
}

/** Delete/Backspace deletes the selected pair when safe (never inside editable fields). */
export function isDeleteKey(event: KeyboardEvent): boolean {
	return event.key === 'Delete' || event.key === 'Backspace';
}
