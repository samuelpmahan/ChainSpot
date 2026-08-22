/** Browser-only inference subset of LAB's deterministic digit classifier. */
export interface LogisticModel {
	readonly classes: readonly string[];
	readonly W: readonly (readonly number[])[];
	readonly b: readonly number[];
	readonly lambda: number;
	readonly iters: number;
}

function softmaxInPlace(values: Float64Array): void {
	let max = -Infinity;
	for (const value of values) if (value > max) max = value;
	let sum = 0;
	for (let index = 0; index < values.length; index++) {
		const exponential = Math.exp(values[index] - max);
		values[index] = exponential;
		sum += exponential;
	}
	const inverse = sum > 0 ? 1 / sum : 0;
	for (let index = 0; index < values.length; index++) values[index] *= inverse;
}

/** One 10x768 matrix multiply followed by softmax. */
export function predictProbs(model: LogisticModel, features: ArrayLike<number>): number[] {
	const classCount = model.classes.length;
	const featureCount = model.W[0]?.length ?? 768;
	const logits = new Float64Array(classCount);
	for (let classIndex = 0; classIndex < classCount; classIndex++) {
		let score = model.b[classIndex];
		const weights = model.W[classIndex];
		for (let featureIndex = 0; featureIndex < featureCount; featureIndex++) {
			score += weights[featureIndex] * features[featureIndex];
		}
		logits[classIndex] = score;
	}
	softmaxInPlace(logits);
	return Array.from(logits);
}
