import { pathToFileURL } from 'node:url';

import { DETECTOR_CARDS } from './detectors';
import { LAB_GATES } from './gates';
import { INVARIANT_CARDS } from './invariants';

export type CaseStatus = 'measured' | 'observed' | 'archetype';

export type CaseExample = {
	course: string;
	holes: readonly number[];
	note: string;
	source: string;
};

/**
 * Case cards are the fourth LAB catalog axis.
 *
 * Gate      = where in the workflow.
 * Detector  = which mechanism measures evidence.
 * Invariant = which reusable claim may be applied.
 * Case      = which pathological evidence configuration is present.
 *
 * A case is deliberately cross-cutting: the same Tee Shard can affect tee
 * detection, recovery, pair ranking, assignment, and review without becoming
 * a new detector or a new invariant.
 */
export type CaseCard = {
	id: string;
	title: string;
	status: CaseStatus;
	tags: readonly string[];
	gates: readonly number[];
	detectors: readonly string[];
	invariants: readonly string[];
	definition: string;
	whyHard: readonly string[];
	evidenceSemantics: {
		positive: readonly string[];
		neutral: readonly string[];
		contradictions: readonly string[];
	};
	measure: readonly string[];
	success: readonly string[];
	doNotInfer: readonly string[];
	examples: readonly CaseExample[];
	open: readonly string[];
};

