import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	recommendNextAnchor,
	type ActiveReviewMap,
	type ActiveReviewRecommendation
} from '../src/lib/autoAnnotation/activeReview.ts';

interface GoldenMapFile {
	readonly name: string;
	readonly deadlineMs?: number;
	readonly map: ActiveReviewMap;
	readonly groundTruth?: {
		readonly teeByHole?: Readonly<Record<string, string>>;
		readonly basketByHole?: Readonly<Record<string, string>>;
	};
}

function goldGain(map: ActiveReviewMap, holeNumber: number, truth: GoldenMapFile['groundTruth']): number {
	const hole = map.holes.find((candidate) => candidate.number === holeNumber);
	if (!hole) return 0;
	const otherHoles = map.holes.filter((candidate) => candidate.number !== holeNumber);
	const expected = [
		...Object.entries(truth?.teeByHole ?? {}).filter(([number]) => Number(number) === holeNumber).map(([, id]) => ({ kind: 'tee' as const, id })),
		...Object.entries(truth?.basketByHole ?? {}).filter(([number]) => Number(number) === holeNumber).map(([, id]) => ({ kind: 'basket' as const, id }))
	];
	return expected.reduce((gain, target) => {
		const present = hole.associations.some((association) => association.kind === target.kind && association.candidateId === target.id);
		const shared = otherHoles.some((other) => other.associations.some((association) => association.candidateId === target.id));
		return gain + (present && shared ? 1 : 0);
	}, 0);
}

function recommendationSummary(recommendation: ActiveReviewRecommendation): Record<string, unknown> {
	return {
		kind: recommendation.kind,
		candidateKind: recommendation.kind === 'candidate' ? recommendation.candidateKind : null,
		candidateId: recommendation.kind === 'candidate' ? recommendation.candidateId : null,
		candidateIndex: recommendation.kind === 'candidate' ? recommendation.candidateIndex : null,
		holeNumber: recommendation.holeNumber ?? null,
		score: recommendation.score,
		timedOut: recommendation.timedOut,
		...(recommendation.kind === 'none'
			? { reason: recommendation.reason }
			: {})
	};
}

function main(): void {
	const fixturePath = process.argv[2];
	if (!fixturePath) {
		throw new Error('Usage: node --experimental-strip-types scripts/benchmark-active-review.ts <golden-map.json>');
	}
	const fixture = JSON.parse(readFileSync(resolve(fixturePath), 'utf8')) as GoldenMapFile;
	let map = fixture.map;
	const history: Array<Record<string, unknown>> = [];
	let totalGoldGain = 0;
	let totalRegret = 0;
	let fallbackCount = 0;
	const maxIterations = map.holes.length + 1;

	for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
		const recommendation = recommendNextAnchor(map, { deadlineMs: fixture.deadlineMs ?? 4000, now: () => 0 });
		const selected = recommendation.holeNumber;
		if (recommendation.kind === 'none') fallbackCount += 1;
		if (selected === undefined) break;
		const unresolved = map.holes.filter((hole) => {
			const confirmed = new Set(map.confirmedCandidateIds ?? []);
			return recommendation.kind !== 'candidate' || !confirmed.has(recommendation.candidateId) || hole.number === selected;
		});
		const oracleGain = Math.max(0, ...unresolved.map((hole) => goldGain(map, hole.number, fixture.groundTruth)));
		const selectedGoldGain = goldGain(map, selected, fixture.groundTruth);
		const regret = Math.max(0, oracleGain - selectedGoldGain);
		totalGoldGain += selectedGoldGain;
		totalRegret += regret;
		history.push({ iteration, recommendation: recommendationSummary(recommendation), selectedGoldGain, oracleGain, regret });
		if (recommendation.kind !== 'candidate') break;
		map = { ...map, confirmedCandidateIds: [...(map.confirmedCandidateIds ?? []), recommendation.candidateId] };
	}

	const result = {
		dataset: fixture.name,
		iterations: history.length,
		fallbackCount,
		totalGoldGain,
		totalRegret,
		averageRegret: history.length === 0 ? 0 : totalRegret / history.length,
		history
	};
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
