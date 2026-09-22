import { materializeComposite } from '../../../g0/composite';
import type { CompositeResult } from '../../../g0/composite';
import type { InputAsset } from '../../../g0/inputAsset';

/**
 * Deliberately boring S0 experiment: take one extra row from each vertical
 * edge of the clean crop. Exists to exercise real speculative S0→S1 flow,
 * not to claim a better crop algorithm.
 */
export async function tighterChromeFromClean(fullImage: InputAsset, clean: CompositeResult): Promise<CompositeResult> {
 const removedTop=Math.max(0,Math.floor((fullImage.heightPx-clean.heightPx)/2));
 const removedBottom=Math.max(0,fullImage.heightPx-clean.heightPx-removedTop);
 const top=Math.min(fullImage.heightPx-1,removedTop+1);
 const bottom=Math.min(fullImage.heightPx-top-1,removedBottom+1);
 return materializeComposite([{rgba:fullImage.rgba,widthPx:fullImage.widthPx,heightPx:fullImage.heightPx,placement:{x:0,y:0}}],{top,bottom,left:0,right:0});
}
