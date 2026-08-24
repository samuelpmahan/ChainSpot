// Shared plain shapes used across G0 operations. Deliberately tiny and
// dependency-free so every g0/*.ts file can import from here without
// pulling in unrelated machinery.

/** A tile's top-left corner in composite-space pixels. */
export interface Placement {
	readonly x: number;
	readonly y: number;
}
