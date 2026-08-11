// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import PointPairList from '../../src/lib/components/PointPairList.svelte';
import { createControlPointPair, createImageAsset } from '../../src/lib/domain/project';
import type { ControlPointPair, ImageAsset } from '../../src/lib/domain/project';
import type { PointSelection } from '../../src/lib/pointSelection';

const SOURCE = createImageAsset({
	id: 'source-1',
	role: 'source-overview',
	fileName: 'source.png',
	mimeType: 'image/png',
	widthPx: 200,
	heightPx: 100
});
const TARGET = createImageAsset({
	id: 'target-1',
	role: 'target-basemap',
	fileName: 'target.png',
	mimeType: 'image/png',
	widthPx: 400,
	heightPx: 50
});

function makePairs(count = 3): ControlPointPair[] {
	return Array.from({ length: count }, (_, i) => {
		const n = i + 1;
		return createControlPointPair({
			id: `pair-${n}`,
			ordinal: n,
			sourceImage: SOURCE,
			targetImage: TARGET,
			sourceCoordinates: { xPx: 20 + n, yPx: 10 + n },
			targetCoordinates: { xPx: 40 + n * 2, yPx: 5 + n },
			label: n === 1 ? 'Parking corner' : null,
			now: () => new Date('2026-08-03T00:00:00.000Z')
		});
	});
}

interface Callbacks {
	onSelectSide: ReturnType<typeof vi.fn<(pairId: string, side: 'source' | 'target') => void>>;
	onLabelCommit: ReturnType<typeof vi.fn<(pairId: string, label: string | null) => void>>;
	onReorder: ReturnType<typeof vi.fn<(pairId: string, direction: -1 | 1) => void>>;
	onToggleEnabled: ReturnType<typeof vi.fn<(pairId: string) => void>>;
	onDelete: ReturnType<typeof vi.fn<(pairId: string) => void>>;
}

interface Mounted {
	host: HTMLDivElement;
	component: ReturnType<typeof mount>;
	callbacks: Callbacks;
}

function mountList(
	pairs: readonly ControlPointPair[],
	selection: PointSelection | null = null,
	interactive = true
): Mounted {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const callbacks: Callbacks = {
		onSelectSide: vi.fn<(pairId: string, side: 'source' | 'target') => void>(),
		onLabelCommit: vi.fn<(pairId: string, label: string | null) => void>(),
		onReorder: vi.fn<(pairId: string, direction: -1 | 1) => void>(),
		onToggleEnabled: vi.fn<(pairId: string) => void>(),
		onDelete: vi.fn<(pairId: string) => void>()
	};
	const component = mount(PointPairList, {
		target: host,
		props: {
			pairs,
			images: [SOURCE, TARGET] as ImageAsset[],
			selection,
			refresh: 0,
			interactive,
			...callbacks
		}
	});
	return { host, component, callbacks };
}

function inputFor(host: HTMLElement, pairId: string): HTMLInputElement {
	const input = host.querySelector<HTMLInputElement>(`[data-testid="pair-label-${pairId}"]`);
	if (!input) throw new Error(`missing label input for ${pairId}`);
	return input;
}

afterEach(() => {
	document.body.replaceChildren();
});

