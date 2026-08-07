/**
 * ChainSpot editor in-memory session holder (Ticket 1 route split, formerly
 * spotRoundSession.ts).
 *
 * Keeps each stage's active `ProjectEditor` alive across client-side SPA
 * navigation, so loaded images, project name, control points, undo/redo
 * history, dirty state, and the editor's transient decoded image resources
 * survive route changes. A full browser reload clears it; nothing is
 * persisted to storage, IndexedDB, or the server. Route unmounting never
 * revokes or destroys image resources still owned by a retained session.
 *
 * Keyed by stage, one independent slot per key — Annotate Round and Create
 * Graphics never share a slot. Reason: Svelte's branch-swap during
 * navigation creates the new page's mount effect before destroying the old
 * page's, so a single shared destructively-read slot would race a
 * mount-read against a destroy-write within one navigation. Two independent
 * keyed slots avoid this entirely, since each key is only ever written by
 * its own route's destroy and read by its own route's mount.
 */
import type { ProjectEditor } from './domain/editor';

export type EditorSessionKey = 'annotate-round' | 'create-graphics';

const retained = new Map<EditorSessionKey, ProjectEditor>();

/**
 * Hands the current editor to the holder for `key` (called when that stage's
 * page is about to be destroyed). Replacing the page's editor (open bundle)
 * automatically retains the replacement because retention happens at unmount
 * time.
 */
export function retainEditor(key: EditorSessionKey, editor: ProjectEditor): void {
	retained.set(key, editor);
}

/**
 * Claims the retained editor for `key`'s mounting page. Returns null on a
 * fresh visit or after a full page reload.
 */
export function takeRetainedEditor(key: EditorSessionKey): ProjectEditor | null {
	const editor = retained.get(key) ?? null;
	retained.delete(key);
	return editor;
}

/**
 * Reads a retained stage without consuming it. Auxiliary pages use this after
 * the owning page has unmounted so the owner can still `take` the same editor
 * when the user navigates back. This deliberately does not create a third
 * editor-session key or transfer ownership.
 */
export function peekRetainedEditor(key: EditorSessionKey): ProjectEditor | null {
	return retained.get(key) ?? null;
}
