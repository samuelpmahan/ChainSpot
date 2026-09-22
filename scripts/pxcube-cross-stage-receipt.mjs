import { badgeParity } from './pxcube-badge-parity.mjs';
import { timingComparison } from './pxcube-timing-comparison.mjs';

export function crossStageReceipt({lineage,cleanS0,candidateS0,deltas,s1Plan,cleanS1,candidateS1}){
 const parity=badgeParity(cleanS1.badges,candidateS1.badges);
 const cleanMs=cleanS1.testimonies.reduce((n,r)=>n+r.durationMs,0);
 const candidateMs=candidateS1.testimonies.reduce((n,r)=>n+r.durationMs,0);
 return {
  lineage,
  s0:{clean:{widthPx:cleanS0.widthPx,heightPx:cleanS0.heightPx},candidate:{widthPx:candidateS0.widthPx,heightPx:candidateS0.heightPx}},
  semanticDelta:deltas,
  s1:{plan:s1Plan,testimony:candidateS1.testimonies.map(r=>({opId:r.opId,resolution:r.resolution,durationMs:r.durationMs}))},
  badgeParity:parity,
  timing:timingComparison({value:cleanS1.badges.length,elapsedMs:cleanMs,calculations:cleanS1.testimonies.length},{value:candidateS1.badges.length,elapsedMs:candidateMs,calculations:candidateS1.testimonies.length}),
  continuation:parity.parity?'PASS_WHILE':'REBUKED'
 };
}
