declare const Buffer: { from(value: string): { toString(encoding: 'base64'): string } };
import {
  renderAngledInfluenceSkeleton,
  renderTrueNorthSkeleton,
  type RadialOrigin
} from './radialRender.js';

const basketTip: RadialOrigin = {
  x: 21,
  y: 66,
  semantic: 'basket bottom-center pole tip'
};

const trueNorth = renderTrueNorthSkeleton({ origin: basketTip });
const angled = renderAngledInfluenceSkeleton({
  origin: basketTip,
  referenceAngleDeg: 37.5,
  referenceFrameId: 'incomingEvidence'
});

console.log('RADIAL RENDER SMOKE');
for (const result of [trueNorth, angled]) {
  console.log(`renderer=${result.spec.id}`);
  console.log(`status=${result.status}`);
  console.log(`origin=${result.spec.origin.semantic}`);
  console.log(`axisFrame=${result.spec.axis.frameId}`);
  console.log(`zeroDeg=${result.spec.axis.zeroDeg}`);
  console.log(`series=${result.spec.series.length}`);
  if (result.spec.note) console.log(`note=${result.spec.note}`);
  console.log(`svg=${Buffer.from(result.svg).toString('base64')}`);
  for (const log of result.logs) console.log(`log[${log.level}] ${log.message}`);
}
