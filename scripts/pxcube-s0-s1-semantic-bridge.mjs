import { semanticDelta, conservativeSemanticPlan } from '../packages/alg/dist/exec/speculative.js';

export function canonicalPixelsDelta(clean,candidate){
  return semanticDelta({
    width:clean.widthPx,height:clean.heightPx,pixels:Array.from(clean.rgba)
  },{
    width:candidate.widthPx,height:candidate.heightPx,pixels:Array.from(candidate.rgba)
  }).map(d=>({...d,path:`px.course.canonicalPixels.${d.path}`}));
}

export function planS1FromCanonicalPixels({clean,candidate,s1Ops}){
  const deltas=canonicalPixelsDelta(clean,candidate);
  return {deltas,plan:conservativeSemanticPlan(deltas,s1Ops)};
}
