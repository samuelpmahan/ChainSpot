import type { StageVariantResult } from './stage';

export interface ComparisonInput {
 readonly baseline: StageVariantResult;
 readonly feature: StageVariantResult;
}

/** Post-execution comparison. Implementations inspect saved results; they do not rerun them.
 * Treat the supplied PxC values and shared pixel buffers as read-only.
 * Execution failures are supplied too, so the comparator can report partial results.
 */
export abstract class Comparator<T = unknown> {
 abstract readonly id: string;
 abstract compare(input: ComparisonInput): T;
}

export interface ComparisonResult {
 readonly comparator: string;
 readonly baseline: string;
 readonly feature: string;
 readonly status: 'completed' | 'failed';
 readonly output?: unknown;
 readonly error?: string;
}
