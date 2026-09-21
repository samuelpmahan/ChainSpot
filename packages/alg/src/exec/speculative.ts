export interface SemanticDelta { readonly path: string; readonly before: unknown; readonly after: unknown; }

export function semanticDelta(before: unknown, after: unknown, path = ''): SemanticDelta[] {
	if (Object.is(before, after)) return [];
	const a = before !== null && typeof before === 'object' && !Array.isArray(before);
	const b = after !== null && typeof after === 'object' && !Array.isArray(after);
	if (a && b) {
		const left = before as Record<string, unknown>, right = after as Record<string, unknown>;
		const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
		return keys.flatMap((key) => semanticDelta(left[key], right[key], path ? `${path}.${key}` : key));
	}
	return [{ path: path || '$', before, after }];
}

export interface SemanticCalculation {
	readonly id: string;
	readonly semanticConsumes?: readonly string[];
	readonly consumes?: readonly string[];
	readonly produces?: readonly string[];
}

export function surgicalExecutionCone(deltas: readonly SemanticDelta[], calculations: readonly SemanticCalculation[]) {
	const changed = deltas.map((d) => d.path);
	const affected = new Set<string>();
	const producedBy = new Map<string, string>();
	for (const calc of calculations) for (const part of calc.produces ?? []) producedBy.set(part, calc.id);
	const touches = (dep: string) => changed.some((path) => path === dep || path.startsWith(dep + '.') || dep.startsWith(path + '.'));
	for (const calc of calculations) if ((calc.semanticConsumes ?? []).some(touches)) affected.add(calc.id);
	let grew = true;
	while (grew) {
		grew = false;
		for (const calc of calculations) {
			if (affected.has(calc.id)) continue;
			if ((calc.consumes ?? []).some((part) => {
				const producer = producedBy.get(part);
				return producer ? affected.has(producer) : false;
			})) { affected.add(calc.id); grew = true; }
		}
	}
	return calculations.map((calc) => ({ id: calc.id, resolution: affected.has(calc.id) ? 'EXECUTE' as const : 'REUSE' as const }));
}

export interface ParityComparison { readonly parity: boolean; readonly comparator?: `fn.${string}`; readonly where?: string; readonly why?: string; }

export function convergeOnEquivalence(candidatePart: string, cleanPart: string, comparison: ParityComparison) {
	return comparison.parity
		? { converged: true as const, reusablePart: cleanPart, testimony: { candidatePart, cleanPart, comparator: comparison.comparator, reason: 'semantic-equivalence' as const } }
		: { converged: false as const, reusablePart: undefined };
}

export function propagateWhileParity<T extends { readonly id: string; readonly compare: () => ParityComparison }>(stages: readonly T[]) {
	const visited: Array<{ stageId: string; comparison: ParityComparison }> = [];
	for (const stage of stages) {
		const comparison = stage.compare();
		visited.push({ stageId: stage.id, comparison });
		if (!comparison.parity) return { status: 'REBUKED' as const, stoppedAt: stage.id, continuation: 'STOP' as const, visited };
	}
	return { status: 'SUPPORTED' as const, continuation: 'PASS_WHILE' as const, visited };
}
