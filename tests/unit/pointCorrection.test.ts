import { describe, expect, it } from 'vitest';
import { commitPointCorrection, parseExactCoordinates } from '../../src/lib/pointCorrection';
import { nudgeDelta } from '../../src/lib/pointSelection';
import { ProjectEditor } from '../../src/lib/domain/editor';
import {
	createControlPointPair,
	createImageAsset,
	createProjectState
} from '../../src/lib/domain/project';

const NOW = () => new Date('2026-08-03T00:00:00.000Z');

function correctionEditor(): ProjectEditor {
	const base = createProjectState({ createId: () => 'project-1', now: NOW });
	const source = createImageAsset({
		id: 'source-1',
		role: 'source-overview',
		fileName: 'source.png',
		mimeType: 'image/png',
		widthPx: 100,
		heightPx: 80
	});
	const target = createImageAsset({
		id: 'target-1',
		role: 'target-basemap',
		fileName: 'target.jpg',
		mimeType: 'image/jpeg',
		widthPx: 120,
		heightPx: 90
	});
	const pair = createControlPointPair({
		id: 'pair-1',
		ordinal: 1,
		sourceImage: source,
		targetImage: target,
		sourceCoordinates: { xPx: 20, yPx: 30 },
		targetCoordinates: { xPx: 40, yPx: 50 },
		now: NOW
	});
	return new ProjectEditor({
		state: { ...base, images: [source, target], controlPointPairs: [pair] },
		assets: new Map([
			['source-1', { bytes: new Uint8Array([1]), decoded: null }],
			['target-1', { bytes: new Uint8Array([2]), decoded: null }]
		]),
		now: NOW
	});
}

function expectExactUndoRedo(
	editor: ProjectEditor,
	baseline: string,
	corrected: string
): void {
	expect(editor.canUndo).toBe(true);
	expect(editor.canRedo).toBe(false);
	expect(editor.undo()).toBe(true);
	expect(JSON.stringify(editor.state)).toBe(baseline);
	expect(editor.canUndo).toBe(false);
	expect(editor.canRedo).toBe(true);
	expect(editor.redo()).toBe(true);
	expect(JSON.stringify(editor.state)).toBe(corrected);
	expect(editor.canUndo).toBe(true);
	expect(editor.canRedo).toBe(false);
}

describe('P0-008 correction history', () => {
	it('restores the exact baseline and corrected state for a completed marker drag', () => {
		const editor = correctionEditor();
		editor.markSaved();
		const baseline = JSON.stringify(editor.state);

		commitPointCorrection(editor, { pairId: 'pair-1', side: 'source' }, { xPx: 22.5, yPx: 31.25 });
		const corrected = JSON.stringify(editor.state);
		expect(editor.state.controlPointPairs[0].source).toMatchObject({ xPx: 22.5, yPx: 31.25 });
		expectExactUndoRedo(editor, baseline, corrected);
	});

	it('restores the exact baseline and corrected state for a one-pixel keyboard nudge', () => {
		const editor = correctionEditor();
		editor.markSaved();
		const baseline = JSON.stringify(editor.state);
		const delta = nudgeDelta('ArrowRight', false);
		if (!delta) throw new Error('missing one-pixel delta');
		const point = editor.state.controlPointPairs[0].source;

		commitPointCorrection(editor, { pairId: 'pair-1', side: 'source' }, {
			xPx: point.xPx + delta.xPx,
			yPx: point.yPx + delta.yPx
		});
		const corrected = JSON.stringify(editor.state);
		expect(editor.state.controlPointPairs[0].source).toMatchObject({ xPx: 21, yPx: 30 });
		expectExactUndoRedo(editor, baseline, corrected);
	});

	it('restores the exact baseline and corrected state for a ten-pixel keyboard nudge', () => {
		const editor = correctionEditor();
		editor.markSaved();
		const baseline = JSON.stringify(editor.state);
		const delta = nudgeDelta('ArrowDown', true);
		if (!delta) throw new Error('missing ten-pixel delta');
		const point = editor.state.controlPointPairs[0].target;

		commitPointCorrection(editor, { pairId: 'pair-1', side: 'target' }, {
			xPx: point.xPx + delta.xPx,
			yPx: point.yPx + delta.yPx
		});
		const corrected = JSON.stringify(editor.state);
		expect(editor.state.controlPointPairs[0].target).toMatchObject({ xPx: 40, yPx: 60 });
		expectExactUndoRedo(editor, baseline, corrected);
	});

	it('restores the exact baseline and corrected state for valid fractional inspector entry', () => {
		const editor = correctionEditor();
		editor.markSaved();
		const baseline = JSON.stringify(editor.state);
		const parsed = parseExactCoordinates(' 23.75 ', ' 34.125 ', 100, 80);
		expect(parsed).toEqual({ ok: true, coordinates: { xPx: 23.75, yPx: 34.125 } });
		if (!parsed.ok) return;

		commitPointCorrection(editor, { pairId: 'pair-1', side: 'source' }, parsed.coordinates);
		const corrected = JSON.stringify(editor.state);
		expect(editor.state.controlPointPairs[0].source).toMatchObject({ xPx: 23.75, yPx: 34.125 });
		expectExactUndoRedo(editor, baseline, corrected);
	});

	it('parses both drafts before mutation and adds no history for invalid or no-op corrections', () => {
		const editor = correctionEditor();
		editor.markSaved();
		const baseline = JSON.stringify(editor.state);
		expect(parseExactCoordinates(' ', '30', 100, 80).ok).toBe(false);
		expect(parseExactCoordinates('20', 'Infinity', 100, 80).ok).toBe(false);
		expect(parseExactCoordinates('101', '30', 100, 80).ok).toBe(false);
		expect(JSON.stringify(editor.state)).toBe(baseline);
		expect(editor.canUndo).toBe(false);

		commitPointCorrection(editor, { pairId: 'pair-1', side: 'source' }, { xPx: 20, yPx: 30 });
		expect(JSON.stringify(editor.state)).toBe(baseline);
		expect(editor.canUndo).toBe(false);
	});
});
