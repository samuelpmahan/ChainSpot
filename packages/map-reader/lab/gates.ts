import { pathToFileURL } from 'node:url';

import { DETECTOR_CARDS } from './detectors';

export type LabGate = {
	id: number;
	title: string;
	detectors: readonly string[];
	description: string;
	rawEvidence: {
		producers: readonly string[];
		measurements: readonly string[];
		images: readonly string[];
		provenance: readonly string[];
	};
	interpretation: {
		matters: readonly string[];
		doNotInfer: readonly string[];
		failureModes: readonly string[];
		nextDecision: string;
	};
	history: {
		reproduced: readonly string[];
		rejected: readonly string[];
		open: readonly string[];
	};
	changelog: readonly {
		commit: string;
		change: string;
		why: string;
		evidence: string;
		consequences: string;
		limits: string;
	}[];
};

const commonProvenance = [
	'run ID and UTC timestamp',
	'code commit and dirty-worktree status',
	'input file SHA-256 and canonical-raster SHA-256',
	'course name, detector configuration, and coordinate-frame dimensions'
] as const;

export const LAB_GATES: readonly LabGate[] = [
	{
		id: 0,
		title: 'Crop + Stitch',
		detectors: ['D00-map-viewport-crop', 'D01-stitch-pipeline'],
		description:
			'Convert one or more source screenshots into one canonical map raster. UI chrome and source-tile coordinates end here; every later measurement uses crop-local pixels in the flattened raster.',
		rawEvidence: {
			producers: [
				'src/lib/stitch/stitchPipeline.ts',
				'src/lib/stitch/renderComposite.ts',
				'src/lib/nuthing/viewport.ts: detectMapViewport + cropRows'
			],
			measurements: [
				'per-source crop bounds',
				'per-source transform into the composite',
				'composite bounds and canonical width/height',
				'crop/stitch diagnostics and abstentions'
			],
			images: [
				'original source raster(s)',
				'cropped source raster(s)',
				'canonical flattened raster',
				'seam/crop diagnostic overlay'
			],
			provenance: commonProvenance
		},
		interpretation: {
			matters: [
				'Whether all course pixels needed downstream survive the crop',
				'Whether overlapping tiles agree geometrically and the composite has no duplicated or missing region',
				'Whether the emitted raster defines one unambiguous coordinate frame'
			],
			doNotInfer: [
				'A clean crop does not prove badges or endpoints are detectable',
				'A visually smooth seam does not prove its transform is geometrically correct',
				'Source-frame coordinates are provenance, never downstream annotation coordinates'
			],
			failureModes: [
				'UI chrome retained or map rows removed',
				'low-texture overlap gives a plausible but wrong stitch',
				'duplicate tiles or incorrect tile order',
				'canonical hash changes because decoding or compositing changed'
			],
			nextDecision: 'Is the canonical raster trustworthy enough to allow badge measurement?'
		},
		history: {
			reproduced: [
				'NuThing uses the production single-image crop proposal through detectMapViewport and then slices rows with cropRows.',
				'The stitch pipeline supports multiple tiles and emits a flattened output raster plus source transforms.'
			],
			rejected: [
				'Treating the screenshot frame and cropped frame as two equally valid annotation systems.'
			],
			open: [
				'A LAB run-scoped evidence store has not yet been wired to persist every crop/stitch image and hash.'
			]
		},
		changelog: [
			{
				commit: '4a33dadc618fc9b1ded76c07e84217824bac29a4',
				change: 'Moved crop-boundary detection to native-resolution evidence.',
				why: 'Downsampled analysis moved crop boundaries.',
				evidence: 'Commit records the crop-boundary correction.',
				consequences:
					'Crop coordinates can define the canonical frame without scale-rounding drift.',
				limits: 'This does not validate stitching or downstream detection.'
			},
			{
				commit: '871b591729174767c080b238a004538e63626216',
				change: 'Generalized the stitch pipeline to N tiles.',
				why: 'The source map may require more than one screenshot.',
				evidence: 'Pipeline and UI were rebuilt around a generalized composite.',
				consequences: 'Gate 0 must preserve every source transform and the final flattened raster.',
				limits: 'N-tile support is capability, not proof that a particular stitch is correct.'
			},
			{
				commit: '2f38e2e440050d2fb7e314f21b83d1e9420d1c61',
				change: 'Integrated production auto-crop into the NuThing experiment.',
				why: 'Endpoint and assignment measurements needed the same raster frame as production intake.',
				evidence:
					'The commit was explicitly known-bad for assignment (21/66) while pool recall remained 69/69.',
				consequences: 'Crop correctness became separable from later algorithm correctness.',
				limits: 'The commit is not an assignment baseline.'
			}
		]
	},
	{
		id: 1,
		title: 'Badges',
		detectors: ['D02-badge-reader'],
		description:
			'Detect badge plates, segment their digit glyphs, and score number identities while preserving alternatives. The gate answers which numbered anchors are measurable and where they are; it does not assign tees or baskets.',
		rawEvidence: {
			producers: [
				'src/lib/nuthing/badgeStage.ts: runBadgeStage',
				'src/lib/nuthing/digits/readBadges.ts: readCourseBadges'
			],
			measurements: [
				'plate/component geometry and source tier',
				'badge anchor position',
				'glyph masks and per-digit scores/alternatives',
				'decoded label and score margin'
			],
			images: [
				'canonical raster with every plate candidate',
				'per-badge plate crop',
				'nearest-neighbor glyph mask'
			],
			provenance: commonProvenance
		},
		interpretation: {
			matters: [
				'Whether labels 1 through 18 are represented exactly once or explicitly unresolved',
				'Whether the stored anchor matches the plate geometry used by route scoring',
				'Whether alternatives show a real identity ambiguity rather than only a low absolute score'
			],
			doNotInfer: [
				'A decoded number does not establish endpoint ownership',
				'A recovered dark plate is not a normal bright-frame component',
				'The top digit score is not Oracle truth when the margin is small'
			],
			failureModes: [
				'basket or map furniture merges with the white badge frame',
				'large bright components intrude into the digit crop',
				'multi-digit segmentation splits or joins glyphs incorrectly',
				'one physical badge yields duplicate candidates'
			],
			nextDecision:
				'Are all badge identities and anchors stable enough to measure endpoint candidates?'
		},
		history: {
			reproduced: [
				'The browser-portable reader preserves glyph masks, scores, and margins instead of only a final label.',
				'Dark-plate recovery restored the full 1..18 badge set on the four-course dev corpus.'
			],
			rejected: ['Assuming every badge must survive as an ordinary bright-frame component.'],
			open: [
				'The current browser/progressive handoff must be audited for lost digit alternatives and fabricated geometry.'
			]
		},
		changelog: [
			{
				commit: '22c89d3347c807434707fa2b458f5e7fdc72b5a4',
				change:
					'Added the browser-portable end-to-end badge reader with retained per-digit evidence.',
				why: 'A decoded label alone was insufficient for diagnosis.',
				evidence: 'The pipeline retains masks, scores, and margins.',
				consequences: 'Agents can separate plate detection from digit interpretation.',
				limits: 'The commit did not solve badge/sprite occlusion.'
			},
			{
				commit: '3c270b1b819c3f183c30474c0fa2fbb20b71bfa2',
				change: 'Added dark-plate recovery and large-component exclusion for recovered glyphs.',
				why: 'Sprite-merged frames caused six missing dev badges and phantom digit strings.',
				evidence: 'Badge identity recall changed from 66/72 to 72/72 on the four dev courses.',
				consequences:
					'Recovered badges use synthesized component label -1 and must retain that provenance.',
				limits:
					'Full assignment moved from 57/63 to 60/68, so badge recovery did not solve ownership.'
			},
			{
				commit: '4597b748b908981be8b91dacc44a1bd0278e6409',
				change: 'Added LAB replay of baseline endpoint evidence.',
				why: 'Detector testimony needed reproducible artifacts rather than final answers only.',
				evidence: 'The commit establishes replay provenance.',
				consequences: 'Badge evidence can be compared across runs.',
				limits: 'It predates the proposed progressive gate catalog and is not itself a gate.'
			}
		]
	},
	{
		id: 2,
		title: 'Baskets',
		detectors: ['D03-basket-sprite'],
		description:
			'Match the fixed basket sprite and convert each match to the semantic pole-tip endpoint. Measurement and scoring live together here; ownership by hole remains deliberately unknown.',
		rawEvidence: {
			producers: ['src/lib/nuthing/endpoints.ts: matchBasketSprites'],
			measurements: [
				'sprite candidate location and claimed template pixels',
				'matched-filter score',
				'onFrac and offFrac',
				'fixed sprite-to-pole-tip transform and resulting endpoint'
			],
			images: [
				'course candidate overlay',
				'sprite neighborhood crop',
				'nearest-neighbor template/evidence crop'
			],
			provenance: commonProvenance
		},
		interpretation: {
			matters: [
				'Candidate recall for real basket sprites',
				'Whether the matched pixels support sprite identity rather than a generic bright blob',
				'Whether the semantic pole tip is derived by the recorded fixed transform'
			],
			doNotInfer: [
				'Basket sprite identity does not establish basket ownership',
				'The sprite center is not the basket endpoint',
				'A high score does not distinguish two genuine neighboring baskets'
			],
			failureModes: [
				'partial occlusion lowers visible template support',
				'shifted echoes create duplicate candidates',
				'overlapping genuine sprites are incorrectly deduplicated',
				'onFrac/offFrac is dropped during handoff and only the persuasive final score survives'
			],
			nextDecision: 'Is the basket candidate inventory complete enough to proceed to tee detection?'
		},
		history: {
			reproduced: [
				'The dev renderer used one fixed 42x66 basket bitmap; 60/66 clean detections were byte-identical in the original study.',
				'Occlusion-tolerant matched filtering plus matching-pursuit deduplication reached 72/72 dev basket recall.'
			],
			rejected: ['Treating solid white support or sprite-center position as the basket endpoint.'],
			open: [
				'Preserve onFrac, offFrac, candidate suppression, and pole-tip provenance through the browser ledger.'
			]
		},
		changelog: [
			{
				commit: 'b30c1bace119f075bce72984d05ebdf879c00dcc',
				change: 'Introduced fixed-sprite matched filtering and matching-pursuit deduplication.',
				why: 'Generic component identity was weaker than renderer identity and failed under occlusion.',
				evidence: 'The commit reports 72/72 basket recall on the four-course dev set.',
				consequences:
					'The detector yields useful object-localization testimony before ownership exists.',
				limits:
					'Recall was measured on the dev renderer/corpus; ownership was not measured by this detector.'
			}
		]
	},
	{
		id: 3,
		title: 'Tees',
		detectors: ['D04-tee-candidates'],
		description:
			'Detect visible tee-pad glyphs from enclosed rings and component-family evidence. Preserve the measured component geometry because orientation and shape can later separate a real pad from nearby furniture; do not assign holes here.',
		rawEvidence: {
			producers: [
				'src/lib/nuthing/endpoints.ts: detectTeeRings + collectTeePoints',
				'src/lib/nuthing/components.ts: ComponentStats'
			],
			measurements: [
				'tier/provenance: ring, component, or later recovery',
				'center, bbox, area, fill, major axis, minor axis, and PCA angle',
				'enclosed-hole elongation, ring fraction, enclosed area, and actual onRing evidence',
				'deduplication/suppression relationship to nearby candidates'
			],
			images: [
				'course candidate overlay by tier',
				'tee neighborhood crop',
				'nearest-neighbor raw bright-mask/ring evidence'
			],
			provenance: commonProvenance
		},
		interpretation: {
			matters: [
				'Whether every visible tee glyph has a measured candidate',
				'Whether orientation and full component geometry survive collection and handoff',
				'Whether the candidate is ring evidence, weaker component evidence, or a later recovery'
			],
			doNotInfer: [
				'Tee-like glyph identity does not establish tee ownership',
				'Component-tier evidence is weaker, not automatically false',
				'Tier must never be used to fabricate actual onRing or geometry measurements'
			],
			failureModes: [
				'tee border opens into a putting-circle or other large bright component',
				'occlusion leaves only a fragment',
				'fill changes with pad size and rotation because a hollow border occupies less of its bounding box',
				'collectTeePoints or the browser adapter discards measured angle/bbox/ring evidence'
			],
			nextDecision:
				'Is the visible tee inventory complete, with honest provenance, or must endpoint recovery run?'
		},
		history: {
			reproduced: [
				'Hollow-ring detection plus component-family fallback reached 69/72 dev tee recall before dedicated recovery.',
				'On The Rec, four real pads failed only the component fill floor because size and rotation changed hollow-border fill.'
			],
			rejected: [
				'Using a component fill floor of 0.20 as if hollow-border fill were scale- and rotation-invariant.',
				'Reconstructing onRing from the candidate tier.'
			],
			open: [
				'The current progressive handoff throws away PCA orientation and other ComponentStats; repairing that seam remains unfinished.'
			]
		},
		changelog: [
			{
				commit: 'b30c1bace119f075bce72984d05ebdf879c00dcc',
				change: 'Added hollow-ring detection and a component-family fallback.',
				why: 'Tee pads are renderer-specific hollow glyphs, and some outlines open into C2 furniture.',
				evidence:
					'The commit reports 69/72 dev tee recall; three Heritage tees remained fused into large furniture blobs.',
				consequences: 'Tier provenance became essential evidence.',
				limits: 'The fallback did not solve heavy occlusion.'
			},
			{
				commit: '209f5100708df9f93f3612f7026e4a8735cffd31',
				change:
					'Lowered the tee-family fill floor from 0.20 to 0.12 after a measured Rec failure analysis.',
				why: 'Four large/rotated Rec pads measured fill 0.13 to 0.199 and failed only that gate.',
				evidence:
					'The Rec changed to 9/9 assigned; Dev72 endpoint recall and assignment stayed 72/72, while rank-1 changed 65 to 64.',
				consequences:
					'Fill must be interpreted with scale/rotation geometry, not as a universal confidence.',
				limits: 'Transfer beyond the measured Rec and Dev72 images is unvalidated.'
			}
		]
	},
	{
		id: 4,
		title: 'Endpoint Recovery',
		detectors: ['D05-occluded-tee-recovery'],
		description:
			'Recover endpoint objects that the ordinary basket or tee detectors could not measure because of occlusion, fusion, or fragmentation. A recovery may be deterministic or manual, but its provenance must remain explicit and unresolved endpoints must stay unresolved.',
		rawEvidence: {
			producers: [
				'scripts/cv-probes/occluded_tee_recovery.py (historical measurement probe)',
				'resources/nuthing-p2/endpoints/recovered-tees.json (historical resource; not blind-safe)',
				'manual recovery producer: NOT IMPLEMENTED on this branch'
			],
			measurements: [
				'missing object type and hole hypothesis, if any',
				'occluder identity/bounds and visible fragment geometry',
				'recovery transform, score components, alternatives, and abstention reason',
				'provenance: detected, deterministic recovery, or manual Oracle-localized'
			],
			images: [
				'course missing-endpoint locator',
				'occluder/fragment neighborhood',
				'nearest-neighbor masked-fit or manual-mark evidence'
			],
			provenance: [
				...commonProvenance,
				'whether any resource or measurement was derived from historical truth'
			]
		},
		interpretation: {
			matters: [
				'Whether a specific missing physical endpoint can be localized with inspectable evidence',
				'Whether the recovery is truth-independent and therefore legal during a blind pass',
				'Whether alternatives or remaining uncertainty should block assignment'
			],
			doNotInfer: [
				'A recovered object does not establish ownership unless an Oracle explicitly supplies it',
				'A stored coordinate is not blind evidence when its producer used historical truth',
				'Recovery score is not interchangeable with ordinary detector score'
			],
			failureModes: [
				'grid search fits corridor paint or putting-circle arcs',
				'wrong occluder bounds leave white frame pixels that imitate a tee border',
				'a tiny visible sliver does not constrain center/orientation enough',
				'GT-derived recovered resources leak into a supposedly blind run'
			],
			nextDecision:
				'Is the endpoint inventory complete enough for straight testing, or must the run stop for focused manual review?'
		},
		history: {
			reproduced: [
				'Fragment-anchored masked tee-border fitting recovered two Heritage tees at 4.8 px and 6.9 px while leaving the 3x7 px sliver unresolved.',
				'Merging historical recovered coordinates into the pool enabled all 72 dev holes to be judged.'
			],
			rejected: [
				'Unanchored grid sweeps over the whole neighborhood.',
				'Using recovered-tees.json as blind instrumentation.'
			],
			open: [
				'A quick app-side manual recovery seam before association is desired but not implemented here.',
				'A truth-independent ribbon-termination recovery for fully hidden pads remains an experiment, not an established detector.'
			]
		},
		changelog: [
			{
				commit: '57d6ac4660f0eb8b5208d308cfcc767ab420af37',
				change: 'Added fragment-anchored, occluder-masked tee-border fitting.',
				why: 'Three Heritage tees were fused into large white map-furniture blobs.',
				evidence:
					'Recovered H10 at 4.8 px and H5 at 6.9 px; H6 remained unresolved; two dev false positives remained.',
				consequences:
					'Focused occlusion evidence is useful, while missing evidence remains legitimate.',
				limits: 'This was a probe, not a general blind recovery stage.'
			},
			{
				commit: '4abdc42d7783c163a39363b1fbeed27bcc7c3a32',
				change: 'Loaded recovered tee coordinates as tier recovered with a 0.7 assignment prior.',
				why: 'The experiment needed complete endpoint availability to measure assignment.',
				evidence:
					'Endpoint availability became 18/18/18 on all four dev courses and assignment reached 65/72.',
				consequences:
					'Recovered-tier provenance and its different scoring behavior became observable.',
				limits:
					'The resource contains historical coordinates and is forbidden in fresh-course blind work.'
			}
		]
	},
	{
		id: 5,
		title: 'Straight Test',
		detectors: ['D06-ribbon-support', 'D07-straight-ray'],
		description:
			'Test whether a candidate tee-badge-basket triple is supported as a straight hole using measured geometry and ribbon evidence. This stage may confirm high-confidence straight structure or abstain; it must not force a bent route into a line.',
		rawEvidence: {
			producers: [
				'scripts/nuthing/straight-hole-test.ts (historical analysis)',
				'scripts/nuthing/pair-matrix-replay.ts: collinearity scoring'
			],
			measurements: [
				'tee-to-badge versus tee-to-basket angle',
				'badge fraction along the tee-to-basket chord',
				'corridor support and off-chord mass along the line',
				'endpoint provenance and all competing straight triples'
			],
			images: [
				'course straight-candidate overlay',
				'hole ribbon neighborhood',
				'tight chord-support/off-chord evidence view'
			],
			provenance: commonProvenance
		},
		interpretation: {
			matters: [
				'Whether the three measured points are nearly collinear and ordered tee to badge to basket',
				'Whether the ribbon supports that chord rather than a nearby walking path or basket zone',
				'Whether a straight conclusion is robust against competing endpoint choices'
			],
			doNotInfer: [
				'Failure of the straight test does not prove the hole is bent',
				'Collinearity alone does not prove ownership in parallel clusters',
				'Dev straight-hole angle ranges are measured precedent, not a renderer law'
			],
			failureModes: [
				'walking paths or neighboring fairways supply stronger line support',
				'basket zones distort terminal ribbon evidence',
				'a false triple in a parallel cluster is also nearly collinear',
				'uncertain/recovered endpoints make precise angle evidence persuasive-looking but unstable'
			],
			nextDecision:
				'Which holes are safely locked as straight, and which must remain for global assignment or bend refinement?'
		},
		history: {
			reproduced: [
				'Across 41 historical dev straight holes, tee-to-badge versus tee-to-basket angle measured median 0.5 degrees, P90 0.9, max 1.4.',
				'Nine of 41 straight routes violated simple chord adherence because of walking paths or basket-zone pixels.',
				'A bounded collinearity bonus helped resolve Lenard cluster thefts in the historical Dev72 replay.'
			],
			rejected: [
				'Treating chord adherence or a straightness bonus as sufficient by itself.',
				'Unrestricted agreement-bearing bonuses; they reduced rank-1 and assignment quality.'
			],
			open: [
				'Define the smallest truth-blind straight-test output that transfers beyond the four dev courses without importing bend truth.'
			]
		},
		changelog: [
			{
				commit: 'd316cf3727278e607893fde4220e6ccbef448297',
				change: 'Measured straight-hole ray geometry and attributed off-chord distractors.',
				why: 'Residual wrong assignments needed a discriminating measurement.',
				evidence:
					'41 straight holes measured max 1.4 degrees; walking paths and basket zones explained all nine chord violations.',
				consequences: 'Straight geometry became useful evidence with explicit distractor caveats.',
				limits:
					'The analysis selected straight holes using historical bend truth and cannot itself classify an unseen course.'
			},
			{
				commit: '6d7f0fe1b2b9cdd4d4c23531449d6a1cc134676c',
				change: 'Added a bounded perfect-line bonus and recentered the badge-position prior.',
				why: 'Lenard parallel-cluster thefts and Heritage H7 were not resolved by the prior score family.',
				evidence:
					'Historical Dev72 assignment reached 72/72; badge-fraction recentering alone reached 72/72 in ablation.',
				consequences: 'Straight evidence can assist assignment without becoming a hard rule.',
				limits: 'The settings were swept on Dev72 and are not a validated universal threshold.'
			}
		]
	},
	{
		id: 6,
		title: 'Assignment',
		detectors: [
			'D02-badge-reader',
			'D03-basket-sprite',
			'D04-tee-candidates',
			'D05-occluded-tee-recovery',
			'D06-ribbon-support',
			'D07-straight-ray',
			'D08-pair-matrix',
			'D09-global-assignment',
			'D10-zfit-pair-rescue'
		],
		description:
			'Assign measured tee and basket candidates to numbered badges using route evidence, scores, and course-wide one-to-one constraints. This is where object identity becomes ownership, so competing hypotheses and theft chains must remain visible.',
		rawEvidence: {
			producers: [
				'scripts/nuthing/pair-matrix.ts: pair measurements',
				'scripts/nuthing/pair-matrix-replay.ts: scoring + global assignment'
			],
			measurements: [
				'complete tee x basket candidate matrix per badge',
				'raw and transformed score components for each pair',
				'candidate ranks before global uniqueness',
				'final one-to-one assignment, swaps, unresolved rows, and theft-chain explanation'
			],
			images: [
				'course assignment overlay',
				'focused competing-route view',
				'tight evidence view for the score component that changed ownership'
			],
			provenance: commonProvenance
		},
		interpretation: {
			matters: [
				'Whether every ownership decision is supported by the same preserved measurements the solver consumed',
				'Whether one-to-one uniqueness resolves a local ambiguity or merely moves the error to another hole',
				'Whether unresolved endpoint inventory makes a complete permutation impossible'
			],
			doNotInfer: [
				'Raw detector recall is not ownership accuracy',
				'Rank 1 is not required when global uniqueness correctly resolves a conflict',
				'72/72 on four development courses does not validate every scoring feature or future course'
			],
			failureModes: [
				'parallel fairways create near-tied neighboring pairs',
				'one persuasive false pair causes a course-wide theft chain',
				'missing endpoints force a false complete assignment',
				'score summaries hide which raw measurement caused the choice'
			],
			nextDecision:
				'Are endpoint ownerships sufficiently supported to lock them, or which small ambiguity set needs Oracle review?'
		},
		history: {
			reproduced: [
				'Greedy plus two-swap one-to-one assignment improved historical replay from local ranks but could cascade errors in parallel Lenard fairways.',
				'At the Dev72 reference, rank 1 was 65/72 while assigned ownership was 72/72; five of seven non-rank-1 rows were same-tee/wrong-basket rivalries resolved structurally.',
				'Attempts to tune every true pair to rank 1 were measured harmful or inert.'
			],
			rejected: [
				'Using rank-1 count as the sole health metric.',
				'Assuming global uniqueness can compensate for missing endpoint evidence.',
				'Unrestricted agreement-bearing tuning.'
			],
			open: [
				'Rival-conditioned evidence is the measured next direction if rank-1 quality matters; it is not yet an established feature.'
			]
		},
		changelog: [
			{
				commit: '9d5ca483c1615ad15e9853db60a080fe71e37717',
				change: 'Added simple-path discipline and global one-to-one assignment.',
				why: 'False pairs rode another hole ribbon and local choices reused endpoints.',
				evidence:
					'Rank-1 rose 35 to 40/61; global assignment reached 42/61 and exposed Lenard cascades.',
				consequences:
					'Ownership became a course-level decision rather than independent per-hole argmax.',
				limits: 'Greedy plus two-swap is not proof of globally correct ownership.'
			},
			{
				commit: '6d7f0fe1b2b9cdd4d4c23531449d6a1cc134676c',
				change:
					'Combined bounded straight evidence, salvage-only Z-fit, and a measured badge-position band.',
				why: 'Seven residual Dev72 ownership errors remained after endpoint recovery.',
				evidence: 'Assigned exact 72/72, rank 1 65/72, rank <=3 71/72 on perfect endpoint recall.',
				consequences: 'This is the historical Dev72 reference state.',
				limits:
					'It is a development-set reproduction, not validation and not evidence that every included feature transfers.'
			},
			{
				commit: '57962815b24f80f010a4c9c737f40269b16257e2',
				change:
					'Measured whether the seven non-rank-1 rows could be tuned to rank 1 and rejected that goal for the current score family.',
				why: 'Rank-1 lagged assignment despite exact ownership.',
				evidence:
					'Unrestricted agreement-bearing changed rank 1 from 65 to 64; straight-gating dropped assignment to 63-67; Z-fit was inert.',
				consequences: 'The catalog must report rank and assignment separately.',
				limits: 'This negative result is specific to the tested score family and Dev72 evidence.'
			}
		]
	},
	{
		id: 7,
		title: 'Bend Refinement',
		detectors: [
			'D06-ribbon-support',
			'D10-zfit-pair-rescue',
			'D11-basket-backwalk',
			'D12-capsule-bends'
		],
		description:
			'Refine the corridor geometry only after tee and basket ownership is established. Straight holes pass through without invented vertices; bent holes retain inner/outer-corner evidence, uncertainty, and any Oracle contribution.',
		rawEvidence: {
			producers: [
				'scripts/nuthing/pair-matrix-replay.ts: historical Z-fit pair rescue',
				'scripts/nuthing/basket-backwalk.ts: historical basket-approach probe',
				'src/lib/autoAnnotation/corridorBendDetectionCapsule.ts: live capsule bend proposals'
			],
			measurements: [
				'assigned tee, badge, and basket endpoints',
				'candidate bend vertices and their crop-local coordinates',
				'ribbon support by segment/window and corridor width',
				'inner/outer rail or miter evidence, endpoint-cap evidence, alternatives, and uncertainty'
			],
			images: [
				'course bent-hole locator',
				'whole-hole corridor crop',
				'nearest-neighbor inner/outer-corner and termination evidence'
			],
			provenance: [
				...commonProvenance,
				'whether each vertex is measured, inferred, historical-reference, or Oracle-established'
			]
		},
		interpretation: {
			matters: [
				'Whether the assigned corridor requires zero, one, or more bends',
				'Whether proposed vertices explain both visible corridor rails rather than only a bright centerline',
				'Whether uncertainty reflects occlusion, weak contrast, or competing geometry'
			],
			doNotInfer: [
				'A polyline that improves assignment score is not automatically the annotation geometry',
				'Basket backward-walk confidence is not reliable approach-bearing confidence',
				'Miter and semicircular-cap behavior measured on AlexClark are transfer hypotheses, not universal renderer laws'
			],
			failureModes: [
				'walking paths and neighboring ribbons dominate local edge evidence',
				'basket-zone fills cancel or reverse terminal direction evidence',
				'an attractive centerline fit places visually wrong inner/outer corners',
				'ground-truth-derived bend labels leak into an unseen-course measurement'
			],
			nextDecision:
				'Is each assigned hole faithfully represented as straight or with evidence-supported bend vertices, or does it require Oracle review?'
		},
		history: {
			reproduced: [
				'Salvage-only Z-fit recovered Heritage H7 assignment evidence, but unconditional use let false pairs shop for two-bend bridges.',
				'Basket backward-walk was only 43/72 within 15 degrees and had 22 catastrophic 130-175 degree errors; confidence did not separate failures.',
				'Rotated-flank terminal profiles provided useful candidate-conditioned features but standalone argmax stayed at parity and remained unwired.',
				'AlexClark pixel review supported mitered bend joins and semicircular route termination, while simple rail-line fitting produced visibly wrong geometry.'
			],
			rejected: [
				'Confidence-weighted basket backward-walk as a standalone direction oracle.',
				'Unconditional Z-fit rescue.',
				'Independent straight-line rail fitting that ignores the renderer construction.'
			],
			open: [
				'The live capsule detector returns centerline bend vertices, not separately measured inner and outer miter corners.',
				'Alex renderer observations must be reproduced on another course before being promoted beyond experimental precedent.'
			]
		},
		changelog: [
			{
				commit: 'f2e6b7f364a5c7f2b23fbb3722dd4a65e3b47ea5',
				change: 'Added a measurement-only basket backward-walk probe.',
				why: 'Approach bearing could discriminate competing baskets on bent holes.',
				evidence:
					'43/72 were within 15 degrees; 22/72 were catastrophically reversed; confidence was anti-correlated on six wrong-assignment holes.',
				consequences: 'Standalone confidence-weighted integration was rejected.',
				limits: 'The probe measures terminal direction, not full bend geometry.'
			},
			{
				commit: '66b86ac9060dad7c8210d7d32dc9c63600b2afac',
				change: 'Added semicircle-aware angular peaks and raw radial profiles.',
				why: 'Basket-zone and neighboring-render traps needed inspectable terminal evidence.',
				evidence:
					'Rotated flanks exposed a near-field signature and flipped two historical cases, while standalone argmax stayed at parity.',
				consequences: 'Raw profiles are useful future candidate-conditioned evidence.',
				limits: 'The argmax remained unwired; no general bend refiner was established.'
			},
			{
				commit: '6d7f0fe1b2b9cdd4d4c23531449d6a1cc134676c',
				change: 'Restricted Z-fit to salvage when routed evidence was weak.',
				why: 'Unconditional fits created false two-bend bridges.',
				evidence:
					'The bounded fit recovered Heritage H7 near its historical bend coordinates as part of the 72/72 assignment replay.',
				consequences:
					'Model-based bend evidence can rescue a pair without becoming a general route annotation.',
				limits:
					'Z-fit was optimized for pair scoring and does not define precise inner/outer bend corners.'
			}
		]
	}
] as const;

