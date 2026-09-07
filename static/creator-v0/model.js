// @ts-check
/** @typedef {import('./types').Disc} Disc */
/** @typedef {import('./types').Workspace} Workspace */
export const MAX_ENTRIES = 4;
export const MAX_DISCS = 200;
export const MAX_BACKUP_BYTES = 40 * 1024 * 1024;
/** randomUUID is secure-context-only; getRandomValues also supports local preview contexts. */
export const uid = () => {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};

/** @returns {Workspace} */
export function createWorkspace() {
  // Illustrative physical instances, NOT photos of a creator's actual discs.
  // Mold numbers were checked against Discraft's official pages; see README.
  const samples = [
    ['buzzz-mint', 'Buzzz', 'Mint practice disc', 'ESP', '177 g', [5, 4, -1, 1], 158],
    ['zone-peach', 'Zone', 'Peach approach disc', 'Z', '173 g', [4, 3, 0, 3], 24],
    ['athena-lilac', 'Athena', 'Lilac fairway disc', 'ESP', '174 g', [7, 5, 0, 2], 262],
    ['luna-sky', 'Luna', 'Blue putting disc', 'Jawbreaker', '174 g', [3, 3, 0, 3], 202],
    ['buzzz-rose', 'Buzzz', 'Pink backup disc', 'Z', '176 g', [5, 4, -1, 1], 337]
  ];
  const discs = samples.map(([id, mold, label, plastic, weight, flight, hue]) => ({
    id: String(id), facts: { manufacturer: 'Discraft', mold: String(mold),
      flight: /** @type {[number,number,number,number]} */ (flight) },
    label: String(label), plastic: String(plastic), weight: String(weight),
    photo: { kind: /** @type {const} */ ('sample'), hue: Number(hue) }
  }));
  return {
    schemaVersion: 1, discs, card: { discId: discs[0].id },
    battle: { id: 'first-battle', title: 'The new-disc lineup',
      entries: discs.slice(0, 3).map((d, i) => ({ id: `entry-${i}`, discId: d.id, score: '' })),
      highlightedEntryId: null, winnerEntryId: null },
    presentation: { mode: 'battle', theme: 'dark', anchor: 'bottom-left', scale: 1,
      cardLayout: 'wide', battleLayout: 'row', showInstanceLabel: true, showFlightNumbers: true }
  };
}

/** @param {Workspace} w @param {string} id */
export const findDisc = (w, id) => w.discs.find(d => d.id === id);

/** @param {Workspace} w @param {string} discId @param {string} [entryId] */
export function addEntry(w, discId, entryId = uid()) {
  if (!findDisc(w, discId)) throw new Error('Choose an existing disc.');
  if (w.battle.entries.length >= MAX_ENTRIES) throw new Error('This v0.0 canvas fits up to four cards. Remove one to try a different disc.');
  if (w.battle.entries.some(e => e.id === entryId)) throw new Error('Entry identity already exists.');
  const entry = { id: entryId, discId, score: '' };
  w.battle.entries.push(entry);
  return entry;
}
/** @param {Workspace} w @param {string} entryId */
export function removeEntry(w, entryId) {
  w.battle.entries = w.battle.entries.filter(e => e.id !== entryId);
  if (w.battle.highlightedEntryId === entryId) w.battle.highlightedEntryId = null;
  if (w.battle.winnerEntryId === entryId) w.battle.winnerEntryId = null;
}
/** @param {Workspace} w @param {string} discId */
export function removeDisc(w, discId) {
  for (const entry of [...w.battle.entries]) if (entry.discId === discId) removeEntry(w, entry.id);
  w.discs = w.discs.filter(d => d.id !== discId);
  if (w.card.discId === discId) w.card.discId = w.discs[0]?.id ?? null;
}
/** Copy facts, not identity or the photograph of a different physical object. @param {Disc} d */
export function anotherDisc(d) {
  return { ...structuredClone(d), id: uid(), label: '', photo: null };
}
/** @param {Workspace} w @param {string} id @param {number} delta */
export function moveEntry(w, id, delta) {
  const a = w.battle.entries;
  const i = a.findIndex(e => e.id === id), j = i + delta;
  if (i >= 0 && j >= 0 && j < a.length) [a[i], a[j]] = [a[j], a[i]];
}

/** Validate BEFORE replacing a local collection. Unknown/newer versions never get overwritten.
 * @param {unknown} input @returns {Workspace}
 */
