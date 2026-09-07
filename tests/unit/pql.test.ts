import { expect, it } from 'vitest';
import { createExecBoard, pxFn } from '../../packages/alg/src/exec/board';
import { readPql, invokePql } from '../../packages/alg/src/exec/pql';
const yaml = `PrincipleComponentRender: Probe
Ticks:
  - name: Twice
    Calculations:
      - call: fn.add
        with: { value: px.input }
        args: { amount: 2 }
        into: px.middle
      - call: fn.add
        with: { value: px.middle }
        args: { amount: 3 }
        into: px.output
`;
it('parses YAML and feeds stored outputs into subsequent calculations with matching records', () => {
 const pxc = createExecBoard();
 pxc.set('px.input', 4);
 pxc.register(pxFn<{value:number;amount:number},number>('fn.add'), ({value,amount}) => value + amount);
 const run = invokePql(readPql(yaml), {pxc});
 expect(pxc.get('px.output')).toBe(9);
 expect(run.Ticks[0].Calculations[1].inputs.value).toBe(6);
 expect(pxc.get('px.pql.Probe')).toBe(run);
});
it('rejects an argument that shadows a named input before invocation', () => {
 expect(() => readPql(yaml.replace('amount: 2','value: 2'))).toThrow('both with and args');
});
