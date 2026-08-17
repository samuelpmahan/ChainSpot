/**
 * Annotate Course correction log (design: `docs/annotate-round-correction-log.md`).
 *
 * Records every confirm/move/replace/place/skip interaction a user makes
 * against a CV proposal in Annotate Course, so ordinary usage becomes
 * reusable truth data over time instead of requiring a separate hand-
 * labeling effort. Entirely local (IndexedDB) and kept out of
 * `project.json`/the `.chainspot.zip` bundle.
 */
import type { CourseGrammarFailureKind, CourseGrammarResult } from './autoAnnotation/courseGrammar';

export type CorrectionEndpoint = 'tee' | 'basket';

export type CorrectionDetector =
	| 'grayt-stage2'
	| 'courseGrammar-hungarian'
	| 'pancake-p5'
	| 'pancake-p6'
	| 'tee-bootstrap'
	| 'number-badge'
	| 'none';

export type CorrectionGateDecision = 'auto-accepted' | 'flagged-for-review' | 'no-candidate';

export interface CorrectionStageScore {
	readonly name: string;
	readonly value: number;
	readonly higherIsBetter?: boolean;
}

export interface CorrectionPriorProposal {
	readonly xPx: number;
	readonly yPx: number;
	/**
	 * Real normalized 0..1 source confidence only. Optional because current
	 * Pancake P5/P6 do not produce one; their named native score is stored in
	 * `score` instead of copying the UI eligibility sentinel here.
	 */
	readonly confidence?: number;
	/** Exact native stage score when confidence is unavailable/non-comparable. */
	readonly score?: CorrectionStageScore;
	readonly detector: CorrectionDetector;
	readonly gateDecision: CorrectionGateDecision;
	/** Only present when `gateDecision !== 'auto-accepted'`. */
	readonly reason?: CourseGrammarFailureKind | 'below-gate-threshold';
}

export type CorrectionUserAction = 'confirm' | 'move' | 'replace' | 'place' | 'skip';

export interface CorrectionEvent {
	readonly schemaVersion: 1;
	readonly eventId: string;
	readonly timestamp: string;
	readonly appVersion: string;

	readonly projectId: string;
	readonly imageId: string;
	/** Denormalized from `ImageAsset.sha256` — null only when the source image hasn't finished hashing yet. */
	readonly imageSha256: string | null;

	readonly holeNumber: number;
	readonly endpoint: CorrectionEndpoint;

	/** Null only for a hole/endpoint the system never proposed anything for at all. */
	readonly priorProposal: CorrectionPriorProposal | null;

	readonly userAction: CorrectionUserAction;
	/** Null iff `userAction === 'skip'`. */
	readonly finalValue: { readonly xPx: number; readonly yPx: number } | null;

	readonly interactionMeta?: {
		readonly zoomLevelAtInteraction?: number;
		/** 0 for `confirm`; larger for `replace`/`move`. */
		readonly dragDistancePx?: number;
		/**
		 * The user's raw drop coordinate, present when snap-to-detection
		 * (`applyLocalSnap`) settled the marker somewhere else afterward — in
		 * that case `finalValue` is the post-snap coordinate.
		 */
		readonly rawDropPx?: { readonly xPx: number; readonly yPx: number };
	};
}

const WEAK_OR_AMBIGUOUS_KINDS: readonly CourseGrammarFailureKind[] = [
	'weak-tee-confidence',
	'weak-basket-confidence',
	'ambiguous-tee',
	'ambiguous-basket',
	'basket-polarity-conflict'
];

interface RuntimeProposalMetadata {
	readonly confidenceSemantics?: 'ui-eligibility-sentinel';
	readonly selectionScore?: CorrectionStageScore;
}

/**
 * Maps the live grammar output to correction provenance. Legacy grammar keeps
 * its real normalized detector confidence. Pancake's display adapter carries
 * an explicit `confidenceSemantics=ui-eligibility-sentinel`; in that case the
 * sentinel is deliberately NOT persisted as confidence and the real P5/P6
 * native score is stored with its name/direction instead.
 */
