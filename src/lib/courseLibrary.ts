/**
 * ChainSpot local course library (Course Memory, stages 4-5).
 *
 * The first persistent concept of *a course* independent of any one round or
 * project file. Recognition (`courseSignature.ts`'s `matchSignatures`) is
 * just its first consumer. Nothing like this exists yet in ChainSpot:
 * `persistence.ts`'s own header comment explicitly scopes out IndexedDB,
 * autosave, and a recent-projects list as never-built — this module fills
 * exactly that gap, and only that gap.
 *
 * Storage boundary: a narrow injectable `CourseLibraryStore` interface (get
 * all / put / delete over one object store), the same "inject a narrow
 * functional boundary, not the raw browser API" convention already used by
 * `HashBytes` and `DecodeImageFile`. `IndexedDbCourseLibraryStore` is the
 * only real implementation — one IndexedDB database, one object store,
 * keyPath `id`, no index. A personal local library is realistically dozens
 * of entries, so `getAll()` plus client-side filtering (in `courseSignature`'s
 * matcher) is enough; no generic ORM, query builder, or migration framework.
 * Tests inject a trivial in-memory fake instead of emulating real IndexedDB.
 *
 * Deliberately out of scope for this module: cross-device sync and an
 * eviction/quota policy. Both are known future gaps, not silent omissions.
 *
 * Scoping decision — no `shots` on a `CourseLibraryHole`: shots are one
 * round's ball landings, not course geometry. Pre-filling a brand-new round
 * with a previous round's throws would misrepresent that round rather than
 * help annotate it, so `tee`/`basket`/`corridorBends`/`corridorWidthPx` are
 * the only geometry carried forward.
 */
import { sha256Hex } from './imageIntake';
import type { HashBytes, Sha256Hex } from './imageIntake';
import { applyTransform, transformPoints } from './alignment/transform';
import { computeSignatureDescriptor, hashSignatureDescriptor, matchSignatures } from './courseSignature';
import type { CourseSignatureInput, LabeledPoint, SignatureMatchResult } from './courseSignature';
import type { AnnotatedHole, HoleNumberBadgeAnchor, SourcePoint } from './domain/project';

export interface CourseLibraryHole {
	readonly number: number;
	readonly tee?: SourcePoint;
	readonly basket?: SourcePoint;
	readonly corridorBends: readonly SourcePoint[];
	readonly corridorWidthPx: number;
}

/** Adapts persisted badge anchors (`number`) to `courseSignature.ts`'s labeled-point shape (`holeNumber`). */
export function badgesToLabeledPoints(badges: readonly HoleNumberBadgeAnchor[]): LabeledPoint[] {
	return badges.map((badge) => ({ holeNumber: badge.number, xPx: badge.xPx, yPx: badge.yPx }));
}

/** Projects durable `AnnotatedHole` geometry into the minimal library shape: no `id`, no `shots`. */
export function toLibraryHoles(holes: readonly AnnotatedHole[]): CourseLibraryHole[] {
	return holes.map((hole) => ({
		number: hole.number,
		...(hole.tee ? { tee: hole.tee } : {}),
		...(hole.basket ? { basket: hole.basket } : {}),
		corridorBends: hole.corridorBends,
		corridorWidthPx: hole.corridorWidthPx
	}));
}

/**
 * Derives labeled basket points from durable holes, for a save path that has
 * no separate CV-detected basket list of its own (Create Graphics reopening
 * and resaving a bundle, rather than Annotate Round's fresh detection run).
 */
export function basketsFromHoles(holes: readonly AnnotatedHole[]): LabeledPoint[] {
	return holes
		.filter((hole): hole is AnnotatedHole & { basket: SourcePoint } => hole.basket !== undefined)
		.map((hole) => ({ holeNumber: hole.number, xPx: hole.basket.xPx, yPx: hole.basket.yPx }));
}

export interface CourseLibraryEntry {
	readonly id: string;
	/** Display-only; the project name at the time of the save that produced this entry. */
	readonly name: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	/** Null when the source project had too few badges for a valid signature (see `computeSignatureDescriptor`). */
	readonly signatureHash: Sha256Hex | null;
	readonly badges: readonly LabeledPoint[];
	readonly baskets: readonly LabeledPoint[];
	readonly holes: readonly CourseLibraryHole[];
}

