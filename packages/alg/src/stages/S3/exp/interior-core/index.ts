/**
 * S3 challenger: renderer-fill components complement (not replace) closed rings.
 * No Annotation inputs. The color prototype is a learned sensor, not a Tee law.
 * Existing non-chrome Tees survive, including differently tinted interiors.
 * Weak narrow fragments remain in PxC for later composed recovery, not discarded.
 * New objects retain OBSERVED support only; their full pose remains unresolved.
 */
import type { CompositeResult } from '../../../../g0/composite';
import { extractComponents, type ComponentStats } from '../../../../detectors/threeFactor/components';
import type { BrightDarkComponentFields } from '../../../../detectors/threeFactor/componentField';
import { detectScreenChromeRegions, pointInScreenChrome, type ScreenChromeRegion } from '../../../../detectors/threeFactor/screenChrome';
import type { Badge } from '../../../S1/clean/Badge';
import type { Basket } from '../../../S2/clean/Basket';
import type { Tee } from '../../clean/Tee';

export const SENSOR_FN = 'fn.Tee.exp.interiorCore';
export const COMPOSE_FN = 'fn.Tee.exp.composeInteriorCore';
// Deliberately broad experimental gates, retained in testimony and tested.
// These are not claims about all course rendering families.
export const SENSOR_KNOBS = Object.freeze({ colorTolerance: 10, minimumPixels: 4,
  maximumSpan: 128, borderReach: 3, minimumWhiteSupport: 0.4, minimumFill: 0.45, minimumStrongMinor: 3, coreTolerance: 3 });

type Box = readonly [number, number, number, number];
export interface InteriorCandidate {
  readonly id: string;
  readonly component: ComponentStats;
  readonly pixels: Uint32Array;
  readonly whiteSupport: Uint32Array;
  readonly whiteSupportFraction: number;
  readonly uniformCorePixels: number;
  readonly accepted: boolean;
  readonly reason: string;
  readonly overlapsBaseline: boolean;
  readonly inChrome: boolean;
}
export interface InteriorObservation {
  readonly fn: typeof SENSOR_FN;
  readonly knobs: typeof SENSOR_KNOBS;
  readonly prototype: readonly [number, number, number] | null;
  readonly prototypeSamples: number;
  readonly palette: readonly (readonly number[])[];
  readonly chrome: readonly ScreenChromeRegion[];
  readonly candidates: readonly InteriorCandidate[];
}
export interface SensorTee {
  readonly center: readonly [number, number];
  readonly innerBbox: Box;
  readonly bbox: Box;
  readonly angleRad: number;
  readonly px: Uint32Array;
  readonly has: {
    readonly interior: { readonly fn: string; readonly candidateId: string; readonly component: ComponentStats };
    readonly whiteSupport: { readonly fn: string; readonly px: Uint32Array; readonly fraction: number; readonly ownership: 'SUPPORT_NOT_CLAIMED' };
    readonly visibility: 'PARTIALLY_OBSERVED';
    readonly localization: 'OBSERVED_INTERIOR_CENTROID_NOT_COMPLETE_POSE';
  };
}
export type BenchTee = Tee | SensorTee;
export interface SensorInput {
  readonly image: CompositeResult;
  readonly fields: BrightDarkComponentFields;
  readonly tees: readonly Tee[];
  readonly badges: readonly Badge[];
  readonly baskets: readonly Basket[];
}

function median(values: number[]): number {
  values.sort((a,b) => a-b);
  return values[Math.floor(values.length / 2)];
}
function boxOf(c: ComponentStats): Box { return [c.bboxX,c.bboxY,c.bboxW,c.bboxH]; }
function intersects(a: Box, b: Box): boolean {
  return a[0] < b[0]+b[2] && b[0] < a[0]+a[2] && a[1] < b[1]+b[3] && b[1] < a[1]+a[3];
}

