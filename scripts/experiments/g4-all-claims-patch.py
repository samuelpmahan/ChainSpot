from pathlib import Path

p=Path('packages/alg/src/detectors/threeFactor/features/g3.teeRecovery.ts')
s=p.read_text()


def once(old: str, new: str, label: str):
    global s
    n=s.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected 1 anchor, got {n}')
    s=s.replace(old,new,1)

# Candidate discovery must expose every locally-valid claim to the symbolic
# resolver. Keep the old winner only as a debug/receipt view.
once(
"""\tsearch: TeeRecoverySearchContext = {}
): { readonly candidates: readonly TeeRecoveryCandidate[]; readonly searchOutcomes: readonly TargetSearchOutcome[]; readonly chromeSubtractionNotes: readonly ChromeSubtractionNote[] } {
\tconst candidates: TeeRecoveryCandidate[] = [];
""",
"""\tsearch: TeeRecoverySearchContext = {}
): { readonly candidates: readonly TeeRecoveryCandidate[]; readonly claimCandidates: readonly TeeRecoveryCandidate[]; readonly searchOutcomes: readonly TargetSearchOutcome[]; readonly chromeSubtractionNotes: readonly ChromeSubtractionNote[] } {
\t/** Receipt/debug winners only. Never used as the semantic claim universe. */
\tconst candidates: TeeRecoveryCandidate[] = [];
\t/** Every shard→badge hypothesis that independently satisfies G4 local geometry. */
\tconst claimCandidates: TeeRecoveryCandidate[] = [];
""",
'build return shape')

s=s.replace('return { candidates, searchOutcomes, chromeSubtractionNotes };', 'return { candidates, claimCandidates, searchOutcomes, chromeSubtractionNotes };')
# There are three early/final returns; all should carry the evidence universe.
if s.count('return { candidates, claimCandidates, searchOutcomes, chromeSubtractionNotes };') < 3:
    raise SystemExit('expected all candidate-builder returns to include claimCandidates')

# The old sort may stay to make receipts deterministic, but semantically-valid
# runner-ups must enter the claim universe BEFORE one winner is selected.
old="""\t\ttargetCandidates.sort((a, b) => {
\t\t\tconst ar = unexplainedPixels(a).length, br = unexplainedPixels(b).length;
\t\t\tconst aa = badgeAxisError(a) ?? Infinity, ba = badgeAxisError(b) ?? Infinity;
\t\t\tconst aRailMiss = isRailProjectionFit(a.fit) ? a.fit.badgePerpendicularMissPx ?? Infinity : undefined;
\t\t\tconst bRailMiss = isRailProjectionFit(b.fit) ? b.fit.badgePerpendicularMissPx ?? Infinity : undefined;
\t\t\tconst aAccepted = a.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && ar === 0 && (aRailMiss !== undefined ? aRailMiss === 0 : aa < activeAxisLimitRad);
\t\t\tconst bAccepted = b.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && br === 0 && (bRailMiss !== undefined ? bRailMiss === 0 : ba < activeAxisLimitRad);
"""
new="""\t\tfor (const candidate of targetCandidates) {
\t\t\tconst unexplained = unexplainedPixels(candidate).length;
\t\t\tconst axisError = badgeAxisError(candidate) ?? Infinity;
\t\t\tconst railMiss = isRailProjectionFit(candidate.fit) ? candidate.fit.badgePerpendicularMissPx ?? Infinity : undefined;
\t\t\tconst locallyValid = candidate.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS &&
\t\t\t\tunexplained === 0 &&
\t\t\t\t(railMiss !== undefined ? railMiss === 0 : axisError < activeAxisLimitRad);
\t\t\tif (locallyValid) claimCandidates.push(candidate);
\t\t}
\t\t// Presentation ordering only. It must never decide which claim exists.
\t\ttargetCandidates.sort((a, b) => {
\t\t\tconst ar = unexplainedPixels(a).length, br = unexplainedPixels(b).length;
\t\t\tconst aa = badgeAxisError(a) ?? Infinity, ba = badgeAxisError(b) ?? Infinity;
\t\t\tconst aRailMiss = isRailProjectionFit(a.fit) ? a.fit.badgePerpendicularMissPx ?? Infinity : undefined;
\t\t\tconst bRailMiss = isRailProjectionFit(b.fit) ? b.fit.badgePerpendicularMissPx ?? Infinity : undefined;
\t\t\tconst aAccepted = a.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && ar === 0 && (aRailMiss !== undefined ? aRailMiss === 0 : aa < activeAxisLimitRad);
\t\t\tconst bAccepted = b.fragmentPixels.length >= MIN_SHARD_SUPPORT_PIXELS && br === 0 && (bRailMiss !== undefined ? bRailMiss === 0 : ba < activeAxisLimitRad);
"""
once(old,new,'all local claims before presentation winner')

