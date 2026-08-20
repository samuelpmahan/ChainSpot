import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
	buildCorrectionEvent,
	correctionEventsToExportBlob,
	deriveProposalFromGrammar,
	IndexedDbCorrectionLogStore
} from '../../src/lib/correctionLog';
import type { CorrectionEvent } from '../../src/lib/correctionLog';
import type { CourseGrammarResult, CourseHoleProposal } from '../../src/lib/autoAnnotation/courseGrammar';

const NOW = () => new Date('2026-08-12T00:00:00.000Z');

function holeProposal(overrides: Partial<CourseHoleProposal> & { number: number }): CourseHoleProposal {
	return {
		confidence: 0.9,
		status: 'ready',
		failures: [],
		...overrides
	};
}

function grammarOf(holes: readonly CourseHoleProposal[]): CourseGrammarResult {
	return {
		holes,
		failures: [],
		unassigned: { numberBadgeCandidateIndexes: [], teeCandidateIndexes: [], basketCandidateIndexes: [] }
	};
}

describe('deriveProposalFromGrammar', () => {
	it('returns null when the grammar has no proposal for that hole at all', () => {
		expect(deriveProposalFromGrammar(null, 6, 'tee')).toBeNull();
		expect(deriveProposalFromGrammar(grammarOf([]), 6, 'tee')).toBeNull();
	});

	it('returns null when the hole exists but has no assignment for that endpoint', () => {
		const grammar = grammarOf([holeProposal({ number: 6 })]);
		expect(deriveProposalFromGrammar(grammar, 6, 'tee')).toBeNull();
	});

	it('reports auto-accepted with the detector-scale confidence when there is no matching failure', () => {
		const grammar = grammarOf([
			holeProposal({
				number: 6,
				tee: {
					candidateIndex: 2,
					xPx: 100,
					yPx: 200,
					detectorConfidence: 0.82,
					confidence: 0.75,
					distancePx: 12
				}
			})
		]);
		expect(deriveProposalFromGrammar(grammar, 6, 'tee')).toEqual({
			xPx: 100,
			yPx: 200,
			confidence: 0.82,
			detector: 'courseGrammar-hungarian',
			gateDecision: 'auto-accepted'
		});
	});

	it('flags for review with the failure kind as reason when a matching weak/ambiguous failure exists', () => {
		const grammar = grammarOf([
			holeProposal({
				number: 2,
				basket: {
					candidateIndex: 7,
					xPx: 300,
					yPx: 400,
					detectorConfidence: 0.61,
					confidence: 0.49,
					distancePx: 30,
					polarityCosine: 0.2,
					cost: 30
				},
				failures: [
					{ kind: 'ambiguous-basket', severity: 'warning', candidateKind: 'basket', message: 'ambiguous' },
					// A failure on a different candidateKind must not leak into this endpoint's reason.
					{ kind: 'weak-tee-confidence', severity: 'warning', candidateKind: 'tee', message: 'weak tee' }
				]
			})
		]);
		expect(deriveProposalFromGrammar(grammar, 2, 'basket')).toEqual({
			xPx: 300,
			yPx: 400,
			confidence: 0.61,
			detector: 'courseGrammar-hungarian',
			gateDecision: 'flagged-for-review',
			reason: 'ambiguous-basket'
		});
	});
});

describe('buildCorrectionEvent', () => {
	it('stamps schemaVersion, eventId, and timestamp and passes the rest through unchanged', () => {
		const event = buildCorrectionEvent(
			{
				appVersion: '0.1.0',
				projectId: 'project-1',
				imageId: 'image-1',
				imageSha256: 'a'.repeat(64),
				holeNumber: 6,
				endpoint: 'tee',
				priorProposal: null,
				userAction: 'place',
				finalValue: { xPx: 10, yPx: 20 }
			},
			{ createId: () => 'event-1', now: NOW }
		);
		expect(event).toEqual({
			schemaVersion: 1,
			eventId: 'event-1',
			timestamp: NOW().toISOString(),
			appVersion: '0.1.0',
			projectId: 'project-1',
			imageId: 'image-1',
			imageSha256: 'a'.repeat(64),
			holeNumber: 6,
			endpoint: 'tee',
			priorProposal: null,
			userAction: 'place',
			finalValue: { xPx: 10, yPx: 20 }
		});
	});
});

describe('correctionEventsToExportBlob', () => {
	it('serializes the event list as pretty-printed JSON', async () => {
		const event = buildCorrectionEvent(
			{
				appVersion: '0.1.0',
				projectId: 'project-1',
				imageId: 'image-1',
				imageSha256: null,
				holeNumber: 1,
				endpoint: 'basket',
				priorProposal: null,
				userAction: 'skip',
				finalValue: null
			},
			{ createId: () => 'event-1', now: NOW }
		);
		const blob = correctionEventsToExportBlob([event]);
		expect(blob.type).toBe('application/json');
		const text = await blob.text();
		expect(JSON.parse(text)).toEqual([event]);
	});
});

describe('IndexedDbCorrectionLogStore', () => {
	function freshFactory(): IDBFactory {
		// jsdom has no real IndexedDB; a fresh fake-indexeddb factory per test
		// keeps this suite isolated from any other test's database state.
		return new IDBFactory();
	}

	function eventOf(eventId: string): CorrectionEvent {
		return buildCorrectionEvent(
			{
				appVersion: '0.1.0',
				projectId: 'project-1',
				imageId: 'image-1',
				imageSha256: null,
				holeNumber: 6,
				endpoint: 'tee',
				priorProposal: null,
				userAction: 'confirm',
				finalValue: { xPx: 1, yPx: 2 }
			},
			{ createId: () => eventId, now: NOW }
		);
	}

	it('round-trips append/getAll against the real IndexedDB request/transaction API, append-only', async () => {
		const store = new IndexedDbCorrectionLogStore(freshFactory());
		expect(await store.getAll()).toEqual([]);

		await store.append(eventOf('event-1'));
		await store.append(eventOf('event-2'));
		const all = await store.getAll();
		expect(all.map((event) => event.eventId).sort()).toEqual(['event-1', 'event-2']);
	});
});
