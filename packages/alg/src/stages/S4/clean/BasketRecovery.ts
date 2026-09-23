import type { RgbaRaster } from '../../../detect';
import type { Badge } from '../../S1/clean/Badge';
import type { Basket } from '../../S2/clean/Basket';

export interface RecoveredBasketCandidate {
	readonly bbox: readonly [number, number, number, number];
	readonly score: number;
	readonly trustedFraction: number;
	readonly source: 'masked-course-template';
}

const SAMPLE_STEP=3, COARSE_STRIDE=6, SEARCH_RADIUS_PX=180, REFINE_RADIUS_PX=7;
const BADGE_MASK_MARGIN_PX=2, DUPLICATE_CENTER_PX=25, MIN_TRUSTED_FRACTION=.25, MIN_SCORE=.55;

function gray(rgba: Uint8Array|Uint8ClampedArray): Float32Array {
	const out=new Float32Array(rgba.length/4);
	for(let i=0,j=0;i<rgba.length;i+=4,j++) out[j]=.299*rgba[i]!+.587*rgba[i+1]!+.114*rgba[i+2]!;
	return out;
}
function center(b: readonly [number,number,number,number]): readonly [number,number] {
	return [b[0]+b[2]/2,b[1]+b[3]/2];
}

/** Clean S4 recovery: learn this course's intact Basket appearance, then
 * badge-mask and locally search around its semantic Badge inventory. */
export function recoverOccludedBaskets(image:RgbaRaster,badges:readonly Badge[],initial:readonly Basket[]):readonly RecoveredBasketCandidate[] {
	if(initial.length<4) return [];
	const [basketW,basketH]=initial[0]!.bbox.slice(2) as [number,number];
	if(basketW<=0||basketH<=0||initial.some(b=>b.bbox[2]!==basketW||b.bbox[3]!==basketH)) return [];
	const pixels=gray(image.rgba);
	const samples:[number,number][]=[];
	for(let y=0;y<basketH;y+=SAMPLE_STEP) for(let x=0;x<basketW;x+=SAMPLE_STEP) samples.push([x,y]);
	const template=new Float32Array(samples.length);
	for(const basket of initial){
		const [x0,y0]=basket.bbox;
		for(let i=0;i<samples.length;i++){const [x,y]=samples[i]!;template[i]+=pixels[(y0+y)*image.widthPx+x0+x]!;}
	}
	for(let i=0;i<template.length;i++) template[i]/=initial.length;
	const badgeBoxes=badges.map(b=>b.bbox);
	const masked=(x:number,y:number)=>badgeBoxes.some(([bx,by,w,h])=>x>=bx-BADGE_MASK_MARGIN_PX&&x<bx+w+BADGE_MASK_MARGIN_PX&&y>=by-BADGE_MASK_MARGIN_PX&&y<by+h+BADGE_MASK_MARGIN_PX);
	const existing=initial.map(b=>center(b.bbox));
	const duplicate=(x0:number,y0:number)=>{const x=x0+basketW/2,y=y0+basketH/2;return existing.some(([ex,ey])=>Math.hypot(ex-x,ey-y)<DUPLICATE_CENTER_PX);};
	const ncc=(x0:number,y0:number):{score:number;trustedFraction:number}|null=>{
		let ps=0,ts=0,n=0;
		for(let i=0;i<samples.length;i++){const [x,y]=samples[i]!,gx=x0+x,gy=y0+y;if(gx<0||gy<0||gx>=image.widthPx||gy>=image.heightPx||masked(gx,gy))continue;ps+=pixels[gy*image.widthPx+gx]!;ts+=template[i]!;n++;}
		const trustedFraction=n/samples.length;if(trustedFraction<MIN_TRUSTED_FRACTION)return null;
		const pm=ps/n,tm=ts/n;let cross=0,pe=0,te=0;
		for(let i=0;i<samples.length;i++){const [x,y]=samples[i]!,gx=x0+x,gy=y0+y;if(gx<0||gy<0||gx>=image.widthPx||gy>=image.heightPx||masked(gx,gy))continue;const a=pixels[gy*image.widthPx+gx]!-pm,b=template[i]!-tm;cross+=a*b;pe+=a*a;te+=b*b;}
		return pe>1e-6&&te>1e-6?{score:cross/Math.sqrt(pe*te),trustedFraction}:null;
	};
	let best:{x0:number;y0:number;score:number;trustedFraction:number}|null=null;
	for(const badge of badges){
		const [cx,cy]=center(badge.bbox);
		const minX=Math.max(0,Math.floor(cx-SEARCH_RADIUS_PX-basketW/2)),maxX=Math.min(image.widthPx-basketW,Math.ceil(cx+SEARCH_RADIUS_PX-basketW/2));
		const minY=Math.max(0,Math.floor(cy-SEARCH_RADIUS_PX-basketH/2)),maxY=Math.min(image.heightPx-basketH,Math.ceil(cy+SEARCH_RADIUS_PX-basketH/2));
		for(let y0=minY;y0<=maxY;y0+=COARSE_STRIDE) for(let x0=minX;x0<=maxX;x0+=COARSE_STRIDE){if(duplicate(x0,y0))continue;const r=ncc(x0,y0);if(r&&(!best||r.score>best.score))best={x0,y0,...r};}
	}
	if(!best)return [];
	let refined=best;
	for(let y0=Math.max(0,best.y0-REFINE_RADIUS_PX);y0<=Math.min(image.heightPx-basketH,best.y0+REFINE_RADIUS_PX);y0++)
		for(let x0=Math.max(0,best.x0-REFINE_RADIUS_PX);x0<=Math.min(image.widthPx-basketW,best.x0+REFINE_RADIUS_PX);x0++){if(duplicate(x0,y0))continue;const r=ncc(x0,y0);if(r&&r.score>refined.score)refined={x0,y0,...r};}
	if(refined.score<MIN_SCORE)return [];
	return [{bbox:[refined.x0,refined.y0,basketW,basketH],score:refined.score,trustedFraction:refined.trustedFraction,source:'masked-course-template'}];
}
