import type { ABFeatureSetServiceDescriptor } from '../../exec/feature-set';

/**
 * Three-factor infrastructure owned by the shared composition boundary.
 *
 * This registry is deliberately metadata-only. `OcclusionDetector` is already
 * constructed once per detector run by the engine and is exposed through
 * `FeatureContext`; registering its descriptor here must not create another
 * detector, feature, or engine unit.
 */
export const THREE_FACTOR_SHARED_SERVICES = [
	{
		id: 'occlusion',
		kind: 'run-scoped-infrastructure',
		scope: 'run',
		note: 'Known opaque/alpha footprint seam shared by three-factor stages.'
	}
] as const satisfies readonly ABFeatureSetServiceDescriptor[];

export type ThreeFactorSharedServiceId = (typeof THREE_FACTOR_SHARED_SERVICES)[number]['id'];

