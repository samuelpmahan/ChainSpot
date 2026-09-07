import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSampleWorkspace } from '../../src/lib/disc-studio/samples';
import {
	cardStateFor,
	deleteDisc,
	formatNumber,
	moveEntry,
	newId,
	parseWorkspace,
	removeEntry,
	setScore
} from '../../src/lib/disc-studio/model';
import { loadDraft, saveDraft, storageKey } from '../../src/lib/disc-studio/localDraft';

describe('Disc Studio domain and composition', () => {
	it('seeds seven distinct specimens including two independent copies of one mold', () => {
		const w = createSampleWorkspace();
		expect(w.discs).toHaveLength(7);
		expect(w.battle.entries).toHaveLength(4);
		const same = w.discs.filter((d) => d.mold === 'Buzzz');
		expect(same).toHaveLength(2);
		expect(same[0].id).not.toBe(same[1].id);
		expect(w.discs.every((d) => d.image === null)).toBe(true);
	});
	it('creates a fresh draft, not shared mutable seed data', () => {
		const a = createSampleWorkspace(),
			b = createSampleWorkspace();
		a.discs[0].flight.speed = 100;
		expect(b.discs[0].flight.speed).toBe(5);
	});
	it('changes a score without mutating input or inventing highlight/winner transitions', () => {
		const w = createSampleWorkspace(),
			before = JSON.stringify(w);
		const next = setScore(w.battle, 'entry-1', -2.5);
		expect(next.entries[0].score).toBe(-2.5);
		expect(next.entries[0].id).toBe('entry-1');
		expect(JSON.stringify(w)).toBe(before);
		expect(w.battleVisual).toEqual({ highlightedEntryId: 'entry-1', emphasizedEntryIds: [] });
	});
	it('rejects a missing score target and non-finite values', () => {
		const w = createSampleWorkspace();
		expect(() => setScore(w.battle, 'missing', 1)).toThrow();
		for (const v of [NaN, Infinity, -Infinity])
			expect(() => setScore(w.battle, 'entry-1', v)).toThrow();
	});
	it('supports two entries referring to one disc with independent scores', () => {
		const w = createSampleWorkspace();
		w.battle.entries[1].discId = w.battle.entries[0].discId;
		const next = setScore(w.battle, 'entry-1', 8);
		expect(next.entries[1].score).toBe(1);
		expect(parseWorkspace(JSON.stringify({ ...w, battle: next })).battle.entries).toHaveLength(4);
	});
	it('reorders entries without replacing their identities or scores', () => {
		const w = createSampleWorkspace();
		const next = moveEntry(w.battle, 'entry-1', 1);
		expect(next.entries[1]).toEqual(w.battle.entries[0]);
		expect(w.battle.entries[0].id).toBe('entry-1');
		expect(moveEntry(w.battle, 'entry-1', -1)).toBe(w.battle);
	});
	it('cleans visual references on entry removal but retains the disc', () => {
		const w = createSampleWorkspace();
		w.battleVisual.emphasizedEntryIds = ['entry-1', 'entry-2'];
		const next = removeEntry(w, 'entry-1');
		expect(next.battle.entries).toHaveLength(3);
		expect(next.discs).toHaveLength(7);
		expect(next.battleVisual).toEqual({
			highlightedEntryId: null,
			emphasizedEntryIds: ['entry-2']
		});
	});
	it('refuses to delete a disc in use; deletes unused specimens', () => {
		const w = createSampleWorkspace();
		expect(() => deleteDisc(w, w.discs[0].id)).toThrow('Remove its entries first');
		expect(deleteDisc(w, w.discs[6].id).discs).toHaveLength(6);
	});
	it('projects a manual winner independently of highlight and score', () => {
		const v = { highlightedEntryId: 'b', emphasizedEntryIds: ['a', 'c'] };
		expect(cardStateFor(v, 'a')).toEqual({ highlighted: false, emphasis: 'winner' });
		expect(cardStateFor(v, 'b')).toEqual({ highlighted: true, emphasis: 'none' });
	});
	it('treats unknown flight values as unknown, not zero', () => {
		expect(formatNumber(null)).toBe('—');
		expect(formatNumber(0)).toBe('0');
		expect(formatNumber(-1)).toBe('−1');
	});
	it('makes distinct specimen identifiers', () => {
		expect(newId('disc')).not.toBe(newId('disc'));
	});
});

