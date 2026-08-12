/**
 * Pure numeric search over per-patch tee metrics. No OpenCV dependency: this
 * module receives already-computed metric vectors (see `teeMetricBattery.ts`)
 * and answers "which metric — or weighted combination — separates the labeled
 * truth patches from distractors on THIS image". It is deliberately an
 * overfitting tool: a single labeled course, no holdout. The discovered
 * `TunedTeeScorer` is a course-specific artifact, not a general detector.
 */

export type PatchLabel = 'truth' | 'distractor' | 'hard-negative';

export interface MetricSample {
	readonly label: PatchLabel;
	/** Present for truth patches so per-hole ranks can be reported. */
	readonly holeNumber?: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly metrics: Readonly<Record<string, number>>;
}

export interface MetricReport {
	readonly name: string;
	/** AUC of truth vs every non-truth sample; 0.5 = chance, 1 = separates, 0 = separates inverted. */
	readonly aucAll: number;
	/** AUC of truth vs hard negatives only (the detector's own false positives). */
	readonly aucHardNegatives: number;
	/** Worst truth sample's percentile among all non-truth samples (0..1; 1 = above all). */
	readonly worstTruthPercentile: number;
	/**
	 * For each truth patch, its 1-based rank among {itself + its local
	 * distractors} under this metric, higher-is-better orientation applied.
	 * Ideal is all 1s.
	 */
	readonly localRanks: readonly Readonly<{ holeNumber?: number; rank: number; localCount: number }>[];
	/** True when the metric separates with larger values on truth; false when inverted. */
	readonly higherIsTruth: boolean;
}

export interface TunedTeeScorer {
	readonly metrics: readonly Readonly<{
		name: string;
		weight: number;
		/** z-score normalization derived from the pooled sample. */
		mean: number;
		std: number;
	}>[];
	/** Scores >= threshold classify as tee under the tuned scorer. */
	readonly threshold: number;
	/** min over truth of (truth score - best local distractor score) at fit time. */
	readonly minLocalMargin: number;
}

export interface LocalNeighborhood {
	readonly truthIndex: number;
	readonly distractorIndices: readonly number[];
}

function mean(values: readonly number[]): number {
	let total = 0;
	for (const value of values) total += value;
	return values.length === 0 ? 0 : total / values.length;
}

function standardDeviation(values: readonly number[], center: number): number {
	if (values.length === 0) return 1;
	let total = 0;
	for (const value of values) total += (value - center) * (value - center);
	const variance = total / values.length;
	return variance > 0 ? Math.sqrt(variance) : 1;
}

/** Mann-Whitney AUC via midrank comparison; ties count half. */
export function computeAuc(positives: readonly number[], negatives: readonly number[]): number {
	if (positives.length === 0 || negatives.length === 0) return 0.5;
	let wins = 0;
	for (const positive of positives) {
		for (const negative of negatives) {
			if (positive > negative) wins += 1;
			else if (positive === negative) wins += 0.5;
		}
	}
	return wins / (positives.length * negatives.length);
}

function metricValues(samples: readonly MetricSample[], name: string): number[] {
	return samples.map((sample) => sample.metrics[name] ?? Number.NaN);
}

function percentileAbove(value: number, population: readonly number[]): number {
	if (population.length === 0) return 1;
	let below = 0;
	for (const other of population) {
		if (value > other) below += 1;
		else if (value === other) below += 0.5;
	}
	return below / population.length;
}

function rankAmong(value: number, competitors: readonly number[]): number {
	if (!Number.isFinite(value)) return competitors.length + 1;
	let rank = 1;
	for (const competitor of competitors) if (competitor > value) rank += 1;
	return rank;
}

/**
 * Builds local truth-vs-nearby-distractor neighborhoods. `radiusPx` should
 * match the production gap-fallback search radius so "wins locally" means
 * "would win a badge-targeted fallback search".
 */
export function buildLocalNeighborhoods(samples: readonly MetricSample[], radiusPx: number): readonly LocalNeighborhood[] {
	const neighborhoods: LocalNeighborhood[] = [];
	samples.forEach((sample, truthIndex) => {
		if (sample.label !== 'truth') return;
		const distractorIndices: number[] = [];
		samples.forEach((other, otherIndex) => {
			if (other.label === 'truth') return;
			if (Math.hypot(other.xPx - sample.xPx, other.yPx - sample.yPx) <= radiusPx) distractorIndices.push(otherIndex);
		});
		neighborhoods.push({ truthIndex, distractorIndices });
	});
	return neighborhoods;
}