export interface CourseLibraryStore {
	getAll(): Promise<readonly CourseLibraryEntry[]>;
	put(entry: CourseLibraryEntry): Promise<void>;
	delete(id: string): Promise<void>;
}

export const COURSE_LIBRARY_DB_NAME = 'chainspot-course-library';
export const COURSE_LIBRARY_DB_VERSION = 1;
export const COURSE_LIBRARY_STORE_NAME = 'courses';

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
	});
}

function promisifyTransaction(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
		transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
	});
}

/** The one real `CourseLibraryStore`: one IndexedDB database, one object store, no index. */
export class IndexedDbCourseLibraryStore implements CourseLibraryStore {
	readonly #factory: IDBFactory;

	constructor(factory: IDBFactory = globalThis.indexedDB) {
		this.#factory = factory;
	}

	#open(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = this.#factory.open(COURSE_LIBRARY_DB_NAME, COURSE_LIBRARY_DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(COURSE_LIBRARY_STORE_NAME)) {
					db.createObjectStore(COURSE_LIBRARY_STORE_NAME, { keyPath: 'id' });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('failed to open the course library database'));
		});
	}

	async getAll(): Promise<readonly CourseLibraryEntry[]> {
		const db = await this.#open();
		try {
			const store = db.transaction(COURSE_LIBRARY_STORE_NAME, 'readonly').objectStore(COURSE_LIBRARY_STORE_NAME);
			return await promisifyRequest(store.getAll());
		} finally {
			db.close();
		}
	}

	async put(entry: CourseLibraryEntry): Promise<void> {
		const db = await this.#open();
		try {
			const transaction = db.transaction(COURSE_LIBRARY_STORE_NAME, 'readwrite');
			transaction.objectStore(COURSE_LIBRARY_STORE_NAME).put(entry);
			await promisifyTransaction(transaction);
		} finally {
			db.close();
		}
	}

	async delete(id: string): Promise<void> {
		const db = await this.#open();
		try {
			const transaction = db.transaction(COURSE_LIBRARY_STORE_NAME, 'readwrite');
			transaction.objectStore(COURSE_LIBRARY_STORE_NAME).delete(id);
			await promisifyTransaction(transaction);
		} finally {
			db.close();
		}
	}
}

let defaultStore: CourseLibraryStore | null = null;

/**
 * One shared `IndexedDbCourseLibraryStore` for the whole app, constructed
 * lazily on first use — mirroring `smartStitchWorker`'s singleton pattern in
 * `stitch/smartImport.ts`. Safe to call during prerendering: the constructor
 * only stores the `IDBFactory` reference, so it never touches IndexedDB
 * itself; only `getAll`/`put`/`delete` do, and routes only call those from
 * interactive, browser-only actions.
 */
export function getDefaultCourseLibraryStore(): CourseLibraryStore {
	defaultStore ??= new IndexedDbCourseLibraryStore();
	return defaultStore;
}

export interface UpsertCourseInput {
	readonly projectName: string;
	readonly numberBadges: readonly LabeledPoint[];
	readonly baskets: readonly LabeledPoint[];
	readonly holes: readonly CourseLibraryHole[];
}

export interface UpsertCourseOptions {
	readonly hash?: HashBytes;
	readonly createId?: () => string;
	readonly now?: () => Date;
}

async function findMatchingEntry(
	store: CourseLibraryStore,
	target: CourseSignatureInput,
	signatureHash: Sha256Hex
): Promise<CourseLibraryEntry | null> {
	const exact = await findExactMatches(store, signatureHash);
	if (exact.length > 0) return exact[0];
	const fuzzy = await findFuzzyMatches(store, target);
	return fuzzy.length > 0 ? fuzzy[0].entry : null;
}

function sourcePointsEqual(a: SourcePoint | undefined, b: SourcePoint | undefined): boolean {
	if (!a || !b) return a === b;
	return a.xPx === b.xPx && a.yPx === b.yPx;
}

