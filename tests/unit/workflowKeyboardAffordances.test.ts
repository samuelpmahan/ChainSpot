// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import WorkflowKeyboardAffordances from '../../src/lib/components/WorkflowKeyboardAffordances.svelte';

async function flush(): Promise<void> {
	for (let index = 0; index < 4; index += 1) {
		await tick();
		await Promise.resolve();
	}
}

let mounted: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = null;
	host?.remove();
	host = null;
	document.body.replaceChildren();
});

function mountAffordances(): void {
	host = document.createElement('div');
	document.body.appendChild(host);
	mounted = mount(WorkflowKeyboardAffordances, { target: host });
}

describe('WorkflowKeyboardAffordances', () => {
	it.each(['geocode-park-name', 'geocode-city-state'])(
		'Enter in %s clicks the existing Clean target Search button',
		async (testId) => {
			const input = document.createElement('input');
			input.dataset.testid = testId;
			const search = document.createElement('button');
			search.dataset.testid = 'geocode-search-button';
			const clickSpy = vi.fn();
			search.addEventListener('click', clickSpy);
			document.body.append(input, search);
			mountAffordances();
			await flush();

			const enter = new KeyboardEvent('keydown', {
				key: 'Enter',
				bubbles: true,
				cancelable: true
			});
			input.dispatchEvent(enter);

			expect(enter.defaultPrevented).toBe(true);
			expect(clickSpy).toHaveBeenCalledTimes(1);
		}
	);

	it('Tab accepts a zero-bend hole and advances through the final bends pass before finishing', async () => {
		const panel = document.createElement('div');
		panel.dataset.testid = 'bend-phase-panel';
		const indicator = document.createElement('div');
		indicator.dataset.testid = 'review-step-indicator';
		indicator.textContent = 'HOLE 1 · BENDS';
		const finish = document.createElement('button');
		finish.dataset.testid = 'finish-bends';
		const finishSpy = vi.fn(() => panel.remove());
		finish.addEventListener('click', finishSpy);

		for (const number of [1, 2, 3]) {
			const button = document.createElement('button');
			button.dataset.testid = `bend-phase-hole-${number}`;
			const tb = document.createElement('span');
			tb.className = 'tb';
			tb.appendChild(document.createElement('span')).textContent = '↯0';
			button.appendChild(tb);
			button.addEventListener('click', () => {
				indicator.textContent = `HOLE ${number} · BENDS`;
			});
			panel.appendChild(button);
		}
		panel.appendChild(finish);
		document.body.append(indicator, panel);
		mountAffordances();
		await flush();

		expect(host?.querySelector('[data-testid="bend-tab-help"]')?.textContent).toContain(
			'Zero bends means a straight hole'
		);

		const firstTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		window.dispatchEvent(firstTab);
		await flush();
		expect(firstTab.defaultPrevented).toBe(true);
		expect(panel.querySelector<HTMLButtonElement>('[data-testid="bend-phase-hole-1"]')?.dataset.bendTabAccepted).toBe('true');
		expect(indicator.textContent).toBe('HOLE 2 · BENDS');
		expect(finishSpy).not.toHaveBeenCalled();

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
		await flush();
		expect(panel.querySelector<HTMLButtonElement>('[data-testid="bend-phase-hole-2"]')?.dataset.bendTabAccepted).toBe('true');
		expect(indicator.textContent).toBe('HOLE 3 · BENDS');

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
		await flush();
		expect(finishSpy).toHaveBeenCalledTimes(1);
		expect(document.querySelector('[data-testid="bend-phase-panel"]')).toBeNull();
	});

	it('does not hijack modified or reverse Tab during bends review', async () => {
		const panel = document.createElement('div');
		panel.dataset.testid = 'bend-phase-panel';
		const indicator = document.createElement('div');
		indicator.dataset.testid = 'review-step-indicator';
		indicator.textContent = 'HOLE 1 · BENDS';
		const button = document.createElement('button');
		button.dataset.testid = 'bend-phase-hole-1';
		panel.appendChild(button);
		document.body.append(indicator, panel);
		mountAffordances();
		await flush();

		const shiftTab = new KeyboardEvent('keydown', {
			key: 'Tab',
			shiftKey: true,
			bubbles: true,
			cancelable: true
		});
		window.dispatchEvent(shiftTab);
		expect(shiftTab.defaultPrevented).toBe(false);
		expect(button.dataset.bendTabAccepted).toBe('false');
	});
});
