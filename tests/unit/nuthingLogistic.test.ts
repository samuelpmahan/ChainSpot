import { describe, expect, it } from 'vitest';
import {
  trainLogisticRegression,
  predictClass,
  predictProbs,
  softmax,
  classBalanceWeights,
  NUM_FEATURES,
  NUM_CLASSES,
  CLASSES,
  type TrainSample,
} from '../../src/lib/nuthing/digits/logistic';

/**
 * Tiny, trivially linearly separable synthetic set: class k's samples all
 * have a single distinctive "marker" pixel (index k) turned on and every
 * other class's marker pixel turned off, plus a couple of shared "noise"
 * pixels that carry no class signal. A linear model should separate this
 * perfectly.
 */
function makeSeparableSamples(copiesPerClass: number): TrainSample[] {
  const samples: TrainSample[] = [];
  for (let k = 0; k < NUM_CLASSES; k++) {
    for (let copy = 0; copy < copiesPerClass; copy++) {
      const features = new Uint8Array(NUM_FEATURES);
      features[k] = 1; // marker pixel unique to this class
      // Shared noise pixels present in every sample regardless of class.
      features[NUM_FEATURES - 1] = 1;
      features[NUM_FEATURES - 2] = copy % 2;
      samples.push({ features, label: k });
    }
  }
  return samples;
}

describe('logistic regression training', () => {
  it('reaches 100% resubstitution accuracy on a tiny separable synthetic set', () => {
    const samples = makeSeparableSamples(4);
    const model = trainLogisticRegression(samples, { lambda: 1e-4 });
    let correct = 0;
    for (const s of samples) {
      const predicted = predictClass(model, s.features);
      if (predicted === CLASSES[s.label]) correct++;
    }
    expect(correct).toBe(samples.length);
  });

  it('produces softmax probability rows that sum to 1 for every sample', () => {
    const samples = makeSeparableSamples(3);
    const model = trainLogisticRegression(samples, { lambda: 1e-3 });
    for (const s of samples) {
      const probs = predictProbs(model, s.features);
      expect(probs).toHaveLength(NUM_CLASSES);
      const sum = probs.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 9);
      for (const p of probs) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  it('softmax() itself always normalizes to a distribution summing to 1', () => {
    const cases = [
      [0, 0, 0],
      [10, -10, 0, 5],
      [-3, -3, -3],
      [100, 0, -100],
    ];
    for (const logits of cases) {
      const probs = softmax(logits);
      expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      for (const p of probs) expect(p).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic: two trainings on identical input produce identical W and b', () => {
    const samples = makeSeparableSamples(3);
    const modelA = trainLogisticRegression(samples, { lambda: 1e-2, iters: 200 });
    const modelB = trainLogisticRegression(samples, { lambda: 1e-2, iters: 200 });
    expect(modelA.W).toEqual(modelB.W);
    expect(modelA.b).toEqual(modelB.b);
  });

  it('zero-initializes and never uses randomness (same seed-free call twice matches a third run too)', () => {
    const samples = makeSeparableSamples(2);
    const models = [0, 1, 2].map(() => trainLogisticRegression(samples, { lambda: 1e-2, iters: 150 }));
    expect(models[0].W).toEqual(models[1].W);
    expect(models[1].W).toEqual(models[2].W);
  });

  it('classBalanceWeights rescales inverse-frequency weights to average 1', () => {
    const labels = [0, 0, 0, 1, 2, 2, 2, 2]; // class 0: 3, class 1: 1, class 2: 4
    const weights = classBalanceWeights(labels, 3);
    expect(weights).toHaveLength(labels.length);
    const avg = Array.from(weights).reduce((a, b) => a + b, 0) / weights.length;
    expect(avg).toBeCloseTo(1, 9);
    // Class 1 (rarest, count=1) gets the largest per-sample weight.
    expect(weights[3]).toBeGreaterThan(weights[0]);
    expect(weights[3]).toBeGreaterThan(weights[4]);
    // All samples within the same class get equal weight.
    expect(weights[0]).toBeCloseTo(weights[1], 9);
    expect(weights[4]).toBeCloseTo(weights[5], 9);
  });

  it('model JSON matches the documented shape: classes, W[10][768], b[10]', () => {
    const samples = makeSeparableSamples(2);
    const model = trainLogisticRegression(samples, { lambda: 1e-2, iters: 50 });
    expect(model.classes).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(model.W).toHaveLength(NUM_CLASSES);
    for (const row of model.W) expect(row).toHaveLength(NUM_FEATURES);
    expect(model.b).toHaveLength(NUM_CLASSES);
    expect(model.lambda).toBe(1e-2);
    expect(model.iters).toBe(50);
    // Round-trips through JSON (as the serialized model artifact does).
    const roundTripped = JSON.parse(JSON.stringify(model));
    expect(roundTripped).toEqual(model);
  });
});
