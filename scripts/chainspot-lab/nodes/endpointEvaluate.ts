import {
	parseJsonObject,
	type BasketsObjectV1,
	type TeeCandidateEntity,
	type TeeCandidatesObjectV1
} from './endpointTypes';
import type { EndpointTruthHole } from '../step3Suite';

export interface EndpointTruthObjectV1 {
	readonly schemaVersion: 1;
	readonly caseId: string;
	readonly course: string;
	readonly evidenceRole: 'calibration';
	readonly source: unknown;
	readonly holes: readonly EndpointTruthHole[];
}

export interface EndpointEvaluationParameters {
	readonly teeTolerancePx: number;
	readonly basketTolerancePx: number;
}

export interface EndpointEvaluationObjectV1 {
	readonly schemaVersion: 1;
	readonly caseId: string;
	readonly course: string;
	readonly truthCount: number;
	readonly rawTeeCandidateCount: number;
	readonly chromeSuppressedCount: number;
	readonly freeTeeCandidateCount: number;
	readonly teeRecallCount: number;
	readonly basketRecallCount: number;
	readonly teeMissHoleNumbers: readonly number[];
	readonly basketMissHoleNumbers: readonly number[];
	readonly teeFalsePositiveClasses: {
		readonly screenChrome: number;
		readonly basketFurniture: number;
		readonly unexplained: number;
	};
	readonly teeTruth: readonly {
		readonly holeNumber: number;
		readonly matchedCandidateLocalIds: readonly string[];
		readonly nearestDistancePx: number | null;
	}[];
	readonly basketTruth: readonly {
		readonly holeNumber: number;
		readonly matchedBasketLocalIds: readonly string[];
		readonly nearestDistancePx: number | null;
	}[];
	readonly teeCandidates: readonly {
		readonly candidateLocalId: string;
		readonly matchedHoleNumbers: readonly number[];
		readonly attributionClass: 'truth-match' | 'screen-chrome' | 'basket-furniture' | 'unexplained';
	}[];
}

function distance(ax: number, ay: number, bx: number, by: number): number {
	return Math.hypot(ax - bx, ay - by);
}

function basketAttributed(
	candidate: TeeCandidateEntity,
	baskets: BasketsObjectV1
): boolean {
	return baskets.baskets.some(
		(basket) =>
			candidate.cx >= basket.match.x &&
			candidate.cx <= basket.match.x + basket.width &&
			candidate.cy >= basket.match.y &&
			candidate.cy <= basket.match.y + basket.height
	);
}

export function runEndpointEvaluation(
	teeBytes: Uint8Array,
	basketBytes: Uint8Array,
	truthBytes: Uint8Array,
	parameters: EndpointEvaluationParameters
): EndpointEvaluationObjectV1 {
	if (parameters.teeTolerancePx <= 0 || parameters.basketTolerancePx <= 0) {
		throw new RangeError('Endpoint evaluation tolerances must be positive');
	}
	const tees = parseJsonObject<TeeCandidatesObjectV1>(teeBytes);
	const baskets = parseJsonObject<BasketsObjectV1>(basketBytes);
	const truth = parseJsonObject<EndpointTruthObjectV1>(truthBytes);
	const frameTee = (hole: EndpointTruthHole): readonly [number, number] => [
		hole.tee[0] - tees.frame.originX,
		hole.tee[1] - tees.frame.originY
	];
	const frameBasket = (hole: EndpointTruthHole): readonly [number, number] => [
		hole.basket[0] - tees.frame.originX,
		hole.basket[1] - tees.frame.originY
	];
	const teeTruth = truth.holes.map((hole) => {
		const [x, y] = frameTee(hole);
		const distances = tees.candidates.map((candidate) => ({
			candidate,
			distance: distance(candidate.cx, candidate.cy, x, y)
		}));
		return {
			holeNumber: hole.number,
			matchedCandidateLocalIds: distances
				.filter((entry) => entry.distance <= parameters.teeTolerancePx)
				.map((entry) => entry.candidate.localId),
			nearestDistancePx:
				distances.length > 0 ? Math.min(...distances.map((entry) => entry.distance)) : null
		};
	});
	const basketTruth = truth.holes.map((hole) => {
		const [x, y] = frameBasket(hole);
		const distances = baskets.baskets.map((basket) => ({
			basket,
			distance: distance(basket.match.tipX, basket.match.tipY, x, y)
		}));
		return {
			holeNumber: hole.number,
			matchedBasketLocalIds: distances
				.filter((entry) => entry.distance <= parameters.basketTolerancePx)
				.map((entry) => entry.basket.localId),
			nearestDistancePx:
				distances.length > 0 ? Math.min(...distances.map((entry) => entry.distance)) : null
		};
	});
	const rawCandidates = [
		...tees.candidates.map((candidate) => ({ candidate, suppressed: false })),
		...tees.suppressedCandidates.map((candidate) => ({ candidate, suppressed: true }))
	];
	const teeCandidates = rawCandidates.map(({ candidate, suppressed }) => {
		const matchedHoleNumbers = truth.holes
			.filter((hole) => {
				const [x, y] = frameTee(hole);
				return distance(candidate.cx, candidate.cy, x, y) <= parameters.teeTolerancePx;
			})
			.map((hole) => hole.number);
		const attributionClass =
			matchedHoleNumbers.length > 0
				? 'truth-match'
				: suppressed
					? 'screen-chrome'
					: basketAttributed(candidate, baskets)
						? 'basket-furniture'
						: 'unexplained';
		return { candidateLocalId: candidate.localId, matchedHoleNumbers, attributionClass } as const;
	});
	return {
		schemaVersion: 1,
		caseId: truth.caseId,
		course: truth.course,
		truthCount: truth.holes.length,
		rawTeeCandidateCount: tees.rawCandidates.length,
		chromeSuppressedCount: tees.suppressedCandidates.length,
		freeTeeCandidateCount: tees.candidates.length,
		teeRecallCount: teeTruth.filter((row) => row.matchedCandidateLocalIds.length > 0).length,
		basketRecallCount: basketTruth.filter((row) => row.matchedBasketLocalIds.length > 0).length,
		teeMissHoleNumbers: teeTruth
			.filter((row) => row.matchedCandidateLocalIds.length === 0)
			.map((row) => row.holeNumber),
		basketMissHoleNumbers: basketTruth
			.filter((row) => row.matchedBasketLocalIds.length === 0)
			.map((row) => row.holeNumber),
		teeFalsePositiveClasses: {
			screenChrome: teeCandidates.filter((candidate) => candidate.attributionClass === 'screen-chrome').length,
			basketFurniture: teeCandidates.filter((candidate) => candidate.attributionClass === 'basket-furniture').length,
			unexplained: teeCandidates.filter((candidate) => candidate.attributionClass === 'unexplained').length
		},
		teeTruth,
		basketTruth,
		teeCandidates
	};
}
