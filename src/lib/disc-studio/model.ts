/** Product facts. A Disc identifies a specimen, NOT a globally deduplicated mold. */
export type FlightNumbers = {
	speed: number | null;
	glide: number | null;
	turn: number | null;
	fade: number | null;
};
export type Disc = {
	id: string;
	manufacturer: string;
	mold: string;
	variant: string;
	flight: FlightNumbers;
	// Actual local photo of this specimen; no catalog lookup, detection or user ownership required.
	image: { src: string; alt: string } | null;
};
export type BattleEntry = { id: string; discId: string; score: number };
export type DiscBattle = { id: string; title: string; entries: BattleEntry[] };

/** Presentation is a separate input to the same renderer in the workbench, route and stories. */
export type CardAppearance = {
	layout: 'showcase' | 'compact';
	hierarchy: 'name' | 'flight';
	theme: 'ink' | 'paper';
	imageFit: 'contain' | 'cover';
	showVariant: boolean;
};
export type CardState = { highlighted: boolean; emphasis: 'none' | 'winner' };
export type BattleAppearance = { layout: 'row' | 'stack' | 'grid'; showScores: boolean };
export type BattleVisualState = { highlightedEntryId: string | null; emphasizedEntryIds: string[] };
export type Workspace = {
	version: 1;
	discs: Disc[];
	battle: DiscBattle;
	cardAppearance: CardAppearance;
	battleAppearance: BattleAppearance;
	battleVisual: BattleVisualState;
};
// Deliberately NOT part of Workspace: editor selection, preview dimensions, open panels,
// search text, the single-card specimen state, and last manual score edit.
export const flightKeys = ['speed', 'glide', 'turn', 'fade'] as const;
export const defaultAppearance: CardAppearance = {
	layout: 'showcase',
	hierarchy: 'name',
	theme: 'ink',
	imageFit: 'contain',
	showVariant: true
};
export const neutralCard: CardState = { highlighted: false, emphasis: 'none' };
export function cardStateFor(visual: BattleVisualState, entryId: string): CardState {
	return {
		highlighted: visual.highlightedEntryId === entryId,
		emphasis: visual.emphasizedEntryIds.includes(entryId) ? 'winner' : 'none'
	};
}
export function setScore(battle: DiscBattle, entryId: string, score: number): DiscBattle {
	if (!Number.isFinite(score)) throw new Error('Score must be a finite number.');
	if (!battle.entries.some((e) => e.id === entryId)) throw new Error('Entry not found.');
	return {
		...battle,
		entries: battle.entries.map((e) => (e.id === entryId ? { ...e, score } : e))
	};
}
export function removeEntry(workspace: Workspace, entryId: string): Workspace {
	return {
		...workspace,
		battle: {
			...workspace.battle,
			entries: workspace.battle.entries.filter((e) => e.id !== entryId)
		},
		battleVisual: {
			highlightedEntryId:
				workspace.battleVisual.highlightedEntryId === entryId
					? null
					: workspace.battleVisual.highlightedEntryId,
			emphasizedEntryIds: workspace.battleVisual.emphasizedEntryIds.filter((id) => id !== entryId)
		}
	};
}
export function moveEntry(battle: DiscBattle, entryId: string, offset: -1 | 1): DiscBattle {
	const index = battle.entries.findIndex((e) => e.id === entryId),
		target = index + offset;
	if (index < 0 || target < 0 || target >= battle.entries.length) return battle;
	const entries = [...battle.entries];
	[entries[index], entries[target]] = [entries[target], entries[index]];
	return { ...battle, entries };
}
export function deleteDisc(workspace: Workspace, discId: string): Workspace {
	if (workspace.battle.entries.some((e) => e.discId === discId))
		throw new Error('This disc is in the battle. Remove its entries first.');
	return { ...workspace, discs: workspace.discs.filter((d) => d.id !== discId) };
}
export function formatNumber(value: number | null): string {
	return value === null ? '—' : String(value).replace('-', '−');
}
export function newId(prefix: string): string {
	const id =
		crypto.randomUUID?.() ??
		[...crypto.getRandomValues(new Uint8Array(16))]
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
	return `${prefix}-${id}`;
}

