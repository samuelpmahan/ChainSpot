import { parse } from 'yaml';
import { pxFn, type PxC } from './board';

export interface PqlCalculation {
 readonly call: `fn.${string}`;
 readonly with: Readonly<Record<string, string>>;
 readonly args: Readonly<Record<string, unknown>>;
 readonly into: string;
}
export interface PqlTick {
 readonly name: string;
 readonly Calculations: readonly PqlCalculation[];
}
export interface PqlComposition {
 readonly PrincipleComponentRender: string;
 readonly Ticks: readonly PqlTick[];
}
export interface PqlCalculationRecord extends PqlCalculation {
 readonly actualCall: `fn.${string}`;
 /** Actual input and output values, held by reference rather than copied. */
 readonly inputs: Readonly<Record<string, unknown>>;
 readonly output: unknown;
}
export interface PqlTickRecord {
 readonly name: string;
 readonly Calculations: readonly PqlCalculationRecord[];
}
export interface PqlRun {
 readonly PrincipleComponentRender: string;
 readonly Ticks: readonly PqlTickRecord[];
}

function object(value: unknown, where: string): Record<string, unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value))
  throw new Error(`PQL ${where}: expected a mapping.`);
 return value as Record<string, unknown>;
}
function text(value: unknown, where: string): string {
 if (typeof value !== 'string' || !value.length) throw new Error(`PQL ${where}: expected a nonempty string.`);
 return value;
}
function list(value: unknown, where: string): unknown[] {
 if (!Array.isArray(value)) throw new Error(`PQL ${where}: expected a sequence.`);
 return value;
}

/** Read YAML text; filesystem access stays with the caller. */
export function readPql(source: string, parseYaml: (source: string) => unknown = parse): PqlComposition {
 const root = object(parseYaml(source), 'document');
 return {
  PrincipleComponentRender: text(root.PrincipleComponentRender, 'PrincipleComponentRender'),
  Ticks: list(root.Ticks, 'Ticks').map((value, tickIndex) => {
   const tick = object(value, `Ticks[${tickIndex}]`);
   return {
    name: text(tick.name, `Ticks[${tickIndex}].name`),
    Calculations: list(tick.Calculations, 'Calculations').map((value, index) => {
     const where = `${tick.name}.Calculations[${index}]`;
     const calculation = object(value, where);
     const call = text(calculation.call, `${where}.call`);
     if (!call.startsWith('fn.')) throw new Error(`PQL ${where}.call: expected a registered fn. address.`);
     const bindings = object(calculation.with ?? {}, `${where}.with`);
     const args = object(calculation.args ?? {}, `${where}.args`);
     for (const [name, address] of Object.entries(bindings)) {
      text(address, `${where}.with.${name}`);
      if (Object.hasOwn(args, name)) throw new Error(`PQL ${where}: '${name}' appears in both with and args.`);
     }
     return { call: call as `fn.${string}`, with: bindings as Record<string, string>,
      args, into: text(calculation.into, `${where}.into`) };
    })
   };
  })
 };
}

/** Execute synchronously in declaration order using already registered PxC calculations.
 * Writes are immediate. Failure leaves earlier writes intact; reruns replace addresses.
 * Records reference actual values: calculations must not mutate their input Parts.
 */
export interface CalculationOverride {
 readonly call: `fn.${string}`;
 readonly args?: Readonly<Record<string, unknown>>;
}
export function invokePql(composition: PqlComposition, { pxc, overrides = {} }: {
 pxc: PxC; overrides?: Readonly<Record<string, CalculationOverride>>;
}): PqlRun {
 const ticks: PqlTickRecord[] = [];
 for (const tick of composition.Ticks) {
  const calculations: PqlCalculationRecord[] = [];
  for (const calculation of tick.Calculations) {
   try {
    const inputs = Object.fromEntries(Object.entries(calculation.with)
     .map(([name, address]) => [name, pxc.get(address)]));
    const replacement = overrides[calculation.call];
    const actualCall = replacement?.call ?? calculation.call;
    const args = { ...calculation.args, ...replacement?.args };
    for (const name of Object.keys(inputs))
     if (Object.hasOwn(args,name)) throw new Error(`Argument '${name}' shadows a named input.`);
    const output = pxc.call(pxFn<Record<string, unknown>, unknown>(actualCall), { ...args, ...inputs });
    pxc.set(calculation.into, output);
    calculations.push({ ...calculation, actualCall, args, inputs, output });
   } catch (cause) {
    throw new Error(`PQL ${tick.name}: ${calculation.call} -> ${calculation.into} failed.`, { cause });
   }
  }
  ticks.push({ name: tick.name, Calculations: calculations });
 }
 const run = { PrincipleComponentRender: composition.PrincipleComponentRender, Ticks: ticks };
 pxc.set(`px.pql.${composition.PrincipleComponentRender}`, run);
 return run;
}
