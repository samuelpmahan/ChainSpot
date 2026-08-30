import { readFileSync, writeFileSync } from 'node:fs';

function read(path) { return readFileSync(path, 'utf8'); }
function write(path, value) { writeFileSync(path, value); }
function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`missing patch anchor: ${label}`);
  if (source.indexOf(needle, first + needle.length) >= 0) throw new Error(`ambiguous patch anchor: ${label}`);
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

// ---- contract: preserve the old S0 geometry contract and add directed-ray testimony.
{
  const path = 'packages/alg/src/detectors/threeFactor/features/st.straightTest.contract.ts';
  let s = read(path);
  const anchor = `export interface StraightTestGateStatuses {`;
  const addition = `export interface StraightTestBasketHypothesis {\n\treadonly basketId: string;\n\treadonly tipXPx: number;\n\treadonly tipYPx: number;\n\treadonly alongPx: number;\n\treadonly perpendicularPx: number;\n\treadonly forward: boolean;\n\treadonly inCorridor: boolean;\n\t/** Rank among forward semantic basket TIPs inside the directed corridor. */\n\treadonly encounterRank: number | null;\n\treadonly strongIdentity: boolean;\n}\n\nexport interface StraightTestRayEvidence {\n\treadonly corridorWidthPx: number | null;\n\treadonly corridorHalfWidthPx: number | null;\n\treadonly selectedAlongPx: number | null;\n\treadonly selectedPerpendicularPx: number | null;\n\treadonly corridorCandidateCount: number;\n\treadonly nextTipMarginPx: number | null;\n}\n\n`;
  s = replaceOnce(s, anchor, addition + anchor, 'straight ray contract insertion');
  const proposalAnchor = `\treadonly measurements: StraightTestMeasurements;\n\treadonly gates: StraightTestGateStatuses;`;
  s = replaceOnce(s, proposalAnchor, `\treadonly measurements: StraightTestMeasurements;\n\t/** Blind G5 directed-corridor evidence. Absent on legacy/tainted S0 rows. */\n\treadonly straightRay?: StraightTestRayEvidence;\n\treadonly basketHypotheses?: readonly StraightTestBasketHypothesis[];\n\treadonly gates: StraightTestGateStatuses;`, 'straight ray proposal fields');
  write(path, s);
}

