// Shared evaluator for all NuThing P2 digit classifiers.
//
// Every classifier experiment emits a predictions JSON; this script scores
// them all against the SAME dataset and truth, so competing experiments stay
// comparable. Classifiers never self-score for the record.
//
// Predictions schema (one file per classifier):
//   {
//     "classifier": "<name>",
//     "model": "<repo path of the learned artifact>",
//     "trainedOn": ["train-real" | "synthetic", ...],
//     "predictions": [
//       { "id": "<sampleId>", "predicted": "0".."9",
//         "scores": [s0..s9],           // higher = more likely, any scale
//         "runtimeMsPerSample"?: number }
//     ]
//   }
//
// Scoring:
// - digit accuracy per split (train / heldout), overall and per class;
// - confusion matrix per split;
// - margin = score[winner] - score[runnerUp] distribution (mean/min);
// - badge-level accuracy: a badge is read correctly iff its segmentation
//   digit count matched the label AND every digit prediction is correct
//   (segmentation failures count as badge failures for badge accuracy and
//   are ALSO reported separately — segmentation and classification errors
//   are different ledgers);
// - explicit failure list (sample id, true, predicted, margin).
//
// Usage: npx tsx scripts/nuthing/eval-digits.ts DATASET_JSON REPORT_MD PRED_JSON...

import { readFileSync, writeFileSync } from 'node:fs';

interface Sample {
  id: string;
  badgeId: string;
  image: string;
  split: 'train' | 'heldout';
  digitIndex: number;
  trueDigit: string | null;
}

interface DatasetBadge {
  badgeId: string;
  image: string;
  split: string;
  labelString: string | null;
  digitCountExpected: number | null;
  digitCountFound: number;
  segmentationOk: boolean;
  failureReason?: string;
}

interface Dataset {
  samples: Sample[];
  badges: DatasetBadge[];
}

interface PredictionFile {
  classifier: string;
  model: string;
  trainedOn: string[];
  predictions: {
    id: string;
    predicted: string;
    scores: number[];
    runtimeMsPerSample?: number;
  }[];
}

interface SplitScore {
  total: number;
  correct: number;
  perClass: Record<string, { total: number; correct: number }>;
  confusion: Record<string, Record<string, number>>;
  margins: number[];
  failures: { id: string; trueDigit: string; predicted: string; margin: number }[];
  badgeTotal: number;
  badgeCorrect: number;
  badgeSegFailures: number;
}

function scoreSplit(
  ds: Dataset,
  pred: Map<string, PredictionFile['predictions'][number]>,
  split: 'train' | 'heldout',
): SplitScore {
  const s: SplitScore = {
    total: 0,
    correct: 0,
    perClass: {},
    confusion: {},
    margins: [],
    failures: [],
    badgeTotal: 0,
    badgeCorrect: 0,
    badgeSegFailures: 0,
  };
  const samplesByBadge = new Map<string, Sample[]>();
  for (const sample of ds.samples) {
    if (sample.split !== split) continue;
    const list = samplesByBadge.get(sample.badgeId);
    if (list) list.push(sample);
    else samplesByBadge.set(sample.badgeId, [sample]);
    if (sample.trueDigit === null) continue;
    const p = pred.get(sample.id);
    if (!p) continue;
    s.total++;
    const cls = (s.perClass[sample.trueDigit] ??= { total: 0, correct: 0 });
    cls.total++;
    const row = (s.confusion[sample.trueDigit] ??= {});
    row[p.predicted] = (row[p.predicted] ?? 0) + 1;
    const sorted = p.scores.slice().sort((a, b) => b - a);
    const margin = sorted.length > 1 ? sorted[0] - sorted[1] : 0;
    s.margins.push(margin);
    if (p.predicted === sample.trueDigit) {
      s.correct++;
      cls.correct++;
    } else {
      s.failures.push({ id: sample.id, trueDigit: sample.trueDigit, predicted: p.predicted, margin });
    }
  }
  for (const badge of ds.badges) {
    if (badge.split !== split || badge.labelString === null) continue;
    s.badgeTotal++;
    if (!badge.segmentationOk) {
      s.badgeSegFailures++;
      continue;
    }
    const samples = (samplesByBadge.get(badge.badgeId) ?? []).sort(
      (a, b) => a.digitIndex - b.digitIndex,
    );
    const read = samples.map((sm) => pred.get(sm.id)?.predicted ?? '?').join('');
    if (read === badge.labelString) s.badgeCorrect++;
  }
  return s;
}