# Cross-target ambiguity belongs on the full evidence universe, not only the
# one candidate a receipt sort happened to place first.
s=s.replace('const accepted = candidates.filter((candidate) => {', 'const accepted = claimCandidates.filter((candidate) => {', 1)
s=s.replace('const index = candidates.indexOf(candidate);\n\t\t\tif (index >= 0) candidates[index] = { ...candidate, ambiguityWithBadgeLabels: others };', 'const index = claimCandidates.indexOf(candidate);\n\t\t\tif (index >= 0) claimCandidates[index] = { ...candidate, ambiguityWithBadgeLabels: others };', 1)

# Claim rows can have several pose witnesses for the same physical-object→badge
# edge. Identity consensus operates on the edge; witness choice comes later.
once(
"""interface G4ClaimRow {
\treadonly id: string;
\treadonly kind: 'visible' | 'recovery';
\treadonly badgeIds: readonly string[];
\t/** Candidate index per recovery edge; visible edges have no candidate. */
\treadonly candidateByBadge?: ReadonlyMap<string, number>;
}
""",
"""interface G4ClaimRow {
\treadonly id: string;
\treadonly kind: 'visible' | 'recovery';
\treadonly badgeIds: readonly string[];
\t/** Every pose witness for a physical recovery-object→badge edge. Identity
\t * consensus never chooses among these. */
\treadonly candidateIndexesByBadge?: ReadonlyMap<string, readonly number[]>;
}
""",
'claim row witness multiplicity')

once(
"""interface G4ClaimConsensus {
\treadonly forcedCandidateIndexes: ReadonlySet<number>;
\treadonly deferredCandidateIndexes: ReadonlySet<number>;
\treadonly base: G4MatchingSolution;
\treadonly recoveryRows: number;
\treadonly forcedEdges: number;
}
""",
"""interface G4ClaimConsensus {
\t/** One localization witness selected AFTER each identity edge is proven forced. */
\treadonly forcedCandidateIndexes: ReadonlySet<number>;
\t/** Locally valid identity edges that remain genuinely ambiguous. */
\treadonly deferredCandidateIndexes: ReadonlySet<number>;
\t/** Alternative pose testimony for an already-forced identity edge. */
\treadonly alternateWitnessCandidateIndexes: ReadonlySet<number>;
\treadonly base: G4MatchingSolution;
\treadonly recoveryRows: number;
\treadonly forcedEdges: number;
}
""",
'consensus result witnesses')

# Select localization only after identity is forced. This precedence is about
# constraint strength, not a relation score: two measured rails > exact
# full-span PCA > one rail > generic support-search; then maximize owned pixels.
anchor="""function candidateLocallySupportsBadge(candidate: TeeRecoveryCandidate): boolean {
\tif (candidate.fragmentPixels.length < MIN_SHARD_SUPPORT_PIXELS) return false;
\tif (unexplainedPixels(candidate).length !== 0) return false;
\tif (isRailProjectionFit(candidate.fit)) return (candidate.fit.badgePerpendicularMissPx ?? Infinity) === 0;
\treturn (badgeAxisError(candidate) ?? Infinity) < activeAxisLimitRad;
}
"""
helper=anchor+r'''

function localizationWitnessRank(candidate: TeeRecoveryCandidate): number {
	if (candidate.fit.fitKind === 'rail-pair-projection') return 0;
	if (candidate.localizationSource === 'full-span-component-pca') return 1;
	if (candidate.fit.fitKind === 'rail-projection') return 2;
	return 3;
}

function selectForcedLocalizationWitness(
	indexes: readonly number[],
	candidates: readonly TeeRecoveryCandidate[]
): number | undefined {
	return [...indexes].sort((a, b) => {
		const ca = candidates[a]!, cb = candidates[b]!;
		return localizationWitnessRank(ca) - localizationWitnessRank(cb) ||
			cb.fragmentPixels.length - ca.fragmentPixels.length ||
			ca.id.localeCompare(cb.id);
	})[0];
}
'''
once(anchor,helper,'localization witness selector')