describe('P0-009 PointPairList rendering', () => {
	it('shows every complete pair exactly once with ordinal, label, state, and derived coordinates', async () => {
		const pairs = makePairs(3);
		const { host, component } = mountList(pairs);
		await tick();

		const rows = host.querySelectorAll('[data-testid="pair-row"]');
		expect(rows).toHaveLength(3);
		expect(host.querySelector('[data-testid="pair-ordinal-pair-1"]')?.textContent).toBe('1');
		expect(host.querySelector('[data-testid="pair-ordinal-pair-2"]')?.textContent).toBe('2');
		expect(host.querySelector('[data-testid="pair-ordinal-pair-3"]')?.textContent).toBe('3');

		expect((inputFor(host, 'pair-1') as HTMLInputElement).value).toBe('Parking corner');
		expect((inputFor(host, 'pair-2') as HTMLInputElement).value).toBe('');

		for (const n of [1, 2, 3]) {
			const enabled = host.querySelector<HTMLInputElement>(`[data-testid="pair-enabled-pair-${n}"]`);
			expect(enabled?.checked).toBe(true);
		}

		// pair-1: source (21, 11) on 200x100 -> norm (0.105, 0.11)
		expect(host.querySelector('[data-testid="pair-source-px-pair-1"]')?.textContent).toBe('(21, 11)');
		expect(host.querySelector('[data-testid="pair-source-norm-pair-1"]')?.textContent).toBe('(0.105, 0.11)');
		// pair-1 target (42, 6) on 400x50 -> norm (0.105, 0.12)
		expect(host.querySelector('[data-testid="pair-target-px-pair-1"]')?.textContent).toBe('(42, 6)');
		expect(host.querySelector('[data-testid="pair-target-norm-pair-1"]')?.textContent).toBe('(0.105, 0.12)');

		unmount(component);
	});

	it('derives normalized values from each side image dimension with fractional pixels', async () => {
		const pairs = [
			createControlPointPair({
				id: 'pair-f',
				ordinal: 1,
				sourceImage: SOURCE,
				targetImage: TARGET,
				sourceCoordinates: { xPx: 50.5, yPx: 25.25 },
				targetCoordinates: { xPx: 100.5, yPx: 12.5 },
				now: () => new Date('2026-08-03T00:00:00.000Z')
			})
		];
		const { host, component } = mountList(pairs);
		await tick();
		expect(host.querySelector('[data-testid="pair-source-px-pair-f"]')?.textContent).toBe('(50.5, 25.25)');
		expect(host.querySelector('[data-testid="pair-source-norm-pair-f"]')?.textContent).toBe('(0.2525, 0.2525)');
		expect(host.querySelector('[data-testid="pair-target-px-pair-f"]')?.textContent).toBe('(100.5, 12.5)');
		expect(host.querySelector('[data-testid="pair-target-norm-pair-f"]')?.textContent).toBe('(0.2512, 0.25)');
		unmount(component);
	});

	it('shows a disabled state for a disabled pair while keeping it fully present', async () => {
		const pairs = makePairs(2).map((pair) =>
			pair.id === 'pair-2' ? { ...pair, enabled: false } : pair
		);
		const { host, component } = mountList(pairs);
		await tick();
		const row2 = host.querySelector('[data-testid="pair-row"][data-pair-id="pair-2"]');
		expect(row2?.classList.contains('disabled-pair')).toBe(true);
		expect(host.querySelector('[data-testid="pair-ordinal-pair-2"]')).toBeTruthy();
		const enabled = host.querySelector<HTMLInputElement>('[data-testid="pair-enabled-pair-2"]');
		expect(enabled?.checked).toBe(false);
		unmount(component);
	});
});

describe('P0-013 PointPairList accessibility', () => {
	it('exposes meaningful accessible names for side, label, enabled, reorder, and delete controls', async () => {
		const { host, component } = mountList(makePairs(3));
		await tick();
		const source = host.querySelector<HTMLButtonElement>('[data-testid="pair-source-pair-2"]');
		const target = host.querySelector<HTMLButtonElement>('[data-testid="pair-target-pair-2"]');
		const label = inputFor(host, 'pair-2');
		const enabled = host.querySelector<HTMLInputElement>('[data-testid="pair-enabled-pair-2"]');
		const up = host.querySelector<HTMLButtonElement>('[data-testid="pair-up-pair-2"]');
		const del = host.querySelector<HTMLButtonElement>('[data-testid="pair-delete-pair-2"]');
		expect(source?.getAttribute('aria-label')).toBe('Select the source point of pair 2');
		expect(target?.getAttribute('aria-label')).toBe('Select the target point of pair 2');
		expect(label.getAttribute('aria-label')).toBe('Label for pair 2');
		expect(enabled?.getAttribute('aria-label')).toBe('Enable pair 2');
		expect(up?.getAttribute('aria-label')).toBe('Move pair 2 up');
		expect(del?.getAttribute('aria-label')).toBe('Delete pair 2');
		unmount(component);
	});

	it('exposes selection state through aria-pressed and a non-color selected mark', async () => {
		const { host, component } = mountList(makePairs(3), { pairId: 'pair-2', side: 'target' });
		await tick();
		const target = host.querySelector<HTMLButtonElement>('[data-testid="pair-target-pair-2"]');
		const source = host.querySelector<HTMLButtonElement>('[data-testid="pair-source-pair-2"]');
		const row = host.querySelector('[data-testid="pair-row"][data-pair-id="pair-2"]');
		expect(target?.getAttribute('aria-pressed')).toBe('true');
		expect(source?.getAttribute('aria-pressed')).toBe('false');
		expect(row?.getAttribute('aria-current')).toBe('true');
		expect(host.querySelector('[data-testid="pair-selected-mark-pair-2"]')).toBeTruthy();
		expect(host.querySelector('[data-testid="pair-selected-mark-pair-1"]')).toBeNull();
		unmount(component);
	});

	it('marks a disabled pair with a non-color disabled tag and an aria state', async () => {
		const pairs = makePairs(2).map((pair) =>
			pair.id === 'pair-2' ? { ...pair, enabled: false } : pair
		);
		const { host, component } = mountList(pairs);
		await tick();
		const row = host.querySelector('[data-testid="pair-row"][data-pair-id="pair-2"]');
		expect(host.querySelector('[data-testid="pair-disabled-pair-2"]')?.textContent).toBe('Disabled');
		expect(row?.getAttribute('aria-label')).toBe('Pair 2, disabled');
		expect(host.querySelector('[data-testid="pair-disabled-pair-1"]')).toBeNull();
		unmount(component);
	});
});

