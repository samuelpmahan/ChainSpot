/**
 * Resolve a SemanticDelta into the smallest Calculation cone.
 * Dependencies are explicit semantic paths, never inferred from source text.
 */
export function surgicalExecutionCone({ deltas, calculations }) {
  const changed = new Set(deltas.map((d) => d.path));
  const affected = new Set();
  const producedBy = new Map();
  for (const calc of calculations) for (const part of calc.produces ?? []) producedBy.set(part, calc.id);

  const pathTouches = (dep) => [...changed].some((path) =>
    path === dep || path.startsWith(dep + '.') || dep.startsWith(path + '.'));

  // Direct semantic consumers seed the cone.
  for (const calc of calculations) {
    if ((calc.semanticConsumes ?? []).some(pathTouches)) affected.add(calc.id);
  }

  // Then close only over actual Part traffic.
  let grew = true;
  while (grew) {
    grew = false;
    for (const calc of calculations) {
      if (affected.has(calc.id)) continue;
      if ((calc.consumes ?? []).some((part) => affected.has(producedBy.get(part)))) {
        affected.add(calc.id); grew = true;
      }
    }
  }
  return calculations.map((calc) => ({
    id: calc.id,
    resolution: affected.has(calc.id) ? 'EXECUTE' : 'REUSE'
  }));
}

/** Comparator-proven semantic equivalence closes a speculative divergence cone. */
export function convergeOnEquivalence({ candidatePart, cleanPart, comparison }) {
  if (!comparison?.parity) return { converged: false, reusablePart: undefined };
  return {
    converged: true,
    reusablePart: cleanPart,
    testimony: {
      candidatePart,
      cleanPart,
      comparator: comparison.comparator,
      reason: 'semantic-equivalence'
    }
  };
}
