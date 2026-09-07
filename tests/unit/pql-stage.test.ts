import { expect, it } from 'vitest';
import {createExecBoard,pxFn} from '../../packages/alg/src/exec/board';
import {createPqlStage} from '../../packages/alg/src/exec/stage';
import {Comparator, type ComparisonInput} from '../../packages/alg/src/exec/comparator';
class TripleComparator extends Comparator {
 readonly id = 'triple-output';
 compare({baseline,feature}: ComparisonInput) {
  return {matchesExpected: baseline.pxc.get('px.output') === 3 && feature.pxc.get('px.output') === 6};
 }
}
it('runs every registration independently, records the actual callable, and replaces registration by ID',()=>{
 const pxc=createExecBoard();pxc.set('px.input',2);
 const add=({value}:{value:number})=>value+1;
 const triple=({value}:{value:number})=>value*3;
 const stage=createPqlStage(`PrincipleComponentRender: Demo
Ticks:
  - name: Transform
    Calculations:
      - call: fn.add
        with: {value: px.input}
        into: px.output
`, world=>{world.register(pxFn<{value:number},number>('fn.add'),add);world.register(pxFn<{value:number},number>('fn.triple'),triple);});
 const comparator = new TripleComparator();
 stage.register({id:'tripled',overrides:{'fn.add':{call:'fn.triple'}},comparator});
 stage.register({id:'tripled',overrides:{'fn.add':{call:'fn.triple'}},comparator});
 const results=stage.run({pxc});
 expect(results.map(r=>r.pxc.get('px.output'))).toEqual([3,6]);
 expect(results[1].run?.Ticks[0].Calculations[0].actualCall).toBe('fn.triple');
 expect(pxc.has('px.output')).toBe(false);
 expect(pxc.get('px.pql.Demo.results')).toBe(results);
 expect(pxc.get('px.pql.Demo.comparisons')).toEqual([
  {comparator:'triple-output',baseline:'Default',feature:'tripled',status:'completed',output:{matchesExpected:true}}
 ]);
 expect(results.every(result => typeof result.executionMs === 'number' && result.executionMs >= 0)).toBe(true);
 expect(() => stage.register({id:'missing',overrides:{}} as Parameters<typeof stage.register>[0])).toThrow('must supply a named Comparator');
});
