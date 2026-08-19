// Normalize the synthetic digit masks produced by
// scripts/nuthing/synthesize-digits.py through the CANONICAL normalizer
// (src/lib/nuthing/digits/normalize.ts) so synthetic samples are
// byte-identical in representation to real digit samples
// (scripts/nuthing/build-digit-dataset.ts uses the same normalizer).
//
// Reads:
//   /workspace/nuthing-work/digits/synthetic-raw/index.json
//   /workspace/nuthing-work/digits/synthetic-raw/*.png (tight binary masks)
//
// Writes:
//   /workspace/nuthing-work/digits/synthetic-dataset.json  (all samples)
//   resources/nuthing-p2/digits/synthetic-dataset.sample.json
//     (first 5 samples per digit = 50 samples, committed so reviewers can
//     inspect the format without pulling the full generated file)
//
// Usage: npx tsx scripts/nuthing/normalize-synthetic.ts

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { normalizeDigitMask, digitToBase64, DIGIT_W, DIGIT_H } from '../../src/lib/nuthing/digits/normalize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const RAW_DIR = '/workspace/nuthing-work/digits/synthetic-raw';
const INDEX_PATH = join(RAW_DIR, 'index.json');
const OUT_PATH = '/workspace/nuthing-work/digits/synthetic-dataset.json';
const SAMPLE_OUT_PATH = join(
  REPO_ROOT,
  'resources',
  'nuthing-p2',
  'digits',
  'synthetic-dataset.sample.json',
);
const SAMPLES_PER_DIGIT_IN_COMMITTED_SAMPLE = 5;

interface ObstructionParams {
  kind: string;
  coverage: number;
  angleDeg: number | null;
  thickness: number;
}

interface RawIndexEntry {
  file: string;
  digit: string;
  sampleIndex: number;
  width: number;
  height: number;
  font: string;
  heightPx: number;
  translation: { dx: number; dy: number };
  threshold: number;
  morph: 'none' | 'erode' | 'dilate';
  blurSigma: number;
  jpegQuality: number | null;
  rotationDeg: number;
  obstruction: ObstructionParams | null;
}

interface RawIndex {
  generator: string;
  seed: number;
  samplesPerDigit: number;
  totalSamples: number;
  fonts: string[];
  samples: RawIndexEntry[];
}

interface OutSample {
  id: string;
  split: 'synthetic';
  provenanceClass: 'SYNTHETIC';
  trueDigit: string;
  mask: string;
  params: {
    font: string;
    heightPx: number;
    translation: { dx: number; dy: number };
    threshold: number;
    morph: 'none' | 'erode' | 'dilate';
    blurSigma: number;
    jpegQuality: number | null;
    rotationDeg: number;
    obstruction: ObstructionParams | null;
  };
}

/** Load a tight binary mask PNG (grayscale or RGBA, 0/255) into a 0/1 buffer. */
function loadMask(path: string): { width: number; height: number; data: Uint8Array } {
  const buf = readFileSync(path);
  const png = PNG.sync.read(buf);
  const { width, height, data } = png;
  const channels = data.length / (width * height);
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    if (data[p] >= 128) out[i] = 1;
  }
  return { width, height, data: out };
}

function main(): void {
  const index: RawIndex = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));

  const samples: OutSample[] = [];
  let n = 0;
  for (const entry of index.samples) {
    const pngPath = join(RAW_DIR, entry.file);
    const mask = loadMask(pngPath);
    if (mask.width !== entry.width || mask.height !== entry.height) {
      throw new Error(
        `${entry.file}: index dims ${entry.width}x${entry.height} != PNG dims ${mask.width}x${mask.height}`,
      );
    }
    const normalized = normalizeDigitMask(mask.data, mask.width, mask.height);
    n++;
    samples.push({
      id: `synth#${n}`,
      split: 'synthetic',
      provenanceClass: 'SYNTHETIC',
      trueDigit: entry.digit,
      mask: digitToBase64(normalized),
      params: {
        font: entry.font,
        heightPx: entry.heightPx,
        translation: entry.translation,
        threshold: entry.threshold,
        morph: entry.morph,
        blurSigma: entry.blurSigma,
        jpegQuality: entry.jpegQuality,
        rotationDeg: entry.rotationDeg,
        obstruction: entry.obstruction,
      },
    });
  }

  if (samples.length !== index.totalSamples) {
    throw new Error(
      `sample count mismatch: index.totalSamples=${index.totalSamples} but produced ${samples.length}`,
    );
  }

  const output = {
    generator: 'scripts/nuthing/synthesize-digits.py + normalize-synthetic.ts',
    normalization: `src/lib/nuthing/digits/normalize.ts DIGIT_W=${DIGIT_W} DIGIT_H=${DIGIT_H} aspect-preserving nearest-neighbor centered`,
    sourceIndex: {
      generator: index.generator,
      seed: index.seed,
      samplesPerDigit: index.samplesPerDigit,
      fonts: index.fonts,
    },
    samples,
  };
  const json = JSON.stringify(output, null, 1);

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, json);

  // ---- committed sample file: first N per digit -------------------------

  const perDigitCount: Record<string, number> = {};
  const sampleSubset: OutSample[] = [];
  for (const s of samples) {
    const count = perDigitCount[s.trueDigit] ?? 0;
    if (count < SAMPLES_PER_DIGIT_IN_COMMITTED_SAMPLE) {
      sampleSubset.push(s);
      perDigitCount[s.trueDigit] = count + 1;
    }
  }

  const sampleOutput = {
    generator: 'scripts/nuthing/synthesize-digits.py + normalize-synthetic.ts',
    note: `First ${SAMPLES_PER_DIGIT_IN_COMMITTED_SAMPLE} samples per digit (${sampleSubset.length} total) from the full synthetic-dataset.json (${samples.length} samples), committed so reviewers can inspect the schema without the generated file.`,
    normalization: output.normalization,
    sourceIndex: output.sourceIndex,
    samples: sampleSubset,
  };
  mkdirSync(dirname(SAMPLE_OUT_PATH), { recursive: true });
  writeFileSync(SAMPLE_OUT_PATH, JSON.stringify(sampleOutput, null, 1));

  console.log(`normalized ${samples.length} synthetic samples`);
  console.log(`wrote: ${OUT_PATH}`);
  console.log(`wrote: ${SAMPLE_OUT_PATH} (${sampleSubset.length} samples)`);
}

main();