if (LAB_GATES.length !== 8 || LAB_GATES.some((gate, index) => gate.id !== index)) {
	throw new Error('LAB gate catalog must contain contiguous gates 0..7');
}

const detectorById = new Map(DETECTOR_CARDS.map((detector) => [detector.id, detector]));
for (const gate of LAB_GATES) {
	for (const detectorId of gate.detectors) {
		const detector = detectorById.get(detectorId);
		if (!detector) throw new Error(`Gate ${gate.id} names unknown detector ${detectorId}`);
		if (!detector.gates.includes(gate.id)) {
			throw new Error(`${detectorId} does not name gate ${gate.id}`);
		}
	}
}
for (const detector of DETECTOR_CARDS) {
	for (const gateId of detector.gates) {
		if (!LAB_GATES[gateId].detectors.includes(detector.id)) {
			throw new Error(`Gate ${gateId} does not name ${detector.id}`);
		}
	}
}

function printGate(gate: LabGate): void {
	console.log(`GATE ${gate.id} — ${gate.title}\n${gate.description}`);
	console.log(`\nDETECTORS\n${gate.detectors.map((id) => `  - ${id}`).join('\n')}`);
	console.log('\nRAW EVIDENCE STORE');
	for (const [label, values] of Object.entries(gate.rawEvidence)) {
		console.log(`${label}:`);
		for (const value of values) console.log(`  - ${value}`);
	}
	console.log('\nGATE INTERPRETATION CARD');
	for (const [label, values] of [
		['what matters', gate.interpretation.matters],
		['what not to infer', gate.interpretation.doNotInfer],
		['known failure modes', gate.interpretation.failureModes]
	] as const) {
		console.log(`${label}:`);
		for (const value of values) console.log(`  - ${value}`);
	}
	console.log(`next decision:\n  ${gate.interpretation.nextDecision}`);
	console.log('\nALGORITHM HISTORY');
	for (const [label, values] of Object.entries(gate.history)) {
		console.log(`${label}:`);
		for (const value of values) console.log(`  - ${value}`);
	}
	console.log('\nCHANGELOG');
	for (const item of gate.changelog) {
		console.log(`- ${item.commit} — ${item.change}`);
		console.log(`  why: ${item.why}`);
		console.log(`  evidence: ${item.evidence}`);
		console.log(`  consequences: ${item.consequences}`);
		console.log(`  limits: ${item.limits}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const requested = process.argv[2];
	if (requested === undefined) {
		for (const gate of LAB_GATES) console.log(`${gate.id}: ${gate.title} — ${gate.description}`);
	} else {
		const gate = LAB_GATES.find(({ id }) => String(id) === requested);
		if (!gate) throw new Error(`Unknown LAB gate ${requested}; expected 0..7`);
		printGate(gate);
	}
}
