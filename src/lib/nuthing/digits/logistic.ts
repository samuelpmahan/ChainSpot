/**
 * Tiny interpretable multinomial logistic regression for NuThing P2 digit
 * classification: P(d = k) = softmax(W x + b), where x is the 768-dim
 * (24x32) binary pixel vector of a normalized digit mask (see
 * `src/lib/nuthing/digits/normalize.ts` for the canonical mask format,
 * which every experiment -- this one included -- must consume unchanged).
 *
 * Design goal: browser inference is exactly one 10x768 matrix multiply plus
 * a bias add and a softmax, and every learned weight W[k][j] is directly
 * interpretable as "how much pixel j (at its 24x32 spatial position)
 * pushes evidence toward digit k" -- see scripts/nuthing/visualize-logistic.ts
 * for the coefficient maps this buys us.
 *
 * Pure TypeScript, dependency-free, deterministic:
 *   - zero-initialized W and b (no RNG anywhere in this module or its
 *     callers -- two calls to trainLogisticRegression with identical
 *     arguments produce bit-identical output);
 *   - full-batch gradient descent (every sample contributes to every
 *     update -- no minibatching, no shuffling, so there is no ordering
 *     nondeterminism either);
 *   - a fixed inverse-time learning-rate schedule and a fixed iteration
 *     count (see hyperparameters below);
 *   - L2 regularization on W only (never on the bias).
 *
 * Class weighting: the labeled train split is heavily imbalanced (class
 * '1' is 82 of 194 samples). classBalanceWeights() assigns each sample a
 * weight of 1 / classCount[label], rescaled to average 1 across the
 * sample set, so every digit class contributes equally to the gradient
 * regardless of how often it appears. This is applied by default inside
 * trainLogisticRegression(); callers combining real + synthetic data can
 * instead pass an explicit `weights` array (e.g. to also account for the
 * real/synthetic mix) -- see scripts/nuthing/train-logistic.ts.
 */

import { DIGIT_W, DIGIT_H, digitFromBase64 } from './normalize';

/** Feature dimensionality: one 0/1 feature per pixel of the 24x32 mask. */
export const NUM_FEATURES = DIGIT_W * DIGIT_H; // 768

export const CLASSES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
export type DigitClass = (typeof CLASSES)[number];
export const NUM_CLASSES = CLASSES.length; // 10

/**
 * Model hyperparameters, fixed and documented (no tuning inside this
 * module -- lambda is chosen externally by LOIO cross-validation, see
 * scripts/nuthing/train-logistic.ts).
 *
 *   lr_t = LEARNING_RATE_INITIAL / (1 + LEARNING_RATE_DECAY * t)
 *
 * DEFAULT_ITERATIONS was chosen empirically as the point past which the
 * weighted training cross-entropy stops improving by more than 1e-5 per
 * 100 iterations for every lambda in the grid (see
 * docs/nuthing-p2/logistic-classifier.md).
 */
export const LEARNING_RATE_INITIAL = 3.0;
export const LEARNING_RATE_DECAY = 0.004;
export const DEFAULT_ITERATIONS = 800;

export interface LogisticModel {
	classes: string[]; // CLASSES, order defines the score/probability vector order
	W: number[][]; // NUM_CLASSES x NUM_FEATURES
	b: number[]; // NUM_CLASSES
	lambda: number;
	iters: number;
}

export interface TrainSample {
	/** length NUM_FEATURES, values in {0,1} (a decoded normalized digit mask). */
	features: Uint8Array | number[];
	/** index into CLASSES, 0..9 */
	label: number;
}

function softmaxInPlace(z: Float64Array, rowStart: number, k: number): void {
	let max = -Infinity;
	for (let j = 0; j < k; j++) {
		const v = z[rowStart + j];
		if (v > max) max = v;
	}
	let sum = 0;
	for (let j = 0; j < k; j++) {
		const e = Math.exp(z[rowStart + j] - max);
		z[rowStart + j] = e;
		sum += e;
	}
	const inv = sum > 0 ? 1 / sum : 0;
	for (let j = 0; j < k; j++) z[rowStart + j] *= inv;
}

/** Numerically stable softmax over a plain array (used at inference time). */
export function softmax(logits: number[]): number[] {
	const k = logits.length;
	const z = Float64Array.from(logits);
	softmaxInPlace(z, 0, k);
	return Array.from(z);
}

/**
 * Per-sample class-balance weights: weight_i = 1 / classCount[label_i],
 * rescaled so the weights average to 1 across `labels`. Counters the '1'
 * imbalance by making every digit class contribute equally to the
 * gradient no matter how many samples of that class are present.
 */
export function classBalanceWeights(labels: ArrayLike<number>, numClasses: number): Float64Array {
	const n = labels.length;
	const counts = new Array(numClasses).fill(0);
	for (let i = 0; i < n; i++) counts[labels[i]]++;
	const raw = new Float64Array(n);
	let sum = 0;
	for (let i = 0; i < n; i++) {
		const c = counts[labels[i]];
		const w = c > 0 ? 1 / c : 0;
		raw[i] = w;
		sum += w;
	}
	const scale = sum > 0 ? n / sum : 1;
	for (let i = 0; i < n; i++) raw[i] *= scale;
	return raw;
}

