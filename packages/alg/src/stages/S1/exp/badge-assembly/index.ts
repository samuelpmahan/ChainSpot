import { pxFn, type PxC } from '../../../../exec/board';
import { containsBbox, type RasterBbox } from '../../../../detectors/threeFactor/componentAssembly';
import { prepareMaskComponentsExp, type ComponentPart, type ComponentSetPart } from '../mask-components';

type MeasuredPart = { readonly part: ComponentPart; readonly bbox: RasterBbox; readonly area: number };
interface PlateSelection {
 readonly selected: readonly MeasuredPart[];
 readonly rejected: readonly { component: MeasuredPart; reasons: readonly string[] }[];
}
interface RelationAnchor { readonly plate: MeasuredPart; readonly anchor: MeasuredPart }
interface RelationRow extends RelationAnchor { readonly matches: readonly MeasuredPart[] }
interface Relations { readonly predicate: RelationPredicate; readonly rows: readonly RelationRow[] }
type RelationPredicate = 'candidate-bbox-contains-anchor' | 'anchor-bbox-contains-candidate';
interface SelectArgs {
 components: ComponentSetPart;
 predicate: 'plate-bbox-and-fill';
 minWidth: number; maxWidth: number; minHeight: number; maxHeight: number;
 minAspect: number; maxAspect: number; minFill: number;
}
interface RelatedArgs {
 anchors: PlateSelection | Relations;
 candidates: ComponentSetPart;
 anchorRole: 'plate' | 'related-component';
 predicate: RelationPredicate;
}
interface AssembleArgs {
 plates: PlateSelection; plateBorders: Relations; plateDigits: Relations; digitLoops: Relations;
 acceptance: 'border-and-digit-material';
}

/** Measure existing membership; preserve the original Part and pixel buffer. */
function measure(part: ComponentPart): MeasuredPart {
 let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
 for (const pixel of part.pixels) {
  const x = pixel % part.widthPx, y = Math.floor(pixel / part.widthPx);
  minX = Math.min(minX,x); maxX = Math.max(maxX,x);
  minY = Math.min(minY,y); maxY = Math.max(maxY,y);
 }
 if (!part.pixels.length) throw new Error(`Cannot measure empty component ${part.id}.`);
 return {part, area: part.pixels.length, bbox:[minX,minY,maxX-minX+1,maxY-minY+1]};
}
function selectPlates(args: SelectArgs): PlateSelection {
 if (args.predicate !== 'plate-bbox-and-fill') throw new Error(`Unknown plate predicate: ${args.predicate}`);
 const selected: MeasuredPart[] = [], rejected: {component:MeasuredPart;reasons:string[]}[] = [];
 for (const part of args.components.components) {
  const component = measure(part);
  const [, , width, height] = component.bbox;
  const reasons: string[] = [];
  if (width < args.minWidth || width > args.maxWidth) reasons.push('width outside range');
  if (height < args.minHeight || height > args.maxHeight) reasons.push('height outside range');
  if (width / height < args.minAspect || width / height > args.maxAspect) reasons.push('aspect outside range');
  if (component.area / (width * height) < args.minFill) reasons.push('fill below minimum');
  if (reasons.length) rejected.push({component,reasons}); else selected.push(component);
 }
 return {selected,rejected};
}

/** Both relationship searches use this function; the predicate chooses direction. */
function findRelated({anchors,candidates,anchorRole,predicate}: RelatedArgs): Relations {
 if (predicate !== 'candidate-bbox-contains-anchor' && predicate !== 'anchor-bbox-contains-candidate')
  throw new Error(`Unknown relationship predicate: ${predicate}`);
 let resolved: RelationAnchor[];
 if (anchorRole === 'plate' && 'selected' in anchors)
  resolved = anchors.selected.map(plate => ({plate,anchor:plate}));
 else if (anchorRole === 'related-component' && 'rows' in anchors)
  resolved = anchors.rows.flatMap(row => row.matches.map(anchor => ({plate:row.plate,anchor})));
 else throw new Error('Relationship input does not match declared anchorRole.');
 const measured = candidates.components.map(measure);
 return {predicate, rows: resolved.map(({plate,anchor}) => ({plate,anchor,
  matches: measured.filter(candidate => {
   if (candidate.part.coordinateFrameId !== anchor.part.coordinateFrameId ||
       candidate.part.widthPx !== anchor.part.widthPx || candidate.part.heightPx !== anchor.part.heightPx)
    throw new Error('Cannot relate components in different raster frames.');
   return predicate === 'candidate-bbox-contains-anchor'
    ? containsBbox(candidate.bbox,anchor.bbox) : containsBbox(anchor.bbox,candidate.bbox);
  })
 }))};
}
function same(left: MeasuredPart,right: MeasuredPart): boolean { return left.part === right.part; }

function assemble({plates,plateBorders,plateDigits,digitLoops,acceptance}: AssembleArgs) {
 if (acceptance !== 'border-and-digit-material') throw new Error(`Unknown assembly predicate: ${acceptance}`);
 const candidates = [];
 const incomplete = [];
 for (const plate of plates.selected) {
  const borders = plateBorders.rows.filter(row => same(row.plate,plate)).flatMap(row => row.matches);
  const digits = plateDigits.rows.filter(row => same(row.plate,plate)).flatMap(row => row.matches);
  if (!borders.length || !digits.length) {
   incomplete.push({plate,borders,digits,reason: !borders.length ? 'no enclosing white border' : 'no contained white digit material'});
   continue;
  }
  // Preserve every border alternative. The same digit may remain related to multiple plates.
  for (const border of borders) {
   const digitParts = digits.filter(digit => !same(digit,border));
   if (!digitParts.length) {
    incomplete.push({plate,borders:[border],digits:digitParts,reason:'border leaves no separate digit material'});
    continue;
   }
   const loops = digitLoops.rows.filter(row => same(row.plate,plate) && digitParts.some(digit => same(digit,row.anchor)));
   const parts = [plate,border,...digitParts,...loops.flatMap(row => row.matches)];
   const pixels = Uint32Array.from([...new Set(parts.flatMap(item => Array.from(item.part.pixels)))].sort((a,b)=>a-b));
   candidates.push({id:`badge-candidate:${plate.part.id}:${border.part.id}`,plate,border,digits:digitParts,
    digitLoops:loops,pixels});
  }
 }
 return {candidates,incomplete};
}

export type BadgeAssemblyResult = ReturnType<typeof assemble>;

export const BadgeAssemblyFn = {
 selectComponents: pxFn<SelectArgs,PlateSelection>('fn.s1.exp.badgeAssembly.selectComponents'),
 findRelated: pxFn<RelatedArgs,Relations>('fn.s1.exp.badgeAssembly.findRelated'),
 assemble: pxFn<AssembleArgs,ReturnType<typeof assemble>>('fn.s1.exp.badgeAssembly.assemble')
};

/** Prepare the same warm PxC; the YAML alone determines which calculations execute. */
export function prepareBadgeAssemblyExp(pxc: PxC): void {
 prepareMaskComponentsExp(pxc);
 pxc.register(BadgeAssemblyFn.selectComponents,selectPlates);
 pxc.register(BadgeAssemblyFn.findRelated,findRelated);
 pxc.register(BadgeAssemblyFn.assemble,assemble);
}
