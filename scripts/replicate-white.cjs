#!/usr/bin/env node
// Bounded Luna replication: compare the production threeFactor badge reader
// with the saved white-glyph assembly adapter, using the same digit modules.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PNG } = require('pngjs');
const alg = require('../packages/alg/dist/detectors/threeFactor/measure.js');
const seg = require('../packages/alg/dist/detectors/threeFactor/digits/segment.js');
const norm = require('../packages/alg/dist/detectors/threeFactor/digits/normalize.js');
const inf = require('../packages/alg/dist/detectors/threeFactor/digits/logisticInference.js');
const model = require('../packages/alg/dist/detectors/threeFactor/assets/logistic.json');

const assemblyPath = path.resolve(process.argv[2] || '../s1-assembly-run/assemblies.json');
const imagePath = path.resolve(process.argv[3] || '../s1-assembly-run/source.png');
const outDir = path.resolve(process.argv[4] || '../white-replication');
fs.mkdirSync(outDir, { recursive: true });

function rank(probs) {
  return probs.map((score, i) => ({ label: model.classes[i], score }))
    .sort((a, b) => b.score - a.score);
}
function bboxAndMask(pixels, width) {
  const xs = pixels.map((p) => p % width), ys = pixels.map((p) => Math.floor(p / width));
  const x = Math.min(...xs), y = Math.min(...ys);
  const w = Math.max(...xs) - x + 1, h = Math.max(...ys) - y + 1;
  const data = new Uint8Array(w * h);
  for (const p of pixels) data[(Math.floor(p / width) - y) * w + p % width - x] = 1;
  return { x, y, w, h, data };
}
function adapterRead(candidate, width) {
  const pixels = [...new Set(candidate.digits.flatMap((d) => Array.from(d.part.pixels)))];
  const glyph = bboxAndMask(pixels, width);
  const segmented = seg.segmentDigits({ width: glyph.w, height: glyph.h, data: glyph.data });
  const readings = segmented.digits.map((digit) => {
    const normalized = norm.normalizeDigitMask(digit.mask, digit.bbox[2], digit.bbox[3]);
    const probabilities = inf.predictProbs(model, normalized);
    const ordered = rank(probabilities);
    return {
      bbox: digit.bbox, method: digit.method,
      normalizedBytes: normalized.length,
      predicted: ordered[0].label, runnerUp: ordered[1]?.label || null,
      topScore: ordered[0].score, runnerUpScore: ordered[1]?.score || 0,
      margin: ordered[0].score - (ordered[1]?.score || 0),
      normalizedSha256: crypto.createHash('sha256').update(normalized).digest('hex'),
      scores: probabilities
    };
  });
  return {
    id: candidate.id, glyph: { x: glyph.x, y: glyph.y, width: glyph.w, height: glyph.h, pixelCount: pixels.length },
    value: readings.map((r) => r.predicted).join(''), readings, notes: segmented.notes
  };
}

const assembly = JSON.parse(fs.readFileSync(assemblyPath, 'utf8'));
const png = PNG.sync.read(fs.readFileSync(imagePath));
const image = { width: png.width, height: png.height, data: png.data };
const production = alg.measureThreeFactor(image);
const prod = production.badges.map((b) => ({
  detId: b.detId, label: b.label, bestLabel: b.bestLabel, rawLabel: b.rawLabel,
  confidence: b.confidence, digitCount: b.digitCount, cxPx: b.cxPx, cyPx: b.cyPx,
  bbox: b.bbox, source: b.source,
  digits: b.digits.map((d) => ({ bbox: d.bbox, method: d.method, predicted: d.predicted,
    runnerUp: d.runnerUp, margin: d.margin, normalizedBytes: d.normalized.length,
    normalizedSha256: crypto.createHash('sha256').update(d.normalized).digest('hex'), scores: d.scores }))
}));
const adapter = assembly.candidates.map((c) => adapterRead(c, assembly.width));
// Candidates and production badges are both in top-to-bottom order; retain an
// explicit spatial pairing check so order is evidence rather than assumption.
const paired = adapter.map((a, i) => ({
  assemblyId: a.id, productionDetId: prod[i]?.detId || null,
  assemblyValue: a.value, productionLabel: prod[i]?.label || null,
  valueEqual: a.value === (prod[i]?.label || ''),
  productionCenter: prod[i] ? [prod[i].cxPx, prod[i].cyPx] : null,
  assemblyGlyphOrigin: [a.glyph.x, a.glyph.y]
}));
const result = {
  schemaVersion: 1,
  inputs: { assemblyPath, imagePath, imageWidth: png.width, imageHeight: png.height,
    assemblyWidth: assembly.width, assemblyHeight: assembly.height,
    imageSha256: crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex') },
  productionPath: {
    function: 'measureThreeFactor(image)', algorithm: production.algo, algorithmVersion: production.algoVersion,
    badgeCount: prod.length, parameters: production.parameters, badges: prod
  },
  digitNormalization: {
    module: 'digits/normalize.normalizeDigitMask', width: norm.DIGIT_W, height: norm.DIGIT_H,
    behavior: 'nearest-neighbor aspect-preserving resize, centered equal margins, binary 0/1 bytes',
    scorer: 'digits/logisticInference.predictProbs', model: 'assets/logistic.json', classes: model.classes,
    featureCount: model.W[0].length, output: 'softmax probabilities; rank descending'
  },
  assembledWhiteAdapter: {
    source: 'candidate.digits[*].part.pixels union', segmentation: 'digits/segment.segmentDigits',
    badgeCount: adapter.length, badges: adapter
  },
  paired, measurements: {
    productionLabels: prod.map((b) => b.label), adapterValues: adapter.map((b) => b.value),
    equalCount: paired.filter((p) => p.valueEqual).length,
    pairCount: paired.length, productionUnreadCount: prod.filter((b) => b.label === null).length,
    adapterEmptyCount: adapter.filter((b) => !b.value).length
  }
};
fs.writeFileSync(path.join(outDir, 'replication.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output: path.join(outDir, 'replication.json'), measurements: result.measurements }, null, 2));
