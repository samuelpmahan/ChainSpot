import { describe, expect, it } from 'vitest';
import {
	applyCourseVisionEvidence,
	emptyCourseVisionEvidence,
	type CourseVisionEvidenceSnapshot,
	type HoleEvidenceEntry
} from '../../src/lib/autoAnnotation/courseVisionEvidenceStore';
import {
	COURSE_VISION_OPERATORS,
	type CourseVisionEvidenceEvent,
	type CourseVisionChannel,
	type HoleVisionState,
	type EvidenceHoleGeometry,
	type EvidenceLandmarkBatch,
	type CourseVisionOperatorRef
} from '../../src/lib/autoAnnotation/courseVisionEvidence';

// Helper: build a CourseVisionEvidenceEvent with sensible defaults.
function buildEvent(overrides: Partial<CourseVisionEvidenceEvent> & { state: HoleVisionState }): CourseVisionEvidenceEvent {
	const { state, channel, producer, message, ...rest } = overrides;
	return {
		state,
		channel: channel ?? 'fast-lane',
		producer: producer ?? COURSE_VISION_OPERATORS.badgeGlyphIdentification,
		message: message ?? 'test event',
		...rest
	};
}

// Deep-freeze helper to ensure purity tests catch mutations.
function deepFreeze<T>(obj: T): T {
	if (typeof obj === 'object' && obj !== null && !Object.isFrozen(obj)) {
		Object.freeze(obj);
		for (const value of Object.values(obj)) {
			deepFreeze(value);
		}
	}
	return obj;
}

