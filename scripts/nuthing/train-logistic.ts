// Train the tiny interpretable multinomial logistic regression classifier
// (src/lib/nuthing/digits/logistic.ts) for NuThing P2 hole-number digit
// recognition, in two variants:
//
//   variant 1 ("real"):        trained on the labeled train split only.
//   variant 2 ("real+synth"):  trained on the labeled train split plus the
//                               synthetic dataset, if it exists on disk.
//
// L2 lambda is chosen ONCE, by leave-one-image-out (LOIO) cross-validation
// over the labeled train split only (never the heldout split, never
// synthetic data), then reused for both variants' final training so the
// two variants are directly comparable classifiers, not a lambda sweep vs
// a fixed value.
//
// Reads:
//   resources/nuthing-p2/digits/digit-dataset.json          (real, train+heldout)
//   /workspace/nuthing-work/digits/synthetic-dataset.json    (synthetic, optional)
//
// Writes:
//   resources/nuthing-p2/digits/models/logistic.json         (variant 1 model)
//   resources/nuthing-p2/digits/models/logistic-synth.json   (variant 2 model, if synthetic present)
//   /workspace/nuthing-work/digits/results-logistic.json       (variant 1 predictions, eval-digits.ts schema)
//   /workspace/nuthing-work/digits/results-logistic-synth.json (variant 2 predictions, eval-digits.ts schema)
//
// Usage: npx tsx scripts/nuthing/train-logistic.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  trainLogisticRegression,
  predictProbs,
  classIndex,
  featuresFromBase64Mask,
  CLASSES,
  NUM_FEATURES,
  type LogisticModel,
  type TrainSample,
} from '../../src/lib/nuthing/digits/logistic';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const DATASET_PATH = join(REPO_ROOT, 'resources', 'nuthing-p2', 'digits', 'digit-dataset.json');
const SYNTHETIC_PATH = '/workspace/nuthing-work/digits/synthetic-dataset.json';
const MODELS_DIR = join(REPO_ROOT, 'resources', 'nuthing-p2', 'digits', 'models');
const MODEL_REAL_PATH = join(MODELS_DIR, 'logistic.json');
const MODEL_SYNTH_PATH = join(MODELS_DIR, 'logistic-synth.json');
const RESULTS_REAL_PATH = '/workspace/nuthing-work/digits/results-logistic.json';
const RESULTS_SYNTH_PATH = '/workspace/nuthing-work/digits/results-logistic-synth.json';

const LAMBDA_GRID = [1e-4, 1e-3, 1e-2, 1e-1];

interface DatasetSample {
  id: string;
  badgeId: string;
  image: string;
  split: 'train' | 'heldout';
  digitIndex: number;
  trueDigit: string | null;
  mask: string;
  rawWidth: number;
  rawHeight: number;
}

interface Dataset {
  samples: DatasetSample[];
}

interface SyntheticSample {
  id: string;
  split: 'synthetic';
  trueDigit: string;
  mask: string;
}

interface SyntheticDataset {
  samples: SyntheticSample[];
}

interface LabeledExample {
  id: string;
  image: string; // for LOIO grouping; synthetic samples get a synthetic-only pseudo-image (never mixed into real LOIO folds)
  features: Uint8Array;
  label: number;
  provenance: 'real' | 'synthetic';
}

function loadRealExamples(ds: Dataset): { train: LabeledExample[]; all: DatasetSample[] } {
  const train: LabeledExample[] = [];
  for (const s of ds.samples) {
    if (s.split !== 'train' || s.trueDigit === null) continue;
    train.push({
      id: s.id,
      image: s.image,
      features: featuresFromBase64Mask(s.mask),
      label: classIndex(s.trueDigit),
      provenance: 'real',
    });
  }
  return { train, all: ds.samples };
}

function loadSyntheticExamples(): LabeledExample[] | null {
  if (!existsSync(SYNTHETIC_PATH)) return null;
  const syn = JSON.parse(readFileSync(SYNTHETIC_PATH, 'utf8')) as SyntheticDataset;
  return syn.samples.map((s) => ({
    id: s.id,
    image: `__synthetic__`, // never used for LOIO folds (synthetic is excluded from CV)
    features: featuresFromBase64Mask(s.mask),
    label: classIndex(s.trueDigit),
    provenance: 'synthetic' as const,
  }));
}

