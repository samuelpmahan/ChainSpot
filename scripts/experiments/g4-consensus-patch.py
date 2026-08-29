from pathlib import Path

p=Path('packages/alg/src/detectors/threeFactor/features/g3.teeRecovery.ts')
s=p.read_text()


def once(old: str, new: str, label: str):
    global s
    n=s.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected 1 anchor, got {n}')
    s=s.replace(old,new,1)

# Search behind POSSIBLE testimony, but never behind an actual unique visible lock.
once(
"""\t\tconst coveredBadgeIds = new Set(rayResolution.coveredBadgeIds);
\t\tconst lockedKeys = new Set(rayResolution.locks.map((claim) => `${claim.teeId}|${claim.badgeId}`));
""",
"""\t\tconst coveredBadgeIds = new Set(rayResolution.coveredBadgeIds);
\t\tconst lockedBadgeIds = new Set(rayResolution.locks.map((claim) => claim.badgeId));
\t\tconst lockedKeys = new Set(rayResolution.locks.map((claim) => `${claim.teeId}|${claim.badgeId}`));
""",
'locked badge set')

once("if (coveredBadgeIds.size === numberedBadges.length) {", "if (lockedBadgeIds.size === numberedBadges.length) {", 'early return')
once(
"""\t\tconst localRayClaims: TeeRecoveryAssignmentContext = {
\t\t\tassignments: [...coveredBadgeIds].sort().map((badgeId) => ({ badgeId, basketId: 'G4-visible-ray-coverage' }))
\t\t};
""",
"""\t\tconst localRayClaims: TeeRecoveryAssignmentContext = {
\t\t\tassignments: [...lockedBadgeIds].sort().map((badgeId) => ({ badgeId, basketId: 'G4-visible-ray-lock' }))
\t\t};
""",
'unlocked search adapter')

