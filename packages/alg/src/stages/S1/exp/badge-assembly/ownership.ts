import { pxFn, type PxC } from '../../../../exec/board';
import type { WhiteRecognitionMatch } from './white-recognition';

type ReadBadge = WhiteRecognitionMatch['candidates'][number];
export interface PixelSet {
 readonly kind: 'pixel-set';
 readonly id: string;
 readonly widthPx: number;
 readonly heightPx: number;
 readonly coordinateFrameId: string;
 readonly pixels: Uint32Array;
}
/** Serializable declaration: component membership remains distinct from ownership. */
export interface UnaccountedButOwned {
 readonly rule: 'outer-border-bbox';
 readonly outerBorder: ReadBadge['border']['part'];
 readonly bbox: readonly [number, number, number, number];
}
export type OwnedBadge = ReadBadge & { readonly unaccountedButOwned: UnaccountedButOwned };
function pixelSet(badge: OwnedBadge, id: string, pixels: Iterable<number>): PixelSet {
 return {kind:'pixel-set',id,widthPx:badge.plate.part.widthPx,heightPx:badge.plate.part.heightPx,
  coordinateFrameId:badge.plate.part.coordinateFrameId,pixels:Uint32Array.from(pixels)};
}
/** Query the full exclusion footprint. Bounds are inclusive of the border pixels. */
export function queryBadgeMutedPixels(badge: OwnedBadge): PixelSet {
 const [x,y,w,h]=badge.unaccountedButOwned.bbox;
 const width=badge.plate.part.widthPx,height=badge.plate.part.heightPx;
 const pixels:number[]=[];
 for(let py=Math.max(0,y);py<Math.min(height,y+h);py++)
  for(let px=Math.max(0,x);px<Math.min(width,x+w);px++)pixels.push(py*width+px);
 return pixelSet(badge,`${badge.id}:exclusion`,pixels);
}
/** The extra owned pixels have no constituent-component explanation yet. */
export function queryUnaccountedButOwned(badge: OwnedBadge): PixelSet {
 const explained=new Set(badge.pixels);
 return pixelSet(badge,`${badge.id}:unaccounted-but-owned`,
  Array.from(queryBadgeMutedPixels(badge).pixels).filter(p=>!explained.has(p)));
}
function declare({recognized}: {recognized:WhiteRecognitionMatch}): readonly OwnedBadge[] {
 return recognized.candidates.map(badge=>({...badge,unaccountedButOwned:{
  rule:'outer-border-bbox' as const,outerBorder:badge.border.part,bbox:badge.border.bbox}}));
}
type Raster = {widthPx:number;heightPx:number};
function collection(raster:Raster,id:string,pixels:Iterable<number>):PixelSet {
 return {kind:'pixel-set',id,widthPx:raster.widthPx,heightPx:raster.heightPx,coordinateFrameId:'px.course.canonicalPixels',pixels:Uint32Array.from(pixels)};
}
function owned({badges,raster}:{badges:readonly OwnedBadge[];raster:Raster}):PixelSet {
 return collection(raster,'badge-component-pixels',[...new Set(badges.flatMap(b=>Array.from(b.pixels)))].sort((a,b)=>a-b));
}
function muted({badges,owned,raster}:{badges:readonly OwnedBadge[];owned:PixelSet;raster:Raster}):PixelSet {
 const explained=new Set(owned.pixels),extra=new Set<number>();
 for(const badge of badges)for(const p of queryBadgeMutedPixels(badge).pixels)if(!explained.has(p))extra.add(p);
 return collection(raster,'unaccounted-but-owned',[...extra].sort((a,b)=>a-b));
}
function remaining({owned,muted,raster}:{owned:PixelSet;muted:PixelSet;raster:Raster}):PixelSet {
 const excluded=new Uint8Array(raster.widthPx*raster.heightPx);
 for(const p of owned.pixels)excluded[p]=1;
 for(const p of muted.pixels)excluded[p]=1;
 const pixels:number[]=[];for(let p=0;p<excluded.length;p++)if(!excluded[p])pixels.push(p);
 return collection(raster,'remaining-after-badges',pixels);
}
export function prepareBadgeOwnership(pxc:PxC):void {
 pxc.register(pxFn<Parameters<typeof declare>[0],ReturnType<typeof declare>>('fn.s1.badges.declareOwnership'),declare);
 pxc.register(pxFn<Parameters<typeof owned>[0],ReturnType<typeof owned>>('fn.s1.badges.ownedPixels'),owned);
 pxc.register(pxFn<Parameters<typeof muted>[0],ReturnType<typeof muted>>('fn.s1.badges.mutedPixels'),muted);
 pxc.register(pxFn<Parameters<typeof remaining>[0],ReturnType<typeof remaining>>('fn.s1.badges.remainingPixels'),remaining);
}