function pct(c: number, t: number): string {
  return t === 0 ? '—' : `${((100 * c) / t).toFixed(1)}% (${c}/${t})`;
}

function main(): void {
  const [dsPath, reportPath, ...predPaths] = process.argv.slice(2);
  if (!dsPath || !reportPath || predPaths.length === 0) {
    console.error('Usage: tsx scripts/nuthing/eval-digits.ts DATASET_JSON REPORT_MD PRED_JSON...');
    process.exit(1);
  }
  const ds = JSON.parse(readFileSync(dsPath, 'utf8')) as Dataset;
  const lines: string[] = [];
  lines.push('# Digit classifier comparison');
  lines.push('');
  lines.push(
    'All classifiers scored by `scripts/nuthing/eval-digits.ts` on the same ' +
      'dataset and splits (train = dev REAL_GROUNDED; heldout = Fountain ' +
      'Hills, truth from evaluation-only manual labels). Badge-level ' +
      'accuracy counts segmentation failures against the badge score; the ' +
      'segmentation ledger itself is docs/nuthing-p2/digit-segmentation.md.',
  );
  lines.push('');
  lines.push(
    '| classifier | trained on | digit acc (train) | digit acc (heldout) | ' +
      'badge acc (train) | badge acc (heldout) | mean margin (heldout) |',
  );
  lines.push('|---|---|---|---|---|---|---|');

  const detail: string[] = [];
  for (const p of predPaths) {
    const pf = JSON.parse(readFileSync(p, 'utf8')) as PredictionFile;
    const pred = new Map(pf.predictions.map((x) => [x.id, x]));
    const train = scoreSplit(ds, pred, 'train');
    const held = scoreSplit(ds, pred, 'heldout');
    const meanMargin =
      held.margins.length > 0
        ? held.margins.reduce((a, b) => a + b, 0) / held.margins.length
        : 0;
    lines.push(
      `| ${pf.classifier} | ${pf.trainedOn.join('+')} | ${pct(train.correct, train.total)} | ` +
        `${pct(held.correct, held.total)} | ${pct(train.badgeCorrect, train.badgeTotal)} | ` +
        `${pct(held.badgeCorrect, held.badgeTotal)} | ${meanMargin.toFixed(4)} |`,
    );

    detail.push(`## ${pf.classifier}`);
    detail.push('');
    detail.push(`Model: \`${pf.model}\`; trained on: ${pf.trainedOn.join(', ')}.`);
    for (const [splitName, sc] of [
      ['train', train],
      ['heldout', held],
    ] as const) {
      detail.push('');
      detail.push(
        `### ${splitName}: digit ${pct(sc.correct, sc.total)}, badge ` +
          `${pct(sc.badgeCorrect, sc.badgeTotal)} (${sc.badgeSegFailures} badge(s) lost to segmentation)`,
      );
      const classes = Object.keys(sc.perClass).sort((a, b) => Number(a) - Number(b));
      detail.push('');
      detail.push(
        'Per class: ' +
          classes.map((c) => `${c}: ${pct(sc.perClass[c].correct, sc.perClass[c].total)}`).join('; '),
      );
      if (sc.failures.length) {
        detail.push('');
        detail.push('Misclassifications:');
        for (const f of sc.failures.slice(0, 40)) {
          detail.push(`- \`${f.id}\`: true ${f.trueDigit} → predicted ${f.predicted} (margin ${f.margin.toFixed(4)})`);
        }
        if (sc.failures.length > 40) detail.push(`- … ${sc.failures.length - 40} more`);
        // Confusion rows for failing classes only (keeps the report small).
        const failing = new Set(sc.failures.map((f) => f.trueDigit));
        for (const cls of [...failing].sort()) {
          detail.push(
            `- confusion[${cls}]: ` +
              Object.entries(sc.confusion[cls] ?? {})
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `${k}×${v}`)
                .join(', '),
          );
        }
      }
    }
    detail.push('');
    console.log(
      `${pf.classifier}: train ${pct(train.correct, train.total)}, heldout ${pct(held.correct, held.total)}, ` +
        `badge heldout ${pct(held.badgeCorrect, held.badgeTotal)}`,
    );
  }

  lines.push('');
  lines.push(...detail);
  writeFileSync(reportPath, lines.join('\n'));
  console.log(`report -> ${reportPath}`);
}

main();