# Insert the small symbolic consensus layer immediately before the G4 unit.
anchor='''\nexport const teeRecoveryUnit: EngineUnit = {\n'''
if s.count(anchor)!=1: raise SystemExit('unit anchor drifted')
helper=r'''

interface G4ClaimRow {
	readonly id: string;
	readonly kind: 'visible' | 'recovery';
	readonly badgeIds: readonly string[];
	/** Candidate index per recovery edge; visible edges have no candidate. */
	readonly candidateByBadge?: ReadonlyMap<string, number>;
}

interface G4MatchingSolution {
	readonly score: number;
	readonly visibleMatched: number;
	readonly recoveryMatched: number;
	readonly badgeByRow: readonly (string | null)[];
}

interface G4ClaimConsensus {
	readonly forcedCandidateIndexes: ReadonlySet<number>;
	readonly deferredCandidateIndexes: ReadonlySet<number>;
	readonly base: G4MatchingSolution;
	readonly recoveryRows: number;
	readonly forcedEdges: number;
}

function physicalComponentLabels(candidate: TeeRecoveryCandidate): readonly string[] {
	const labels = new Set<string>();
	for (const id of candidate.supportingComponentIds) {
		for (const label of id.split(':')[0]!.split('+')) if (label) labels.add(label);
	}
	return [...labels].sort();
}

function candidateLocallySupportsBadge(candidate: TeeRecoveryCandidate): boolean {
	if (candidate.fragmentPixels.length < MIN_SHARD_SUPPORT_PIXELS) return false;
	if (unexplainedPixels(candidate).length !== 0) return false;
	if (isRailProjectionFit(candidate.fit)) return (candidate.fit.badgePerpendicularMissPx ?? Infinity) === 0;
	return (badgeAxisError(candidate) ?? Infinity) < activeAxisLimitRad;
}

/**
 * Maximum-weight bipartite matching over LOCAL G4 claims only.
 *
 * This is not an assignment oracle. Visible tees have weight B where
 * B > the maximum possible number of recovery edges, so the objective is
 * lexicographic: preserve as many already-visible tee identities as the claim
 * graph permits, THEN maximize how many independent shard objects can coexist.
 * There is no residual/angle/score in the weights. A recovery edge is promoted
 * only when deleting that edge makes the optimum strictly worse — i.e. that
 * exact edge occurs in EVERY optimal solution. Matching never chooses among
 * equally supported alternatives; those remain DEFERRED testimony.
 */
function solveG4ClaimMatching(
	rows: readonly G4ClaimRow[],
	badgeIds: readonly string[],
	excludedEdge?: string
): G4MatchingSolution {
	if (rows.length === 0) return { score: 0, visibleMatched: 0, recoveryMatched: 0, badgeByRow: [] };
	const badgeIndex = new Map(badgeIds.map((id, index) => [id, index]));
	const visibleWeight = badgeIds.length + 1;
	const unsupported = -1_000_000;
	// One dummy column per row means every object may remain unresolved rather
	// than being forced onto an unsupported badge.
	const columns = badgeIds.length + rows.length;
	const weights = rows.map((row) => {
		const values = new Array<number>(columns).fill(0);
		for (let j = 0; j < badgeIds.length; j++) values[j] = unsupported;
		for (const badgeId of row.badgeIds) {
			const j = badgeIndex.get(badgeId);
			if (j === undefined) continue;
			if (excludedEdge === `${row.id}|${badgeId}`) continue;
			values[j] = row.kind === 'visible' ? visibleWeight : 1;
		}
		return values;
	});

	// Hungarian algorithm (rectangular minimization form), using negated
	// weights. n<=m because of the dummy columns above.
	const n = rows.length, m = columns;
	const u = new Array<number>(n + 1).fill(0);
	const v = new Array<number>(m + 1).fill(0);
	const p = new Array<number>(m + 1).fill(0);
	const way = new Array<number>(m + 1).fill(0);
	for (let i = 1; i <= n; i++) {
		p[0] = i;
		let j0 = 0;
		const minv = new Array<number>(m + 1).fill(Infinity);
		const used = new Array<boolean>(m + 1).fill(false);
		do {
			used[j0] = true;
			const i0 = p[j0]!;
			let delta = Infinity, j1 = 0;
			for (let j = 1; j <= m; j++) {
				if (used[j]) continue;
				const cur = -weights[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
				if (cur < minv[j]!) { minv[j] = cur; way[j] = j0; }
				if (minv[j]! < delta) { delta = minv[j]!; j1 = j; }
			}
			for (let j = 0; j <= m; j++) {
				if (used[j]) { u[p[j]!] += delta; v[j] -= delta; }
				else minv[j] -= delta;
			}
			j0 = j1;
		} while (p[j0] !== 0);
		do {
			const j1 = way[j0]!;
			p[j0] = p[j1]!;
			j0 = j1;
		} while (j0 !== 0);
	}
	const columnByRow = new Array<number>(n).fill(-1);
	for (let j = 1; j <= m; j++) if (p[j]! > 0) columnByRow[p[j]! - 1] = j - 1;
	let score = 0, visibleMatched = 0, recoveryMatched = 0;
	const badgeByRow: (string | null)[] = [];
	for (let i = 0; i < n; i++) {
		const j = columnByRow[i]!;
		const real = j >= 0 && j < badgeIds.length && weights[i]![j]! > 0;
		badgeByRow.push(real ? badgeIds[j]! : null);
		if (!real) continue;
		score += weights[i]![j]!;
		if (rows[i]!.kind === 'visible') visibleMatched++; else recoveryMatched++;
	}
	return { score, visibleMatched, recoveryMatched, badgeByRow };
}

function resolveG4ClaimConsensus(
	tees: readonly TeeEvidence[],
	visibleClaims: readonly VisibleTeeBadgeRayClaim[],
	candidates: readonly TeeRecoveryCandidate[],
	badges: readonly BadgeEvidence[]
): G4ClaimConsensus {
	const badgeIds = badges.filter((badge) => numberLabel(badge) !== undefined).map((badge) => badge.detId).sort();
	const visibleByTee = new Map<string, Set<string>>();
	for (const tee of tees) visibleByTee.set(tee.detId, new Set());
	for (const claim of visibleClaims) visibleByTee.get(claim.teeId)?.add(claim.badgeId);
	const visibleRows: G4ClaimRow[] = tees.map((tee) => {
		const claims = [...(visibleByTee.get(tee.detId) ?? [])].sort();
		// A visible tee with zero local relation testimony still physically
		// exists and therefore consumes one badge slot. Wildcarding only this
		// zero-evidence case reserves that cardinality without fabricating a
		// relation claim or suppressing any recorded alternative.
		return { id: `visible:${tee.detId}`, kind: 'visible', badgeIds: claims.length > 0 ? claims : badgeIds };
	});

	// Overlapping component hypotheses are one physical evidence cluster: the
	// same bright pixel may not become two recovered tees merely because one
	// target used a subset/superset group key.
	const localIndexes = candidates.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => candidateLocallySupportsBadge(candidate));
	const parent = localIndexes.map((_, index) => index);
	const find = (x: number): number => parent[x] === x ? x : (parent[x] = find(parent[x]!));
	const unite = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
	const labels = localIndexes.map(({ candidate }) => new Set(physicalComponentLabels(candidate)));
	for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
		if ([...labels[i]!].some((label) => labels[j]!.has(label))) unite(i, j);
	}
	const members = new Map<number, typeof localIndexes>();
	for (let i = 0; i < localIndexes.length; i++) {
		const root = find(i); const bucket = members.get(root); if (bucket) bucket.push(localIndexes[i]!); else members.set(root, [localIndexes[i]!]);
	}
	const recoveryRows: G4ClaimRow[] = [...members.entries()].map(([root, bucket]) => {
		const candidateByBadge = new Map<string, number>();
		for (const { candidate, index } of bucket) if (candidate.badgeId) candidateByBadge.set(candidate.badgeId, index);
		return {
			id: `recovery:${[...new Set(bucket.flatMap(({ candidate }) => physicalComponentLabels(candidate)))].sort().join('+') || root}`,
			kind: 'recovery',
			badgeIds: [...candidateByBadge.keys()].sort(),
			candidateByBadge
		};
	});
	const rows = [...visibleRows, ...recoveryRows];
	const base = solveG4ClaimMatching(rows, badgeIds);
	const forcedCandidateIndexes = new Set<number>();
	const allLocalCandidateIndexes = new Set(localIndexes.map(({ index }) => index));
	for (const row of recoveryRows) {
		for (const badgeId of row.badgeIds) {
			const candidateIndex = row.candidateByBadge?.get(badgeId);
			if (candidateIndex === undefined) continue;
			const without = solveG4ClaimMatching(rows, badgeIds, `${row.id}|${badgeId}`);
			if (without.score < base.score) forcedCandidateIndexes.add(candidateIndex);
		}
	}
	const deferredCandidateIndexes = new Set([...allLocalCandidateIndexes].filter((index) => !forcedCandidateIndexes.has(index)));
	return { forcedCandidateIndexes, deferredCandidateIndexes, base, recoveryRows: recoveryRows.length, forcedEdges: forcedCandidateIndexes.size };
}
'''
s=s.replace(anchor, helper+anchor,1)

