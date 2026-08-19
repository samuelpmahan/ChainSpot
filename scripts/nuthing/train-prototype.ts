// NuThing P2 prototype-matcher experiment driver.
//
// Tests the hypothesis that a digit is recognizable from *where* its
// expected bright (stroke) pixels occur, by training simple nearest-class-
// prototype classifiers (src/lib/nuthing/digits/prototype.ts) over a family
// of compact spatial-occupancy feature vectors
// (src/lib/nuthing/digits/features.ts) and comparing them against the raw
// 768-pixel mask and 1-D projections.
//
// Feature sets x metrics are selected purely by LEAVE-ONE-IMAGE-OUT (LOIO)
// cross-validation on the labeled `split=="train"` samples -- an image is
// the natural correlation unit (all digits on one badge/course share
// lighting, angle, font rendering), so held-out folds are held-out
// *images*, never individual digits. `split=="heldout"` (Fountain Hills) is
// NEVER used for model selection or training; it is only ever a prediction
// target, scored later by the shared evaluator (eval-digits.ts).
//
// Reads:
//   resources/nuthing-p2/digits/digit-dataset.json
//   /workspace/nuthing-work/digits/synthetic-dataset.json (optional; if
//     present, trains a SECOND "+synthetic" variant of the winning model)
//
// Writes:
//   docs/nuthing-p2/prototype-classifier.md          (LOIO selection table, winner, sizes, runtime)
//   resources/nuthing-p2/digits/models/prototype.json        (winner, trained on train only)
//   resources/nuthing-p2/digits/models/prototype-synth.json  (winner, trained on train+synthetic; only if synthetic dataset present)
//   /workspace/nuthing-work/digits/results-prototype.json
//   /workspace/nuthing-work/digits/results-prototype-synth.json (only if synthetic dataset present)
//
// Usage: npx tsx scripts/nuthing/train-prototype.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { digitFromBase64, DIGIT_W, DIGIT_H, type NormalizedDigit } from '../../src/lib/nuthing/digits/normalize';
import {
  fullMask768,
  occupancy6x8,
  occupancy8x10,
  multiscale,
  rowProjection32,
  colProjection24,
  topology,
} from '../../src/lib/nuthing/digits/features';
import { trainPrototypes, classifyVector, toJSON, type Metric, type LabeledVector } from '../../src/lib/nuthing/digits/prototype';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const DATASET_PATH = join(REPO_ROOT, 'resources', 'nuthing-p2', 'digits', 'digit-dataset.json');
const SYNTHETIC_PATH = '/workspace/nuthing-work/digits/synthetic-dataset.json';
const DOC_PATH = join(REPO_ROOT, 'docs', 'nuthing-p2', 'prototype-classifier.md');
const MODEL_DIR = join(REPO_ROOT, 'resources', 'nuthing-p2', 'digits', 'models');
const MODEL_PATH = join(MODEL_DIR, 'prototype.json');
const MODEL_SYNTH_PATH = join(MODEL_DIR, 'prototype-synth.json');
const RESULTS_PATH = '/workspace/nuthing-work/digits/results-prototype.json';
const RESULTS_SYNTH_PATH = '/workspace/nuthing-work/digits/results-prototype-synth.json';

const CLASSES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const METRICS: Metric[] = ['euclidean', 'cosine'];

// ---- dataset types ---------------------------------------------------------