// ---- producer: blind mode now consumes accepted G4 locks and semantic basket TIPs.
{
  const path = 'packages/alg/src/detectors/threeFactor/features/st.straightTest.ts';
  let s = read(path);
  s = replaceOnce(
    s,
    `import type { BadgeEvidence, BasketEvidence, TeeEvidence } from '../types';`,
    `import type { BadgeEvidence, BasketEvidence, TeeEvidence, ThreeFactorMeasurement } from '../types';`,
    'straight test type import'
  );
  s = replaceOnce(
    s,
    `import type { ABFeature, EngineUnit } from './types';`,
    `import type { ABFeature, EngineUnit, FeatureContext } from './types';\nimport type { TeeBadgeLockEvidence, TeeBadgeLockEvidenceLock } from './g4.teeBadgeLockMath';\nimport { STRAIGHT_TEST_RENDER } from './st.straightTestReceipt';`,
    'straight test feature imports'
  );
  s = replaceOnce(
    s,
    `\ttype StraightTestCandidateInput,\n\ttype StraightTestGeometryEndpoints,`,
    `\ttype StraightTestBasketHypothesis,\n\ttype StraightTestCandidateInput,\n\ttype StraightTestGeometryEndpoints,`,
    'straight test contract type import'
  );
  s = replaceOnce(
    s,
    `\tnote: 'Early geometry-only S0 straight-test testimony; never asserts ownership or bend truth.',`,
    `\tnote: 'G5 straight-hole testimony: extend an accepted Tee→Badge direction and select the first semantic basket TIP encountered inside the existing corridor; no assignment mutation.',`,
    'straight test feature note'
  );
  s = replaceOnce(
    s,
    `\t}\n} satisfies ABFeature;\n\nfunction vectors`,
    `\t},\n\trender: STRAIGHT_TEST_RENDER\n} satisfies ABFeature;\n\nfunction vectors`,
    'straight test renderer attachment'
  );

  const helperAnchor = `function candidateFromEvidence(`;
  const helpers = `interface StraightRayEndpoints {\n\treadonly tee: readonly [number, number];\n\treadonly badge: readonly [number, number];\n}\n\nfunction lockEndpoints(lock: TeeBadgeLockEvidenceLock): StraightRayEndpoints | null {\n\tconst tee = lock.teeBadgePath[0];\n\tconst badge = lock.teeBadgePath[lock.teeBadgePath.length - 1];\n\tif (!tee || !badge) return null;\n\tif (![tee[0], tee[1], badge[0], badge[1]].every(Number.isFinite)) return null;\n\tif (Math.hypot(badge[0] - tee[0], badge[1] - tee[1]) <= 0) return null;\n\treturn { tee, badge };\n}\n\nexport function rankBasketTipsOnStraightRay(\n\tlock: TeeBadgeLockEvidenceLock,\n\tbaskets: readonly BasketEvidence[],\n\tcorridorWidthPx: number | null\n): readonly StraightTestBasketHypothesis[] {\n\tconst endpoints = lockEndpoints(lock);\n\tif (!endpoints) return [];\n\tconst dx = endpoints.badge[0] - endpoints.tee[0];\n\tconst dy = endpoints.badge[1] - endpoints.tee[1];\n\tconst length = Math.hypot(dx, dy);\n\tconst ux = dx / length;\n\tconst uy = dy / length;\n\tconst half = corridorWidthPx !== null && corridorWidthPx > 0 ? corridorWidthPx / 2 : null;\n\tconst rows = baskets.map((basket) => {\n\t\tconst vx = basket.tipXPx - endpoints.badge[0];\n\t\tconst vy = basket.tipYPx - endpoints.badge[1];\n\t\tconst alongPx = vx * ux + vy * uy;\n\t\tconst perpendicularPx = Math.abs(ux * vy - uy * vx);\n\t\tconst forward = alongPx > 0;\n\t\tconst inCorridor = forward && half !== null && perpendicularPx <= half;\n\t\treturn {\n\t\t\tbasketId: basket.detId,\n\t\t\ttipXPx: basket.tipXPx,\n\t\t\ttipYPx: basket.tipYPx,\n\t\t\talongPx,\n\t\t\tperpendicularPx,\n\t\t\tforward,\n\t\t\tinCorridor,\n\t\t\tencounterRank: null as number | null,\n\t\t\tstrongIdentity: basket.confidence === 'high'\n\t\t};\n\t});\n\tconst rank = new Map(\n\t\trows\n\t\t\t.filter((row) => row.inCorridor)\n\t\t\t.sort((a, b) => a.alongPx - b.alongPx || a.perpendicularPx - b.perpendicularPx || a.basketId.localeCompare(b.basketId))\n\t\t\t.map((row, index) => [row.basketId, index + 1] as const)\n\t);\n\treturn rows\n\t\t.map((row) => ({ ...row, encounterRank: rank.get(row.basketId) ?? null }))\n\t\t.sort((a, b) =>\n\t\t\tNumber(!a.inCorridor) - Number(!b.inCorridor) ||\n\t\t\t(a.encounterRank ?? Number.POSITIVE_INFINITY) - (b.encounterRank ?? Number.POSITIVE_INFINITY) ||\n\t\t\ta.perpendicularPx - b.perpendicularPx ||\n\t\t\ta.basketId.localeCompare(b.basketId)\n\t\t);\n}\n\nfunction blindProposalForLock(\n\tlock: TeeBadgeLockEvidenceLock,\n\tbaskets: readonly BasketEvidence[],\n\tcorridorWidthPx: number | null\n): StraightTestProposal {\n\tconst endpoints = lockEndpoints(lock);\n\tconst hypotheses = rankBasketTipsOnStraightRay(lock, baskets, corridorWidthPx);\n\tconst corridor = hypotheses.filter((candidate) => candidate.inCorridor);\n\tconst winner = corridor.find((candidate) => candidate.encounterRank === 1);\n\tconst next = corridor.find((candidate) => candidate.encounterRank === 2);\n\tconst half = corridorWidthPx !== null && corridorWidthPx > 0 ? corridorWidthPx / 2 : null;\n\tconst holeLabel = Number.isInteger(lock.hole) ? String(lock.hole) : null;\n\tconst straightRay = {\n\t\tcorridorWidthPx,\n\t\tcorridorHalfWidthPx: half,\n\t\tselectedAlongPx: winner?.alongPx ?? null,\n\t\tselectedPerpendicularPx: winner?.perpendicularPx ?? null,\n\t\tcorridorCandidateCount: corridor.length,\n\t\tnextTipMarginPx: winner && next ? next.alongPx - winner.alongPx : null\n\t};\n\tif (!endpoints || !winner) {\n\t\treturn {\n\t\t\tproposalId: \\`straight-\\${lock.badgeId}-\\${lock.teeId}-UNKNOWN-basket\\`,\n\t\t\tholeLabel,\n\t\t\tbadgeId: lock.badgeId,\n\t\t\tcandidateCount: baskets.length,\n\t\t\tteeId: lock.teeId,\n\t\t\tbasketId: null,\n\t\t\tendpointProvenance: {\n\t\t\t\tbadge: 'accepted teeBadgeLock path endpoint',\n\t\t\t\ttee: 'accepted teeBadgeLock path start',\n\t\t\t\tbasket: 'UNKNOWN -- no forward basket TIP inside corridor'\n\t\t\t},\n\t\t\tgeometryEndpoints: null,\n\t\t\tcoordinateFrame: STRAIGHT_TEST_COORDINATE_FRAME,\n\t\t\tverdict: 'ABSTAIN',\n\t\t\tselected: false,\n\t\t\trunnerUpProposalId: null,\n\t\t\tmeasurements: { f: null, dPerpPx: null, axialResidualDeg: null, directionalResidualDeg: null, collinearityResidualDeg: null },\n\t\t\tstraightRay,\n\t\t\tbasketHypotheses: hypotheses,\n\t\t\tgates: {\n\t\t\t\tidentifiedBadge: holeLabel !== null ? 'PASS' : 'UNKNOWN',\n\t\t\t\tstrongBasketIdentity: 'UNKNOWN',\n\t\t\t\tsemanticStrongRingTee: lock.tier === 'visible' ? 'PASS' : 'UNKNOWN',\n\t\t\t\tteeAxisToBadgeAgreement: 'UNKNOWN',\n\t\t\t\tbadgeLongitudinalFraction: 'UNKNOWN',\n\t\t\t\tteeBadgeBasketCollinearity: 'FAIL',\n\t\t\t\toneToOneUniqueness: 'UNKNOWN'\n\t\t\t},\n\t\t\treasons: [\n\t\t\t\tcorridorWidthPx === null\n\t\t\t\t\t? 'ABSTAIN: corridorWidthPx testimony is UNKNOWN.'\n\t\t\t\t\t: \\`ABSTAIN: no semantic basket TIP lies forward of the badge within \\${half?.toFixed(2) ?? 'UNKNOWN'}px of the accepted Tee→Badge ray.\\`,\n\t\t\t\t'No basket assignment is mutated.'\n\t\t\t],\n\t\t\ttruthTainted: false\n\t\t};\n\t}\n\n\tconst basket = baskets.find((candidate) => candidate.detId === winner.basketId)!;\n\tconst candidate: StraightTestCandidateInput = {\n\t\tholeLabel,\n\t\tbadge: { detId: lock.badgeId, xPx: endpoints.badge[0], yPx: endpoints.badge[1], label: holeLabel, provenance: 'accepted teeBadgeLock path endpoint' },\n\t\ttee: { detId: lock.teeId, xPx: endpoints.tee[0], yPx: endpoints.tee[1], tier: lock.tier, angleRad: null, provenance: 'accepted teeBadgeLock path start' },\n\t\tbasket: { detId: basket.detId, xPx: basket.tipXPx, yPx: basket.tipYPx, strongIdentity: basket.confidence === 'high', provenance: \\`\\${basket.tier ?? 'basket'}; semantic basket TIP\\` }\n\t};\n\treturn {\n\t\tproposalId: \\`straight-\\${lock.badgeId}-\\${lock.teeId}-\\${basket.detId}\\`,\n\t\tholeLabel,\n\t\tbadgeId: lock.badgeId,\n\t\tcandidateCount: baskets.length,\n\t\tteeId: lock.teeId,\n\t\tbasketId: basket.detId,\n\t\tendpointProvenance: { badge: candidate.badge.provenance, tee: candidate.tee.provenance, basket: candidate.basket.provenance },\n\t\tgeometryEndpoints: geometryEndpoints(candidate),\n\t\tcoordinateFrame: STRAIGHT_TEST_COORDINATE_FRAME,\n\t\tverdict: 'PROVISIONAL',\n\t\tselected: true,\n\t\trunnerUpProposalId: null,\n\t\tmeasurements: measureStraightGeometry(candidate),\n\t\tstraightRay,\n\t\tbasketHypotheses: hypotheses,\n\t\tgates: {\n\t\t\tidentifiedBadge: holeLabel !== null ? 'PASS' : 'UNKNOWN',\n\t\t\tstrongBasketIdentity: winner.strongIdentity ? 'PASS' : 'FAIL',\n\t\t\tsemanticStrongRingTee: lock.tier === 'visible' ? 'PASS' : 'UNKNOWN',\n\t\t\tteeAxisToBadgeAgreement: 'UNKNOWN',\n\t\t\tbadgeLongitudinalFraction: 'UNKNOWN',\n\t\t\tteeBadgeBasketCollinearity: 'PASS',\n\t\t\toneToOneUniqueness: 'UNKNOWN'\n\t\t},\n\t\treasons: [\n\t\t\t\\`BLIND straight hypothesis: \\${basket.detId}'s semantic TIP is the first forward TIP encountered inside the existing \\${corridorWidthPx?.toFixed(2) ?? 'UNKNOWN'}px directed Tee→Badge corridor.\\`,\n\t\t\t\\`TIP testimony: along=\\${winner.alongPx.toFixed(2)}px, perpendicular=\\${winner.perpendicularPx.toFixed(2)}px, corridorCandidates=\\${corridor.length}\\${next ? \\`, next TIP +\\${(next.alongPx - winner.alongPx).toFixed(2)}px downrange\\` : ''}.\\`,\n\t\t\t'No basket assignment is mutated.'\n\t\t],\n\t\ttruthTainted: false\n\t};\n}\n\nfunction enforceUniqueBasketTips(proposals: readonly StraightTestProposal[]): StraightTestProposal[] {\n\tconst counts = new Map<string, number>();\n\tfor (const proposal of proposals) {\n\t\tif (proposal.selected && proposal.basketId) counts.set(proposal.basketId, (counts.get(proposal.basketId) ?? 0) + 1);\n\t}\n\treturn proposals.map((proposal) => {\n\t\tif (!proposal.selected || !proposal.basketId) return proposal;\n\t\tif ((counts.get(proposal.basketId) ?? 0) === 1) {\n\t\t\treturn { ...proposal, gates: { ...proposal.gates, oneToOneUniqueness: 'PASS' } };\n\t\t}\n\t\treturn {\n\t\t\t...proposal,\n\t\t\tselected: false,\n\t\t\tverdict: 'ABSTAIN',\n\t\t\tgates: { ...proposal.gates, oneToOneUniqueness: 'FAIL' },\n\t\t\treasons: [...proposal.reasons, \\`ABSTAIN: basket TIP \\${proposal.basketId} is the local first hit for more than one tee→badge corridor.\\`]\n\t\t};\n\t});\n}\n\nfunction emitBlindStraightDrawables(\n\tctx: FeatureContext,\n\tproposals: readonly StraightTestProposal[],\n\tlocks: readonly TeeBadgeLockEvidenceLock[]\n): void {\n\tconst lockByBadge = new Map(locks.map((lock) => [lock.badgeId, lock]));\n\tfor (const proposal of proposals) {\n\t\tconst lock = lockByBadge.get(proposal.badgeId);\n\t\tconst endpoints = lock ? lockEndpoints(lock) : null;\n\t\tconst e = proposal.geometryEndpoints;\n\t\tconst ray = proposal.straightRay;\n\t\tconst hole = Number(proposal.holeLabel);\n\t\tif (!proposal.selected || !e || !ray || !endpoints || !Number.isFinite(ray.corridorHalfWidthPx)) {\n\t\t\tctx.overlay('straightTest', {\n\t\t\t\ttype: 'point',\n\t\t\t\txPx: endpoints?.badge[0] ?? 0,\n\t\t\t\tyPx: endpoints?.badge[1] ?? 0,\n\t\t\t\tverdict: 'rejected',\n\t\t\t\tmetadata: { straightRole: 'straight-abstention', badgeId: proposal.badgeId, teeId: proposal.teeId ?? 'UNKNOWN' },\n\t\t\t\tref: \\`\\${proposal.proposalId}:abstain\\`,\n\t\t\t\treason: proposal.reasons.join(' ')\n\t\t\t});\n\t\t\tcontinue;\n\t\t}\n\t\tconst values: Record<string, number> = {\n\t\t\talongPx: ray.selectedAlongPx ?? Number.NaN,\n\t\t\tperpendicularPx: ray.selectedPerpendicularPx ?? Number.NaN,\n\t\t\tcorridorWidthPx: ray.corridorWidthPx ?? Number.NaN,\n\t\t\tcorridorCandidateCount: ray.corridorCandidateCount\n\t\t};\n\t\tif (Number.isFinite(hole)) values.hole = hole;\n\t\tif (ray.nextTipMarginPx !== null) values.nextTipMarginPx = ray.nextTipMarginPx;\n\t\tfor (const key of Object.keys(values)) if (!Number.isFinite(values[key])) delete values[key];\n\t\tconst metadata = {\n\t\t\tstraightRole: 'straight-route',\n\t\t\tteeId: proposal.teeId ?? 'UNKNOWN',\n\t\t\tbadgeId: proposal.badgeId,\n\t\t\tbasketId: proposal.basketId ?? 'UNKNOWN'\n\t\t};\n\t\tctx.overlay('straightTest', {\n\t\t\ttype: 'polyline',\n\t\t\tpath: [[e.tee.xPx, e.tee.yPx], [e.badge.xPx, e.badge.yPx], [e.basket.xPx, e.basket.yPx]],\n\t\t\tverdict: 'accepted',\n\t\t\tmetadata,\n\t\t\tvalues,\n\t\t\tref: \\`\\${proposal.proposalId}:route\\`,\n\t\t\treason: proposal.reasons[0]\n\t\t});\n\t\tconst dx = e.badge.xPx - e.tee.xPx;\n\t\tconst dy = e.badge.yPx - e.tee.yPx;\n\t\tconst len = Math.hypot(dx, dy);\n\t\tconst nx = (-dy / len) * ray.corridorHalfWidthPx!;\n\t\tconst ny = (dx / len) * ray.corridorHalfWidthPx!;\n\t\tfor (const sign of [-1, 1]) {\n\t\t\tctx.overlay('straightTest', {\n\t\t\t\ttype: 'polyline',\n\t\t\t\tpath: [[e.tee.xPx + sign * nx, e.tee.yPx + sign * ny], [e.basket.xPx + sign * nx, e.basket.yPx + sign * ny]],\n\t\t\t\tverdict: 'info',\n\t\t\t\tmetadata: { ...metadata, straightRole: 'corridor-edge' },\n\t\t\t\tvalues,\n\t\t\t\tref: \\`\\${proposal.proposalId}:corridor-\\${sign < 0 ? 'left' : 'right'}\\`\n\t\t\t});\n\t\t}\n\t\tctx.overlay('straightTest', {\n\t\t\ttype: 'point', xPx: e.basket.xPx, yPx: e.basket.yPx, verdict: 'accepted',\n\t\t\tmetadata: { ...metadata, straightRole: 'winning-basket-tip' }, values,\n\t\t\tref: \\`\\${proposal.proposalId}:winning-tip\\`, reason: 'first semantic basket TIP encountered in directed corridor'\n\t\t});\n\t\tconst winnerAlong = ray.selectedAlongPx ?? 0;\n\t\tfor (const alternative of proposal.basketHypotheses ?? []) {\n\t\t\tif (!alternative.inCorridor || alternative.encounterRank === null || alternative.encounterRank <= 1) continue;\n\t\t\tctx.overlay('straightTest', {\n\t\t\t\ttype: 'point', xPx: alternative.tipXPx, yPx: alternative.tipYPx, verdict: 'rejected',\n\t\t\t\tmetadata: { straightRole: 'later-basket-tip', teeId: proposal.teeId ?? 'UNKNOWN', badgeId: proposal.badgeId, basketId: alternative.basketId },\n\t\t\t\tvalues: { ...(Number.isFinite(hole) ? { hole } : {}), alongPx: alternative.alongPx, perpendicularPx: alternative.perpendicularPx, afterFirstPx: alternative.alongPx - winnerAlong, encounterRank: alternative.encounterRank },\n\t\t\t\tref: \\`\\${proposal.proposalId}:later-tip:\\${alternative.basketId}\\`,\n\t\t\t\treason: \\`later basket TIP in same corridor: +\\${(alternative.alongPx - winnerAlong).toFixed(2)}px after first hit\\`\n\t\t\t});\n\t\t}\n\t}\n}\n\n`;
  s = replaceOnce(s, helperAnchor, helpers + helperAnchor, 'blind straight helper insertion');

  s = replaceOnce(
    s,
    `\tconsumes: ['badges', 'baskets', 'tees', 'straightTestTruthAssistance'],`,
    `\tconsumes: ['badges', 'baskets', 'tees', 'measurement', 'teeBadgeLock', 'straightTestTruthAssistance'],`,
    'straight test consumes'
  );
  s = replaceOnce(
    s,
    `\tnote: 'Geometry-only early S0; no assignment or bend refinement.',`,
    `\tnote: 'Blind directed-corridor straight resolver over accepted Tee→Badge locks and semantic basket TIPs; truth-assisted S0 comparison retained separately.',`,
    'straight test unit note'
  );

  const startNeedle = `\t\tconst proposals = badges.flatMap((badge) => {`;
  const endNeedle = `\t\tconst trace: StraightTestTrace = {`;
  const start = s.indexOf(startNeedle);
  const end = s.indexOf(endNeedle, start);
  if (start < 0 || end < 0) throw new Error('missing straight test run-body anchors');
  const oldBody = s.slice(start, end);
  const oldProposalStart = oldBody.indexOf(startNeedle);
  const oldDrawStart = oldBody.indexOf(`\t\tconst drawableProposals = proposals.filter`);
  if (oldDrawStart < 0) throw new Error('missing old drawable block');
  const truthProposalBlock = oldBody.slice(oldProposalStart, oldDrawStart)
    .replace(`\t\tconst proposals =`, `\t\t\tproposals =`)
    .split('\n').map((line, index) => index === 0 ? line : `\t${line}`).join('\n');
  const truthDrawBlock = oldBody.slice(oldDrawStart)
    .split('\n').map((line) => `\t${line}`).join('\n');
  const replacement = `\t\tlet proposals: StraightTestProposal[];\n\t\tif (assistance.mode === 'blind') {\n\t\t\tconst teeBadge = board.get<TeeBadgeLockEvidence>('teeBadgeLock');\n\t\t\tconst measurement = board.get<ThreeFactorMeasurement>('measurement');\n\t\t\tconst width =\n\t\t\t\ttypeof teeBadge.corridorWidthPx === 'number' && Number.isFinite(teeBadge.corridorWidthPx)\n\t\t\t\t\t? teeBadge.corridorWidthPx\n\t\t\t\t\t: typeof measurement.parameters?.corridorWidthPx === 'number' && Number.isFinite(measurement.parameters.corridorWidthPx)\n\t\t\t\t\t\t? measurement.parameters.corridorWidthPx\n\t\t\t\t\t\t: null;\n\t\t\tproposals = enforceUniqueBasketTips(teeBadge.locks.map((lock) => blindProposalForLock(lock, baskets, width)));\n\t\t\temitBlindStraightDrawables(ctx, proposals, teeBadge.locks);\n\t\t} else {\n${truthProposalBlock}\n${truthDrawBlock}\t\t}\n`;
  s = s.slice(0, start) + replacement + s.slice(end);
  write(path, s);
}

