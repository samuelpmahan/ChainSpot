import type { PxC } from './board';

/**
 * A root mounted above an ordinary PxC. The root is intentionally external
 * to PxC's semantic address space: values remain px.* and calculations remain
 * fn.* inside every mounted world.
 */
export type PxCRootId = string;

export interface PxCRootMounts {
	/** Mount one already-materialized world beneath a root id (currently ImgID). */
	mount(root: PxCRootId, pxc: PxC): void;
	/** True when the root has a warm PxC mounted. */
	has(root: PxCRootId): boolean;
	/** Return the exact PxC mounted at root; no address rewriting occurs. */
	get(root: PxCRootId): PxC;
	/** Stable insertion-order roots for wide/grouped projection. */
	roots(): readonly PxCRootId[];
	/** Stable insertion-order mounted worlds for cross-root queries. */
	entries(): readonly (readonly [PxCRootId, PxC])[];
	/** Make a cheap root-level slice; mounted PxCs themselves are shared. */
	slice(roots: readonly PxCRootId[]): PxCRootMounts;
}

export function createPxCRootMounts(): PxCRootMounts {
	const worlds = new Map<PxCRootId, PxC>();

	const api: PxCRootMounts = {
		mount(root, pxc) {
			if (!root) throw new Error('PxC mounts: root id must be non-empty.');
			const current = worlds.get(root);
			if (current && current !== pxc) {
				throw new Error(`PxC mounts: root '${root}' is already mounted.`);
			}
			worlds.set(root, pxc);
		},
		has: (root) => worlds.has(root),
		get(root) {
			const pxc = worlds.get(root);
			if (!pxc) throw new Error(`PxC mounts: root '${root}' is not mounted.`);
			return pxc;
		},
		roots: () => Object.freeze(Array.from(worlds.keys())),
		entries: () => Object.freeze(Array.from(worlds.entries())),
		slice(selected) {
			const sliced = createPxCRootMounts();
			for (const root of selected) sliced.mount(root, api.get(root));
			return sliced;
		}
	};

	return api;
}
