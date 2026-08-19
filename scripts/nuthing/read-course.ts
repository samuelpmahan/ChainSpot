// Warm full-course badge recognition runtime + end-to-end integration check.
//
// Runs the complete browser-portable pipeline (P1 -> badge family -> glyph ->
// segmentation -> normalization -> classifier) on corpus rasters, reporting
// warm timings for the badge-READING stage separately from P1 localization
// (the 100 ms/course loose ceiling applies to reading a course's badges after
// localization). Also cross-checks the end-to-end readings against the
// manifest's truth labels, proving the runtime path reproduces the offline
// dataset pipeline.
//
// Usage: npx tsx scripts/nuthing/read-course.ts RGBA_DIR MANIFEST_JSON REPORT_MD
//        [--model logistic|prototype] [--repeats N]

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runNuThingP1 } from '../../src/lib/nuthing/p1';
import { readCourseBadges, DIGIT_CLASSES } from '../../src/lib/nuthing/digits/readBadges';
import type { DigitScorer } from '../../src/lib/nuthing/digits/readBadges';
import type { NormalizedDigit } from '../../src/lib/nuthing/digits/normalize';
import { predictProbs } from '../../src/lib/nuthing/digits/logistic';
import type { LogisticModel } from '../../src/lib/nuthing/digits/logistic';
import { scoreVector, fromJSON as prototypeFromJSON } from '../../src/lib/nuthing/digits/prototype';
import { FEATURE_EXTRACTORS } from '../../src/lib/nuthing/digits/features';
import { decodeRgbaBin } from './decode';

function logisticScorer(modelPath: string): DigitScorer {
  const model = JSON.parse(readFileSync(modelPath, 'utf8')) as LogisticModel;
  return {
    name: `logistic(${modelPath})`,
    scores: (mask: NormalizedDigit) => predictProbs(model, mask),
  };
}

function prototypeScorer(modelPath: string): DigitScorer {
  const model = prototypeFromJSON(JSON.parse(readFileSync(modelPath, 'utf8')));
  const extract = FEATURE_EXTRACTORS[model.featureName];
  if (!extract) throw new Error(`Unknown feature ${model.featureName}`);
  return {
    name: `prototype(${modelPath})`,
    scores: (mask: NormalizedDigit) => scoreVector(model, extract(mask)),
  };
}

interface ManifestBadgeTruth {
  id: string;
  image: string;
  bbox: [number, number, number, number];
  label: string | null;
  evalLabel?: string | null;
}

function main(): void {
  const args = process.argv.slice(2);
  const modelIdx = args.indexOf('--model');
  const modelKind = modelIdx >= 0 ? args.splice(modelIdx, 2)[1] : 'logistic';
  const repeatsIdx = args.indexOf('--repeats');
  const repeats = repeatsIdx >= 0 ? Number(args.splice(repeatsIdx, 2)[1]) : 5;
  const [rgbaDir, manifestPath, reportPath] = args;
  if (!rgbaDir || !manifestPath || !reportPath) {
    console.error(
      'Usage: tsx scripts/nuthing/read-course.ts RGBA_DIR MANIFEST_JSON REPORT_MD [--model logistic|prototype] [--repeats N]',
    );
    process.exit(1);
  }
  const scorer =
    modelKind === 'prototype'
      ? prototypeScorer('resources/nuthing-p2/digits/models/prototype.json')
      : logisticScorer('resources/nuthing-p2/digits/models/logistic.json');

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    badges: ManifestBadgeTruth[];
  };
  const truthByImage = new Map<string, ManifestBadgeTruth[]>();
  for (const b of manifest.badges) {
    const list = truthByImage.get(b.image);
    if (list) list.push(b);
    else truthByImage.set(b.image, [b]);
  }

  const names = readdirSync(rgbaDir)
    .filter((f) => f.endsWith('.rgba.bin'))
    .map((f) => f.replace(/\.rgba\.bin$/, ''))
    .sort();

  const lines: string[] = [];
  lines.push('# Warm full-course badge recognition runtime');
  lines.push('');
  lines.push(
    `Model: \`${scorer.name}\`. Warm timing = median of ${repeats} repeats after one ` +
      'warmup pass; "badge reading" covers glyph extraction, segmentation, ' +
      'normalization and classification for every badge of the course — the ' +
      'stage the 100 ms loose ceiling applies to. P1 localization is timed ' +
      'separately (single warm run). End-to-end readings are cross-checked ' +
      'against manifest truth (training labels on dev, evaluation-only ' +
      'labels on Fountain Hills; the non-digit arrow badge is excluded).',
  );
  lines.push('');
  lines.push('| image | badges | P1 s | badge reading ms (median) | reads correct | mismatches |');
  lines.push('|---|---|---|---|---|---|');

  let totalCorrect = 0;
  let totalChecked = 0;
  const mismatches: string[] = [];
  for (const name of names) {
    const image = decodeRgbaBin(join(rgbaDir, `${name}.rgba.bin`));
    const t0 = performance.now();
    const result = runNuThingP1(image);
    const p1Seconds = (performance.now() - t0) / 1000;

    let readings = readCourseBadges(result, scorer); // warmup
    const times: number[] = [];
    for (let r = 0; r < repeats; r++) {
      const t1 = performance.now();
      readings = readCourseBadges(result, scorer);
      times.push(performance.now() - t1);
    }
    times.sort((a, b) => a - b);
    const medianMs = times[times.length >> 1];

    const truths = truthByImage.get(name) ?? [];
    const truthByBboxKey = new Map(truths.map((t) => [t.bbox.join(','), t]));
    let correct = 0;
    let checked = 0;
    for (const reading of readings) {
      const key = [
        reading.badge.bboxX,
        reading.badge.bboxY,
        reading.badge.bboxW,
        reading.badge.bboxH,
      ].join(',');
      const truth = truthByBboxKey.get(key);
      const expected = truth ? (truth.label ?? truth.evalLabel ?? null) : null;
      if (expected === null || expected === undefined) continue;
      checked++;
      if (reading.label === expected) correct++;
      else {
        mismatches.push(
          `${name} badge@(${reading.badge.bboxX},${reading.badge.bboxY}): read "${reading.label}" ` +
            `expected "${expected}" (confidence ${reading.confidence.toFixed(4)})`,
        );
      }
    }
    totalCorrect += correct;
    totalChecked += checked;
    lines.push(
      `| ${name} | ${readings.length} | ${p1Seconds.toFixed(2)} | ${medianMs.toFixed(2)} | ` +
        `${correct}/${checked} | ${checked - correct} |`,
    );
    console.log(
      `${name}: badges=${readings.length} p1=${p1Seconds.toFixed(2)}s read=${medianMs.toFixed(2)}ms ` +
        `correct=${correct}/${checked}`,
    );
  }

  lines.push('');
  lines.push(`**End-to-end reads correct: ${totalCorrect}/${totalChecked}.**`);
  if (mismatches.length) {
    lines.push('');
    lines.push('Mismatches:');
    for (const m of mismatches) lines.push(`- ${m}`);
  }
  writeFileSync(reportPath, lines.join('\n'));
  console.log(`total ${totalCorrect}/${totalChecked} -> ${reportPath}`);
}

main();
