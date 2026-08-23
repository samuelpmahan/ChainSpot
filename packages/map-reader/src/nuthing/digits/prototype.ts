/**
 * Prototype (nearest-mean) classifiers over a feature-vector space.
 *
 * Pure TS, browser-portable, dependency-free. A prototype model reduces
 * training to: for each class, average its training feature vectors into
 * one prototype vector; classify a new sample by scoring it against every
 * class's prototype and taking the best score. This is the simplest
 * possible classifier over a feature space and is used here specifically
 * to test whether the compact occupancy/topology features in `features.ts`
 * carry enough signal on their own, without a learned decision boundary.
 *
 * Two scoring metrics are supported:
 *  - 'euclidean': score = -||x - prototype||  (higher is better, 0 is a
 *    perfect match) — sensitive to absolute vector magnitude.
 *  - 'cosine': score = cosine similarity between x and the prototype
 *    (range [-1, 1], higher is better) — scale-invariant, only compares
 *    direction, so it is less sensitive to e.g. overall stroke density
 *    differences between samples of the same digit.
 *
 * A trained model is a plain JSON-serializable object so it can be written
 * to resources/nuthing-p2/digits/models/*.json and loaded by both the
 * training script and (later) any consumer.
 */

export type Metric = 'euclidean' | 'cosine';

export interface PrototypeModel {
	featureName: string;
	/** Class labels, in the same order as `prototypes`. */
	classes: string[];
	/** One mean feature vector per class, same order as `classes`. */
	prototypes: number[][];
	metric: Metric;
}

export interface LabeledVector {
	label: string;
	vector: number[];
}

/**
 * Train a prototype model: per-class mean of training vectors. `classes`
 * fixes the output class order (pass all 10 digit classes even if some are
 * absent from `samples` — see `zeroFillMissingClasses`); a class with zero
 * training samples gets an all-zero prototype rather than being dropped, so
 * downstream consumers can rely on a fixed 10-row model shape.
 */
export function trainPrototypes(
	samples: LabeledVector[],
	classes: string[],
	metric: Metric,
	featureName: string
): PrototypeModel {
	const dims = samples.length > 0 ? samples[0].vector.length : 0;
	const sums = new Map<string, number[]>();
	const counts = new Map<string, number>();
	for (const c of classes) {
		sums.set(c, new Array<number>(dims).fill(0));
		counts.set(c, 0);
	}
	for (const s of samples) {
		const sum = sums.get(s.label);
		if (!sum) continue; // label outside the fixed class list is ignored
		for (let i = 0; i < s.vector.length; i++) sum[i] += s.vector[i];
		counts.set(s.label, (counts.get(s.label) ?? 0) + 1);
	}
	const prototypes: number[][] = classes.map((c) => {
		const sum = sums.get(c)!;
		const n = counts.get(c) ?? 0;
		return n > 0 ? sum.map((v) => v / n) : sum; // all-zero if n === 0
	});
	return { featureName, classes, prototypes, metric };
}

function euclideanDistance(a: number[], b: number[]): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) {
		const d = a[i] - (b[i] ?? 0);
		sum += d * d;
	}
	return Math.sqrt(sum);
}

function dot(a: number[], b: number[]): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i] * (b[i] ?? 0);
	return sum;
}

function norm(a: number[]): number {
	return Math.sqrt(dot(a, a));
}

function cosineSimilarity(a: number[], b: number[]): number {
	const na = norm(a);
	const nb = norm(b);
	if (na === 0 || nb === 0) return 0;
	return dot(a, b) / (na * nb);
}

/**
 * Score one feature vector against every class prototype in `model`, using
 * `model.metric`. Returns scores in `model.classes` order; higher is
 * always better regardless of metric (euclidean is negated distance).
 */
export function scoreVector(model: PrototypeModel, vector: number[]): number[] {
	return model.prototypes.map((proto) =>
		model.metric === 'cosine' ? cosineSimilarity(vector, proto) : -euclideanDistance(vector, proto)
	);
}

/** Classify one feature vector: predicted class + full per-class scores (model.classes order). */
export function classifyVector(
	model: PrototypeModel,
	vector: number[]
): { predicted: string; scores: number[] } {
	const scores = scoreVector(model, vector);
	let bestIdx = 0;
	for (let i = 1; i < scores.length; i++) {
		if (scores[i] > scores[bestIdx]) bestIdx = i;
	}
	return { predicted: model.classes[bestIdx], scores };
}

/** Serialize a model to a plain JSON-compatible object (identity — model is already plain JSON). */
export function toJSON(model: PrototypeModel): PrototypeModel {
	return {
		featureName: model.featureName,
		classes: model.classes.slice(),
		prototypes: model.prototypes.map((p) => p.slice()),
		metric: model.metric
	};
}

/** Parse a model from plain JSON (as produced by `toJSON` / `JSON.parse`), with light shape validation. */
export function fromJSON(json: unknown): PrototypeModel {
	const obj = json as PrototypeModel;
	if (
		!obj ||
		typeof obj.featureName !== 'string' ||
		!Array.isArray(obj.classes) ||
		!Array.isArray(obj.prototypes) ||
		(obj.metric !== 'euclidean' && obj.metric !== 'cosine')
	) {
		throw new Error('prototype.ts fromJSON: malformed PrototypeModel JSON');
	}
	return {
		featureName: obj.featureName,
		classes: obj.classes.slice(),
		prototypes: obj.prototypes.map((p) => p.slice()),
		metric: obj.metric
	};
}