# Replace winner-promotion with consensus proof. Preserve every local candidate
# as testimony; only forced edges become recovered objects.
old="""\t\t// Keep one deterministic component verdict per missing numbered badge so
\t\t// trace, CLI, and visual receipt remain one-to-one.
\t\tconst badgeSupportStop = ctx.span('teeRecovery.badgeSupport');
\t\tconst promoted = promoteGraphResults(built.candidates, allResults);
\t\tbadgeSupportStop();
\t\tconst results = promoted.map((entry) => entry.result);
\t\tconst existing = board.get<readonly RecoveredTeeInput[]>('recoveredTees');
"""
new="""\t\tconst badgeSupportStop = ctx.span('teeRecovery.badgeSupport');
\t\tconst consensus = resolveG4ClaimConsensus(tees, rayResolution.claims, built.candidates, numberedBadges);
\t\tbadgeSupportStop();
\t\tctx.measure('teeRecovery', 'claimConsensusVisibleMatched', consensus.base.visibleMatched);
\t\tctx.measure('teeRecovery', 'claimConsensusRecoveryMatched', consensus.base.recoveryMatched);
\t\tctx.measure('teeRecovery', 'claimConsensusRecoveryObjects', consensus.recoveryRows);
\t\tctx.measure('teeRecovery', 'claimConsensusForcedEdges', consensus.forcedEdges);
\t\tctx.measure('teeRecovery', 'claimConsensusDeferredEdges', consensus.deferredCandidateIndexes.size);
\t\tconst promoted = [...consensus.forcedCandidateIndexes].sort((a, b) => a - b).map((index) => {
\t\t\tconst candidate = built.candidates[index]!;
\t\t\tconst baseResult = allResults[index]!;
\t\t\treturn {
\t\t\t\tcandidate,
\t\t\t\tresult: {
\t\t\t\t\t...baseResult,
\t\t\t\t\tverdict: 'accepted' as const,
\t\t\t\t\treason: `G4 CONSENSUS LOCK: this physical shard→badge claim occurs in every maximum-consistency mapping that preserves visible tee claims; ${baseResult.reason}`
\t\t\t\t}
\t\t\t};
\t\t});
\t\tconst results = promoted.map((entry) => entry.result);
\t\tfor (let index = 0; index < built.candidates.length; index++) {
\t\t\tconst candidate = built.candidates[index]!;
\t\t\tif (consensus.forcedCandidateIndexes.has(index)) continue;
\t\t\tconst baseResult = allResults[index]!;
\t\t\tconst xPx = candidate.fit.centerXPx;
\t\t\tconst yPx = candidate.fit.centerYPx + (candidate.coordinateFrame === 'original' ? 0 : candidate.viewportTopPx ?? 0);
\t\t\tif (consensus.deferredCandidateIndexes.has(index)) {
\t\t\t\tctx.overlay('teeRecovery', {
\t\t\t\t\ttype: 'point', xPx, yPx, verdict: 'info', visualRole: 'tee-rejection', ref: `${candidate.id}:consensus-defer`,
\t\t\t\t\treason: `DEFER: local shard→badge testimony survives, but this edge is not present in every maximum-consistency G4 mapping; no residual score, pathfinding, or loop order may select it`,
\t\t\t\t\tvalues: numericTraceValues(baseResult.values)
\t\t\t\t});
\t\t\t} else {
\t\t\t\tctx.overlay('teeRecovery', { type: 'point', xPx, yPx, verdict: 'rejected', visualRole: 'tee-rejection', ref: `${candidate.id}:local-reject`, reason: baseResult.reason, values: numericTraceValues(baseResult.values) });
\t\t\t}
\t\t}
\t\tconst existing = board.get<readonly RecoveredTeeInput[]>('recoveredTees');
"""
once(old,new,'consensus promotion seam')

# Promoted should now mean actual locked additions, not pre-consensus winners.
once("ctx.measure('teeRecovery', 'promoted', results.length);", "ctx.measure('teeRecovery', 'promoted', additions.length);", 'promoted metric')

# Feature note: relation ambiguity is resolved only by forced consensus.
s=s.replace('only badges with zero visible-tee ray coverage enter shard recovery', 'only uniquely visible-locked badges skip shard search; POSSIBLE badges remain searchable but can promote only by consensus')

p.write_text(s)
print('patched',p)
