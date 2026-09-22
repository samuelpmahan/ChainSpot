import { propagateWhileParity } from '../packages/alg/dist/exec/speculative.js';

export function badgeParity(cleanBadges,candidateBadges){
  const cleanIds=cleanBadges.map(x=>x.detId ?? x.id ?? JSON.stringify(x)).sort();
  const candidateIds=candidateBadges.map(x=>x.detId ?? x.id ?? JSON.stringify(x)).sort();
  const parity=JSON.stringify(cleanIds)===JSON.stringify(candidateIds);
  return {
    parity,
    comparator:'fn.compareBadgeIdentity',
    where:parity?undefined:'badge identities',
    why:parity?'same badge identities':`clean=[${cleanIds.join(',')}]; candidate=[${candidateIds.join(',')}]`
  };
}

export function passWhileBadgeParity(stages){
  return propagateWhileParity(stages);
}