# Rewrite recovery-row assembly + force proof to keep all witnesses per edge.
old="""\tconst recoveryRows: G4ClaimRow[] = [...members.entries()].map(([root, bucket]) => {
\t\tconst candidateByBadge = new Map<string, number>();
\t\tfor (const { candidate, index } of bucket) if (candidate.badgeId) candidateByBadge.set(candidate.badgeId, index);
\t\treturn {
\t\t\tid: `recovery:${[...new Set(bucket.flatMap(({ candidate }) => physicalComponentLabels(candidate)))].sort().join('+') || root}`,
\t\t\tkind: 'recovery',
\t\t\tbadgeIds: [...candidateByBadge.keys()].sort(),
\t\t\tcandidateByBadge
\t\t};
\t});
\tconst rows = [...visibleRows, ...recoveryRows];
\tconst base = solveG4ClaimMatching(rows, badgeIds);
\tconst forcedCandidateIndexes = new Set<number>();
\tconst allLocalCandidateIndexes = new Set(localIndexes.map(({ index }) => index));
\tfor (const row of recoveryRows) {
\t\tfor (const badgeId of row.badgeIds) {
\t\t\tconst candidateIndex = row.candidateByBadge?.get(badgeId);
\t\t\tif (candidateIndex === undefined) continue;
\t\t\tconst without = solveG4ClaimMatching(rows, badgeIds, `${row.id}|${badgeId}`);
\t\t\tif (without.score < base.score) forcedCandidateIndexes.add(candidateIndex);
\t\t}
\t}
\tconst deferredCandidateIndexes = new Set([...allLocalCandidateIndexes].filter((index) => !forcedCandidateIndexes.has(index)));
\treturn { forcedCandidateIndexes, deferredCandidateIndexes, base, recoveryRows: recoveryRows.length, forcedEdges: forcedCandidateIndexes.size };
"""
new="""\tconst recoveryRows: G4ClaimRow[] = [...members.entries()].map(([root, bucket]) => {
\t\tconst candidateIndexesByBadge = new Map<string, number[]>();
\t\tfor (const { candidate, index } of bucket) {
\t\t\tif (!candidate.badgeId) continue;
\t\t\tconst witnesses = candidateIndexesByBadge.get(candidate.badgeId);
\t\t\tif (witnesses) witnesses.push(index); else candidateIndexesByBadge.set(candidate.badgeId, [index]);
\t\t}
\t\treturn {
\t\t\tid: `recovery:${[...new Set(bucket.flatMap(({ candidate }) => physicalComponentLabels(candidate)))].sort().join('+') || root}`,
\t\t\tkind: 'recovery',
\t\t\tbadgeIds: [...candidateIndexesByBadge.keys()].sort(),
\t\t\tcandidateIndexesByBadge
\t\t};
\t});
\tconst rows = [...visibleRows, ...recoveryRows];
\tconst base = solveG4ClaimMatching(rows, badgeIds);
\tconst forcedCandidateIndexes = new Set<number>();
\tconst forcedRelationCandidateIndexes = new Set<number>();
\tconst alternateWitnessCandidateIndexes = new Set<number>();
\tconst allLocalCandidateIndexes = new Set(localIndexes.map(({ index }) => index));
\tlet forcedEdges = 0;
\tfor (const row of recoveryRows) {
\t\tfor (const badgeId of row.badgeIds) {
\t\t\tconst witnessIndexes = row.candidateIndexesByBadge?.get(badgeId) ?? [];
\t\t\tif (witnessIndexes.length === 0) continue;
\t\t\tconst without = solveG4ClaimMatching(rows, badgeIds, `${row.id}|${badgeId}`);
\t\t\tif (without.score >= base.score) continue;
\t\t\tforcedEdges++;
\t\t\tfor (const index of witnessIndexes) forcedRelationCandidateIndexes.add(index);
\t\t\tconst selected = selectForcedLocalizationWitness(witnessIndexes, candidates);
\t\t\tif (selected !== undefined) forcedCandidateIndexes.add(selected);
\t\t\tfor (const index of witnessIndexes) if (index !== selected) alternateWitnessCandidateIndexes.add(index);
\t\t}
\t}
\tconst deferredCandidateIndexes = new Set([...allLocalCandidateIndexes].filter((index) => !forcedRelationCandidateIndexes.has(index)));
\treturn { forcedCandidateIndexes, deferredCandidateIndexes, alternateWitnessCandidateIndexes, base, recoveryRows: recoveryRows.length, forcedEdges };
"""
once(old,new,'all-witness consensus')

