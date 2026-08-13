import type { TeeCandidateProvenance, TeePadCandidate, TeePadSupport } from './teePadDetection';

export interface TeePhysicalCluster {
	readonly candidate: TeePadCandidate;
	readonly sourceIndexes: readonly number[];
}

function axisDifferenceDeg(a: number, b: number): number {
	const difference = Math.abs(((a % 180) + 180) % 180 - (((b % 180) + 180) % 180));
	return Math.min(difference, 180 - difference);
}

/**
 * Scale-relative physical-pad equivalence in the coordinate space supplied by
 * the caller. Production calls this only after canonical candidates have been
 * mapped back to native pixels. Close centers alone are insufficient: at the
 * outer edge of the gate the long axes must also agree modulo 180 degrees.
 */
export function samePhysicalTeePad(a: TeePadCandidate, b: TeePadCandidate): boolean {
	const minor = Math.max(1, Math.min(a.heightPx, b.heightPx));
	const distance = Math.hypot(a.xPx - b.xPx, a.yPx - b.yPx);
	if (distance > minor * 0.8) return false;
	return distance <= minor * 0.35 || axisDifferenceDeg(a.orientationDeg, b.orientationDeg) <= 22.5;
}

function mergedCandidate(candidates: readonly TeePadCandidate[]): TeePadCandidate {
	const best = [...candidates].sort(
		(a, b) => b.support.length - a.support.length || b.score - a.score
	)[0];
	const support = [...new Set(candidates.flatMap((candidate) => candidate.support))].sort() as TeePadSupport[];
	const provenance = candidates.flatMap((candidate) => candidate.provenance ?? []);
	const uniqueProvenance = [...new Map(
		provenance.map((entry) => [`${entry.tier}:${entry.support}`, entry] as const)
	).values()] as TeeCandidateProvenance[];
	return {
		...best,
		score: Math.max(...candidates.map((candidate) => candidate.score)),
		support,
		...(uniqueProvenance.length > 0 ? { provenance: uniqueProvenance } : {})
	};
}

/** Greedy score-ordered non-maximum clustering; never imposes an 18-result cap. */
export function deduplicatePhysicalTeePads(candidates: readonly TeePadCandidate[]): readonly TeePhysicalCluster[] {
	const order = candidates
		.map((candidate, sourceIndex) => ({ candidate, sourceIndex }))
		.sort((a, b) => b.candidate.support.length - a.candidate.support.length || b.candidate.score - a.candidate.score);
	const clusters: Array<{ members: TeePadCandidate[]; sourceIndexes: number[] }> = [];
	for (const entry of order) {
		// Match against the cluster's representative (its first/highest-priority
		// member — `order` is sorted the same way `mergedCandidate` picks `best`)
		// rather than any member: single-linkage chain matching could bridge two
		// physically distinct pads through a weak in-between candidate.
		const cluster = clusters.find((candidateCluster) =>
			samePhysicalTeePad(candidateCluster.members[0], entry.candidate)
		);
		if (cluster) {
			cluster.members.push(entry.candidate);
			cluster.sourceIndexes.push(entry.sourceIndex);
		} else {
			clusters.push({ members: [entry.candidate], sourceIndexes: [entry.sourceIndex] });
		}
	}
	return clusters.map((cluster) => ({
		candidate: mergedCandidate(cluster.members),
		sourceIndexes: [...cluster.sourceIndexes].sort((a, b) => a - b)
	}));
}