function sourcePointArraysEqual(a: readonly SourcePoint[], b: readonly SourcePoint[]): boolean {
	return a.length === b.length && a.every((point, index) => sourcePointsEqual(point, b[index]));
}

function labeledPointsEqual(a: readonly LabeledPoint[], b: readonly LabeledPoint[]): boolean {
	return (
		a.length === b.length &&
		a.every(
			(point, index) =>
				point.holeNumber === b[index].holeNumber && point.xPx === b[index].xPx && point.yPx === b[index].yPx
		)
	);
}

/** Hole-number-keyed comparison so reordering never counts as a change. */
function libraryHolesEqual(a: readonly CourseLibraryHole[], b: readonly CourseLibraryHole[]): boolean {
	if (a.length !== b.length) return false;
	const byNumber = new Map(b.map((hole) => [hole.number, hole]));
	return a.every((hole) => {
		const other = byNumber.get(hole.number);
		return (
			other !== undefined &&
			sourcePointsEqual(hole.tee, other.tee) &&
			sourcePointsEqual(hole.basket, other.basket) &&
			sourcePointArraysEqual(hole.corridorBends, other.corridorBends) &&
			hole.corridorWidthPx === other.corridorWidthPx
		);
	});
}

/** Whether `input` would leave `entry`'s stored geometry (badges/baskets/hole tee-basket-bends-width) byte-for-byte the same. */
function isGeometryUnchanged(entry: CourseLibraryEntry, input: UpsertCourseInput): boolean {
	return (
		labeledPointsEqual(entry.badges, input.numberBadges) &&
		labeledPointsEqual(entry.baskets, input.baskets) &&
		libraryHolesEqual(entry.holes, input.holes)
	);
}

export type UpsertCoursePreview =
	| { readonly kind: 'new' }
	| { readonly kind: 'identical'; readonly entry: CourseLibraryEntry }
	| { readonly kind: 'update'; readonly entry: CourseLibraryEntry };

/**
 * Read-only counterpart to `upsertCourse`: reports what an upsert of `input`
 * WOULD do — insert a fresh entry, no-op against an already-matching entry,
 * or overwrite a matched entry's stored geometry — without writing anything.
 * Shares `findMatchingEntry`'s exact-hash-then-fuzzy matching so the two
 * functions can never disagree on which entry an upsert would touch. A
 * `descriptor` failure (too few badges) mirrors `upsertCourse`'s own no-op:
 * reported as `'new'` since the caller's subsequent upsert attempt will
 * itself write nothing.
 */
export async function previewUpsertCourse(
	store: CourseLibraryStore,
	input: UpsertCourseInput,
	options: Pick<UpsertCourseOptions, 'hash'> = {}
): Promise<UpsertCoursePreview> {
	const { hash = sha256Hex } = options;
	const target: CourseSignatureInput = { badges: input.numberBadges, baskets: input.baskets };
	const descriptor = computeSignatureDescriptor(target);
	if (!descriptor.ok) return { kind: 'new' };
	const signatureHash = await hashSignatureDescriptor(descriptor, hash);

	const existing = await findMatchingEntry(store, target, signatureHash);
	if (!existing) return { kind: 'new' };
	return isGeometryUnchanged(existing, input) ? { kind: 'identical', entry: existing } : { kind: 'update', entry: existing };
}

/**
 * Computes the new signature, then updates the closest existing entry in
 * place (dedup: same physical course re-saved after further annotation)
 * or inserts a fresh one. Returns null without writing anything when the
 * input has too few badges for a valid signature (`computeSignatureDescriptor`
 * failure) — there would be nothing reliable to store or ever match against.
 */
