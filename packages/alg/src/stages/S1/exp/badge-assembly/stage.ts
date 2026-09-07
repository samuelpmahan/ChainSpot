import { createPqlStage } from '../../../../exec/stage';
import { prepareBadgeAssemblyExp } from './index';
import { prepareWhiteRecognition } from './white-recognition';
import { prepareBadgeOwnership } from './ownership';
/** The host supplies this directory's PrincipleComponentRender.yaml as text. */
export function createStage(yaml: string) {
 return createPqlStage(yaml, pxc => {
  prepareBadgeAssemblyExp(pxc);
  prepareWhiteRecognition(pxc);
  prepareBadgeOwnership(pxc);
 });
}
