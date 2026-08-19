// Build the shared per-digit training/eval dataset from the badge-observation
// manifest (resources/nuthing-p2/badges/manifest.json).
//
// For every badge: load its glyph-mask PNG (255=glyph pixel), run the
// label-blind segmenter (src/lib/nuthing/digits/segment.ts) to propose
// per-digit masks, normalize each through the canonical normalizer
// (src/lib/nuthing/digits/normalize.ts), and align the segmented digits to
// the badge's label string (train: `label`, heldout: `evalLabel`) purely by
// position count -- segmentation itself never sees the label.
//
// Output is written identically to both:
//   /workspace/nuthing-work/digits/digit-dataset.json
//   resources/nuthing-p2/digits/digit-dataset.json
// plus docs/nuthing-p2/digit-segmentation.md, the segmentation-error ledger
// (kept separate from any future classifier's error ledger).
//
// Usage: npx tsx scripts/nuthing/build-digit-dataset.ts

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { segmentDigits } from '../../src/lib/nuthing/digits/segment';
import {
  normalizeDigitMask,
  digitToBase64,
  DIGIT_W,
  DIGIT_H,
} from '../../src/lib/nuthing/digits/normalize';
import type { Mask } from '../../src/lib/nuthing/raster';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const BADGES_DIR = join(REPO_ROOT, 'resources', 'nuthing-p2', 'badges');
const MANIFEST_PATH = join(BADGES_DIR, 'manifest.json');
const OUT_PATHS = [
  '/workspace/nuthing-work/digits/digit-dataset.json',
  join(REPO_ROOT, 'resources', 'nuthing-p2', 'digits', 'digit-dataset.json'),
];
const DOC_PATH = join(REPO_ROOT, 'docs', 'nuthing-p2', 'digit-segmentation.md');

type ProvenanceClass = 'REAL_GROUNDED' | 'UNRESOLVED' | 'HELD_OUT';
type Split = 'train' | 'heldout';

interface ManifestBadge {
  id: string;
  image: string;
  crops: { glyphMask: string };
  label: string | null;
  evalLabel?: string | null;
  provenanceClass: ProvenanceClass;
}

interface ManifestFile {
  badges: ManifestBadge[];
}

interface Sample {
  id: string;
  badgeId: string;
  image: string;
  split: Split;
  provenanceClass: ProvenanceClass;
  digitIndex: number;
  trueDigit: string | null;
  bboxInGlyph: [number, number, number, number];
  rawWidth: number;
  rawHeight: number;
  mask: string;
  method: 'cc' | 'valley-split';
}

interface BadgeRecord {
  badgeId: string;
  image: string;
  split: Split;
  labelString: string | null;
  digitCountExpected: number | null;
  digitCountFound: number;
  segmentationOk: boolean;
  failureReason?: string;
}

function splitFor(provenanceClass: ProvenanceClass): Split {
  return provenanceClass === 'HELD_OUT' ? 'heldout' : 'train';
}

/** Load a glyph-mask PNG (RGBA, 0/255) into a binary Mask (255 -> 1). */
function loadGlyphMask(path: string): Mask {
  const buf = readFileSync(path);
  const png = PNG.sync.read(buf);
  const { width, height, data } = png;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    if (data[p] >= 128) out[i] = 1;
  }
  return { width, height, data: out };
}