interface DatasetSample {
  id: string;
  badgeId: string;
  image: string;
  split: 'train' | 'heldout';
  digitIndex: number;
  trueDigit: string | null;
  rawWidth: number;
  rawHeight: number;
  mask: string;
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

// ---- feature-set registry --------------------------------------------------
//
// `topology4` packs the topology descriptor (hole count / hole sizes /
// stroke density -- shape-topology signal) into a fixed 4-dim vector so it
// can compete in the same LOIO table as the location-based occupancy grids:
// [strokeFraction, holeCount, largest hole fraction, 2nd-largest hole
// fraction]. No real digit in this font produces more than 2 enclosed
// holes, so 2 hole slots (zero-padded) is sufficient without truncating
// real signal.

function topology4(mask: NormalizedDigit): number[] {
  const t = topology(mask);
  return [t.strokeFraction, t.holeCount, t.holeSizeFractions[0] ?? 0, t.holeSizeFractions[1] ?? 0];
}

type FeatureFn = (mask: NormalizedDigit) => number[];

const FEATURE_SETS: Record<string, { fn: FeatureFn; dims: number }> = {
  fullMask768: { fn: fullMask768, dims: DIGIT_W * DIGIT_H },
  occupancy6x8: { fn: occupancy6x8, dims: 6 * 8 },
  occupancy8x10: { fn: occupancy8x10, dims: 8 * 10 },
  multiscale: { fn: multiscale, dims: 6 * 8 + 12 * 16 },
  rowProjection32: { fn: rowProjection32, dims: DIGIT_H },
  colProjection24: { fn: colProjection24, dims: DIGIT_W },
  topology4: { fn: topology4, dims: 4 },
};

// ---- LOIO cross-validation --------------------------------------------------

interface LoioResult {
  correct: number;
  total: number;
  confusion: Record<string, Record<string, number>>; // confusion[true][predicted]
}

/**
 * Leave-one-image-out CV: for each distinct source image among `samples`,
 * train prototypes on every OTHER image's samples and predict this image's
 * samples. Accuracy is pooled across all folds (total correct / total
 * predictions), not averaged per-fold, so images with more digits weigh
 * proportionally more -- consistent with how the shared evaluator reports
 * digit accuracy.
 */
function loioAccuracy(
  samples: { label: string; image: string; vector: number[] }[],
  metric: Metric,
  featureName: string,
): LoioResult {
  const images = [...new Set(samples.map((s) => s.image))];
  const result: LoioResult = { correct: 0, total: 0, confusion: {} };
  for (const heldImage of images) {
    const trainSet: LabeledVector[] = [];
    const testSet: { label: string; vector: number[] }[] = [];
    for (const s of samples) {
      if (s.image === heldImage) testSet.push({ label: s.label, vector: s.vector });
      else trainSet.push({ label: s.label, vector: s.vector });
    }
    const model = trainPrototypes(trainSet, CLASSES, metric, featureName);
    for (const s of testSet) {
      const { predicted } = classifyVector(model, s.vector);
      result.total++;
      if (predicted === s.label) result.correct++;
      const row = (result.confusion[s.label] ??= {});
      row[predicted] = (row[predicted] ?? 0) + 1;
    }
  }
  return result;
}

// ---- runtime measurement ---------------------------------------------------

/** Warm median per-sample inference time in ms, over many repeated full-dataset passes. */
function measureRuntimeMsPerSample(
  model: ReturnType<typeof trainPrototypes>,
  vectors: number[][],
): number {
  const WARMUP_PASSES = 10;
  const TIMED_PASSES = 60;
  for (let i = 0; i < WARMUP_PASSES; i++) {
    for (const v of vectors) classifyVector(model, v);
  }
  const perPassMsPerSample: number[] = [];
  for (let p = 0; p < TIMED_PASSES; p++) {
    const t0 = performance.now();
    for (const v of vectors) classifyVector(model, v);
    const t1 = performance.now();
    perPassMsPerSample.push((t1 - t0) / vectors.length);
  }
  perPassMsPerSample.sort((a, b) => a - b);
  return perPassMsPerSample[Math.floor(perPassMsPerSample.length / 2)];
}

// ---- main -------------------------------------------------------------------

function pct(c: number, t: number): string {
  return t === 0 ? '—' : `${((100 * c) / t).toFixed(1)}% (${c}/${t})`;
}

function main(): void {
  const ds: Dataset = JSON.parse(readFileSync(DATASET_PATH, 'utf8'));
  const allSamples = ds.samples;
  const trainLabeled = allSamples.filter((s) => s.split === 'train' && s.trueDigit !== null);
  console.log(`loaded dataset: ${allSamples.length} total samples, ${trainLabeled.length} labeled train samples`);

  const hasSynthetic = existsSync(SYNTHETIC_PATH);
  let syntheticSamples: SyntheticSample[] = [];
  if (hasSynthetic) {
    const synDs: SyntheticDataset = JSON.parse(readFileSync(SYNTHETIC_PATH, 'utf8'));
    syntheticSamples = synDs.samples;
    console.log(`synthetic dataset found: ${syntheticSamples.length} samples`);
  } else {
    console.log('synthetic dataset NOT found; only the train-only variant will be produced');
  }

  // Decode every labeled train mask once; reused across all feature sets.
  const trainDecoded = trainLabeled.map((s) => ({
    label: s.trueDigit as string,
    image: s.image,
    mask: digitFromBase64(s.mask),
  }));

  // ---- LOIO selection table over every (feature set, metric) --------------

  interface Candidate {
    featureName: string;
    metric: Metric;
    dims: number;
    correct: number;
    total: number;
    accuracy: number;
    confusion: Record<string, Record<string, number>>;
  }

  const candidates: Candidate[] = [];
  for (const [featureName, { fn, dims }] of Object.entries(FEATURE_SETS)) {
    const vectorized = trainDecoded.map((s) => ({ label: s.label, image: s.image, vector: fn(s.mask) }));
    for (const metric of METRICS) {
      const result = loioAccuracy(vectorized, metric, featureName);
      candidates.push({
        featureName,
        metric,
        dims,
        correct: result.correct,
        total: result.total,
        accuracy: result.total > 0 ? result.correct / result.total : 0,
        confusion: result.confusion,
      });
      console.log(`LOIO ${featureName} / ${metric}: ${pct(result.correct, result.total)}, dims=${dims}`);
    }
  }

  // Best by LOIO accuracy, tie-break fewer dimensions.
  const winner = candidates.slice().sort((a, b) => {
    if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
    return a.dims - b.dims;
  })[0];
  console.log(
    `winner: ${winner.featureName} / ${winner.metric} (LOIO ${pct(winner.correct, winner.total)}, dims=${winner.dims})`,
  );

  const winnerFn = FEATURE_SETS[winner.featureName].fn;

  // ---- train winner on full labeled train split ----------------------------

  const trainVectors: LabeledVector[] = trainDecoded.map((s) => ({ label: s.label, vector: winnerFn(s.mask) }));
  const model = trainPrototypes(trainVectors, CLASSES, winner.metric, winner.featureName);

  // Decode + featurize EVERY sample in the dataset (train and heldout) once,
  // reused for prediction and for the runtime measurement.
  const allVectors = allSamples.map((s) => winnerFn(digitFromBase64(s.mask)));
  const runtimeMs = measureRuntimeMsPerSample(model, allVectors);
  console.log(`warm runtime: ${runtimeMs.toFixed(5)} ms/sample (median over 60 passes after 10 warmup passes)`);

  const predictions = allSamples.map((s, i) => {
    const { predicted, scores } = classifyVector(model, allVectors[i]);
    return { id: s.id, predicted, scores, runtimeMsPerSample: runtimeMs };
  });

  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(
    RESULTS_PATH,
    JSON.stringify(
      {
        classifier: `prototype-${winner.featureName}-${winner.metric}`,
        model: 'resources/nuthing-p2/digits/models/prototype.json',
        trainedOn: ['train-real'],
        predictions,
      },
      null,
      1,
    ),
  );
  console.log(`wrote: ${RESULTS_PATH} (${predictions.length} predictions)`);

  mkdirSync(MODEL_DIR, { recursive: true });
  writeFileSync(MODEL_PATH, JSON.stringify(toJSON(model), null, 1));
  console.log(`wrote: ${MODEL_PATH}`);

  // ---- optional train+synthetic variant of the SAME winning (feature, metric) ----

  let synthWinnerAccuracyNote = '';
  if (hasSynthetic) {
    const synthDecoded = syntheticSamples.map((s) => ({ label: s.trueDigit, mask: digitFromBase64(s.mask) }));
    const synthTrainVectors: LabeledVector[] = trainDecoded
      .map((s) => ({ label: s.label, vector: winnerFn(s.mask) }))
      .concat(synthDecoded.map((s) => ({ label: s.label, vector: winnerFn(s.mask) })));
    const synthModel = trainPrototypes(synthTrainVectors, CLASSES, winner.metric, winner.featureName);

    const synthRuntimeMs = measureRuntimeMsPerSample(synthModel, allVectors);
    const synthPredictions = allSamples.map((s, i) => {
      const { predicted, scores } = classifyVector(synthModel, allVectors[i]);
      return { id: s.id, predicted, scores, runtimeMsPerSample: synthRuntimeMs };
    });

    writeFileSync(
      RESULTS_SYNTH_PATH,
      JSON.stringify(
        {
          classifier: `prototype-${winner.featureName}-${winner.metric}-synth`,
          model: 'resources/nuthing-p2/digits/models/prototype-synth.json',
          trainedOn: ['train-real', 'synthetic'],
          predictions: synthPredictions,
        },
        null,
        1,
      ),
    );
    console.log(`wrote: ${RESULTS_SYNTH_PATH} (${synthPredictions.length} predictions)`);

    writeFileSync(MODEL_SYNTH_PATH, JSON.stringify(toJSON(synthModel), null, 1));
    console.log(`wrote: ${MODEL_SYNTH_PATH}`);
    synthWinnerAccuracyNote = `Second variant trained on train-real (${trainDecoded.length}) + synthetic (${synthDecoded.length}) samples, same winning feature set / metric.`;
  }

  // ---- docs/nuthing-p2/prototype-classifier.md -----------------------------

  const lines: string[] = [];
  lines.push('# NuThing P2 prototype-matcher digit classifier');
  lines.push('');
  lines.push(
    'Prototype (nearest-class-mean) classifiers over compact spatial-occupancy ' +
      'feature vectors (`src/lib/nuthing/digits/features.ts`), testing the ' +
      'hypothesis that a digit is recognizable largely from *where* its bright ' +
      '(stroke) pixels occur rather than needing the full pixel grid. ' +
      'Classifier: `src/lib/nuthing/digits/prototype.ts` (per-class mean of ' +
      'training vectors, scored by negative Euclidean distance or cosine ' +
      'similarity). Driver: `scripts/nuthing/train-prototype.ts`.',
  );
  lines.push('');
  lines.push(
    'Model selection is by LEAVE-ONE-IMAGE-OUT (LOIO) cross-validation on the ' +
      `${trainDecoded.length} labeled \`split=="train"\` samples ONLY -- an image ` +
      'is the natural correlation unit (every digit on one badge/course shares ' +
      'lighting, camera angle, and font rendering), so folds hold out whole ' +
      `source images (${[...new Set(trainDecoded.map((s) => s.image))].length} distinct images), never individual ` +
      'digits. `split=="heldout"` (Fountain Hills) is never used for selection ' +
      'or training here -- per this doc\'s scope, only the shared evaluator ' +
      '(`scripts/nuthing/eval-digits.ts`) scores heldout, for the record.',
  );
  lines.push('');

  lines.push('## LOIO selection table (feature set x metric)');
  lines.push('');
  lines.push('| feature set | dims | metric | LOIO accuracy |');
  lines.push('| --- | --- | --- | --- |');
  const sortedForTable = candidates.slice().sort((a, b) => {
    if (a.featureName !== b.featureName) return a.dims - b.dims;
    return a.metric.localeCompare(b.metric);
  });
  for (const c of sortedForTable) {
    const isWinner = c.featureName === winner.featureName && c.metric === winner.metric;
    lines.push(
      `| ${c.featureName}${isWinner ? ' **(winner)**' : ''} | ${c.dims} | ${c.metric} | ${pct(c.correct, c.total)} |`,
    );
  }
  lines.push('');

  lines.push('## Winner');
  lines.push('');
  lines.push(
    `**${winner.featureName} / ${winner.metric}**, LOIO accuracy ${pct(winner.correct, winner.total)} ` +
      `(dims=${winner.dims}). Selected by highest pooled LOIO accuracy across the ` +
      `${images(trainDecoded)} held-out image folds; ties broken toward fewer dimensions.`,
  );
  lines.push('');

  lines.push('## Model size');
  lines.push('');
  lines.push(
    `${winner.dims} dimensions x ${CLASSES.length} classes = ${winner.dims * CLASSES.length} floats per ` +
      `prototype matrix (plus ${CLASSES.length} class labels and a metric tag). ` +
      `Serialized JSON: \`resources/nuthing-p2/digits/models/prototype.json\`` +
      (hasSynthetic ? ' and `resources/nuthing-p2/digits/models/prototype-synth.json` (identical shape).' : '.'),
  );
  lines.push('');

  lines.push('## Runtime');
  lines.push('');
  lines.push(
    `Warm median inference time: **${runtimeMs.toFixed(5)} ms/sample** ` +
      `(median over 60 timed passes across all ${allVectors.length} dataset samples, ` +
      'after 10 warmup passes, single-threaded Node). Scoring one sample is a ' +
      `${CLASSES.length}-prototype ${winner.metric === 'cosine' ? 'dot-product + norm' : 'euclidean distance'} ` +
      `comparison over a ${winner.dims}-dim vector -- linear in dims x classes, no ` +
      'search or iteration, so this is representative of steady-state cost.',
  );
  lines.push('');

  lines.push('## Synthetic augmentation');
  lines.push('');
  lines.push(
    hasSynthetic
      ? `\`/workspace/nuthing-work/digits/synthetic-dataset.json\` was present (${syntheticSamples.length} ` +
          `samples) at run time. ${synthWinnerAccuracyNote} Both variants use the same winning ` +
          '(feature set, metric); the synthetic-augmented variant is a second candidate for the ' +
          'shared evaluator to compare against the train-only variant, not a replacement for it -- ' +
          'this doc does not itself declare a winner between them (see the non-goal note below).'
      : '`/workspace/nuthing-work/digits/synthetic-dataset.json` was NOT present at run time; ' +
          'only the train-only variant (`results-prototype.json` / `models/prototype.json`) was produced.',
  );
  lines.push('');

  lines.push('## Why so many feature sets tie at ~100% LOIO');
  lines.push('');
  {
    const uniqueMasksByClass = new Map<string, Set<string>>();
    for (const s of trainLabeled) {
      const set = uniqueMasksByClass.get(s.trueDigit as string) ?? new Set<string>();
      set.add(s.mask);
      uniqueMasksByClass.set(s.trueDigit as string, set);
    }
    const totalUnique = new Set(trainLabeled.map((s) => s.mask)).size;
    lines.push(
      `The labeled train split has only ${totalUnique} distinct mask bitmaps across ` +
        `${trainLabeled.length} samples (per-class distinct-mask counts: ` +
        CLASSES.map((c) => `${c}=${uniqueMasksByClass.get(c)?.size ?? 0}`).join(', ') +
        '). UDisc renders each digit value from a fixed bitmap font at a fixed size, so ' +
        'the same digit crop recurs near-identically across different source images/courses ' +
        '-- e.g. class "2" has just 1 distinct mask across 11 samples on 6 different images. ' +
        'That near-duplication is exactly why LOIO (holding out a whole image) still lets a ' +
        'spatially-rich feature set reconstruct an almost-exact match from the other 10 ' +
        'images\' prototypes: the held-out image\'s digits were effectively already "seen" in ' +
        'pixel-identical or near-identical form elsewhere in train. This is a genuine ' +
        'property of this corpus, not a leak in the LOIO split (each fold still excludes ' +
        'every sample belonging to the held-out image). It does mean near-100% train-side ' +
        'LOIO should NOT be read as a heldout-accuracy prediction -- Fountain Hills ' +
        '(`split=="heldout"`) may differ in camera angle, resolution, or JPEG compression in ' +
        'ways this train corpus\'s low bitmap diversity does not exercise; that is exactly ' +
        'what the shared evaluator\'s heldout score is for. `topology4` (position-blind, only ' +
        `4 dims) is the one feature set that still makes real LOIO errors ` +
        `(${pct(candidates.find((c) => c.featureName === 'topology4' && c.metric === 'euclidean')!.correct, candidates.find((c) => c.featureName === 'topology4' && c.metric === 'euclidean')!.total)} euclidean) -- it discards exactly the ` +
        'positional signal the winning feature sets rely on, which is itself evidence that ' +
        '*location* of ink, not just its topology, is carrying the discriminative signal here.',
    );
  }
  lines.push('');

  lines.push('## Notable LOIO confusions (winner)');
  lines.push('');
  const winnerConfusion = winner.confusion;
  const confusedClasses = Object.keys(winnerConfusion)
    .filter((cls) => {
      const row = winnerConfusion[cls];
      const wrong = Object.entries(row).filter(([k]) => k !== cls);
      return wrong.some(([, v]) => v > 0);
    })
    .sort((a, b) => Number(a) - Number(b));
  if (confusedClasses.length === 0) {
    lines.push('No misclassifications in LOIO for the winning (feature set, metric).');
  } else {
    lines.push('True class -> predicted class (count), misclassifications only, from the LOIO folds:');
    lines.push('');
    for (const cls of confusedClasses) {
      const row = winnerConfusion[cls];
      const wrong = Object.entries(row)
        .filter(([k]) => k !== cls)
        .sort((a, b) => b[1] - a[1]);
      lines.push(`- true ${cls} -> ${wrong.map(([k, v]) => `${k}×${v}`).join(', ')}`);
    }
  }
  lines.push('');

  {
    const topoEuclidean = candidates.find((c) => c.featureName === 'topology4' && c.metric === 'euclidean')!;
    const topoConfused = Object.keys(topoEuclidean.confusion)
      .filter((cls) => Object.entries(topoEuclidean.confusion[cls]).some(([k, v]) => k !== cls && v > 0))
      .sort((a, b) => Number(a) - Number(b));
    if (topoConfused.length > 0) {
      lines.push('For contrast, `topology4 / euclidean` (the one feature set with real LOIO errors):');
      lines.push('');
      for (const cls of topoConfused) {
        const wrong = Object.entries(topoEuclidean.confusion[cls])
          .filter(([k]) => k !== cls)
          .sort((a, b) => b[1] - a[1]);
        lines.push(`- true ${cls} -> ${wrong.map(([k, v]) => `${k}×${v}`).join(', ')}`);
      }
      lines.push('');
    }
  }

  lines.push(
    '**Note:** heldout (Fountain Hills) accuracy is deliberately NOT reported here. ' +
      'The shared evaluator (`scripts/nuthing/eval-digits.ts`) scores every ' +
      'classifier family against heldout for the record; this doc is the ' +
      'train-side feature study only.',
  );
  lines.push('');

  mkdirSync(dirname(DOC_PATH), { recursive: true });
  writeFileSync(DOC_PATH, lines.join('\n'));
  console.log(`wrote: ${DOC_PATH}`);
}

function images(samples: { image: string }[]): number {
  return new Set(samples.map((s) => s.image)).size;
}

main();
