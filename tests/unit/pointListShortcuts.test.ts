import { describe, expect, it } from 'vitest';
import { historyShortcut, isDeleteKey, reorderShortcut } from '../../src/lib/pointListShortcuts';

function key(event: Partial<KeyboardEvent>): KeyboardEvent {
	return event as KeyboardEvent;
}

describe('P0-009 shortcut detection', () => {
	it('detects Cmd/Ctrl+Z undo and Cmd/Ctrl+Shift+Z redo', () => {
		expect(historyShortcut(key({ key: 'z', ctrlKey: true }))).toBe('undo');
		expect(historyShortcut(key({ key: 'Z', metaKey: true }))).toBe('undo');
		expect(historyShortcut(key({ key: 'z', ctrlKey: true, shiftKey: true }))).toBe('redo');
		expect(historyShortcut(key({ key: 'Z', metaKey: true, shiftKey: true }))).toBe('redo');
	});

	it('detects Ctrl+Y redo but not Cmd+Y, Ctrl+Shift+Y, or bare Y', () => {
		expect(historyShortcut(key({ key: 'y', ctrlKey: true }))).toBe('redo');
		expect(historyShortcut(key({ key: 'y', metaKey: true }))).toBeNull();
		expect(historyShortcut(key({ key: 'y' }))).toBeNull();
		expect(historyShortcut(key({ key: 'y', ctrlKey: true, shiftKey: true }))).toBeNull();
	});

	it('returns null for unrelated keys and combinations', () => {
		expect(historyShortcut(key({ key: 'a', ctrlKey: true }))).toBeNull();
		expect(historyShortcut(key({ key: 'z' }))).toBeNull();
	});

	it('detects Cmd/Ctrl+ArrowUp/Down reorder', () => {
		expect(reorderShortcut(key({ key: 'ArrowUp', ctrlKey: true }))).toBe(-1);
		expect(reorderShortcut(key({ key: 'ArrowDown', metaKey: true }))).toBe(1);
		expect(reorderShortcut(key({ key: 'ArrowUp' }))).toBeNull();
		expect(reorderShortcut(key({ key: 'ArrowDown' }))).toBeNull();
	});

	it('detects Delete and Backspace', () => {
		expect(isDeleteKey(key({ key: 'Delete' }))).toBe(true);
		expect(isDeleteKey(key({ key: 'Backspace' }))).toBe(true);
		expect(isDeleteKey(key({ key: 'ArrowRight' }))).toBe(false);
	});
});