describe('P0-009 PointPairList selection', () => {
	it('selects the exact side from source and target controls', async () => {
		const { host, component, callbacks } = mountList(makePairs(3));
		await tick();
		host.querySelector<HTMLButtonElement>('[data-testid="pair-source-pair-2"]')?.click();
		expect(callbacks.onSelectSide).toHaveBeenCalledWith('pair-2', 'source');
		host.querySelector<HTMLButtonElement>('[data-testid="pair-target-pair-3"]')?.click();
		expect(callbacks.onSelectSide).toHaveBeenCalledWith('pair-3', 'target');
		expect(callbacks.onSelectSide).toHaveBeenCalledTimes(2);
		unmount(component);
	});

	it('highlights the row and the exact side for the current selection', async () => {
		const { host, component } = mountList(makePairs(3), { pairId: 'pair-2', side: 'target' });
		await tick();
		const row2 = host.querySelector('[data-testid="pair-row"][data-pair-id="pair-2"]');
		expect(row2?.classList.contains('selected')).toBe(true);
		expect(
			host
				.querySelector('[data-testid="pair-target-pair-2"]')
				?.classList.contains('selected')
		).toBe(true);
		expect(
			host
				.querySelector('[data-testid="pair-source-pair-2"]')
				?.classList.contains('selected')
		).toBe(false);
		const row1 = host.querySelector('[data-testid="pair-row"][data-pair-id="pair-1"]');
		expect(row1?.classList.contains('selected')).toBe(false);
		unmount(component);
	});
});

describe('P0-009 PointPairList label editing', () => {
	it('commits a label once on blur, never per keystroke', async () => {
		const { host, component, callbacks } = mountList(makePairs(3));
		await tick();
		const input = inputFor(host, 'pair-2');
		input.focus();
		input.value = 'P';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.value = 'Po';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.value = 'Pond';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await tick();
		expect(callbacks.onLabelCommit).not.toHaveBeenCalled();
		input.dispatchEvent(new Event('blur', { bubbles: true }));
		await tick();
		expect(callbacks.onLabelCommit).toHaveBeenCalledTimes(1);
		expect(callbacks.onLabelCommit).toHaveBeenCalledWith('pair-2', 'Pond');
		unmount(component);
	});

	it('commits a label exactly once for Enter followed by blur', async () => {
		const { host, component, callbacks } = mountList(makePairs(3));
		await tick();
		const input = inputFor(host, 'pair-2');
		input.focus();
		input.value = 'Pond edge';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await tick();
		expect(callbacks.onLabelCommit).toHaveBeenCalledTimes(1);
		expect(callbacks.onLabelCommit).toHaveBeenCalledWith('pair-2', 'Pond edge');
		unmount(component);
	});

	it('clears an existing label to null', async () => {
		const { host, component, callbacks } = mountList(makePairs(3));
		await tick();
		const clear = inputFor(host, 'pair-1');
		clear.focus();
		clear.value = '';
		clear.dispatchEvent(new Event('input', { bubbles: true }));
		clear.dispatchEvent(new Event('blur', { bubbles: true }));
		await tick();
		expect(callbacks.onLabelCommit).toHaveBeenCalledTimes(1);
		expect(callbacks.onLabelCommit).toHaveBeenCalledWith('pair-1', null);
		unmount(component);
	});

	it('treats whitespace-only input on an already-null label as a no-op', async () => {
		const { host, component, callbacks } = mountList(makePairs(3));
		await tick();
		const whitespace = inputFor(host, 'pair-2');
		whitespace.focus();
		whitespace.value = '   ';
		whitespace.dispatchEvent(new Event('input', { bubbles: true }));
		whitespace.dispatchEvent(new Event('blur', { bubbles: true }));
		await tick();
		expect(callbacks.onLabelCommit).not.toHaveBeenCalled();
		unmount(component);
	});

	it('treats an unchanged label with surrounding whitespace as a no-op', async () => {
		const { host, component, callbacks } = mountList(makePairs(3));
		await tick();
		const unchanged = inputFor(host, 'pair-1');
		unchanged.focus();
		unchanged.value = '  Parking corner  ';
		unchanged.dispatchEvent(new Event('input', { bubbles: true }));
		unchanged.dispatchEvent(new Event('blur', { bubbles: true }));
		await tick();
		expect(callbacks.onLabelCommit).not.toHaveBeenCalled();
		unmount(component);
	});
});