export const CASE_CARDS: readonly CaseCard[] = [
	{
		id: 'C00-tee-shard',
		title: 'Tee Shard',
		status: 'measured',
		tags: ['tee', 'occlusion', 'partial-evidence', 'renderer-overlap'],
		gates: [3, 4, 6],
		detectors: ['D04-tee-candidates', 'D05-occluded-tee-recovery', 'D08-pair-matrix'],
		invariants: [
			'I01-render-stack-order',
			'I06-anchor-locked-basket-zone',
			'I09-tee-glyph-anatomy'
		],
		definition:
			'A tee whose ordinary hollow-glyph observation is destroyed by a known higher render layer, leaving only a small visible white border fragment that could still belong to the tee family.',
		whyHard: [
			'Most expected tee pixels may be hidden, so ordinary full-template recall is meaningless.',
			'The surviving shard may be too small to recover center or pose by PCA/bbox alone.',
			'Basket, C1/C2, badge, and corridor furniture can create nearby white fragments that are not tees.'
		],
		evidenceSemantics: {
			positive: [
				'Use the inner/core portion of the expected white tee border as a falsifiable material model: visible shard pixels should be explained by tee-white support at a plausible placement.',
				'A precision-dominant match is appropriate: if nearly every visible shard pixel is tee-consistent, the shard remains a viable tee hypothesis even when only a tiny fraction of the full tee is visible.',
				'Independent family evidence such as course-local white-component size, right-angle edges, gray tee interior, and proximity to a known occluder strengthens the hypothesis.'
			],
			neutral: [
				'Expected tee pixels hidden by a known occluder are UNKNOWN, not misses, and must not enter the mismatch denominator.',
				'No orientation evidence surviving the shard does not disprove tee identity.'
			],
			contradictions: [
				'Any confidently visible pixel pattern that the tee model cannot produce is negative evidence; for example, a non-tee colored island inside what is claimed to be a pure white tee shard.',
				'A shard placement that requires visible, unoccluded expected border pixels where the raster clearly contains incompatible evidence is falsified rather than excused.'
			]
		},
		measure: [
			'visible shard pixels and their source bright-component identity',
			'known-occluder mask; report visible expected border separately from hidden expected border',
			'inner-border support / visible-shard explained fraction / explicit contradiction count',
			'full surviving component bbox, area, fill, straight-edge segments, corner angles, and right-angle evidence',
			'course-local tee family geometry and gray-interior evidence when available'
		],
		success: [
			'Retain the shard as a candidate when visible evidence is strongly tee-consistent and no visible contradiction falsifies it.',
			'Use full surviving edges/corners for pose when present; inner/core matching is for identity/falsification, not pose fitting.',
			'Forward honest uncertainty into pair evidence instead of manufacturing missing pixels.'
		],
		doNotInfer: [
			'High visible-shard agreement does not prove the hidden tee center.',
			'Occlusion cannot excuse a contradictory visible pixel.',
			'Inner-50/core support is not a license to fit pose from only the reduced template.'
		],
		examples: [
			{
				course: 'HeritagePark',
				holes: [6],
				note: 'Historical recovery v3 records a tee living almost entirely inside a basket sprite bbox; deleting the whole sprite rectangle removed the useful surviving evidence.',
				source: 'scripts/cv-probes/occluded_tee_recovery_v3.py'
			},
			{
				course: 'FountainHills',
				holes: [],
				note: 'Held-out 2026-08-22 inspection found basket-overlapped tee shards with useful surviving right-angle/white-family evidence. Persist exact hole identities before promoting this to a regression fixture.',
				source: 'LAB held-out validation session; artifact not yet committed'
			}
		],
		open: [
			'Define the cheapest explicit contradiction test that transfers across gray/antialias variants.',
			'Persist held-out shard crops and measured visible/occluded masks as replayable fixtures.'
		]
	},
	{
		id: 'C01-complete-occlusion',
		title: 'Complete Occlusion',
		status: 'archetype',
		tags: ['tee', 'occlusion', 'zero-visible-evidence', 'latent-endpoint'],
		gates: [3, 4, 6],
		detectors: ['D05-occluded-tee-recovery', 'D08-pair-matrix', 'D09-global-assignment'],
		invariants: [
			'I01-render-stack-order',
			'I18-one-to-one-ownership',
			'I19-rank1-is-not-assignment'
		],
		definition:
			'An endpoint is geometrically plausible under a known higher render layer but no tee-owned pixel survives visibly enough to test tee appearance.',
		whyHard: [
			'There is no shard to score: appearance evidence is absent rather than weak.',
			'A candidate location can only come from independent geometry/ownership/path evidence, so localization and identity uncertainty are coupled.'
		],
		evidenceSemantics: {
			positive: [
				'Independent evidence may support a latent endpoint hypothesis: known occluder geometry, route termination, course-wide one-to-one ownership, or repeat renderer layout.'
			],
			neutral: [
				'All fully occluded tee-appearance pixels are unknown.',
				'A tee appearance scorer has no observation and should return unscorable/unknown rather than a low match.'
			],
			contradictions: [
				'Independent visible geometry that makes the latent endpoint impossible remains a contradiction; complete occlusion is not a universal excuse.'
			]
		},
		measure: [
			'occluder footprint and confidence that the expected endpoint region is actually hidden',
			'candidate-location uncertainty region rather than a fabricated point estimate',
			'independent path/ownership evidence and alternatives'
		],
		success: [
			'Preserve a latent/review candidate without pretending tee appearance verified it.',
			'Allow downstream evidence to resolve or leave it unresolved.'
		],
		doNotInfer: [
			'Zero visible tee pixels is not a zero-percent tee match.',
			'Known occlusion does not identify the hidden object by itself.',
			'Do not synthesize a confident center or orientation solely because one endpoint is missing.'
		],
		examples: [],
		open: [
			'Add the first fully verified zero-visible-pixel example; near-complete shards belong in C00, not here.'
		]
	},
	{
		id: 'C02-tight-cluster',
		title: 'Tight Cluster',
		status: 'observed',
		tags: ['crowding', 'ownership', 'multiple-real-candidates', 'global-assignment'],
		gates: [2, 3, 6],
		detectors: [
			'D03-basket-sprite',
			'D04-tee-candidates',
			'D08-pair-matrix',
			'D09-global-assignment'
		],
		invariants: [
			'I06-anchor-locked-basket-zone',
			'I18-one-to-one-ownership',
			'I19-rank1-is-not-assignment'
		],
		definition:
			'Multiple genuine endpoints and renderer zones occupy the same small neighborhood, so local proximity and local score rank cannot safely establish ownership.',
		whyHard: [
			'Every nearby object can be real; precision filters cannot solve ownership by deleting competitors.',
			'Basket zones, tee glyphs, badges, and ribbons overlap, changing both appearance and route evidence.',
			'Greedy nearest-neighbor reasoning can be locally plausible while globally impossible.'
		],
		evidenceSemantics: {
			positive: [
				'Preserve every credible endpoint and every measured tee→basket pair; global one-to-one structure is useful evidence here.'
			],
			neutral: ['A lower local pair rank is not itself negative evidence in a crowded cluster.'],
			contradictions: [
				'A proposed ownership that duplicates an endpoint or contradicts strong route evidence should lose even if it is nearest locally.'
			]
		},
		measure: [
			'pairwise endpoint and badge distances',
			'raw per-badge top-N pair ranking before assignment',
			'final one-to-one assignment and every displacement from local rank 1',
			'overlapping sprite/C1/C2/ribbon support masks'
		],
		success: [
			'Keep the candidate inventory broad enough that every real endpoint survives.',
			'Separate raw candidate ranking from final course-wide ownership in both logs and visual output.'
		],
		doNotInfer: [
			'Nearest endpoint is not automatically the owner.',
			'Deduplication must not erase a second genuine endpoint merely because sprites overlap.'
		],
		examples: [
			{
				course: 'DashsTrack',
				holes: [4, 5, 6],
				note: 'Shared inspection shows a dense H4-H6 renderer/endpoint neighborhood; H4 and H6 basket sprites are close enough for heavy overlap while adjacent tee/badge evidence also competes.',
				source: 'chainspot-corpus dev/DashsTrack + 2026-08-22 LAB shared inspection'
			}
		],
		open: [
			'Persist one canonical tight-cluster crop with candidate IDs and raw-vs-assigned pair tables.'
		]
	},
	{
		id: 'C03-merged-renderer-component',
		title: 'Merged Renderer Component',
		status: 'measured',
		tags: ['components', 'renderer-collision', 'white-mask', 'identity-vs-geometry'],
		gates: [1, 2, 3, 4],
		detectors: [
			'D02-badge-reader',
			'D03-basket-sprite',
			'D04-tee-candidates',
			'D05-occluded-tee-recovery'
		],
		invariants: [
			'I01-render-stack-order',
			'I06-anchor-locked-basket-zone',
			'I07-badge-anatomy',
			'I09-tee-glyph-anatomy'
		],
		definition:
			'Two renderer objects touch in the thresholded white mask and become one connected component, so component bbox/aspect/fill no longer describe either object faithfully.',
		whyHard: [
			'Connected-component geometry changes discontinuously when two white layers touch by even one pixel.',
			'A strong object identity signal may remain in another channel even though the white component is contaminated.'
		],
		evidenceSemantics: {
			positive: [
				'Use independent renderer identity such as the dark badge plate or fixed basket sprite before trusting merged white-component geometry.'
			],
			neutral: [
				'A contaminated outer bbox is not evidence that the underlying object changed scale or shape.'
			],
			contradictions: [
				'If all independent identity channels disagree, do not retain the object merely because a white blob exists.'
			]
		},
		measure: [
			'component labels before/after contact and exact touching pixels',
			'independent dark-plate, sprite-template, ring, or shard evidence',
			'which geometry fields were contaminated and which channels survived'
		],
		success: [
			'Recover identity from the surviving independent channel while preserving that the ordinary component geometry was contaminated.'
		],
		doNotInfer: [
			'Do not loosen global aspect/size thresholds to accommodate a merged component.',
			'Do not treat synthesized recovery geometry as a normal measured component.'
		],
		examples: [
			{
				course: 'HeritagePark / Lenard',
				holes: [2, 5, 12, 13, 15],
				note: 'Dev badge recovery work measured sprite/white-furniture merges that removed ordinary white-frame badge candidates; the dark plate remained stable and restored 72/72 dev badge availability.',
				source: 'D02 badge card history and badgeStage dark-plate recovery'
			}
		],
		open: [
			'Catalog tee-specific merged-component examples separately from C00 shards when substantial tee geometry still survives.'
		]
	},
	{
		id: 'C04-extreme-turn',
		title: 'Extreme Turn / Endpoint Geometry',
		status: 'observed',
		tags: ['ribbon', 'bend', 'endpoint', 'geometry-outlier'],
		gates: [4, 5, 7],
		detectors: ['D06-ribbon-support', 'D12-capsule-bends'],
		invariants: [
			'I02-corridor-render-primitive',
			'I03-one-width-per-course',
			'I04-alpha-composite-paint'
		],
		definition:
			'A corridor changes heading unusually soon after an endpoint and/or by an unusually large angle, so a one-bend or straight-arm approximation conflates endpoint-cap, join, and turn evidence.',
		whyHard: [
			'The turn may occur inside the same small renderer neighborhood as tee/basket sprites and C1/C2 furniture.',
			'One bend can smear a slight initial drift and a later hard turn into a single inaccurate vertex.'
		],
		evidenceSemantics: {
			positive: [
				'Multiple exposed ribbon fragments on distinct arms should support the direction change; constant-width paired rails are stronger than a single edge.'
			],
			neutral: ['Pixels hidden by endpoint furniture do not determine where the turn begins.'],
			contradictions: [
				'A proposed extra bend that only improves contaminated endpoint pixels but disagrees with exposed arms is overfit.'
			]
		},
		measure: [
			'distance from endpoint to first stable heading change',
			'heading-change angle and uncertainty',
			'one-bend versus two-bend residual on exposed, non-furniture ribbon pixels'
		],
		success: [
			'Represent the minimum bend complexity supported by multiple exposed fragments and keep unusual geometry tagged as an outlier rather than retuning normal holes around it.'
		],
		doNotInfer: [
			'A visually hard real-life hole does not prove a raster bend.',
			'A two-bend fit with lower residual is not enough if both bends are supported only by the same contaminated pixels.'
		],
		examples: [
			{
				course: 'DashsTrack',
				holes: [4],
				note: 'Shared inspection suggests a slight initial drift followed by a hard return near the basket. The hypothesis that H4 is both an unusually fast and sharp turn remains to be measured against the rest of the corpus.',
				source: '2026-08-22 LAB shared inspection; outlier ranking not yet proven'
			}
		],
		open: [
			'Measure endpoint-to-turn distance and angle over dev + validation before calling H4 the corpus extreme.'
		]
	}
] as const;