export async function upsertCourse(
	store: CourseLibraryStore,
	input: UpsertCourseInput,
	options: UpsertCourseOptions = {}
): Promise<CourseLibraryEntry | null> {
	const { hash = sha256Hex, createId = () => globalThis.crypto.randomUUID(), now = () => new Date() } = options;
	const target: CourseSignatureInput = { badges: input.numberBadges, baskets: input.baskets };
	const descriptor = computeSignatureDescriptor(target);
	if (!descriptor.ok) return null;
	const signatureHash = await hashSignatureDescriptor(descriptor, hash);

	const existing = await findMatchingEntry(store, target, signatureHash);
	const timestamp = now().toISOString();
	const entry: CourseLibraryEntry = {
		id: existing?.id ?? createId(),
		name: input.projectName,
		createdAt: existing?.createdAt ?? timestamp,
		updatedAt: timestamp,
		signatureHash,
		badges: input.numberBadges,
		baskets: input.baskets,
		holes: input.holes
	};
	await store.put(entry);
	return entry;
}

export async function findExactMatches(
	store: CourseLibraryStore,
	hash: Sha256Hex
): Promise<readonly CourseLibraryEntry[]> {
	const all = await store.getAll();
	return all.filter((entry) => entry.signatureHash === hash);
}

/** Matched entries only, sorted by descending confidence. */
export async function findFuzzyMatches(
	store: CourseLibraryStore,
	target: CourseSignatureInput
): Promise<readonly (SignatureMatchResult & { entry: CourseLibraryEntry })[]> {
	const all = await store.getAll();
	return all
		.map((entry) => ({ entry, ...matchSignatures({ badges: entry.badges, baskets: entry.baskets }, target) }))
		.filter((result) => result.matched)
		.sort((a, b) => b.confidence - a.confidence);
}

export interface ApplyLibraryEntryOptions {
	/** Protects an already-populated field on an existing hole from being overwritten. Off by default: an explicit Import reapplies fully. */
	readonly skipExisting?: boolean;
}

/**
 * Transforms a matched library entry's course geometry into the current
 * image's pixel space and merges it into `currentHoles` by hole number,
 * mirroring the merge shape `applyReadyCourseHoles` already uses for CV
 * proposals in Annotate Round (same per-field `skipExisting` protection,
 * library-sourced instead of detection-sourced). `match` must be a confident
 * match (`matched: true`, non-null `transform`); an unmatched result is
 * returned as a no-op copy of `currentHoles` rather than silently applying
 * nothing useful.
 */
export function applyLibraryEntry(
	entry: CourseLibraryEntry,
	match: SignatureMatchResult,
	currentHoles: readonly AnnotatedHole[],
	options: ApplyLibraryEntryOptions = {}
): AnnotatedHole[] {
	if (!match.matched || !match.transform) return [...currentHoles];
	const transform = match.transform;
	// A similarity fit's two axis scales are equal; affine's may differ, so a
	// single scalar corridor width uses their mean rather than picking one.
	const widthScale = (transform.majorAxisScale + transform.minorAxisScale) / 2;

	const existingByNumber = new Map(currentHoles.map((hole) => [hole.number, hole]));
	for (const libraryHole of entry.holes) {
		const existing = existingByNumber.get(libraryHole.number);
		const keepTee = Boolean(options.skipExisting && existing?.tee);
		const keepBasket = Boolean(options.skipExisting && existing?.basket);
		const keepCorridor = Boolean(options.skipExisting && existing && existing.corridorBends.length > 0);

		const transformedTee = libraryHole.tee ? applyTransform(libraryHole.tee, transform) : undefined;
		const transformedBasket = libraryHole.basket ? applyTransform(libraryHole.basket, transform) : undefined;
		const transformedBends = transformPoints(libraryHole.corridorBends, transform);
		const transformedWidth = libraryHole.corridorWidthPx * widthScale;

		const base = existing ?? {
			id: globalThis.crypto.randomUUID(),
			number: libraryHole.number,
			shots: []
		};

		const next: AnnotatedHole = {
			...base,
			...(keepTee ? {} : transformedTee ? { tee: transformedTee } : {}),
			...(keepBasket ? {} : transformedBasket ? { basket: transformedBasket } : {}),
			corridorBends: keepCorridor ? (existing as AnnotatedHole).corridorBends : transformedBends,
			corridorWidthPx: keepCorridor ? (existing as AnnotatedHole).corridorWidthPx : transformedWidth
		};
		existingByNumber.set(libraryHole.number, next);
	}
	return [...existingByNumber.values()].sort((a, b) => a.number - b.number);
}
