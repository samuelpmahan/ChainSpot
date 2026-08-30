import {
  basketTipFrame,
  courseResidualFrame,
  imageNorthFrame,
  incomingEvidenceFrame,
  runFrameStudySkeleton,
  type Frame
} from './frameStudy.js';

interface SmokeEvidence {
  readonly marker: 'unchanged';
}

const frames = [
  imageNorthFrame,
  basketTipFrame,
  courseResidualFrame,
  incomingEvidenceFrame
] as readonly Frame<SmokeEvidence>[];

const baseline: SmokeEvidence = { marker: 'unchanged' };
const result = runFrameStudySkeleton({
  experimentId: 'frame-study-smoke',
  subjectId: 'basket-smoke',
  baseline,
  frames
});

console.log('FRAME STUDY SMOKE');
console.log(`status=${result.status}`);
console.log(`identityPreserved=${result.framed === baseline}`);
console.log(`loss=${String(result.loss)}`);
console.log(`factors=${result.factors.length}`);
console.log(`projection=${String(result.projection)}`);
for (const frame of frames) {
  console.log(`frame=${frame.id} purpose=${frame.purpose}`);
  if (frame.note) console.log(`note=${frame.note}`);
}
for (const log of result.logs) console.log(`log[${log.level}] ${log.message}`);
for (const explanation of result.explanations) console.log(`explain ${explanation}`);
