/**
 * Toph core: the `Trace` interface and its production no-op singleton.
 *
 * This is the vertical slice of `samuelpmahan/toph` DESIGN.md (Part 3),
 * implemented ChainSpot-side so the P1 mask pass can be instrumented without
 * waiting on the external library. The contract mirrors the design doc:
 *
 *   - entity IDs (integers) are the spine; events are the record
 *   - gate helpers (`gte`/`lte`/`range`/`check`) RETURN the comparison so
 *     production control flow is unchanged and the value is computed once
 *   - a failed gate implies `decide{rejected, at: name}` for that entity
 *   - `NOOP` performs bare comparisons and allocates nothing; production
 *     callers that never import a recorder tree-shake all recording away
 *
 * The recorder lives in `scripts/toph/record.ts` (Node harnesses only) and
 * must never be imported from `src/`.
 */

export interface TophGeom {
	readonly x: number;
	readonly y: number;
	readonly w?: number;
	readonly h?: number;
	readonly angleDeg?: number;
}

export interface Trace {
	readonly enabled: boolean;
	/** Opens a stage invocation; returns its id. Repeated names are distinct invocations. */
	stage(name: string): number;
	/** Registers a raster asset (mask/labelmap/image); returns asset id. Data is copied by recorders. */
	raster(
		name: string,
		kind: 'image' | 'mask' | 'labelmap',
		data: Uint8Array | Uint8ClampedArray | Uint16Array,
		widthPx: number,
		heightPx: number,
		opts?: { space?: string; op?: { name: string; params: Record<string, number | string> } }
	): number;
	/** Registers an entity; optionally binds `obj` so `idOf(obj)` recovers the id later. */
	spawn(
		kind: string,
		obj?: object,
		opts?: {
			space?: string;
			geom?: TophGeom;
			region?: { asset: number; label: number };
			attrs?: Record<string, number | string | boolean>;
		}
	): number;
	/** Recovers the entity id bound at spawn/keep time; 0 when unknown or disabled. */
	idOf(obj: object): number;
	attrs(e: number, attrs: Record<string, number | string | boolean>): void;
	gte(e: number, name: string, value: number, min: number): boolean;
	lte(e: number, name: string, value: number, max: number): boolean;
	range(e: number, name: string, value: number, min: number, max: number): boolean;
	/** Free-form gate: records pass/value; returns `pass` unchanged. */
	check(e: number, name: string, pass: boolean, value?: number): boolean;
	/** Marks an entity as surviving the current stage; optionally binds its surviving form. */
	keep(e: number, obj?: object): void;
	/** Explicit rejection when not implied by a failed gate. */
	reject(e: number, at: string): void;
	/** Records a derivation from one parent to one child object (e.g. component -> emitted tee). */
	transform(parent: object, child: object, space?: string): number;
	/** Population-relative decision (consensus clustering etc.). */
	select(
		name: string,
		kept: readonly object[],
		rejected: readonly object[],
		basis?: Record<string, number | string>
	): void;
	/** Non-gate measurement attached to an entity (0 = stage-scoped). */
	measure(e: number, name: string, value: number): void;
}

const noopStage = (): number => 0;

/** Frozen production singleton: gates are bare comparisons, everything else is inert. */
export const NOOP: Trace = Object.freeze({
	enabled: false,
	stage: noopStage,
	raster: () => 0,
	spawn: () => 0,
	idOf: () => 0,
	attrs: () => undefined,
	gte: (_e: number, _n: string, value: number, min: number) => value >= min,
	lte: (_e: number, _n: string, value: number, max: number) => value <= max,
	range: (_e: number, _n: string, value: number, min: number, max: number) =>
		value >= min && value <= max,
	check: (_e: number, _n: string, pass: boolean) => pass,
	keep: () => undefined,
	reject: () => undefined,
	transform: () => 0,
	select: () => undefined,
	measure: () => undefined
});
