import assert from 'node:assert/strict';
import { segmentRibbonMass } from '../../src/lib/autoAnnotation/ribbonMass';
import { findExclusiveBasketFloodOwnership } from '../../src/lib/autoAnnotation/basketFloodOwnership';
import { associateCourseGrammar } from '../../src/lib/autoAnnotation/courseGrammar';
import { FIXTURE_COURSES, loadFixtureRaster } from './ribbonMassFixtures';

const expectedLocks = new Map([
	['GoldenTeeSet', 8],
	['AlexClarkSet', 3]
]);

for (const course of FIXTURE_COURSES) {
	const raster = loadFixtureRaster(course.zip);
	const badges = course.badges.map(([holeNumber, xPx, yPx]) => ({ holeNumber, xPx, yPx }));
	const segmentation = segmentRibbonMass(raster, badges);
	// Truth supplies only the candidate coordinates. Reverse the pool so array
	// order cannot encode ownership; hole identity is consulted only afterward
	// to score the locks.
	const candidates = [...course.truth]
		.map(([holeNumber, _tx, _ty, xPx, yPx]) => ({ holeNumber, xPx, yPx }))
		.reverse();
	const result = findExclusiveBasketFloodOwnership(segmentation, badges, candidates);
	assert.equal(result.locks.length, expectedLocks.get(course.name), `${course.name}: unexpected lock count`);
	for (const lock of result.locks) {
		assert.equal(
			candidates[lock.basketCandidateIndex].holeNumber,
			lock.holeNumber,
			`${course.name}: false basket lock on component ${lock.componentLabel}`
		);
	}
	assert.equal(result.badgeSeedMissHoleNumbers.length, 0, `${course.name}: badge seed miss`);
	assert.equal(result.basketSeedMissCandidateIndexes.length, 0, `${course.name}: basket seed miss`);
	console.log(JSON.stringify({
		course: course.name,
		locks: result.locks.length,
		lockedHoles: result.locks.map((lock) => lock.holeNumber),
		ambiguousComponents: result.ambiguousComponents.length,
		falseLocks: 0
	}, null, 2));
}

// Small adversarial grammar check: candidate 0 is closer to hole 2's badge,
// but a structural pre-association owns it for hole 1. The full-course solve
// must preserve that owner without splitting the course into sub-solves.
const grammar = associateCourseGrammar({
	holeNumbers: [1, 2],
	numberBadges: [
		{ xPx: 0, yPx: 0, confidence: 1, holeNumber: 1 },
		{ xPx: 100, yPx: 0, confidence: 1, holeNumber: 2 }
	],
	tees: [
		{ xPx: -20, yPx: 0, confidence: 1, holeNumber: 1, bootstrapDecision: 'auto' },
		{ xPx: 120, yPx: 0, confidence: 1, holeNumber: 2, bootstrapDecision: 'auto' }
	],
	baskets: [
		{ xPx: 90, yPx: 0, confidence: 1, holeNumber: 1 },
		{ xPx: 40, yPx: 0, confidence: 1 }
	],
	basketPolarityPenaltyPx: 0
});
assert.equal(grammar.holes.find((hole) => hole.number === 1)?.basket?.candidateIndex, 0);
assert.equal(grammar.holes.find((hole) => hole.number === 2)?.basket?.candidateIndex, 1);
console.log('PASS: in-grammar basket ownership constraint reserves structural ownership');