export interface TrainOptions {
	/** L2 regularization strength on W (never applied to b). */
	lambda: number;
	iters?: number; // default DEFAULT_ITERATIONS
	learningRateInitial?: number; // default LEARNING_RATE_INITIAL
	learningRateDecay?: number; // default LEARNING_RATE_DECAY
	/**
	 * Optional externally supplied per-sample weights (e.g. to also fold in
	 * a real/synthetic mixing weight). Defaults to classBalanceWeights()
	 * over `samples`' labels.
	 */
	weights?: ArrayLike<number>;
}

/**
 * Deterministic full-batch gradient descent on the L2-regularized
 * multinomial softmax cross-entropy loss:
 *
 *   L(W,b) = (1 / sum(weight)) * sum_i weight_i * CE(softmax(W x_i + b), y_i)
 *            + (lambda / 2) * ||W||_2^2
 *
 * Zero-initialized W, b. No RNG. Given identical (samples order, options),
 * two calls produce bit-identical W and b.
 */
export function trainLogisticRegression(
	samples: TrainSample[],
	options: TrainOptions
): LogisticModel {
	const n = samples.length;
	const d = NUM_FEATURES;
	const k = NUM_CLASSES;
	const iters = options.iters ?? DEFAULT_ITERATIONS;
	const lr0 = options.learningRateInitial ?? LEARNING_RATE_INITIAL;
	const decay = options.learningRateDecay ?? LEARNING_RATE_DECAY;
	const lambda = options.lambda;

	if (n === 0) {
		return {
			classes: [...CLASSES],
			W: Array.from({ length: k }, () => new Array(d).fill(0)),
			b: new Array(k).fill(0),
			lambda,
			iters
		};
	}

	// Flatten features into row-major X (n x d) once; avoids re-touching the
	// caller's arrays (which may be Uint8Array or number[]) on every iter.
	const X = new Float64Array(n * d);
	const labels = new Int32Array(n);
	for (let i = 0; i < n; i++) {
		const f = samples[i].features;
		const row = i * d;
		for (let j = 0; j < d; j++) X[row + j] = f[j];
		labels[i] = samples[i].label;
	}

	const weights =
		options.weights !== undefined
			? Float64Array.from(options.weights)
			: classBalanceWeights(labels, k);
	let weightSum = 0;
	for (let i = 0; i < n; i++) weightSum += weights[i];
	const invWeightSum = weightSum > 0 ? 1 / weightSum : 1;

	const W = new Float64Array(k * d); // zero-init
	const b = new Float64Array(k); // zero-init
	const Z = new Float64Array(n * k); // reused logits/probs buffer
	const gW = new Float64Array(k * d);
	const gb = new Float64Array(k);

	for (let t = 0; t < iters; t++) {
		// Forward pass: Z[i] = softmax(W x_i + b)
		for (let i = 0; i < n; i++) {
			const xRow = i * d;
			const zRow = i * k;
			for (let c = 0; c < k; c++) {
				let s = b[c];
				const wRow = c * d;
				for (let j = 0; j < d; j++) s += W[wRow + j] * X[xRow + j];
				Z[zRow + c] = s;
			}
			softmaxInPlace(Z, zRow, k);
		}

		// Gradient of the weighted mean cross-entropy + L2 penalty.
		gW.fill(0);
		gb.fill(0);
		for (let i = 0; i < n; i++) {
			const wgt = weights[i];
			const zRow = i * k;
			const xRow = i * d;
			const label = labels[i];
			for (let c = 0; c < k; c++) {
				const p = Z[zRow + c];
				const y = c === label ? 1 : 0;
				const diff = wgt * (p - y);
				gb[c] += diff;
				const gwRow = c * d;
				for (let j = 0; j < d; j++) gW[gwRow + j] += diff * X[xRow + j];
			}
		}

		const lr = lr0 / (1 + decay * t);
		for (let c = 0; c < k; c++) {
			const wRow = c * d;
			for (let j = 0; j < d; j++) {
				const reg = lambda * W[wRow + j];
				W[wRow + j] -= lr * (gW[wRow + j] * invWeightSum + reg);
			}
			b[c] -= lr * gb[c] * invWeightSum;
		}
	}

	const Wout: number[][] = [];
	for (let c = 0; c < k; c++) {
		const row = new Array(d);
		const wRow = c * d;
		for (let j = 0; j < d; j++) row[j] = W[wRow + j];
		Wout.push(row);
	}
	return { classes: [...CLASSES], W: Wout, b: Array.from(b), lambda, iters };
}

/** Softmax class probabilities, in CLASSES order, for one feature vector. */
export function predictProbs(model: LogisticModel, features: ArrayLike<number>): number[] {
	const k = model.classes.length;
	const d = model.W[0]?.length ?? NUM_FEATURES;
	const z = new Array(k);
	for (let c = 0; c < k; c++) {
		let s = model.b[c];
		const Wc = model.W[c];
		for (let j = 0; j < d; j++) s += Wc[j] * features[j];
		z[c] = s;
	}
	return softmax(z);
}

/** Highest-probability class label (a member of model.classes). */
export function predictClass(model: LogisticModel, features: ArrayLike<number>): string {
	const probs = predictProbs(model, features);
	let best = 0;
	for (let c = 1; c < probs.length; c++) if (probs[c] > probs[best]) best = c;
	return model.classes[best];
}

/** Decode a dataset sample's base64 mask field into the raw feature vector. */
export function featuresFromBase64Mask(mask: string): Uint8Array {
	return digitFromBase64(mask);
}

export function classIndex(digit: string): number {
	return (CLASSES as readonly string[]).indexOf(digit);
}