/** Leave-one-image-out cross-validation accuracy for one lambda, over `examples` (grouped by .image). */
function loioAccuracy(examples: LabeledExample[], lambda: number): { accuracy: number; folds: number; perFold: { image: string; n: number; correct: number }[] } {
  const images = [...new Set(examples.map((e) => e.image))];
  let totalCorrect = 0;
  let totalCount = 0;
  const perFold: { image: string; n: number; correct: number }[] = [];
  for (const heldImage of images) {
    const foldTrain: TrainSample[] = [];
    const foldTest: LabeledExample[] = [];
    for (const e of examples) {
      if (e.image === heldImage) foldTest.push(e);
      else foldTrain.push({ features: e.features, label: e.label });
    }
    const model = trainLogisticRegression(foldTrain, { lambda });
    let correct = 0;
    for (const e of foldTest) {
      const probs = predictProbs(model, e.features);
      let best = 0;
      for (let c = 1; c < probs.length; c++) if (probs[c] > probs[best]) best = c;
      if (best === e.label) correct++;
    }
    totalCorrect += correct;
    totalCount += foldTest.length;
    perFold.push({ image: heldImage, n: foldTest.length, correct });
  }
  return { accuracy: totalCount > 0 ? totalCorrect / totalCount : 0, folds: images.length, perFold };
}

function chooseLambda(examples: LabeledExample[]): {
  chosen: number;
  grid: { lambda: number; accuracy: number; folds: number }[];
  perFoldByLambda: Record<number, { image: string; n: number; correct: number }[]>;
} {
  const grid: { lambda: number; accuracy: number; folds: number }[] = [];
  const perFoldByLambda: Record<number, { image: string; n: number; correct: number }[]> = {};
  for (const lambda of LAMBDA_GRID) {
    const { accuracy, folds, perFold } = loioAccuracy(examples, lambda);
    grid.push({ lambda, accuracy, folds });
    perFoldByLambda[lambda] = perFold;
    console.log(`  lambda=${lambda}: LOIO accuracy ${(accuracy * 100).toFixed(2)}% (${folds} folds)`);
  }
  // Highest LOIO accuracy wins; ties broken toward the LARGER lambda
  // (stronger regularization = simpler, more spatially-smooth W, preferred
  // when it costs nothing in cross-validated accuracy).
  let chosen = grid[0];
  for (const g of grid) {
    if (g.accuracy > chosen.accuracy || (g.accuracy === chosen.accuracy && g.lambda > chosen.lambda)) {
      chosen = g;
    }
  }
  return { chosen: chosen.lambda, grid, perFoldByLambda };
}

function buildTrainSamples(examples: LabeledExample[]): { samples: TrainSample[]; weights: Float64Array } {
  const samples: TrainSample[] = examples.map((e) => ({ features: e.features, label: e.label }));
  // Class-balance weights computed over the WHOLE combined set (real +
  // synthetic together where applicable), so every digit class contributes
  // equally to the gradient regardless of how the class's samples split
  // between real and synthetic provenance.
  const counts = new Array(CLASSES.length).fill(0);
  for (const e of examples) counts[e.label]++;
  const weights = new Float64Array(examples.length);
  let sum = 0;
  for (let i = 0; i < examples.length; i++) {
    const c = counts[examples[i].label];
    const w = c > 0 ? 1 / c : 0;
    weights[i] = w;
    sum += w;
  }
  const scale = sum > 0 ? examples.length / sum : 1;
  for (let i = 0; i < weights.length; i++) weights[i] *= scale;
  return { samples, weights };
}