/**
 * Per-metric discrimination report, orientation-corrected: a metric whose
 * raw AUC is below 0.5 is flipped (reported with `higherIsTruth: false`) so
 * every report row reads "how well does this metric separate", not "which
 * direction it happens to point".
 */
export function scoreMetricDiscrimination(
	metricNames: readonly string[],
	samples: readonly MetricSample[],
	neighborhoods: readonly LocalNeighborhood[]
): readonly MetricReport[] {
	const truth = samples.filter((sample) => sample.label === 'truth');
	const nonTruth = samples.filter((sample) => sample.label !== 'truth');
	const hardNegatives = samples.filter((sample) => sample.label === 'hard-negative');
	const reports = metricNames.map((name) => {
		const truthValues = metricValues(truth, name);
		const nonTruthValues = metricValues(nonTruth, name);
		const rawAuc = computeAuc(truthValues, nonTruthValues);
		const higherIsTruth = rawAuc >= 0.5;
		const sign = higherIsTruth ? 1 : -1;
		const orient = (values: readonly number[]) => values.map((value) => sign * value);
		const orientedTruth = orient(truthValues);
		const orientedNonTruth = orient(nonTruthValues);
		const localRanks = neighborhoods.map((neighborhood) => {
			const truthSample = samples[neighborhood.truthIndex];
			const truthValue = sign * (truthSample.metrics[name] ?? Number.NaN);
			const competitors = neighborhood.distractorIndices.map((index) => sign * (samples[index].metrics[name] ?? Number.NaN));
			return {
				holeNumber: truthSample.holeNumber,
				rank: rankAmong(truthValue, competitors),
				localCount: competitors.length + 1
			};
		});
		return {
			name,
			aucAll: computeAuc(orientedTruth, orientedNonTruth),
			aucHardNegatives: computeAuc(orientedTruth, orient(metricValues(hardNegatives, name))),
			worstTruthPercentile: Math.min(...orientedTruth.map((value) => percentileAbove(value, orientedNonTruth))),
			localRanks,
			higherIsTruth
		};
	});
	return [...reports].sort((a, b) => b.aucHardNegatives - a.aucHardNegatives || b.aucAll - a.aucAll);
}

export function applyTunedScorer(scorer: TunedTeeScorer, metrics: Readonly<Record<string, number>>): number {
	let score = 0;
	for (const entry of scorer.metrics) {
		const value = metrics[entry.name];
		if (!Number.isFinite(value)) return Number.NEGATIVE_INFINITY;
		score += entry.weight * ((value - entry.mean) / entry.std);
	}
	return score;
}

export interface GreedySearchOptions {
	/** Stop after this many metrics are combined. Defaults to 4. */
	readonly maxMetrics?: number;
	/** Candidate weights tried for each newly added metric. */
	readonly weightGrid?: readonly number[];
	/**
	 * Hole numbers whose truth patch must be locally rank 1 for a combination
	 * to be preferred; the search maximizes their margin first. Use this to
	 * force the overfit target (e.g. hole 5) into the winning set.
	 */
	readonly requiredHoleNumbers?: readonly number[];
}

interface CombinationScore {
	readonly minLocalMargin: number;
	readonly requiredMargin: number;
	readonly hardNegativeAuc: number;
}

const DEFAULT_WEIGHT_GRID = [-2, -1, -0.5, 0.5, 1, 2] as const;

function scoreCombination(
	scorer: TunedTeeScorer,
	samples: readonly MetricSample[],
	neighborhoods: readonly LocalNeighborhood[],
	requiredHoleNumbers: readonly number[]
): CombinationScore {
	let minLocalMargin = Number.POSITIVE_INFINITY;
	let requiredMargin = Number.POSITIVE_INFINITY;
	for (const neighborhood of neighborhoods) {
		const truthSample = samples[neighborhood.truthIndex];
		const truthScore = applyTunedScorer(scorer, truthSample.metrics);
		let bestDistractor = Number.NEGATIVE_INFINITY;
		for (const index of neighborhood.distractorIndices) {
			const score = applyTunedScorer(scorer, samples[index].metrics);
			if (score > bestDistractor) bestDistractor = score;
		}
		const margin = neighborhood.distractorIndices.length === 0 ? Number.POSITIVE_INFINITY : truthScore - bestDistractor;
		minLocalMargin = Math.min(minLocalMargin, margin);
		if (truthSample.holeNumber !== undefined && requiredHoleNumbers.includes(truthSample.holeNumber)) {
			requiredMargin = Math.min(requiredMargin, margin);
		}
	}
	const truthScores = samples.filter((sample) => sample.label === 'truth').map((sample) => applyTunedScorer(scorer, sample.metrics));
	const hardNegativeScores = samples
		.filter((sample) => sample.label === 'hard-negative')
		.map((sample) => applyTunedScorer(scorer, sample.metrics));
	return {
		minLocalMargin,
		requiredMargin,
		hardNegativeAuc: computeAuc(truthScores, hardNegativeScores)
	};
}