describe('P0-009 PointPairList reorder, enable, and delete', () => {
	it('disables boundary reorder buttons and calls onReorder once for a valid move', async () => {
		const { host, component, callbacks } = mountList(makePairs(3));
		await tick();
		expect((host.querySelector('[data-testid="pair-up-pair-1"]') as HTMLButtonElement).disabled).toBe(true);
		expect((host.querySelector('[data-testid="pair-down-pair-3"]') as HTMLButtonElement).disabled).toBe(true);
		expect((host.querySelector('[data-testid="pair-up-pair-3"]') as HTMLButtonElement).disabled).toBe(false);

		host.querySelector<HTMLButtonElement>('[data-testid="pair-down-pair-1"]')?.click();
		expect(callbacks.onReorder).toHaveBeenCalledTimes(1);
		expect(callbacks.onReorder).toHaveBeenCalledWith('pair-1', 1);
		unmount(component);
	});

	it('toggles enabled and deletes through their controls', async () => {
		const { host, component, callbacks } = mountList(makePairs(3));
		await tick();
		host.querySelector<HTMLInputElement>('[data-testid="pair-enabled-pair-2"]')?.click();
		expect(callbacks.onToggleEnabled).toHaveBeenCalledWith('pair-2');
		host.querySelector<HTMLButtonElement>('[data-testid="pair-delete-pair-2"]')?.click();
		expect(callbacks.onDelete).toHaveBeenCalledWith('pair-2');
		unmount(component);
	});

	it('disables all management controls when interactive is false', async () => {
		const { host, component, callbacks } = mountList(makePairs(2), null, false);
		await tick();
		expect((inputFor(host, 'pair-1') as HTMLInputElement).disabled).toBe(true);
		expect((host.querySelector('[data-testid="pair-source-pair-1"]') as HTMLButtonElement).disabled).toBe(true);
		expect((host.querySelector('[data-testid="pair-enabled-pair-1"]') as HTMLInputElement).disabled).toBe(true);
		expect((host.querySelector('[data-testid="pair-delete-pair-1"]') as HTMLButtonElement).disabled).toBe(true);
		host.querySelector<HTMLButtonElement>('[data-testid="pair-source-pair-1"]')?.click();
		expect(callbacks.onSelectSide).not.toHaveBeenCalled();
		unmount(component);
	});
});

