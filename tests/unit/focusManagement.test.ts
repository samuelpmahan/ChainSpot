import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	dialogKeyboard,
	getFocusableDescendants,
	isModalOpen,
	trapTabIn
} from '../../src/lib/focusManagement';

function makeDialog(): { root: HTMLDivElement; buttons: HTMLButtonElement[]; inputs: HTMLInputElement[] } {
	const root = document.createElement('div');
	root.setAttribute('role', 'dialog');
	root.setAttribute('aria-modal', 'true');
	const buttons = [document.createElement('button'), document.createElement('button')];
	const inputs = [
		document.createElement('input'),
		document.createElement('input')
	] as HTMLInputElement[];
	buttons[0].textContent = 'Cancel';
	buttons[1].textContent = 'Accept';
	inputs[0].type = 'text';
	inputs[1].type = 'text';
	root.append(buttons[0], inputs[0], inputs[1], buttons[1]);
	document.body.appendChild(root);
	return { root, buttons, inputs };
}

afterEach(() => {
	document.body.replaceChildren();
});

describe('P0-013 focus management', () => {
	it('lists enabled, visible, focusable descendants in DOM order and skips disabled/hidden ones', () => {
		const { root, buttons, inputs } = makeDialog();
		buttons[1].disabled = true;
		inputs[1].style.display = 'none';
		const focusable = getFocusableDescendants(root);
		expect(focusable).toEqual([buttons[0], inputs[0]]);
	});

	it('detects an open modal dialog and ignores non-modal dialogs', () => {
		expect(isModalOpen()).toBe(false);
		const { root } = makeDialog();
		expect(isModalOpen()).toBe(true);
		root.setAttribute('aria-modal', 'false');
		expect(isModalOpen()).toBe(false);
	});

	it('traps Tab forward and Shift+Tab backward within the dialog', () => {
		const { root, buttons, inputs } = makeDialog();

		// Forward wrap: from the last focusable element back to the first.
		buttons[1].focus();
		const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		trapTabIn(root, tab);
		expect(tab.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(buttons[0]);

		// Backward wrap: from the first focusable element to the last.
		buttons[0].focus();
		const shiftTab = new KeyboardEvent('keydown', {
			key: 'Tab',
			shiftKey: true,
			bubbles: true,
			cancelable: true
		});
		trapTabIn(root, shiftTab);
		expect(shiftTab.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(buttons[1]);

		// Tab from an interior element is left to the browser.
		void inputs;
		inputs[0].focus();
		const interiorTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		trapTabIn(root, interiorTab);
		expect(interiorTab.defaultPrevented).toBe(false);
	});

	it('ignores non-Tab keys in the trap', () => {
		const { root } = makeDialog();
		const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
		trapTabIn(root, event);
		expect(event.defaultPrevented).toBe(false);
	});

	it('dialogKeyboard routes Escape to the callback and stops propagation', () => {
		const { root } = makeDialog();
		const onEscape = vi.fn();
		const action = dialogKeyboard(root, onEscape);
		const windowSpy = vi.fn();
		window.addEventListener('keydown', windowSpy);

		const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		root.dispatchEvent(escape);
		expect(onEscape).toHaveBeenCalledTimes(1);
		expect(escape.defaultPrevented).toBe(true);
		expect(windowSpy).not.toHaveBeenCalled();

		action.destroy();
		root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		expect(onEscape).toHaveBeenCalledTimes(1);

		window.removeEventListener('keydown', windowSpy);
	});
});
