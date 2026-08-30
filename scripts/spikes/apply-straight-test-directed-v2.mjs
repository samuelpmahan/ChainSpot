import { readFileSync, writeFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const write = (path, value) => writeFileSync(path, value);
function once(source, needle, replacement, label) {
  const i = source.indexOf(needle);
  if (i < 0) throw new Error(`missing patch anchor: ${label}`);
  if (source.indexOf(needle, i + needle.length) >= 0) throw new Error(`ambiguous patch anchor: ${label}`);
  return source.slice(0, i) + replacement + source.slice(i + needle.length);
}

// Contract: add the directed-corridor evidence without disturbing legacy S0 geometry.
{
  const path = 'packages/alg/src/detectors/threeFactor/features/st.straightTest.contract.ts';
  let s = read(path);
  s = once(s, 'export interface StraightTestGateStatuses {', `export interface StraightTestBasketHypothesis {\n\treadonly basketId: string;\n\treadonly tipXPx: number;\n\treadonly tipYPx: number;\n\treadonly alongPx: number;\n\treadonly perpendicularPx: number;\n\treadonly forward: boolean;\n\treadonly inCorridor: boolean;\n\treadonly encounterRank: number | null;\n\treadonly strongIdentity: boolean;\n}\n\nexport interface StraightTestRayEvidence {\n\treadonly corridorWidthPx: number | null;\n\treadonly corridorHalfWidthPx: number | null;\n\treadonly selectedAlongPx: number | null;\n\treadonly selectedPerpendicularPx: number | null;\n\treadonly corridorCandidateCount: number;\n\treadonly nextTipMarginPx: number | null;\n}\n\nexport interface StraightTestGateStatuses {`, 'contract types');
  s = once(s, '\treadonly measurements: StraightTestMeasurements;\n\treadonly gates: StraightTestGateStatuses;', '\treadonly measurements: StraightTestMeasurements;\n\treadonly straightRay?: StraightTestRayEvidence;\n\treadonly basketHypotheses?: readonly StraightTestBasketHypothesis[];\n\treadonly gates: StraightTestGateStatuses;', 'proposal evidence');
  write(path, s);
}

// Feature: blind runs delegate to the directed producer; tainted comparison remains old code.
{
  const path = 'packages/alg/src/detectors/threeFactor/features/st.straightTest.ts';
  let s = read(path);
  s = once(s, `import type { ABFeature, EngineUnit } from './types';`, `import type { ABFeature, EngineUnit } from './types';\nimport { runDirectedStraightTest } from './st.straightDirected';\nimport { STRAIGHT_TEST_RENDER } from './st.straightTestReceipt';`, 'feature imports');
  s = once(s, `\tnote: 'Early geometry-only S0 straight-test testimony; never asserts ownership or bend truth.',`, `\tnote: 'G5 straight-hole testimony: first semantic basket TIP encountered in the accepted Tee→Badge corridor; truth-assisted S0 comparison retained separately.',`, 'feature note');
  s = once(s, '\t}\n} satisfies ABFeature;\n\nfunction vectors', '\t},\n\trender: STRAIGHT_TEST_RENDER\n} satisfies ABFeature;\n\nfunction vectors', 'feature renderer');
  s = once(s, `\tconsumes: ['badges', 'baskets', 'tees', 'straightTestTruthAssistance'],`, `\tconsumes: ['badges', 'baskets', 'tees', 'measurement', 'teeBadgeLock', 'straightTestTruthAssistance'],`, 'unit consumes');
  s = once(s, `\tnote: 'Geometry-only early S0; no assignment or bend refinement.',`, `\tnote: 'Blind directed-corridor resolver over accepted Tee→Badge locks and semantic basket TIPs; no assignment mutation.',`, 'unit note');
  const anchor = `\t\tconst baskets = board.get<readonly BasketEvidence[]>('baskets');\n\t\tconst proposals = badges.flatMap((badge) => {`;
  s = once(s, anchor, `\t\tconst baskets = board.get<readonly BasketEvidence[]>('baskets');\n\t\tif (assistance.mode === 'blind') {\n\t\t\tconst proposals = runDirectedStraightTest(board, ctx, baskets);\n\t\t\tconst trace: StraightTestTrace = {\n\t\t\t\tfeatureId: 'straightTest',\n\t\t\t\tcoordinateFrame: STRAIGHT_TEST_COORDINATE_FRAME,\n\t\t\t\ttruthAssistance: assistance,\n\t\t\t\tproposals\n\t\t\t};\n\t\t\tctx.recordStraightTest?.(trace);\n\t\t\tboard.set('straightProposals', proposals);\n\t\t\treturn;\n\t\t}\n\t\tconst proposals = badges.flatMap((badge) => {`, 'blind branch');
  write(path, s);
}

// G5 isolated compilation must declare imported G4 testimony explicitly.
{
  const path = 'packages/alg/src/detectors/threeFactor/gate-sets.ts';
  let s = read(path);
  s = once(s, `\t\tseededSlots: ['image', 'localImage', 'params', 'viewport', 'stage', 'badges', 'baskets', 'tees', 'straightTestTruthAssistance']`, `\t\tseededSlots: ['image', 'localImage', 'params', 'viewport', 'stage', 'badges', 'baskets', 'tees', 'measurement', 'teeBadgeLock', 'straightTestTruthAssistance']`, 'G5 seeded testimony');
  write(path, s);
}

for (const [path, tainted] of [
  ['packages/alg/src/detectors/threeFactor/configs/straight-test-on.json', false],
  ['packages/alg/src/detectors/threeFactor/configs/straight-test-truth-assisted-compare.json', true]
]) {
  const config = JSON.parse(read(path));
  config.note = tainted
    ? 'Explicit TRUTH-TAINT comparison after the frozen 106 endpoint/teeBadgeLock chain; caller must provide verified-canonical assistance payload.'
    : 'Blind G5 Straight Test after the frozen 106 endpoint/teeBadgeLock chain: first semantic basket TIP encountered inside the directed Tee→Badge corridor; no assignment mutation.';
  config.execution = ['badgeStage','badges','baskets','tees','teeFamily','supportField','badgeOcclusionPatch','rawPairs','measurement','assignment','teeRecovery','teeBadgeLock','straightTest'];
  write(path, `${JSON.stringify(config, null, '\t')}\n`);
}

console.log('directed-corridor Straight Test v2 patch applied');
