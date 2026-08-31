export interface TraceIdentity {
  readonly inputId: string;
  readonly schemaId: string;
  readonly coordinateFrame: string;
  readonly planHash: string;
}

export interface TickEvidence {
  readonly id: string;
  readonly count?: number;
  readonly measure?: number;
  readonly note?: string;
}

export interface TickResidue {
  readonly id: string;
  readonly count?: number;
  readonly measure?: number;
  readonly note?: string;
}

/**
 * Smallest PCR unit: one claim advances the shared evidence state while
 * keeping what it still cannot explain explicit. Nothing here dictates how
 * that claim must be drawn.
 */
export interface Tick {
  readonly id: string;
  readonly label: string;
  readonly claim: string;
  readonly consumes: readonly string[];
  readonly produces: readonly string[];
  readonly evidence: readonly TickEvidence[];
  readonly residue: readonly TickResidue[];
  readonly timingMs?: number;
}

export interface PcrTrace {
  readonly traceId: string;
  readonly identity: TraceIdentity;
  readonly ticks: readonly Tick[];
  readonly unexplained: readonly TickResidue[];
}

export interface PcrProjectionSummary {
  readonly traceId: string;
  readonly tickIds: readonly string[];
  readonly unexplainedIds: readonly string[];
}

export function composePcr(
  traceId: string,
  identity: TraceIdentity,
  ticks: readonly Tick[]
): PcrTrace {
  if (!ticks.length) throw new Error('PCR requires at least one Tick');
  const seen = new Set<string>();
  for (const tick of ticks) {
    if (seen.has(tick.id)) throw new Error(`duplicate Tick '${tick.id}'`);
    seen.add(tick.id);
    if (!tick.claim.trim()) throw new Error(`Tick '${tick.id}' has no claim`);
    if (!tick.residue) throw new Error(`Tick '${tick.id}' must retain residue`);
  }
  return {
    traceId,
    identity,
    ticks: [...ticks],
    unexplained: [...ticks[ticks.length - 1].residue]
  };
}

/** Render and CLI are projections of the same trace, so their summaries must agree. */
export function projectionSummary(trace: PcrTrace): PcrProjectionSummary {
  return {
    traceId: trace.traceId,
    tickIds: trace.ticks.map((tick) => tick.id),
    unexplainedIds: trace.unexplained.map((residue) => residue.id)
  };
}

export function assertSameProjection(
  left: PcrProjectionSummary,
  right: PcrProjectionSummary
): void {
  const l = JSON.stringify(left);
  const r = JSON.stringify(right);
  if (l !== r) throw new Error(`PCR projection disagreement\nrender=${l}\nreceipt=${r}`);
}
