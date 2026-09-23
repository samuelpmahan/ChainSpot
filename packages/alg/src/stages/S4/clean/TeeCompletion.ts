import type { Tee } from '../../S3/clean/Tee';
import type { RecoveredTee } from '../contract';

export type CompleteTee = Tee | RecoveredTee;

function centerOf(tee: CompleteTee): readonly [number,number] {
	return 'center' in tee ? tee.center : [tee.xPx,tee.yPx];
}
function distance(a:CompleteTee,b:CompleteTee):number {
	const [ax,ay]=centerOf(a),[bx,by]=centerOf(b); return Math.hypot(ax-bx,ay-by);
}

/**
 * S4 completion is not concatenation. Recovery is evidence that can replace a
 * spurious initial proposal. Keep every recovered physical Tee, suppress an
 * initial Tee when it duplicates recovery, then retain the most course-like
 * initial inventory needed to satisfy Badge-defined cardinality.
 */
export function completeTees(initial:readonly Tee[],recovered:readonly RecoveredTee[],expected:number):readonly CompleteTee[] {
	const RECOVERY_DEDUPE_PX=18;
	const surviving=initial.filter(t=>!recovered.some(r=>distance(t,r)<RECOVERY_DEDUPE_PX));
	const needed=expected-recovered.length;
	if(needed<0) throw new Error(`Tee completion impossible: recovered=${recovered.length} exceeds expected=${expected}`);
	if(surviving.length<needed) throw new Error(`Tee completion incomplete: initial survivors=${surviving.length}, recovered=${recovered.length}, expected=${expected}`);
	if(surviving.length===needed) return [...surviving,...recovered];

	// Initial S3 false positives on UDisc captures are characteristically
	// isolated from the course's coherent Tee population. Score each proposal
	// by distance to its nearest neighbors and discard only the excess.
	const isolation=surviving.map((tee,index)=>{
		const ds=surviving.filter((_,j)=>j!==index).map(other=>distance(tee,other)).sort((a,b)=>a-b);
		const local=(ds[0]??Infinity)+(ds[1]??Infinity);
		return {tee,index,local};
	});
	isolation.sort((a,b)=>a.local-b.local||a.index-b.index);
	return [...isolation.slice(0,needed).map(x=>x.tee),...recovered];
}
