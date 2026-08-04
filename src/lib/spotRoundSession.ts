/**
 * ChainSpot Spot Round in-memory session holder (P05-002 review).
 *
 * Keeps the active `ProjectEditor` alive across client-side SPA navigation
 * between /spot-round and /stitch-map, so loaded images, project name, control
 * points, undo/redo history, dirty state, and the editor's transient decoded
 * image resources survive route changes. A full browser reload clears it; nothing
 * is persisted to storage, IndexedDB, or the server. Route unmounting never
 * revokes or destroys image resources still owned by the retained session.
 */
import type { ProjectEditor } from './domain/editor';

let retained: ProjectEditor | null = null;

/**
 * Hands the current editor to the holder (called when the Spot Round page is
 * about to be destroyed). Replacing the page's editor (open bundle) automatically
 * retains the replacement because retention happens at unmount time.
 */
export function retainEditor(editor: ProjectEditor): void {
	retained = editor;
}

/**
 * Claims the retained editor for a mounting Spot Round page. Returns null on a
 * fresh visit or after a full page reload.
 */
export function takeRetainedEditor(): ProjectEditor | null {
	const editor = retained;
	retained = null;
	return editor;
}