export function validateWorkspace(input) {
  const fail = (/** @type {string} */ s) => { throw new Error(`Cannot open this collection: ${s}`); };
  const obj = (/** @type {any} */ o) => o !== null && typeof o === 'object' && !Array.isArray(o);
  const str = (/** @type {any} */ s, /** @type {number} */ max, empty = true) =>
    typeof s === 'string' && s.length <= max && (empty || s.trim().length > 0);
  const finite = (/** @type {any} */ n) => typeof n === 'number' && Number.isFinite(n);
  const w = /** @type {Workspace} */ (input);
  if (!obj(w) || w.schemaVersion !== 1) fail('unsupported schema version (expected 1).');
  if (!Array.isArray(w.discs) || w.discs.length > MAX_DISCS) fail('invalid disc collection.');
  const ids = new Set();
  for (const d of w.discs) {
    if (!obj(d) || !str(d.id, 100, false) || ids.has(d.id)) fail('duplicate or missing disc identity.');
    ids.add(d.id);
    if (!obj(d.facts) || !str(d.facts.manufacturer, 80, false) || !str(d.facts.mold, 80, false)) fail('manufacturer and mold are required.');
    if (!Array.isArray(d.facts.flight) || d.facts.flight.length !== 4 || !d.facts.flight.every(finite)) fail('four finite flight numbers are required.');
    if (!str(d.label, 80) || !str(d.plastic, 60) || !str(d.weight, 30)) fail('invalid disc details.');
    if (d.photo !== null) {
      if (!obj(d.photo)) fail('invalid photo.');
      if (d.photo.kind === 'sample') {
        if (!finite(d.photo.hue) || d.photo.hue < 0 || d.photo.hue > 360) fail('invalid sample artwork.');
      } else if (d.photo.kind === 'upload') {
        const p = d.photo;
        if (!str(p.dataUrl, 8 * 1024 * 1024, false) || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(p.dataUrl)) fail('photos must be embedded PNG, JPEG or WebP images.');
        if (!str(p.fileName, 256) || !finite(p.width) || !finite(p.height) || p.width <= 0 || p.height <= 0 || p.width > 1400 || p.height > 1400) fail('invalid photo dimensions.');
      } else fail('unsupported photo type.');
    }
  }
  if (!obj(w.card) || !(w.card.discId === null || ids.has(w.card.discId))) fail('card refers to a missing disc.');
  const b = w.battle;
  if (!obj(b) || !str(b.id, 100, false) || !str(b.title, 100) || !Array.isArray(b.entries) || b.entries.length > MAX_ENTRIES) fail('invalid battle composition.');
  const entryIds = new Set();
  for (const e of b.entries) {
    if (!obj(e) || !str(e.id, 100, false) || entryIds.has(e.id) || !ids.has(e.discId) || !str(e.score, 12)) fail('invalid battle entry.');
    entryIds.add(e.id);
  }
  if (![b.highlightedEntryId, b.winnerEntryId].every(id => id === null || entryIds.has(id))) fail('emphasis refers to a missing entry.');
  const p = w.presentation;
  if (!obj(p) || !['card', 'battle'].includes(p.mode) || !['dark', 'light'].includes(p.theme) ||
    !['bottom-left', 'bottom-right', 'top-left', 'top-right', 'center'].includes(p.anchor) ||
    !finite(p.scale) || p.scale < .5 || p.scale > 1.5 || !['wide', 'portrait'].includes(p.cardLayout) ||
    !['row', 'stack'].includes(p.battleLayout) || typeof p.showInstanceLabel !== 'boolean' || typeof p.showFlightNumbers !== 'boolean') fail('invalid presentation settings.');
  // Strip unknown keys, including prototype-looking properties. No raw imported HTML is rendered.
  return { schemaVersion: 1, discs: w.discs.map(d => ({id: d.id,
    facts: {manufacturer: d.facts.manufacturer, mold: d.facts.mold, flight: [...d.facts.flight]},
    label: d.label, plastic: d.plastic, weight: d.weight,
    photo: d.photo?.kind === 'upload' ? { kind: 'upload', dataUrl: d.photo.dataUrl, fileName: d.photo.fileName, width: d.photo.width, height: d.photo.height }
      : d.photo?.kind === 'sample' ? {kind: 'sample', hue: d.photo.hue} : null })),
    card: {discId: w.card.discId}, battle: {id: b.id, title: b.title,
      entries: b.entries.map(e => ({id: e.id, discId: e.discId, score: e.score})),
      highlightedEntryId: b.highlightedEntryId, winnerEntryId: b.winnerEntryId},
    presentation: { mode: p.mode, theme: p.theme, anchor: p.anchor, scale: p.scale,
      cardLayout: p.cardLayout, battleLayout: p.battleLayout,
      showInstanceLabel: p.showInstanceLabel, showFlightNumbers: p.showFlightNumbers } };
}
