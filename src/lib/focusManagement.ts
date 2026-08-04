/**
 * ChainSpot dialog keyboard and focus helpers (P0-013).
 *
 * The Phase 0 confirmation dialogs are native `role="dialog"`/`aria-modal="true"`
 * elements rendered by the page. The page owns initial focus and focus restoration
 * (it already records the previously focused element and restores it on settle/cancel).
 * This module supplies the remaining dialog behavior without a framework dependency:
 *
 * - `dialogKeyboard`: a Svelte action that traps Tab/Shift+Tab inside the dialog and
 *   routes Escape to the caller (stopping propagation so the global shortcut handler
 *   cannot also react).
 * - `isModalOpen`: the global keyboard handler consults this so nudge/delete/undo/redo
 *   shortcuts never fire while a modal dialog is open.
 * - `getFocusableDescendants` / `trapTabIn`: pure DOM helpers, unit-tested in jsdom.
 */

/** Selector for keyboard-focusable, enabled, visible elements inside a dialog. */
export const FOCUSABLE_SELECTOR = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[tabindex]:not([tabindex="-1"])',
	'[contenteditable="true"]',
	'[contenteditable=""]'
].join(',');

function isVisible(element: HTMLElement): boolean {
	const style = window.getComputedStyle(element);
	return style.visibility !== 'hidden' && style.display !== 'none';
}

/** The enabled, visible, focusable descendants of a root, in DOM order. */
export function getFocusableDescendants(root: HTMLElement): HTMLElement[] {
	const candidates = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
	return candidates.filter((element) => isVisible(element));
}

/** True when a modal dialog is currently open anywhere in the document. */
export function isModalOpen(root: ParentNode = document): boolean {
	return root.querySelector('[role="dialog"][aria-modal="true"]') !== null;
}

/** Traps Tab/Shift+Tab within `root`, wrapping to the first/last focusable element. */
export function trapTabIn(root: HTMLElement, event: KeyboardEvent): void {
	if (event.key !== 'Tab') return;
	const focusable = getFocusableDescendants(root);
	if (focusable.length === 0) return;
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	const active = document.activeElement;
	if (event.shiftKey) {
		if (active === first || active === root || !root.contains(active)) {
			event.preventDefault();
			last.focus({ preventScroll: true });
		}
	} else if (active === last || active === root || !root.contains(active)) {
		event.preventDefault();
		first.focus({ preventScroll: true });
	}
}

/**
 * Svelte action for the simple confirmation dialogs: traps Tab/Shift+Tab inside the
 * dialog and handles Escape via `onEscape`. Escape is `preventDefault`ed and
 * `stopPropagation`ed so the global window keydown handler cannot also cancel a
 * pending correspondence while a dialog is open.
 */
export function dialogKeyboard(
	node: HTMLElement,
	onEscape?: () => void
): { destroy(): void } {
	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			onEscape?.();
			return;
		}
		trapTabIn(node, event);
	};
	node.addEventListener('keydown', onKeyDown);
	return {
		destroy() {
			node.removeEventListener('keydown', onKeyDown);
		}
	};
}
