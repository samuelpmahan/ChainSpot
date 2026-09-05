/** Experimental S4: local Tee→Badge resolution. No global Basket assignment. */
import type { Tee } from '../../../S3/clean/Tee';
import type { Badge } from '../../../S1/clean/Badge';
import { pxKey } from '../../../../exec/board';

export const AXIS_WINDOW_DEG = 5; // Owner hint as an explicit NaiveGate, not a law.
export interface PairMeasure {
  readonly tee: number;
  readonly hole: number;
  readonly badgeCenter: readonly [number, number];
  readonly distancePx: number;
  readonly angleDeg: number;
  readonly perpendicularPx: number;
}
export interface Resolution extends PairMeasure {
  readonly center: readonly [number, number];
  readonly visibility: 'VISIBLE' | 'PARTIALLY_OBSERVED_RECOVERED';
  readonly ownedPx: Uint32Array;
  readonly state: 'RESOLVED_BY_NAIVE_GATE';
}
export interface ResolutionState {
  readonly resolutions: readonly Resolution[];
  readonly unresolvedHoles: readonly number[];
  readonly unresolvedTees: readonly number[];
  readonly assumption: string;
  readonly recovery: 'NOT_RUN' | 'OPEN_FRAME_ONLY';
}
export const S4PxC = {
  pairs: pxKey<readonly PairMeasure[]>('px.s4.teeBadge.pairs'),
  state: pxKey<ResolutionState>('px.s4.teeBadge.state'),
  pcr: pxKey<unknown>('px.s4.pcr')
};

/** Bidirectional major axis: the eigenvector's sign is not semantic direction. */
export function measurePairs(tees: readonly Pick<Tee,'center'|'angleRad'>[], badges: readonly Badge[]): PairMeasure[] {
  return tees.flatMap((tee, index) => badges.flatMap(badge => {
    const hole = Number(badge.label);
    if (!Number.isInteger(hole) || hole <= 0) return [];
    const center: [number, number] = [badge.bbox[0] + (badge.bbox[2]-1)/2,
      badge.bbox[1] + (badge.bbox[3]-1)/2];
    const dx = center[0]-tee.center[0], dy = center[1]-tee.center[1];
    const distancePx = Math.hypot(dx,dy);
    const perpendicularPx = Math.abs(-Math.sin(tee.angleRad)*dx + Math.cos(tee.angleRad)*dy);
    const angleDeg = distancePx > 0 ? Math.asin(Math.min(1,perpendicularPx/distancePx))*180/Math.PI : 90;
    return [{tee:index, hole, badgeCenter:center, distancePx, angleDeg, perpendicularPx}];
  }));
}

/** Non-executing Gate: judgment over already-computed pair measurements.
 * Reciprocal nearest within the axis window is deliberately falsifiable.
 * Do not free conflicting candidates and rerun until the cardinality is 18.
 */
export function judgePairs(pairs: readonly PairMeasure[], tees: readonly Pick<Tee,'center'|'px'>[]): ResolutionState {
  const eligible = pairs.filter(pair => pair.angleDeg <= AXIS_WINDOW_DEG && pair.distancePx > 0);
  const nearest = (items: readonly PairMeasure[]) => [...items].sort((a,b) =>
    a.distancePx-b.distancePx || a.angleDeg-b.angleDeg || a.hole-b.hole || a.tee-b.tee)[0];
  const preferred = tees.map((_,tee) => nearest(eligible.filter(pair => pair.tee===tee)));
  const resolutions = preferred.filter((pair): pair is PairMeasure => !!pair &&
    nearest(eligible.filter(other => other.hole===pair.hole))?.tee === pair.tee)
    .map(pair => ({...pair, center:tees[pair.tee].center, visibility:'VISIBLE' as const,
      ownedPx:Uint32Array.from(tees[pair.tee].px), state:'RESOLVED_BY_NAIVE_GATE' as const}));
  return {resolutions:resolutions.sort((a,b)=>a.hole-b.hole),
    unresolvedHoles:[...new Set(pairs.map(pair=>pair.hole))].filter(hole=>!resolutions.some(r=>r.hole===hole)).sort((a,b)=>a-b),
    unresolvedTees:tees.map((_,i)=>i).filter(tee=>!resolutions.some(r=>r.tee===tee)),
    assumption:'NaiveGate: reciprocal nearest candidate within 5 degrees of the bidirectional major axis',
    recovery:'NOT_RUN'};
}