# Feed consensus the full locally-valid evidence graph. Keep old debug winners
# and runner-ups for inspection, but never use them as semantic input.
once(
"""\t\tconst geometryFittingStop = ctx.span('teeRecovery.geometryFitting');
\t\tconst allResults = built.candidates.map(graphCandidateResult);
\t\tgeometryFittingStop();
\t\tctx.measure('teeRecovery', 'seedFragments', new Set(built.candidates.map((candidate) => candidate.id.match(/^tee-shard-[^-]+/)?.[0] ?? candidate.id)).size);
\t\tctx.measure('teeRecovery', 'componentHypotheses', allResults.length);
\t\tfor (const candidate of built.candidates) ctx.measure('teeRecovery', 'bfsComponentsVisited', candidate.bfsComponentsVisited ?? 0);
\t\tconst badgeSupportStop = ctx.span('teeRecovery.badgeSupport');
\t\tconst consensus = resolveG4ClaimConsensus(tees, rayResolution.claims, built.candidates, numberedBadges);
""",
"""\t\tconst geometryFittingStop = ctx.span('teeRecovery.geometryFitting');
\t\tconst allResults = built.claimCandidates.map(graphCandidateResult);
\t\tgeometryFittingStop();
\t\tctx.measure('teeRecovery', 'localClaimEdges', built.claimCandidates.length);
\t\tctx.measure('teeRecovery', 'presentationWinners', built.candidates.length);
\t\tctx.measure('teeRecovery', 'seedFragments', new Set(built.claimCandidates.map((candidate) => candidate.id.match(/^tee-shard-[^-]+/)?.[0] ?? candidate.id)).size);
\t\tctx.measure('teeRecovery', 'componentHypotheses', allResults.length);
\t\tfor (const candidate of built.claimCandidates) ctx.measure('teeRecovery', 'bfsComponentsVisited', candidate.bfsComponentsVisited ?? 0);
\t\tconst badgeSupportStop = ctx.span('teeRecovery.badgeSupport');
\t\tconst consensus = resolveG4ClaimConsensus(tees, rayResolution.claims, built.claimCandidates, numberedBadges);
""",
'consensus consumes all claims')

# Forced/deferred index loops now index the full claimCandidates array.
s=s.replace('const candidate = built.candidates[index]!;', 'const candidate = built.claimCandidates[index]!;')
s=s.replace('for (let index = 0; index < built.candidates.length; index++) {\n\t\t\tconst candidate = built.candidates[index]!;', 'for (let index = 0; index < built.claimCandidates.length; index++) {\n\t\t\tconst candidate = built.claimCandidates[index]!;')

# Alternate pose witnesses for an already-forced identity are not ambiguous
# identity edges; retain them explicitly as custody testimony.
old="""\t\tctx.measure('teeRecovery', 'claimConsensusForcedEdges', consensus.forcedEdges);
\t\tctx.measure('teeRecovery', 'claimConsensusDeferredEdges', consensus.deferredCandidateIndexes.size);
"""
new="""\t\tctx.measure('teeRecovery', 'claimConsensusForcedEdges', consensus.forcedEdges);
\t\tctx.measure('teeRecovery', 'claimConsensusDeferredEdges', consensus.deferredCandidateIndexes.size);
\t\tctx.measure('teeRecovery', 'claimConsensusAlternateWitnesses', consensus.alternateWitnessCandidateIndexes.size);
"""
once(old,new,'alternate witness metric')

old="""\t\t\tif (consensus.forcedCandidateIndexes.has(index)) continue;
\t\t\tconst baseResult = allResults[index]!;
\t\t\tconst xPx = candidate.fit.centerXPx;
\t\t\tconst yPx = candidate.fit.centerYPx + (candidate.coordinateFrame === 'original' ? 0 : candidate.viewportTopPx ?? 0);
\t\t\tif (consensus.deferredCandidateIndexes.has(index)) {
"""
new="""\t\t\tif (consensus.forcedCandidateIndexes.has(index)) continue;
\t\t\tconst baseResult = allResults[index]!;
\t\t\tconst xPx = candidate.fit.centerXPx;
\t\t\tconst yPx = candidate.fit.centerYPx + (candidate.coordinateFrame === 'original' ? 0 : candidate.viewportTopPx ?? 0);
\t\t\tif (consensus.alternateWitnessCandidateIndexes.has(index)) {
\t\t\t\tctx.overlay('teeRecovery', {
\t\t\t\t\ttype: 'point', xPx, yPx, verdict: 'info', visualRole: 'tee-rejection', ref: `${candidate.id}:alternate-witness`,
\t\t\t\t\treason: `ALTERNATE WITNESS: shard→badge identity is already forced by consensus; this independently valid pose witness is preserved but is less constrained than the selected localization witness`,
\t\t\t\t\tvalues: numericTraceValues(baseResult.values)
\t\t\t\t});
\t\t\t} else if (consensus.deferredCandidateIndexes.has(index)) {
"""
once(old,new,'alternate witness receipt')

p.write_text(s)
print('patched',p)
