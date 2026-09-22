import { readFile } from 'node:fs/promises';
import { createS0Stage, executeS0, forkS0Crop } from '../packages/alg/dist/stages/S0/clean/index.js';
import { executeS1BadgesCandidate, executeS1BadgesCandidateInLineage } from '../packages/alg/dist/stages/S1/clean/index.js';
import { planS1FromCanonicalPixels } from './pxcube-s0-s1-semantic-bridge.mjs';
import { crossStageReceipt } from './pxcube-cross-stage-receipt.mjs';

// Environment supplies decode/candidate materializer. This runner owns only the real PxC/S0/S1 flow.
export async function runRealS0S1({source,decode,candidateCrop,lineage='exp/candidate-crop',s1Ops=[]}){
 const stage=createS0Stage();
 const clean=await executeS0({stage,source,decode});
 const candidate=await forkS0Crop(stage,lineage,candidateCrop);
 const cleanS1=executeS1BadgesCandidate(stage.pxc);
 const candidateS1=executeS1BadgesCandidateInLineage(candidate.pxc,lineage);
 const bridge=planS1FromCanonicalPixels({clean:clean.croppedImage,candidate:candidate.croppedImage,s1Ops});
 return crossStageReceipt({
  lineage,cleanS0:clean.croppedImage,candidateS0:candidate.croppedImage,
  deltas:bridge.deltas,s1Plan:bridge.plan,cleanS1,candidateS1
 });
}
