/**
 * SpeculativeExecution resolver.
 *
 * A lineage is a resolution context over the same Calculation graph.
 * This planner is intentionally pure: it decides EXECUTE vs REUSE and why;
 * the gateway remains responsible for actually evaluating Calculations.
 */
export function resolveSpeculativeExecution({ calculations, lineage = 'clean', overrides = [], cache = new Map(), equivalent = new Set() }) {
  const overrideSet = new Set(overrides);
  return calculations.map((address) => {
    if (overrideSet.has(address)) {
      return { address, lineage, resolution: { kind: 'execute' }, reason: 'override' };
    }
    const key = `${lineage}:${address}`;
    if (equivalent.has(address)) {
      return { address, lineage, resolution: { kind: 'reuse', reason: 'equivalent-result' } };
    }
    if (cache.has(key) || cache.has(`clean:${address}`)) {
      return { address, lineage, resolution: { kind: 'reuse', reason: 'cache-hit' } };
    }
    return { address, lineage, resolution: { kind: 'execute' } };
  });
}

export function speculativePrefixCache(calculations, values, lineage = 'clean') {
  const cache = new Map();
  calculations.forEach((address, index) => {
    if (index < values.length) cache.set(`${lineage}:${address}`, values[index]);
  });
  return cache;
}