describe('bounded local draft', () => {
	afterEach(() => vi.unstubAllGlobals());
	it('round-trips the complete workspace and does not retain editor-only state', () => {
		const w = createSampleWorkspace();
		expect(parseWorkspace(JSON.stringify({ ...w, selectedDiscId: 'unrelated' }))).toEqual(w);
	});
	it('accepts unknown numbers, empty shelf and no composition', () => {
		const w = createSampleWorkspace();
		w.discs = [];
		w.battle.entries = [];
		w.battleVisual = { highlightedEntryId: null, emphasizedEntryIds: [] };
		expect(parseWorkspace(JSON.stringify(w))).toEqual(w);
	});
	it('rejects malformed JSON and unsupported schema versions', () => {
		expect(() => parseWorkspace('{')).toThrow();
		expect(() =>
			parseWorkspace(JSON.stringify({ ...createSampleWorkspace(), version: 2 }))
		).toThrow('version');
	});
	it('rejects missing disc references and duplicate identifiers', () => {
		const a = createSampleWorkspace();
		a.battle.entries[0].discId = 'missing';
		expect(() => parseWorkspace(JSON.stringify(a))).toThrow('absent disc');
		const b = createSampleWorkspace();
		b.discs[1].id = b.discs[0].id;
		expect(() => parseWorkspace(JSON.stringify(b))).toThrow('duplicate disc');
		const c = createSampleWorkspace();
		c.battle.entries[1].id = c.battle.entries[0].id;
		expect(() => parseWorkspace(JSON.stringify(c))).toThrow('duplicate entry');
	});
	it('rejects dangling highlights and emphasis', () => {
		const a = createSampleWorkspace();
		a.battleVisual.highlightedEntryId = 'missing';
		expect(() => parseWorkspace(JSON.stringify(a))).toThrow('visual state');
		const b = createSampleWorkspace();
		b.battleVisual.emphasizedEntryIds = ['missing'];
		expect(() => parseWorkspace(JSON.stringify(b))).toThrow('visual state');
	});
	it('rejects unsafe image sources at the draft boundary', () => {
		for (const src of [
			'javascript:alert(1)',
			'https://example.com/pixel.png',
			'data:image/svg+xml;base64,AAAA'
		]) {
			const w = createSampleWorkspace();
			w.discs[0].image = { src, alt: 'bad' };
			expect(() => parseWorkspace(JSON.stringify(w))).toThrow('embedded');
		}
	});
	it('rejects invalid field types, score and appearance', () => {
		const w = createSampleWorkspace();
		w.battle.entries[0].score = Infinity;
		expect(() => parseWorkspace(JSON.stringify(w))).toThrow('number');
		const raw = {
			...createSampleWorkspace(),
			cardAppearance: { ...createSampleWorkspace().cardAppearance, theme: 'invented' }
		};
		expect(() => parseWorkspace(JSON.stringify(raw))).toThrow('option');
	});
	it('saves and restores through the browser storage seam', () => {
		const values = new Map();
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => values.get(k) ?? null,
			setItem: (k: string, v: string) => values.set(k, v)
		});
		expect(loadDraft()).toBeNull();
		const w = createSampleWorkspace();
		saveDraft(w);
		expect(values.has(storageKey)).toBe(true);
		expect(loadDraft()).toEqual(w);
	});
	it('surfaces storage errors instead of claiming persistence', () => {
		vi.stubGlobal('localStorage', {
			setItem: () => {
				throw new Error('Quota exceeded');
			}
		});
		expect(() => saveDraft(createSampleWorkspace())).toThrow('Quota exceeded');
	});
});
