import { parse, stringify } from 'yaml';

export interface MermaidNode { readonly id: string; readonly label: string; readonly kind: 'fn' | 'px'; readonly tick?: string; }
export interface MermaidEdge { readonly from: string; readonly to: string; readonly label?: string; }
export interface MermaidGraph { readonly nodes: readonly MermaidNode[]; readonly edges: readonly MermaidEdge[]; readonly ticks: readonly string[]; }

function fail(message: string): never { throw new Error(`Mermaid PCR: ${message}`); }
function object(value: unknown, where: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${where} must be a mapping.`); return value as Record<string, unknown>; }
function fnLabel(value: string): value is `fn.${string}` { return value.startsWith('fn.'); }

/** Parse only the graph constructs used by the authored S0/S1 source. */
export function parseMermaid(source: string): MermaidGraph {
 const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
 if (lines.shift() !== 'flowchart TD') fail('only `flowchart TD` is supported.');
 const nodes = new Map<string, MermaidNode>(), edges: MermaidEdge[] = [], subgraphs: string[] = [], ticks: string[] = [];
 for (const line of lines) {
  if (line === 'end') { if (!subgraphs.length) fail('unexpected `end`.'); subgraphs.pop(); continue; }
  const sg = /^subgraph ([A-Za-z0-9_]+)\["([^"]+)"\]$/.exec(line);
  if (sg) { subgraphs.push(sg[2]); if (sg[2].startsWith('Tick: ')) ticks.push(sg[2].slice(6)); continue; }
  if (line.includes(':::') || line.startsWith('click ') || line.startsWith('classDef ')) fail(`unsupported syntax '${line}'.`);
		const labeled = /^([A-Za-z0-9_]+)\s+-->\|([^|]+)\|\s+([A-Za-z0-9_]+)$/.exec(line);
		if (labeled) { edges.push({ from: labeled[1], label: labeled[2], to: labeled[3] }); continue; }
		const labeledInlineTarget = /^([A-Za-z0-9_]+)\s+-->\|([^|]+)\|\s+([A-Za-z0-9_]+)\["([^"]+)"\]$/.exec(line);
		if (labeledInlineTarget) { registerNode(nodes, subgraphs, labeledInlineTarget[3], labeledInlineTarget[4]); edges.push({ from: labeledInlineTarget[1], label: labeledInlineTarget[2], to: labeledInlineTarget[3] }); continue; }
		const plain = /^([A-Za-z0-9_]+)\s+-->\s+([A-Za-z0-9_]+)$/.exec(line);
		if (plain) { edges.push({ from: plain[1], to: plain[2] }); continue; }
		const plainInlineTarget = /^([A-Za-z0-9_]+)\s+-->\s+([A-Za-z0-9_]+)\["([^"]+)"\]$/.exec(line);
		if (plainInlineTarget) { registerNode(nodes, subgraphs, plainInlineTarget[2], plainInlineTarget[3]); edges.push({ from: plainInlineTarget[1], to: plainInlineTarget[2] }); continue; }
  const node = /^([A-Za-z0-9_]+)\["([^"]+)"\]$/.exec(line);
  if (node) {
   const kind = fnLabel(node[2]) ? 'fn' : node[2].startsWith('px.') ? 'px' : null;
   if (!kind) fail(`node '${node[1]}' must label fn.* or px.*.`);
   const tick = [...subgraphs].reverse().find(value => value.startsWith('Tick: '))?.slice(6);
   const prior = nodes.get(node[1]);
   if (prior) fail(`node '${node[1]}' is declared more than once.`);
   nodes.set(node[1], { id: node[1], label: node[2], kind, tick });
   continue;
  }
  fail(`unsupported syntax '${line}'.`);
 }
 if (subgraphs.length) fail(`unterminated subgraph '${subgraphs.at(-1)}'.`);
 return { nodes: [...nodes.values()], edges, ticks };
}

function registerNode(nodes: Map<string, MermaidNode>, subgraphs: readonly string[], id: string, label: string): void {
	const kind = fnLabel(label) ? 'fn' : label.startsWith('px.') ? 'px' : null;
	if (!kind) fail(`node '${id}' must label fn.* or px.*.`);
	const tick = [...subgraphs].reverse().find(value => value.startsWith('Tick: '))?.slice(6);
	const prior = nodes.get(id);
	if (prior) fail(`node '${id}' is declared more than once.`);
	nodes.set(id, { id, label, kind, tick });
}

function readArgs(source: string): Record<string, Record<string, unknown>> { const root = object(parse(source), 'argument metadata'); return Object.fromEntries(Object.entries(root).map(([id, value]) => [id, object(value, `args.${id}`)])); }
function incoming(graph: MermaidGraph, id: string): readonly MermaidEdge[] { return graph.edges.filter(edge => edge.to === id); }
function outgoing(graph: MermaidGraph, id: string): readonly MermaidEdge[] { return graph.edges.filter(edge => edge.from === id); }

/** Declaration order is executable order; reject forward dependencies, including via PxC. */
export function compileMermaidPcr(mermaid: string, argsJson: string, _legacyS1Yaml?: string): string {
 const graph = parseMermaid(mermaid);
 const pcr = /subgraph \w+\["PCR: ([^"]+)"\]/.exec(mermaid)?.[1];
 if (!pcr) fail('missing PCR subgraph.');
 if (new Set(graph.ticks).size !== graph.ticks.length) fail('duplicate Tick names.');
 const byId = new Map(graph.nodes.map(node => [node.id, node]));
 const functions = graph.nodes.filter(node => node.kind === 'fn');
 const positions = new Map(functions.map((node, i) => [node.id, i]));
 const args = readArgs(argsJson);
 for (const id of Object.keys(args)) if (!positions.has(id)) fail(`unknown argument occurrence '${id}'.`);
 const writers = new Map<string, string>();
 for (const edge of graph.edges) {
  const from = byId.get(edge.from), to = byId.get(edge.to);
  if (!from || !to) fail(`unknown edge endpoint '${edge.from}' or '${edge.to}'.`);
  if (from.kind === 'px' && to.kind === 'px') fail('PxC-to-PxC edges require a Calculation.');
  if (to.kind === 'fn' && !edge.label) fail(`input edge to '${to.id}' needs a named binding.`);
  if (to.kind === 'px') {
   if (edge.label) fail('publication edges cannot have input labels.');
   if (writers.has(to.label)) fail(`multiple writers for '${to.label}'.`);
   writers.set(to.label, from.id);
  }
 }
 const ticks = graph.ticks.map(name => ({ name, Calculations: [] as Record<string, unknown>[] }));
 let previousTick = -1;
 for (const fn of functions) {
  const ti = graph.ticks.indexOf(fn.tick ?? '');
  if (ti < 0 || ti < previousTick) fail(`invalid Tick placement for '${fn.id}'.`);
  previousTick = ti;
  const bindings: Record<string, unknown> = {};
  for (const edge of incoming(graph, fn.id)) {
   const source = byId.get(edge.from)!;
   const key = edge.label!;
   if (Object.hasOwn(bindings, key) || Object.hasOwn(args[fn.id] ?? {}, key)) fail(`duplicate input '${fn.id}.${key}'.`);
   const producer = source.kind === 'fn' ? source.id : writers.get(source.label);
   if (producer && positions.get(producer)! >= positions.get(fn.id)!) fail(`forward dependency or cycle at '${fn.id}.${key}'.`);
   bindings[key] = source.kind === 'fn' ? { kind: 'fn', ref: source.id } : { kind: 'px', ref: source.label };
  }
  const publications = outgoing(graph, fn.id).filter(edge => byId.get(edge.to)!.kind === 'px');
  if (publications.length > 1) fail(`multiple publications from '${fn.id}'.`);
  if (!outgoing(graph, fn.id).length) fail(`unused function '${fn.id}'.`);
  ticks[ti].Calculations.push({ id: fn.id, call: fn.label, with: bindings, args: args[fn.id] ?? {},
   ...(publications.length ? { into: byId.get(publications[0].to)!.label } : {}) });
 }
 return stringify({ PrincipleComponentRender: pcr, Ticks: ticks });
}