export function deriveProposalFromGrammar(
	grammar: CourseGrammarResult | null,
	holeNumber: number,
	endpoint: CorrectionEndpoint
): CorrectionPriorProposal | null {
	const hole = grammar?.holes.find((candidate) => candidate.number === holeNumber);
	const assignment = endpoint === 'tee' ? hole?.tee : hole?.basket;
	if (!hole || !assignment) return null;
	const metadata = assignment as typeof assignment & RuntimeProposalMetadata;
	const pancake = metadata.confidenceSemantics === 'ui-eligibility-sentinel';
	const failure = hole.failures.find(
		(candidate) => candidate.candidateKind === endpoint && WEAK_OR_AMBIGUOUS_KINDS.includes(candidate.kind)
	);
	return {
		xPx: assignment.xPx,
		yPx: assignment.yPx,
		...(pancake ? {} : { confidence: assignment.detectorConfidence }),
		...(metadata.selectionScore ? { score: metadata.selectionScore } : {}),
		detector: pancake ? (endpoint === 'tee' ? 'pancake-p5' : 'pancake-p6') : 'courseGrammar-hungarian',
		gateDecision: failure ? 'flagged-for-review' : 'auto-accepted',
		...(failure ? { reason: failure.kind } : {})
	};
}

export interface BuildCorrectionEventInput {
	readonly appVersion: string;
	readonly projectId: string;
	readonly imageId: string;
	readonly imageSha256: string | null;
	readonly holeNumber: number;
	readonly endpoint: CorrectionEndpoint;
	readonly priorProposal: CorrectionPriorProposal | null;
	readonly userAction: CorrectionUserAction;
	readonly finalValue: { readonly xPx: number; readonly yPx: number } | null;
	readonly interactionMeta?: CorrectionEvent['interactionMeta'];
}

export interface BuildCorrectionEventOptions {
	readonly createId?: () => string;
	readonly now?: () => Date;
}

export function buildCorrectionEvent(
	input: BuildCorrectionEventInput,
	options: BuildCorrectionEventOptions = {}
): CorrectionEvent {
	const { createId = () => globalThis.crypto.randomUUID(), now = () => new Date() } = options;
	return {
		schemaVersion: 1,
		eventId: createId(),
		timestamp: now().toISOString(),
		...input
	};
}

export interface CorrectionLogStore {
	append(event: CorrectionEvent): Promise<void>;
	getAll(): Promise<readonly CorrectionEvent[]>;
}

export const CORRECTION_LOG_DB_NAME = 'chainspot-correction-log';
export const CORRECTION_LOG_DB_VERSION = 1;
export const CORRECTION_LOG_STORE_NAME = 'events';

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

export class IndexedDbCorrectionLogStore implements CorrectionLogStore {
	readonly #factory: IDBFactory;

	constructor(factory: IDBFactory = globalThis.indexedDB) {
		this.#factory = factory;
	}

	#open(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = this.#factory.open(CORRECTION_LOG_DB_NAME, CORRECTION_LOG_DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(CORRECTION_LOG_STORE_NAME)) {
					db.createObjectStore(CORRECTION_LOG_STORE_NAME, { keyPath: 'eventId' });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('failed to open the correction log database'));
		});
	}

	async append(event: CorrectionEvent): Promise<void> {
		const db = await this.#open();
		try {
			const transaction = db.transaction(CORRECTION_LOG_STORE_NAME, 'readwrite');
			transaction.objectStore(CORRECTION_LOG_STORE_NAME).put(event);
			await promisifyTransaction(transaction);
		} finally {
			db.close();
		}
	}

	async getAll(): Promise<readonly CorrectionEvent[]> {
		const db = await this.#open();
		try {
			const store = db.transaction(CORRECTION_LOG_STORE_NAME, 'readonly').objectStore(CORRECTION_LOG_STORE_NAME);
			return await promisifyRequest(store.getAll());
		} finally {
			db.close();
		}
}

let defaultStore: CorrectionLogStore | null = null;

export function getDefaultCorrectionLogStore(): CorrectionLogStore {
	defaultStore ??= new IndexedDbCorrectionLogStore();
	return defaultStore;
}

export function correctionEventsToExportBlob(events: readonly CorrectionEvent[]): Blob {
	return new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
}