export function observeInterior({image, fields, tees, badges, baskets}: SensorInput): InteriorObservation {
  const {widthPx: width, heightPx: height, rgba} = image;
  const chrome = detectScreenChromeRegions(fields.bright.components, width, height);
  const samples: number[][] = [];
  for (const tee of tees) {
    if (pointInScreenChrome(tee.center[0], tee.center[1], chrome)) continue;
    const x = Math.round(tee.center[0]), y = Math.round(tee.center[1]);
    if (x < 1 || y < 1 || x >= width-1 || y >= height-1) continue;
    const channels: number[][] = [[],[],[]];
    for (let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
      const p = ((y+dy)*width+x+dx)*4;
      for (let c=0;c<3;c++) channels[c].push(rgba[p+c]);
    }
    samples.push(channels.map(median));
  }
  if (!samples.length) return {fn:SENSOR_FN,knobs:SENSOR_KNOBS,prototype:null,prototypeSamples:0,palette:[],chrome,candidates:[]};
  const prototype = [0,1,2].map(c=>median(samples.map(s=>s[c]))) as [number,number,number];
  const palette: number[][] = [];
  for (const sample of samples) if (!palette.some(color=>Math.max(...color.map((v,c)=>Math.abs(v-sample[c])))<=3)) palette.push(sample);
  const count = width*height, mask = new Uint8Array(count), tight = new Uint8Array(count), occupied = new Uint8Array(count);
  for (const badge of badges) for (const p of badge.has.mute.px) occupied[p]=1;
  for (const basket of baskets) for (const p of basket.px) occupied[p]=1;
  for(let p=0;p<count;p++) {
    const i=p*4;
    if (!occupied[p] && rgba[i+3] && palette.some(color=>Math.max(Math.abs(rgba[i]-color[0]),Math.abs(rgba[i+1]-color[1]),Math.abs(rgba[i+2]-color[2])) <= SENSOR_KNOBS.colorTolerance)) {
      mask[p]=1;
      if(palette.some(color=>Math.max(Math.abs(rgba[i]-color[0]),Math.abs(rgba[i+1]-color[1]),Math.abs(rgba[i+2]-color[2]))<=SENSOR_KNOBS.coreTolerance)) tight[p]=1;
    }
  }
  const field = extractComponents({width,height,data:mask});
  const candidates: InteriorCandidate[] = [];
  for (const c of field.components) {
    if(c.area < SENSOR_KNOBS.minimumPixels || c.bboxW>SENSOR_KNOBS.maximumSpan || c.bboxH>SENSOR_KNOBS.maximumSpan) continue;
    const pixels: number[] = [], white = new Set<number>();
    let boundaryCount=0, supported=0, uniformCorePixels=0;
    for(let y=c.bboxY;y<c.bboxY+c.bboxH;y++) for(let x=c.bboxX;x<c.bboxX+c.bboxW;x++) {
      const p=y*width+x;
      if(field.labels[p]!==c.label) continue;
      pixels.push(p);
      if(x>0 && y>0 && x<width-1 && y<height-1) {
        let completeCore=true;
        for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
          const q=(y+dy)*width+x+dx;
          if(!tight[q] || field.labels[q]!==c.label) completeCore=false;
        }
        if(completeCore) uniformCorePixels++;
      }
      const boundary = x===0 || y===0 || x===width-1 || y===height-1 ||
        field.labels[p-1]!==c.label || field.labels[p+1]!==c.label || field.labels[p-width]!==c.label || field.labels[p+width]!==c.label;
      if(!boundary) continue;
      boundaryCount++;
      let hasWhite=false;
      for(let dy=-SENSOR_KNOBS.borderReach;dy<=SENSOR_KNOBS.borderReach;dy++)
        for(let dx=-SENSOR_KNOBS.borderReach;dx<=SENSOR_KNOBS.borderReach;dx++) {
          if(x+dx<0 || y+dy<0 || x+dx>=width || y+dy>=height) continue;
          const q=(y+dy)*width+x+dx;
          if(!occupied[q] && fields.bright.mask.data[q]) { hasWhite=true; white.add(q); }
        }
      if(hasWhite) supported++;
    }
    const fraction=boundaryCount ? supported/boundaryCount : 0;
    const inChrome=pointInScreenChrome(c.cx,c.cy,chrome);
    // AA fragments beside the interior still belong to the same local Molecule.
    // This relates components to the observed frame; it is not a course-wide distance gate.
    const overlapsBaseline=tees.some(tee=>intersects(boxOf(c),[tee.bbox[0]-3,tee.bbox[1]-3,tee.bbox[2]+6,tee.bbox[3]+6]));
    const accepted=!inChrome && uniformCorePixels>0 && c.fill>=SENSOR_KNOBS.minimumFill && c.minor>=SENSOR_KNOBS.minimumStrongMinor && fraction>=SENSOR_KNOBS.minimumWhiteSupport;
    candidates.push({id:`interior-${c.label}`,component:c,pixels:Uint32Array.from(pixels),whiteSupport:Uint32Array.from([...white].sort((a,b)=>a-b)),whiteSupportFraction:fraction,uniformCorePixels,overlapsBaseline,inChrome,accepted,
      reason:inChrome?'SCREEN_CHROME_PARENT':uniformCorePixels===0?'NO_UNIFORM_CORE_WEAK_FRAGMENT_RETAINED':c.fill<SENSOR_KNOBS.minimumFill?'IRREGULAR_COMPONENT':c.minor<SENSOR_KNOBS.minimumStrongMinor?'WEAK_FRAGMENT_RETAINED_FOR_RECOVERY':fraction<SENSOR_KNOBS.minimumWhiteSupport?'INSUFFICIENT_WHITE_BOUNDARY_SUPPORT':overlapsBaseline?'BASELINE_CORROBORATION':'NEW_INTERIOR_SUPPORT'});
  }
  return {fn:SENSOR_FN,knobs:SENSOR_KNOBS,prototype,prototypeSamples:samples.length,palette,chrome,candidates};
}

export function composeInterior(input: {tees:readonly Tee[]; observation:InteriorObservation}): readonly BenchTee[] {
  const retained: BenchTee[] = input.tees.filter(tee=>!pointInScreenChrome(tee.center[0],tee.center[1],input.observation.chrome));
  for(const c of input.observation.candidates) {
    if(!c.accepted || c.overlapsBaseline) continue;
    retained.push({center:[c.component.cx,c.component.cy],innerBbox:boxOf(c.component),bbox:boxOf(c.component),angleRad:c.component.angle,px:c.pixels,
      has:{interior:{fn:SENSOR_FN,candidateId:c.id,component:c.component},whiteSupport:{fn:SENSOR_FN,px:c.whiteSupport,fraction:c.whiteSupportFraction,ownership:'SUPPORT_NOT_CLAIMED'},visibility:'PARTIALLY_OBSERVED',localization:'OBSERVED_INTERIOR_CENTROID_NOT_COMPLETE_POSE'}});
  }
  return retained.sort((a,b)=>a.center[1]-b.center[1] || a.center[0]-b.center[0]);
}