describe('P0-013 PointPairList accessibility', () => {
	it('exposes meaningful accessible names for side, label, enabled, reorder, and delete controls', async () => {
		const { host, component } = mountList(makePairs(3));
		await tick();
		expect(host.querySelector('[data-testid="pair-source-pair-2"]')?.getAttribute('aria-label')).toBe(
			'Select the source point of pair 2'
		);
		expect(host.querySelector('[data-testid="pair-target-pair-2"]')?.getAttribute('aria-label')).toBe(
			'Select the target point of pair 2'
		);
		expect(inputFor(host, 'pair-2').getAttribute('aria-label')).toBe('Label for pair 2');
		expect(host.querySelector('[data-testid="pair-enabled-pair-2"]')?.getAttribute('aria-label')).toBe(
			'Enable pair 2'
		);
		expect(host.querySelector('[data-testid="pair-up-pair-2"]')?.getAttribute('aria-label')).toBe(
			'Move pair 2 up'
		);
		expect(host.querySelector('[data-testid="pair-delete-pair-2"]')?.getAttribute('aria-label')).toBe(
			'Delete pair 2'
		);
		unmount(component);
	});

	it('exposes selection through aria-pressed, aria-current, and a non-color selected mark', async () => {
		const { host, component } = mountList(makePairs(3), { pairId: 'pair-2', side: 'target' });
		await tick();
		expect(host.querySelector('[data-testid="pair-target-pair-2"]')?.getAttribute('aria-pressed')).toBe(
			'true'
		);
		expect(host.querySelector('[data-testid="pair-source-pair-2"]')?.getAttribute('aria-pressed')).toBe(
			'false'
		);
		expect(
			host.querySelector('[data-testid="pair-row"][data-pair-id="pair-2"]')?.getAttribute('aria-current')
		).toBe('true');
		expect(host.querySelector('[data-testid="pair-selected-mark-pair-2"]')).toBeTruthy();
		expect(host.querySelector('[data-testid="pair-selected-mark-pair-1"]')).toBeNull();
		unmount(component);
	});

	it('marks a disabled pair with a visible non-color disabled tag and aria label', async () => {
		const pairs = makePairs(2).map((pair) =>
			pair.id === 'pair-2' ? { ...pair, enabled: false } : pair
		);
		const { host, component } = mountList(pairs);
		await tick();
		expect(host.querySelector('[data-testid="pair-disabled-pair-2"]')?.textContent).toBe('Disabled');
		expect(
			host
				.querySelector('[data-testid="pair-row"][data-pair-id="pair-2"]')
				?.getAttribute('aria-label')
		).toBe('Pair 2, disabled');
		expect(host.querySelector('[data-testid="pair-disabled-pair-1"]')).toBeNull();
		unmount(component);
	});
});

describe('P0-013 PointPairList accessibility', () => {
	it('exposes accessible names and selection state for the side controls', async () => {
		const { host, component } = mountList(makePairs(3), { pairId: 'pair-2', side: 'target' });
		await tick();
		const source = host.querySelector<HTMLButtonElement>('[data-testid="pair-source-pair-2"]');
		const target = host.querySelector<HTMLButtonElement>('[data-testid="pair-target-pair-2"]');
		expect(source?.getAttribute('aria-label')).toBe('Select the source point of pair 2');
		expect(target?.getAttribute('aria-label')).toBe('Select the target point of pair 2');
		expect(source?.getAttribute('aria-pressed')).toBe('false');
		expect(target?.getAttribute('aria-pressed')).toBe('true');
		expect(host.querySelector('[data-testid="pair-selected-mark-pair-2"]')).toBeTruthy();
		expect(host.querySelector('[data-testid="pair-selected-mark-pair-1"]')).toBeNull();
		unmount(component);
	});

	it('exposes meaningful labels for label, enabled, reorder, and delete controls', async () => {
		const { host, component } = mountList(makePairs(3));
		await tick();
		expect(inputFor(host, 'pair-2').getAttribute('aria-label')).toBe('Label for pair 2');
		const enabled = host.querySelector<HTMLInputElement>('[data-testid="pair-enabled-pair-2"]');
		expect(enabled?.getAttribute('aria-label')).toBe('Enable pair 2');
		const up = host.querySelector<HTMLButtonElement>('[data-testid="pair-up-pair-2"]');
		const down = host.querySelector<HTMLButtonElement>('[data-testid="pair-down-pair-2"]');
		const del = host.querySelector<HTMLButtonElement>('[data-testid="pair-delete-pair-2"]');
		expect(up?.getAttribute('aria-label')).toBe('Move pair 2 up');
		expect(down?.getAttribute('aria-label')).toBe('Move pair 2 down');
		expect(del?.getAttribute('aria-label')).toBe('Delete pair 2');
		unmount(component);
	});

	it('marks a disabled pair with a non-color tag and an accessible row label', async () => {
		const pairs = makePairs(2).map((pair) =>
			pair.id === 'pair-2' ? { ...pair, enabled: false } : pair
		);
		const { host, component } = mountList(pairs);
		await tick();
		const tag = host.querySelector('[data-testid="pair-disabled-pair-2"]');
		expect(tag?.textContent).toBe('Disabled');
		const row = host.querySelector('[data-testid="pair-row"][data-pair-id="pair-2"]');
		expect(row?.getAttribute('aria-label')).toContain('disabled');
		unmount(component);
	});
});