function measureWarmInferenceMs(model: LogisticModel, features: Uint8Array[]): number {
  if (features.length === 0) return 0;
  // Warm up the JIT.
  for (let i = 0; i < 50; i++) predictProbs(model, features[i % features.length]);
  const times: number[] = [];
  for (const f of features) {
    const t0 = performance.now();
    predictProbs(model, f);
    const t1 = performance.now();
    times.push(t1 - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

function predictAll(
  model: LogisticModel,
  allDatasetSamples: DatasetSample[],
  runtimeMsPerSample: number,
): { id: string; predicted: string; scores: number[]; runtimeMsPerSample: number }[] {
  const out: { id: string; predicted: string; scores: number[]; runtimeMsPerSample: number }[] = [];
  for (const s of allDatasetSamples) {
    const features = featuresFromBase64Mask(s.mask);
    const scores = predictProbs(model, features);
    let best = 0;
    for (let c = 1; c < scores.length; c++) if (scores[c] > scores[best]) best = c;
    out.push({ id: s.id, predicted: model.classes[best], scores, runtimeMsPerSample });
  }
  return out;
}

function main(): void {
  mkdirSync(MODELS_DIR, { recursive: true });

  console.log('Loading real dataset...');
  const ds = JSON.parse(readFileSync(DATASET_PATH, 'utf8')) as Dataset;
  const { train: realTrain, all } = loadRealExamples(ds);
  console.log(`  ${realTrain.length} labeled train samples across ${new Set(realTrain.map((e) => e.image)).size} images`);

  console.log('LOIO cross-validation (train split only) for L2 lambda...');
  const { chosen: lambda, grid } = chooseLambda(realTrain);
  console.log(`Chosen lambda = ${lambda}`);

  // ---- Variant 1: real only ----
  console.log('Training variant 1 (real only)...');
  const { samples: realSamples, weights: realWeights } = buildTrainSamples(realTrain);
  const t0 = Date.now();
  const modelReal = trainLogisticRegression(realSamples, { lambda, weights: realWeights });
  console.log(`  trained in ${Date.now() - t0}ms`);
  writeFileSync(MODEL_REAL_PATH, JSON.stringify(modelReal));
  console.log(`  model -> ${MODEL_REAL_PATH}`);

  const allFeaturesReal = all.map((s) => featuresFromBase64Mask(s.mask));
  const warmMsReal = measureWarmInferenceMs(modelReal, allFeaturesReal);
  console.log(`  warm median inference: ${warmMsReal.toFixed(4)}ms/sample`);
  const predsReal = predictAll(modelReal, all, warmMsReal);
  writeFileSync(
    RESULTS_REAL_PATH,
    JSON.stringify(
      {
        classifier: 'logistic-regression',
        model: 'resources/nuthing-p2/digits/models/logistic.json',
        trainedOn: ['train-real'],
        hyperparameters: {
          lambda,
          iters: modelReal.iters,
          lambdaGrid: grid,
          numFeatures: NUM_FEATURES,
          trainSamples: realTrain.length,
        },
        predictions: predsReal,
      },
      null,
      2,
    ),
  );
  console.log(`  predictions -> ${RESULTS_REAL_PATH}`);

  // ---- Variant 2: real + synthetic ----
  const synthetic = loadSyntheticExamples();
  if (synthetic === null) {
    console.log('No synthetic dataset found at ' + SYNTHETIC_PATH + '; skipping variant 2.');
  } else {
    console.log(`Training variant 2 (real + synthetic, ${synthetic.length} synthetic samples)...`);
    const combined = [...realTrain, ...synthetic];
    const { samples: combinedSamples, weights: combinedWeights } = buildTrainSamples(combined);
    const t1 = Date.now();
    const modelSynth = trainLogisticRegression(combinedSamples, { lambda, weights: combinedWeights });
    console.log(`  trained in ${Date.now() - t1}ms`);
    writeFileSync(MODEL_SYNTH_PATH, JSON.stringify(modelSynth));
    console.log(`  model -> ${MODEL_SYNTH_PATH}`);

    const warmMsSynth = measureWarmInferenceMs(modelSynth, allFeaturesReal);
    console.log(`  warm median inference: ${warmMsSynth.toFixed(4)}ms/sample`);
    const predsSynth = predictAll(modelSynth, all, warmMsSynth);
    writeFileSync(
      RESULTS_SYNTH_PATH,
      JSON.stringify(
        {
          classifier: 'logistic-regression-synth',
          model: 'resources/nuthing-p2/digits/models/logistic-synth.json',
          trainedOn: ['train-real', 'synthetic'],
          hyperparameters: {
            lambda,
            iters: modelSynth.iters,
            lambdaGrid: grid,
            numFeatures: NUM_FEATURES,
            trainSamplesReal: realTrain.length,
            trainSamplesSynthetic: synthetic.length,
          },
          predictions: predsSynth,
        },
        null,
        2,
      ),
    );
    console.log(`  predictions -> ${RESULTS_SYNTH_PATH}`);
  }

  console.log('Done.');
}

main();