const gateIds = new Set(LAB_GATES.map(({ id }) => id));
const detectorIds = new Set(DETECTOR_CARDS.map(({ id }) => id));
const invariantIds = new Set(INVARIANT_CARDS.map(({ id }) => id));
const caseIds = new Set<string>();
for (const card of CASE_CARDS) {
	if (caseIds.has(card.id)) throw new Error(`Duplicate case card ${card.id}`);
	caseIds.add(card.id);
	for (const gate of card.gates)
		if (!gateIds.has(gate)) throw new Error(`${card.id} names unknown gate ${gate}`);
	for (const detector of card.detectors) {
		if (!detectorIds.has(detector))
			throw new Error(`${card.id} names unknown detector ${detector}`);
	}
	for (const invariant of card.invariants) {
		if (!invariantIds.has(invariant))
			throw new Error(`${card.id} names unknown invariant ${invariant}`);
	}
}

function printCard(card: CaseCard): void {
	console.log(
		`${card.id} — ${card.title}\nstatus: ${card.status}\ntags: ${card.tags.join(', ')}\ngates: ${card.gates.join(', ')}\n${card.definition}`
	);
	for (const [label, values] of [
		['WHY THIS IS HARD', card.whyHard],
		['POSITIVE EVIDENCE', card.evidenceSemantics.positive],
		['NEUTRAL / UNKNOWN EVIDENCE', card.evidenceSemantics.neutral],
		['VISIBLE CONTRADICTIONS', card.evidenceSemantics.contradictions],
		['MEASURE', card.measure],
		['SUCCESS', card.success],
		['WHAT NOT TO INFER', card.doNotInfer],
		['OPEN', card.open],
		['DETECTORS', card.detectors],
		['INVARIANTS', card.invariants]
	] as const) {
		console.log(`\n${label}`);
		for (const value of values) console.log(`  - ${value}`);
	}
	if (card.examples.length > 0) {
		console.log('\nEXAMPLES');
		for (const example of card.examples) {
			const holes = example.holes.length > 0 ? ` H${example.holes.join('/H')}` : '';
			console.log(`  - ${example.course}${holes}: ${example.note}`);
			console.log(`    source: ${example.source}`);
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const requested = process.argv[2];
	if (requested === undefined) {
		for (const card of CASE_CARDS) console.log(`${card.id} [${card.status}] — ${card.title}`);
	} else {
		const card = CASE_CARDS.find(({ id }) => id === requested || id.startsWith(`${requested}-`));
		if (!card) throw new Error(`Unknown case ${requested}`);
		printCard(card);
	}
}
