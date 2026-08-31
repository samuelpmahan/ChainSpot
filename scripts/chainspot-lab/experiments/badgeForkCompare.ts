export interface BadgeCompareCheckpoint<TInput> {
  readonly checkpointId: string;
  readonly inputSchemaIdentity: string;
  readonly coordinateFrame: string;
  readonly input: TInput;
}

export interface BadgeCompareBranchOutput<TOutput, TEvidenceTrace, TRenderFragment> {
  readonly output: TOutput;
  readonly evidenceTrace: TEvidenceTrace;
  readonly renderFragment: TRenderFragment;
  readonly unexplainedResidual: number;
}

export interface BadgeCompareBranchDefinition<TInput, TOutput, TEvidenceTrace, TRenderFragment> {
  readonly name: string;
  readonly planConfigHash: string;
  readonly run: (input: TInput) => BadgeCompareBranchOutput<TOutput, TEvidenceTrace, TRenderFragment>;
}

export interface BadgeCompareBranchResult<TOutput, TEvidenceTrace, TRenderFragment, TMeasure> {
  readonly name: string;
  readonly planConfigHash: string;
  readonly inputSchemaIdentity: string;
  readonly coordinateFrame: string;
  readonly evidenceTrace: TEvidenceTrace;
  readonly renderFragment: TRenderFragment;
  readonly unexplainedResidual: number;
  readonly durationMs: number;
  readonly output: TOutput;
  readonly measure: TMeasure;
}

export interface BadgeForkComparison<TOutput, TEvidenceTrace, TRenderFragment, TMeasure, TComparison> {
  readonly checkpointId: string;
  readonly branches: readonly [
    BadgeCompareBranchResult<TOutput, TEvidenceTrace, TRenderFragment, TMeasure>,
    BadgeCompareBranchResult<TOutput, TEvidenceTrace, TRenderFragment, TMeasure>
  ];
  readonly comparison: TComparison;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Local badge experiment only: fork one immutable checkpoint into exactly two
 * sidecar branches, then compare compatible measurements. It deliberately has
 * no merge/select/pin mutation operation. The caller owns the pinned/default
 * downstream flow; this helper only records a fair side-by-side experiment.
 */
export function forkBadgeCompare<TInput, TOutput, TEvidenceTrace, TRenderFragment, TMeasure, TComparison>(
  checkpoint: BadgeCompareCheckpoint<TInput>,
  branches: readonly [
    BadgeCompareBranchDefinition<TInput, TOutput, TEvidenceTrace, TRenderFragment>,
    BadgeCompareBranchDefinition<TInput, TOutput, TEvidenceTrace, TRenderFragment>
  ],
  measure: (output: TOutput) => TMeasure,
  compare: (left: TMeasure, right: TMeasure) => TComparison,
  now: () => number = defaultNow
): BadgeForkComparison<TOutput, TEvidenceTrace, TRenderFragment, TMeasure, TComparison> {
  const runBranch = (
    branch: BadgeCompareBranchDefinition<TInput, TOutput, TEvidenceTrace, TRenderFragment>
  ): BadgeCompareBranchResult<TOutput, TEvidenceTrace, TRenderFragment, TMeasure> => {
    const startedAtMs = now();
    const result = branch.run(checkpoint.input);
    const durationMs = now() - startedAtMs;
    return {
      name: branch.name,
      planConfigHash: branch.planConfigHash,
      inputSchemaIdentity: checkpoint.inputSchemaIdentity,
      coordinateFrame: checkpoint.coordinateFrame,
      evidenceTrace: result.evidenceTrace,
      renderFragment: result.renderFragment,
      unexplainedResidual: result.unexplainedResidual,
      durationMs,
      output: result.output,
      measure: measure(result.output)
    };
  };

  const left = runBranch(branches[0]);
  const right = runBranch(branches[1]);

  if (left.inputSchemaIdentity !== right.inputSchemaIdentity) {
    throw new Error('forkBadgeCompare: branch input schema identities diverged');
  }
  if (left.coordinateFrame !== right.coordinateFrame) {
    throw new Error('forkBadgeCompare: branch coordinate frames diverged');
  }

  return {
    checkpointId: checkpoint.checkpointId,
    branches: [left, right],
    comparison: compare(left.measure, right.measure)
  };
}