describe('courseVisionEvidenceStore', () => {
	describe('emptyCourseVisionEvidence()', () => {
		it('returns a snapshot with the correct empty shape', () => {
			const snapshot = emptyCourseVisionEvidence();
			expect(snapshot.unassigned).toBeNull();
			expect(snapshot.holes).toEqual(new Map());
			expect(snapshot.marks).toEqual({});
			expect(snapshot.log).toEqual([]);
		});

		it('returns a new snapshot each time (not a singleton)', () => {
			const snap1 = emptyCourseVisionEvidence();
			const snap2 = emptyCourseVisionEvidence();
			expect(snap1).not.toBe(snap2);
			expect(snap1.holes).not.toBe(snap2.holes);
			expect(snap1.marks).not.toBe(snap2.marks);
			expect(snap1.log).not.toBe(snap2.log);
		});
	});

	describe('candidate events', () => {
		it('replaces unassigned with new landmark batch', () => {
			const snapshot = emptyCourseVisionEvidence();
			const landmarks: EvidenceLandmarkBatch = {
				tees: [{ xPx: 10, yPx: 20 }],
				badges: [{ xPx: 30, yPx: 40 }]
			};
			const event = buildEvent({
				state: 'candidate',
				landmarks,
				elapsedMs: 50
			});
			const next = applyCourseVisionEvidence(snapshot, [event]);
			expect(next.unassigned).toEqual(landmarks);
		});

		it('second candidate batch replaces the first', () => {
			const snapshot = emptyCourseVisionEvidence();
			const landmarks1: EvidenceLandmarkBatch = { tees: [{ xPx: 1, yPx: 2 }] };
			const landmarks2: EvidenceLandmarkBatch = { badges: [{ xPx: 3, yPx: 4 }] };
			const event1 = buildEvent({
				state: 'candidate',
				landmarks: landmarks1,
				elapsedMs: 10
			});
			const event2 = buildEvent({
				state: 'candidate',
				landmarks: landmarks2,
				elapsedMs: 20
			});
			let next = applyCourseVisionEvidence(snapshot, [event1]);
			expect(next.unassigned).toEqual(landmarks1);
			next = applyCourseVisionEvidence(next, [event2]);
			expect(next.unassigned).toEqual(landmarks2);
		});

		it('sets marks.firstCandidateMs only on the first candidate event', () => {
			const snapshot = emptyCourseVisionEvidence();
			const landmarks1: EvidenceLandmarkBatch = { tees: [{ xPx: 1, yPx: 2 }] };
			const landmarks2: EvidenceLandmarkBatch = { badges: [{ xPx: 3, yPx: 4 }] };
			const event1 = buildEvent({
				state: 'candidate',
				landmarks: landmarks1,
				elapsedMs: 50
			});
			const event2 = buildEvent({
				state: 'candidate',
				landmarks: landmarks2,
				elapsedMs: 100
			});
			let next = applyCourseVisionEvidence(snapshot, [event1]);
			expect(next.marks.firstCandidateMs).toBe(50);
			next = applyCourseVisionEvidence(next, [event2]);
			// firstCandidateMs should remain 50, not be updated to 100.
			expect(next.marks.firstCandidateMs).toBe(50);
		});

		it('appends log entries for accepted candidate events', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event = buildEvent({
				state: 'candidate',
				landmarks: { tees: [{ xPx: 10, yPx: 20 }] },
				elapsedMs: 42,
				producer: COURSE_VISION_OPERATORS.badgeGlyphIdentification
			});
			const next = applyCourseVisionEvidence(snapshot, [event]);
			expect(next.log.length).toBe(1);
			expect(next.log[0]).toContain('[42ms]');
			expect(next.log[0]).toContain('P2');
			expect(next.log[0]).toContain('course');
			expect(next.log[0]).toContain('candidate');
		});
	});

	describe('per-hole monotonic merge (identified then owned upgrades)', () => {
		it('identified event creates entry for hole', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event = buildEvent({
				state: 'identified',
				holeNumber: 7,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 50
			});
			const next = applyCourseVisionEvidence(snapshot, [event]);
			const entry = next.holes.get(7);
			expect(entry).toBeDefined();
			expect(entry?.state).toBe('identified');
			expect(entry?.holeNumber).toBe(7);
		});

		it('owned event replaces identified when given same hole', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event1 = buildEvent({
				state: 'identified',
				holeNumber: 7,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 50
			});
			const event2 = buildEvent({
				state: 'owned',
				holeNumber: 7,
				geometry: { tee: { xPx: 50, yPx: 100 }, badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 60
			});
			let next = applyCourseVisionEvidence(snapshot, [event1]);
			expect(next.holes.get(7)?.state).toBe('identified');
			next = applyCourseVisionEvidence(next, [event2]);
			expect(next.holes.get(7)?.state).toBe('owned');
		});

		it('lower-rank event after higher-rank is rejected (state and geometry unchanged)', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event1 = buildEvent({
				state: 'owned',
				holeNumber: 5,
				geometry: { tee: { xPx: 50, yPx: 100 }, badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 50
			});
			const event2 = buildEvent({
				state: 'identified',
				holeNumber: 5,
				geometry: { badge: { xPx: 150, yPx: 250 } },
				elapsedMs: 60
			});
			let next = applyCourseVisionEvidence(snapshot, [event1]);
			expect(next.holes.get(5)?.state).toBe('owned');
			const geomAfterEvent1 = next.holes.get(5)?.geometry;
			next = applyCourseVisionEvidence(next, [event2]);
			expect(next.holes.get(5)?.state).toBe('owned');
			expect(next.holes.get(5)?.geometry).toEqual(geomAfterEvent1);
		});
	});

	describe('equal-rank channel policy', () => {
		it('authoritative beats fast-lane at equal rank', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event1 = buildEvent({
				state: 'identified',
				channel: 'fast-lane',
				holeNumber: 3,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 50,
				producer: COURSE_VISION_OPERATORS.pureTsBadgeGlyphIdentification
			});
			const event2 = buildEvent({
				state: 'identified',
				channel: 'authoritative',
				holeNumber: 3,
				geometry: { badge: { xPx: 110, yPx: 210 } },
				elapsedMs: 60,
				producer: COURSE_VISION_OPERATORS.badgeGlyphIdentification
			});
			let next = applyCourseVisionEvidence(snapshot, [event1]);
			expect(next.holes.get(3)?.channel).toBe('fast-lane');
			expect(next.holes.get(3)?.geometry?.badge).toEqual({ xPx: 100, yPx: 200 });
			next = applyCourseVisionEvidence(next, [event2]);
			expect(next.holes.get(3)?.channel).toBe('authoritative');
			expect(next.holes.get(3)?.geometry?.badge).toEqual({ xPx: 110, yPx: 210 });
		});

		it('later fast-lane at equal rank does NOT replace authoritative entry', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event1 = buildEvent({
				state: 'identified',
				channel: 'authoritative',
				holeNumber: 3,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 50
			});
			const event2 = buildEvent({
				state: 'identified',
				channel: 'fast-lane',
				holeNumber: 3,
				geometry: { badge: { xPx: 110, yPx: 210 } },
				elapsedMs: 60
			});
			let next = applyCourseVisionEvidence(snapshot, [event1]);
			expect(next.holes.get(3)?.channel).toBe('authoritative');
			expect(next.holes.get(3)?.geometry?.badge).toEqual({ xPx: 100, yPx: 200 });
			next = applyCourseVisionEvidence(next, [event2]);
			expect(next.holes.get(3)?.channel).toBe('authoritative');
			expect(next.holes.get(3)?.geometry?.badge).toEqual({ xPx: 100, yPx: 200 });
		});

		it('later authoritative at equal rank replaces earlier authoritative (latest wins within channel)', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event1 = buildEvent({
				state: 'identified',
				channel: 'authoritative',
				holeNumber: 3,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 50
			});
			const event2 = buildEvent({
				state: 'identified',
				channel: 'authoritative',
				holeNumber: 3,
				geometry: { badge: { xPx: 110, yPx: 210 } },
				elapsedMs: 60
			});
			let next = applyCourseVisionEvidence(snapshot, [event1]);
			expect(next.holes.get(3)?.geometry?.badge).toEqual({ xPx: 100, yPx: 200 });
			next = applyCourseVisionEvidence(next, [event2]);
			expect(next.holes.get(3)?.geometry?.badge).toEqual({ xPx: 110, yPx: 210 });
		});
	});

	describe('geometry field-wise merge', () => {
		it('owned event with tee+badge, then provisional with only basket → entry keeps tee+badge and gains basket', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event1 = buildEvent({
				state: 'owned',
				holeNumber: 2,
				geometry: {
					tee: { xPx: 10, yPx: 20 },
					badge: { xPx: 30, yPx: 40 }
				},
				elapsedMs: 50
			});
			const event2 = buildEvent({
				state: 'provisional',
				holeNumber: 2,
				geometry: {
					basket: { xPx: 100, yPx: 200 }
				},
				elapsedMs: 60
			});
			let next = applyCourseVisionEvidence(snapshot, [event1]);
			const geom1 = next.holes.get(2)?.geometry;
			expect(geom1?.tee).toEqual({ xPx: 10, yPx: 20 });
			expect(geom1?.badge).toEqual({ xPx: 30, yPx: 40 });
			expect(geom1?.basket).toBeUndefined();

			next = applyCourseVisionEvidence(next, [event2]);
			const geom2 = next.holes.get(2)?.geometry;
			expect(geom2?.tee).toEqual({ xPx: 10, yPx: 20 });
			expect(geom2?.badge).toEqual({ xPx: 30, yPx: 40 });
			expect(geom2?.basket).toEqual({ xPx: 100, yPx: 200 });
		});

		it('incoming field overwrites prior field of the same kind', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event1 = buildEvent({
				state: 'identified',
				holeNumber: 4,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 50
			});
			const event2 = buildEvent({
				state: 'owned',
				holeNumber: 4,
				geometry: { badge: { xPx: 150, yPx: 250 } },
				elapsedMs: 60
			});
			let next = applyCourseVisionEvidence(snapshot, [event1]);
			expect(next.holes.get(4)?.geometry?.badge).toEqual({ xPx: 100, yPx: 200 });
			next = applyCourseVisionEvidence(next, [event2]);
			expect(next.holes.get(4)?.geometry?.badge).toEqual({ xPx: 150, yPx: 250 });
		});
	});

	describe('final state', () => {
		it('final always wins regardless of prior state', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event1 = buildEvent({
				state: 'identified',
				holeNumber: 8,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 50
			});
			const event2 = buildEvent({
				state: 'final',
				holeNumber: 8,
				geometry: {
					tee: { xPx: 10, yPx: 20 },
					badge: { xPx: 110, yPx: 210 },
					basket: { xPx: 200, yPx: 300 }
				},
				elapsedMs: 100
			});
			let next = applyCourseVisionEvidence(snapshot, [event1]);
			expect(next.holes.get(8)?.state).toBe('identified');
			next = applyCourseVisionEvidence(next, [event2]);
			expect(next.holes.get(8)?.state).toBe('final');
			expect(next.holes.get(8)?.geometry?.basket).toEqual({ xPx: 200, yPx: 300 });
		});

		it('sets marks.finalBurstMs once', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event1 = buildEvent({
				state: 'final',
				holeNumber: 1,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 150
			});
			const event2 = buildEvent({
				state: 'final',
				holeNumber: 2,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 160
			});
			let next = applyCourseVisionEvidence(snapshot, [event1]);
			expect(next.marks.finalBurstMs).toBe(150);
			next = applyCourseVisionEvidence(next, [event2]);
			expect(next.marks.finalBurstMs).toBe(150);
		});
	});

	describe('marks (timing traces)', () => {
		it('first fast-lane identified sets firstFastLaneIdentityMs', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event = buildEvent({
				state: 'identified',
				channel: 'fast-lane',
				holeNumber: 5,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 75
			});
			const next = applyCourseVisionEvidence(snapshot, [event]);
			expect(next.marks.firstFastLaneIdentityMs).toBe(75);
		});

		it('first owned sets firstOwnedMs', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event = buildEvent({
				state: 'owned',
				holeNumber: 3,
				geometry: { tee: { xPx: 10, yPx: 20 } },
				elapsedMs: 85
			});
			const next = applyCourseVisionEvidence(snapshot, [event]);
			expect(next.marks.firstOwnedMs).toBe(85);
		});

		it('first provisional sets firstProvisionalMs', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event = buildEvent({
				state: 'provisional',
				holeNumber: 6,
				geometry: { basket: { xPx: 200, yPx: 300 } },
				elapsedMs: 95
			});
			const next = applyCourseVisionEvidence(snapshot, [event]);
			expect(next.marks.firstProvisionalMs).toBe(95);
		});

		it('authoritative identified does NOT set firstFastLaneIdentityMs', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event = buildEvent({
				state: 'identified',
				channel: 'authoritative',
				holeNumber: 5,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 75
			});
			const next = applyCourseVisionEvidence(snapshot, [event]);
			expect(next.marks.firstFastLaneIdentityMs).toBeUndefined();
		});

		it('each mark is set only once (first occurrence sticks)', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event1 = buildEvent({
				state: 'owned',
				holeNumber: 1,
				geometry: { tee: { xPx: 10, yPx: 20 } },
				elapsedMs: 50
			});
			const event2 = buildEvent({
				state: 'owned',
				holeNumber: 2,
				geometry: { tee: { xPx: 10, yPx: 20 } },
				elapsedMs: 100
			});
			let next = applyCourseVisionEvidence(snapshot, [event1]);
			expect(next.marks.firstOwnedMs).toBe(50);
			next = applyCourseVisionEvidence(next, [event2]);
			expect(next.marks.firstOwnedMs).toBe(50);
		});
	});

	describe('malformed events', () => {
		it('skips event with unknown state string without throwing', () => {
			const snapshot = emptyCourseVisionEvidence();
			const badEvent = buildEvent({ state: 'candidate' });
			// Manually construct an event with an invalid state.
			const invalidEvent = {
				...badEvent,
				state: 'invalidState' as unknown as HoleVisionState
			};
			const next = applyCourseVisionEvidence(snapshot, [invalidEvent as CourseVisionEvidenceEvent]);
			expect(next).toEqual(snapshot);
		});

		it('skips event with missing producer without throwing', () => {
			const snapshot = emptyCourseVisionEvidence();
			// Construct an event with a falsy producer directly, bypassing buildEvent.
			const badEvent: CourseVisionEvidenceEvent = {
				state: 'identified',
				channel: 'fast-lane',
				holeNumber: 5,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				message: 'test',
				producer: null as unknown as CourseVisionOperatorRef
			};
			const next = applyCourseVisionEvidence(snapshot, [badEvent]);
			expect(next).toEqual(snapshot);
		});

		it('skips event with NaN holeNumber without throwing', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event = buildEvent({
				state: 'identified',
				holeNumber: NaN,
				geometry: { badge: { xPx: 100, yPx: 200 } }
			});
			const next = applyCourseVisionEvidence(snapshot, [event]);
			expect(next).toEqual(snapshot);
		});

		it('skips event with negative holeNumber', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event = buildEvent({
				state: 'identified',
				holeNumber: -5,
				geometry: { badge: { xPx: 100, yPx: 200 } }
			});
			const next = applyCourseVisionEvidence(snapshot, [event]);
			expect(next).toEqual(snapshot);
		});

		it('skips event with zero holeNumber', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event = buildEvent({
				state: 'identified',
				holeNumber: 0,
				geometry: { badge: { xPx: 100, yPx: 200 } }
			});
			const next = applyCourseVisionEvidence(snapshot, [event]);
			expect(next).toEqual(snapshot);
		});

		it('skips event with invalid channel without throwing', () => {
			const snapshot = emptyCourseVisionEvidence();
			const badEvent = buildEvent({
				state: 'identified',
				holeNumber: 5,
				channel: 'invalid-channel' as unknown as CourseVisionChannel
			});
			const next = applyCourseVisionEvidence(snapshot, [badEvent as CourseVisionEvidenceEvent]);
			expect(next).toEqual(snapshot);
		});

		it('skips event where producer is not an object', () => {
			const snapshot = emptyCourseVisionEvidence();
			const badEvent = buildEvent({ state: 'candidate' });
			const invalidEvent = {
				...badEvent,
				producer: 'not-an-object'
			};
			const next = applyCourseVisionEvidence(snapshot, [invalidEvent as unknown as CourseVisionEvidenceEvent]);
			expect(next).toEqual(snapshot);
		});

		it('skips null event without throwing', () => {
			const snapshot = emptyCourseVisionEvidence();
			const next = applyCourseVisionEvidence(snapshot, [null as unknown as CourseVisionEvidenceEvent]);
			expect(next).toEqual(snapshot);
		});
	});

	describe('log lines', () => {
		it('accepted events append log lines with elapsed time, producer label, scope, and state', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event = buildEvent({
				state: 'owned',
				holeNumber: 7,
				geometry: { tee: { xPx: 10, yPx: 20 } },
				elapsedMs: 123,
				producer: COURSE_VISION_OPERATORS.geometricOwnership
			});
			const next = applyCourseVisionEvidence(snapshot, [event]);
			expect(next.log.length).toBe(1);
			expect(next.log[0]).toContain('[123ms]');
			expect(next.log[0]).toContain('P3');
			expect(next.log[0]).toContain('Geometric');
			expect(next.log[0]).toContain('H7');
			expect(next.log[0]).toContain('owned');
		});

		it('course-level events (no holeNumber) log with scope "course"', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event = buildEvent({
				state: 'candidate',
				landmarks: { tees: [{ xPx: 1, yPx: 2 }] },
				elapsedMs: 50
			});
			const next = applyCourseVisionEvidence(snapshot, [event]);
			expect(next.log[0]).toContain('course');
		});

		it('log cap: when log length >= 200, oldest entry is discarded', () => {
			let snapshot = emptyCourseVisionEvidence();
			// Add 201 events.
			for (let i = 0; i < 201; i++) {
				const event = buildEvent({
					state: 'candidate',
					landmarks: { tees: [{ xPx: i, yPx: i }] },
					elapsedMs: i
				});
				snapshot = applyCourseVisionEvidence(snapshot, [event]);
			}
			expect(snapshot.log.length).toBe(200);
			// The first entry (i=0) should have been discarded.
			expect(snapshot.log[0]).toContain('[1ms]');
			expect(snapshot.log[199]).toContain('[200ms]');
		});

		it('rejected events do not append log lines', () => {
			const snapshot = emptyCourseVisionEvidence();
			const validEvent = buildEvent({
				state: 'identified',
				holeNumber: 5,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 50
			});
			const invalidEvent = buildEvent({
				state: 'identified',
				holeNumber: NaN,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 60
			});
			let next = applyCourseVisionEvidence(snapshot, [validEvent]);
			expect(next.log.length).toBe(1);
			next = applyCourseVisionEvidence(next, [invalidEvent]);
			expect(next.log.length).toBe(1);
		});
	});

	describe('purity', () => {
		it('never mutates the input snapshot', () => {
			const snapshot = deepFreeze(emptyCourseVisionEvidence());
			const event = buildEvent({
				state: 'identified',
				holeNumber: 5,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 50
			});
			// Should not throw even though snapshot is frozen.
			const next = applyCourseVisionEvidence(snapshot, [event]);
			expect(next).not.toBe(snapshot);
			expect(snapshot.holes.size).toBe(0);
			expect(next.holes.size).toBe(1);
		});

		it('never mutates the input events array', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event = buildEvent({
				state: 'identified',
				holeNumber: 5,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 50
			});
			const frozenEvents = deepFreeze([event]);
			const next = applyCourseVisionEvidence(snapshot, frozenEvents);
			expect(next.holes.size).toBe(1);
		});

		it('returns a new holes Map each time (not reusing prior one)', () => {
			const snapshot = emptyCourseVisionEvidence();
			const event1 = buildEvent({
				state: 'identified',
				holeNumber: 5,
				geometry: { badge: { xPx: 100, yPx: 200 } },
				elapsedMs: 50
			});
			const event2 = buildEvent({
				state: 'owned',
				holeNumber: 6,
				geometry: { tee: { xPx: 10, yPx: 20 } },
				elapsedMs: 60
			});
			const snap1 = applyCourseVisionEvidence(snapshot, [event1]);
			const snap2 = applyCourseVisionEvidence(snap1, [event2]);
			expect(snap1.holes).not.toBe(snap2.holes);
		});
	});

	describe('complex scenarios', () => {
		it('multiple holes at different ranks in a single batch', () => {
			const snapshot = emptyCourseVisionEvidence();
			const events: CourseVisionEvidenceEvent[] = [
				buildEvent({
					state: 'identified',
					holeNumber: 1,
					geometry: { badge: { xPx: 100, yPx: 200 } },
					elapsedMs: 10
				}),
				buildEvent({
					state: 'owned',
					holeNumber: 2,
					geometry: { tee: { xPx: 10, yPx: 20 } },
					elapsedMs: 20
				}),
				buildEvent({
					state: 'provisional',
					holeNumber: 3,
					geometry: { basket: { xPx: 200, yPx: 300 } },
					elapsedMs: 30
				})
			];
			const next = applyCourseVisionEvidence(snapshot, events);
			expect(next.holes.get(1)?.state).toBe('identified');
			expect(next.holes.get(2)?.state).toBe('owned');
			expect(next.holes.get(3)?.state).toBe('provisional');
			expect(next.log.length).toBe(3);
		});

		it('candidate followed by per-hole events in one batch', () => {
			const snapshot = emptyCourseVisionEvidence();
			const events: CourseVisionEvidenceEvent[] = [
				buildEvent({
					state: 'candidate',
					landmarks: { tees: [{ xPx: 10, yPx: 20 }] },
					elapsedMs: 10
				}),
				buildEvent({
					state: 'identified',
					holeNumber: 1,
					geometry: { badge: { xPx: 100, yPx: 200 } },
					elapsedMs: 20
				})
			];
			const next = applyCourseVisionEvidence(snapshot, events);
			expect(next.unassigned).not.toBeNull();
			expect(next.holes.size).toBe(1);
			expect(next.log.length).toBe(2);
		});
	});
});