// ---- G5 isolated composition: new blind resolver explicitly reads G4 testimony.
{
  const path = 'packages/alg/src/detectors/threeFactor/gate-sets.ts';
  let s = read(path);
  s = replaceOnce(
    s,
    `\t\tseededSlots: ['image', 'localImage', 'params', 'viewport', 'stage', 'badges', 'baskets', 'tees', 'straightTestTruthAssistance']`,
    `\t\tseededSlots: ['image', 'localImage', 'params', 'viewport', 'stage', 'badges', 'baskets', 'tees', 'measurement', 'teeBadgeLock', 'straightTestTruthAssistance']`,
    'g5 straight-test seeded slots'
  );
  write(path, s);
}

// ---- Experimental configs: run the frozen 106 endpoint chain first, then G5 Straight Test.
for (const [path, truthAssisted] of [
  ['packages/alg/src/detectors/threeFactor/configs/straight-test-on.json', false],
  ['packages/alg/src/detectors/threeFactor/configs/straight-test-truth-assisted-compare.json', true]
]) {
  const value = JSON.parse(read(path));
  value.note = truthAssisted
    ? 'Explicit TRUTH-TAINT comparison after the frozen 106 endpoint/teeBadgeLock chain; caller must provide verified-canonical assistance payload.'
    : 'Blind G5 Straight Test after the frozen 106 endpoint/teeBadgeLock chain: first semantic basket TIP encountered inside the directed Tee→Badge corridor; no assignment mutation.';
  value.execution = [
    'badgeStage', 'badges', 'baskets', 'tees', 'teeFamily',
    'supportField', 'badgeOcclusionPatch', 'rawPairs', 'measurement',
    'assignment', 'teeRecovery', 'teeBadgeLock', 'straightTest'
  ];
  write(path, `${JSON.stringify(value, null, '\t')}\n`);
}

console.log('directed-corridor Straight Test patch applied');
