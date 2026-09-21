/** Semantic identity stays explainable; fingerprints are an optimization layer, not truth. */
export function semanticDelta(before, after, path = '') {
  if (Object.is(before, after)) return [];
  const beforeObj = before && typeof before === 'object' && !Array.isArray(before);
  const afterObj = after && typeof after === 'object' && !Array.isArray(after);
  if (beforeObj && afterObj) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => semanticDelta(before[key], after[key], path ? `${path}.${key}` : key));
  }
  return [{ path: path || '$', before, after }];
}

/** Keep only deltas a parity claim says are relevant to its comparator. */
export function relevantSemanticDelta(deltas, dependencies) {
  return deltas.filter((delta) => dependencies.some((dep) =>
    delta.path === dep || delta.path.startsWith(dep + '.') || dep.startsWith(delta.path + '.')
  ));
}

export function surgicalComparisonObligation({ claim, deltas, dependencies }) {
  const relevant = relevantSemanticDelta(deltas, dependencies);
  return {
    claim: claim.id,
    comparator: claim.comparator,
    required: relevant.length > 0,
    relevant,
    skipped: deltas.filter((delta) => !relevant.includes(delta))
  };
}