/** Validate imports/local drafts at the boundary. Never spread untrusted input into app state. */
export function parseWorkspace(raw: string): Workspace {
	if (raw.length > 4_500_000) throw new Error('Draft is too large (maximum 4.5 MB).');
	const x = JSON.parse(raw);
	const fail = (message: string): never => {
		throw new Error(`Invalid draft: ${message}`);
	};
	const text = (v: unknown, name: string, max = 200): string => {
		if (typeof v !== 'string' || v.length > max) return fail(name);
		return v;
	};
	const id = (v: unknown): string => {
		const s = text(v, 'identifier');
		if (!s.trim()) return fail('empty identifier');
		return s;
	};
	const number = (v: unknown): number => {
		if (typeof v !== 'number' || !Number.isFinite(v)) return fail('number');
		return v;
	};
	const bool = (v: unknown): boolean => {
		if (typeof v !== 'boolean') return fail('boolean');
		return v;
	};
	const choice = <T extends string>(v: unknown, options: readonly T[]): T => {
		if (typeof v !== 'string' || !options.includes(v as T)) return fail('presentation option');
		return v as T;
	};
	if (!x || x.version !== 1 || !Array.isArray(x.discs) || !Array.isArray(x.battle?.entries))
		return fail('version or shape');
	if (x.discs.length > 100 || x.battle.entries.length > 4)
		return fail('this probe supports up to 100 discs and 4 entries');
	const discs: Disc[] = x.discs.map((d: any) => {
		if (!d || !d.flight) return fail('disc');
		const flight = Object.fromEntries(
			flightKeys.map((k) => [k, d.flight[k] === null ? null : number(d.flight[k])])
		) as FlightNumbers;
		let image: Disc['image'] = null;
		if (d.image !== null) {
			const src = text(d.image?.src, 'photo', 850_000);
			if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(src))
				return fail('photo must be an embedded PNG, JPEG or WebP');
			image = { src, alt: text(d.image.alt, 'photo description') };
		}
		return {
			id: id(d.id),
			manufacturer: text(d.manufacturer, 'manufacturer'),
			mold: text(d.mold, 'mold'),
			variant: text(d.variant, 'variant'),
			flight,
			image
		};
	});
	const discIds = new Set(discs.map((d) => d.id));
	if (discIds.size !== discs.length) return fail('duplicate disc identifiers');
	const entries: BattleEntry[] = x.battle.entries.map((e: any) => {
		if (!e || !discIds.has(e.discId)) return fail('entry references an absent disc');
		return { id: id(e.id), discId: id(e.discId), score: number(e.score) };
	});
	const entryIds = new Set(entries.map((e) => e.id));
	if (entryIds.size !== entries.length) return fail('duplicate entry identifiers');
	const v = x.battleVisual;
	if (
		!v ||
		!(v.highlightedEntryId === null || entryIds.has(v.highlightedEntryId)) ||
		!Array.isArray(v.emphasizedEntryIds) ||
		v.emphasizedEntryIds.some((i: unknown) => !entryIds.has(i as string)) ||
		new Set(v.emphasizedEntryIds).size !== v.emphasizedEntryIds.length
	)
		return fail('visual state references');
	const a = x.cardAppearance,
		b = x.battleAppearance;
	if (!a || !b) return fail('appearance');
	return {
		version: 1,
		discs,
		battle: { id: id(x.battle.id), title: text(x.battle.title, 'title'), entries },
		cardAppearance: {
			layout: choice(a.layout, ['showcase', 'compact']),
			hierarchy: choice(a.hierarchy, ['name', 'flight']),
			theme: choice(a.theme, ['ink', 'paper']),
			imageFit: choice(a.imageFit, ['contain', 'cover']),
			showVariant: bool(a.showVariant)
		},
		battleAppearance: {
			layout: choice(b.layout, ['row', 'stack', 'grid']),
			showScores: bool(b.showScores)
		},
		battleVisual: {
			highlightedEntryId: v.highlightedEntryId,
			emphasizedEntryIds: [...v.emphasizedEntryIds]
		}
	};
}