function betterCombination(a: CombinationScore, b: CombinationScore): boolean {
	if (a.requiredMargin !== b.requiredMargin) return a.requiredMargin > b.requiredMargin;
	if (a.minLocalMargin !== b.minLocalMargin) return a.minLocalMargin > b.minLocalMargin;
	return a.hardNegativeAuc > b.hardNegativeAuc;
}

function deriveThreshold(scorer: Omit<TunedTeeScorer, 'threshold' | 'minLocalMargin'>, samples: readonly MetricSample[]): number {
	const complete: TunedTeeScorer = { ...scorer, threshold: 0, minLocalMargin: 0 };
	const truthScores = samples
		.filter((sample) => sample.label === 'truth')
		.map((sample) => applyTunedScorer(complete, sample.metrics))
		.filter(Number.isFinite);
	const distractorScores = samples
		.filter((sample) => sample.label !== 'truth')
		.map((sample) => applyTunedScorer(complete, sample.metrics))
		.filter(Number.isFinite);
	if (truthScores.length === 0) return 0;
	const lowestTruth = Math.min(...truthScores);
	const distractorsBelow = distractorScores.filter((score) => score < lowestTruth);
	if (distractorsBelow.length === 0) return lowestTruth;
	return (lowestTruth + Math.max(...distractorsBelow)) / 2;
}

/**
 * Greedy forward selection of a z-scored weighted sum. Each round tries every
 * unused metric at every grid weight appended to the current combination and
 * keeps the single addition that most improves the objective: maximize the
 * required holes' local margin, then the global min local margin, then
 * hard-negative AUC. Stops when no addition improves or `maxMetrics` reached.
 */
export function greedySearchCombination(
	metricNames: readonly string[],
	samples: readonly MetricSample[],
	neighborhoods: readonly LocalNeighborhood[],
	options: GreedySearchOptions = {}
): TunedTeeScorer {
	const maxMetrics = options.maxMetrics ?? 4;
	const weightGrid = options.weightGrid ?? DEFAULT_WEIGHT_GRID;
	const requiredHoleNumbers = options.requiredHoleNumbers ?? [];
	const pooled = samples.filter((sample) => sample.label !== 'hard-negative');
	const normalization = new Map<string, { mean: number; std: number }>();
	for (const name of metricNames) {
		const values = metricValues(pooled, name).filter(Number.isFinite);
		// A constant (or near-constant, or mostly-unmeasurable) metric scores a
		// fake margin of exactly 0 everywhere, which would beat any honest
		// negative margin; exclude it from the search entirely.
		if (values.length < pooled.length * 0.5) continue;
		const center = mean(values);
		const std = standardDeviation(values, center);
		const spread = Math.max(...values) - Math.min(...values);
		if (spread === 0 || std < 1e-9) continue;
		normalization.set(name, { mean: center, std });
	}

	let current: TunedTeeScorer['metrics'] = [];
	let currentScore: CombinationScore = {
		minLocalMargin: Number.NEGATIVE_INFINITY,
		requiredMargin: Number.NEGATIVE_INFINITY,
		hardNegativeAuc: 0
	};
	for (let round = 0; round < maxMetrics; round += 1) {
		let bestAddition: TunedTeeScorer['metrics'] | undefined;
		let bestScore = currentScore;
		for (const name of metricNames) {
			if (current.some((entry) => entry.name === name)) continue;
			const stats = normalization.get(name);
			if (!stats) continue;
			for (const weight of weightGrid) {
				const candidate = [...current, { name, weight, mean: stats.mean, std: stats.std }];
				const score = scoreCombination(
					{ metrics: candidate, threshold: 0, minLocalMargin: 0 },
					samples,
					neighborhoods,
					requiredHoleNumbers
				);
				if (betterCombination(score, bestScore)) {
					bestScore = score;
					bestAddition = candidate;
				}
			}
		}
		if (!bestAddition) break;
		current = bestAddition;
		currentScore = bestScore;
	}
	const threshold = deriveThreshold({ metrics: current }, samples);
	return { metrics: current, threshold, minLocalMargin: currentScore.minLocalMargin };
}
