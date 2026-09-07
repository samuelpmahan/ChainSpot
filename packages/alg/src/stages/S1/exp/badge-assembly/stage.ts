import { createPqlStage } from '../../../../exec/stage';
import { prepareBadgeAssemblyExp } from './index';
/** The host supplies this directory's PrincipleComponentRender.yaml as text. */
export function createStage(yaml: string) { return createPqlStage(yaml, prepareBadgeAssemblyExp); }
