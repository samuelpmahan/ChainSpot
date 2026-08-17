import { applyTransform } from './alignment/transform';
import type { SerializableTransform } from './alignment/types';
import type { ControlPointPair, SourcePoint } from './domain/project';

/** Applies the two registration legs in the product's canonical order. */
export function composePlayedToTarget(
	playedPoint: SourcePoint,
	playedToClean: SerializableTransform,
	cleanToTarget: SerializableTransform
): SourcePoint {
	return applyTransform(applyTransform(playedPoint, playedToClean), cleanToTarget);
}

/** Returns the enabled landmark proof points in target-image coordinates. */
export function composedProofPoints(
	pairs: readonly ControlPointPair[],
	playedToClean: SerializableTransform | null,
	cleanToTarget: SerializableTransform | null
): Array<{ id: string; xPx: number; yPx: number }> {
	if (!playedToClean || !cleanToTarget) return [];
	return pairs
		.filter((pair) => pair.enabled)
		.map((pair) => ({ id: pair.id, ...composePlayedToTarget(pair.source, playedToClean, cleanToTarget) }));
}