function main(): void {
  const manifest: ManifestFile = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

  const samples: Sample[] = [];
  const badgeRecords: BadgeRecord[] = [];
  let skippedEmptyGlyph = 0;
  const methodHistogram: Record<'cc' | 'valley-split', number> = { cc: 0, 'valley-split': 0 };

  for (const badge of manifest.badges) {
    const glyphRel = badge.crops.glyphMask;
    if (!glyphRel) {
      skippedEmptyGlyph++;
      console.warn(`[skip] ${badge.id}: empty crops.glyphMask path`);
      continue;
    }

    const split = splitFor(badge.provenanceClass);
    const labelString = split === 'heldout' ? (badge.evalLabel ?? null) : (badge.label ?? null);

    const glyphPath = join(BADGES_DIR, glyphRel);
    const mask = loadGlyphMask(glyphPath);
    const { digits } = segmentDigits(mask);

    const digitCountExpected = labelString != null ? labelString.length : null;
    const digitCountFound = digits.length;
    const alignOk = labelString != null && digitCountFound === digitCountExpected;

    let segmentationOk = true;
    let failureReason: string | undefined;
    if (labelString != null && !alignOk) {
      segmentationOk = false;
      failureReason = `DIGIT_COUNT_MISMATCH expected=${digitCountExpected} found=${digitCountFound}`;
    }

    digits.forEach((d, i) => {
      methodHistogram[d.method]++;
      const trueDigit = alignOk ? labelString!.charAt(i) : null;
      const normalized = normalizeDigitMask(d.mask, d.bbox[2], d.bbox[3]);
      samples.push({
        id: `${badge.id}#d${i}`,
        badgeId: badge.id,
        image: badge.image,
        split,
        provenanceClass: badge.provenanceClass,
        digitIndex: i,
        trueDigit,
        bboxInGlyph: d.bbox,
        rawWidth: d.bbox[2],
        rawHeight: d.bbox[3],
        mask: digitToBase64(normalized),
        method: d.method,
      });
    });

    badgeRecords.push({
      badgeId: badge.id,
      image: badge.image,
      split,
      labelString,
      digitCountExpected,
      digitCountFound,
      segmentationOk,
      ...(failureReason ? { failureReason } : {}),
    });
  }

  const output = {
    generator: 'scripts/nuthing/build-digit-dataset.ts',
    normalization: `src/lib/nuthing/digits/normalize.ts DIGIT_W=${DIGIT_W} DIGIT_H=${DIGIT_H} aspect-preserving nearest-neighbor centered`,
    samples,
    badges: badgeRecords,
  };
  const json = JSON.stringify(output, null, 1);

  for (const outPath of OUT_PATHS) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, json);
  }

  // ---- docs/nuthing-p2/digit-segmentation.md -------------------------------

  const splits: Split[] = ['train', 'heldout'];

  function accuracyFor(split: Split): { withLabel: number; matched: number } {
    let withLabel = 0;
    let matched = 0;
    for (const b of badgeRecords) {
      if (b.split !== split || b.labelString == null) continue;
      withLabel++;
      if (b.digitCountFound === b.digitCountExpected) matched++;
    }
    return { withLabel, matched };
  }

  const lines: string[] = [];
  lines.push('# NuThing P2 digit segmentation report');
  lines.push('');
  lines.push(`Generated by \`scripts/nuthing/build-digit-dataset.ts\`.`);
  lines.push('');
  lines.push(
    'This is the segmentation-error ledger only: whether the label-blind segmenter ' +
      '(`src/lib/nuthing/digits/segment.ts`) found the right *number* of digits per ' +
      'badge. It says nothing about digit classification accuracy -- that is a ' +
      'separate, future ledger.',
  );
  lines.push('');
  lines.push(
    '`split=="heldout"` samples carry `trueDigit` derived from `evalLabel` for ' +
      'evaluation only. **Classifiers must never train on `split=="heldout"` samples.**',
  );
  lines.push('');

  lines.push('## Digit-count accuracy (badges with a label, found count == expected count)');
  lines.push('');
  lines.push('| split | badges with label | count matched | accuracy |');
  lines.push('| --- | --- | --- | --- |');
  for (const split of splits) {
    const { withLabel, matched } = accuracyFor(split);
    const pct = withLabel > 0 ? ((100 * matched) / withLabel).toFixed(1) : 'n/a';
    lines.push(`| ${split} | ${withLabel} | ${matched} | ${pct}% |`);
  }
  lines.push('');

  lines.push('## Segmentation method histogram (per emitted digit sample)');
  lines.push('');
  lines.push('| method | count |');
  lines.push('| --- | --- |');
  lines.push(`| cc | ${methodHistogram.cc} |`);
  lines.push(`| valley-split | ${methodHistogram['valley-split']} |`);
  lines.push('');
  lines.push(
    methodHistogram['valley-split'] === 0
      ? '`cc` accounts for every emitted digit: touching/merged digits were not observed ' +
          'in this corpus, confirming the "digits usually don\'t touch" assumption rather ' +
          'than assuming it.'
      : `valley-split accounts for ${(
          (100 * methodHistogram['valley-split']) /
          Math.max(1, methodHistogram.cc + methodHistogram['valley-split'])
        ).toFixed(1)}% of emitted digits.`,
  );
  lines.push('');

  lines.push('## Segmentation failures (digit-count mismatch)');
  lines.push('');
  const failures = badgeRecords.filter((b) => !b.segmentationOk);
  if (failures.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| badgeId | split | labelString | expected | found |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const b of failures) {
      lines.push(
        `| ${b.badgeId} | ${b.split} | ${b.labelString ?? ''} | ${b.digitCountExpected ?? ''} | ${b.digitCountFound} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Sample counts per digit class per split (labeled samples only)');
  lines.push('');
  for (const split of splits) {
    lines.push(`### ${split}`);
    lines.push('');
    lines.push('| digit | samples |');
    lines.push('| --- | --- |');
    const counts: Record<string, number> = {};
    for (const s of samples) {
      if (s.split !== split || s.trueDigit == null) continue;
      counts[s.trueDigit] = (counts[s.trueDigit] ?? 0) + 1;
    }
    const digitsSeen = Object.keys(counts).sort();
    if (digitsSeen.length === 0) {
      lines.push('| (none) | 0 |');
    } else {
      for (const d of digitsSeen) lines.push(`| ${d} | ${counts[d]} |`);
    }
    lines.push('');
  }

  lines.push('## Notes');
  lines.push('');
  lines.push(`- Badges with empty \`crops.glyphMask\` path skipped: ${skippedEmptyGlyph}.`);
  lines.push(`- Total badges processed: ${badgeRecords.length}.`);
  lines.push(`- Total digit samples emitted: ${samples.length}.`);
  lines.push('');

  mkdirSync(dirname(DOC_PATH), { recursive: true });
  const doc = lines.join('\n');
  writeFileSync(DOC_PATH, doc);

  // ---- console summary -------------------------------------------------

  console.log(`badges processed: ${badgeRecords.length} (skipped empty-glyph: ${skippedEmptyGlyph})`);
  for (const split of splits) {
    const { withLabel, matched } = accuracyFor(split);
    const pct = withLabel > 0 ? ((100 * matched) / withLabel).toFixed(1) : 'n/a';
    console.log(`  ${split}: digit-count accuracy ${matched}/${withLabel} (${pct}%)`);
  }
  console.log(`method histogram: cc=${methodHistogram.cc} valley-split=${methodHistogram['valley-split']}`);
  console.log(`segmentation failures: ${failures.length}`);
  for (const b of failures) {
    console.log(
      `  ${b.badgeId} [${b.split}] label=${b.labelString} expected=${b.digitCountExpected} found=${b.digitCountFound}`,
    );
  }
  console.log(`total samples: ${samples.length}`);
  console.log(`wrote: ${OUT_PATHS.join(', ')}`);
  console.log(`wrote: ${DOC_PATH}`);
}

main();
