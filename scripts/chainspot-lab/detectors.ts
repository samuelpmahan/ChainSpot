import { pathToFileURL } from 'node:url';

export type DetectorStatus = 'live-product' | 'active-lab' | 'historical-probe' | 'missing-seam';

export type DetectorCard = {
	id: string;
	title: string;
	status: DetectorStatus;
	gates: readonly number[];
	purpose: string;
	implementation: readonly string[];
	input: readonly string[];
	rawEvidence: {
		measurements: readonly string[];
		images: readonly string[];
		provenance: readonly string[];
	};
	scoring: readonly string[];
	outputMeaning: readonly string[];
	doNotInfer: readonly string[];
	failureModes: readonly string[];
	handoffLosses: readonly string[];
	history: {
		reproduced: readonly string[];
		rejected: readonly string[];
		open: readonly string[];
	};
	changelog: readonly {
		commit: string;
		availability: 'current-head' | 'other-ref';
		change: string;
		why: string;
		evidence: string;
		consequences: string;
		limit: string;
	}[];
};

const canonicalProvenance = [
	'run ID and UTC timestamp',
	'code commit and dirty-worktree status',
	'input SHA-256 and canonical-raster SHA-256',
	'course, crop-local raster dimensions, and detector parameters'
] as const;

export const DETECTOR_CARDS: readonly DetectorCard[] = [
	{
		id: 'D00-map-viewport-crop',
		title: 'Map Viewport Crop',
		status: 'active-lab',
		gates: [0],
		purpose: 'Remove screenshot chrome and establish the canonical crop-local raster consumed by every NuThing measurement.',
		implementation: ['src/lib/nuthing/viewport.ts', 'src/lib/stitch/autoCrop.ts: proposeSingleImageCrop'],
		input: ['One decoded source screenshot in source-image pixels'],
		rawEvidence: {
			measurements: ['production crop proposal', 'top inclusive row', 'bottom exclusive row', 'canonical width and height'],
			images: ['source screenshot', 'crop-boundary overlay', 'clean canonical raster'],
			provenance: canonicalProvenance
		},
		scoring: [
			'Converts the raster to native-resolution grayscale and delegates boundary inference to the production entropy-band crop proposal.',
			'No proposal means keep the full image; cropRows then copies the full width between top and bottom.'
		],
		outputMeaning: ['The returned raster is the only downstream coordinate frame.', 'The source-row transform remains provenance only.'],
		doNotInfer: ['A plausible crop does not prove the course content is complete.', 'No crop does not necessarily mean crop detection failed; the source may already be chromeless.'],
		failureModes: ['Chrome resembles map texture.', 'Map edge has stronger entropy change than the real chrome boundary.', 'Only vertical rows are cropped in the NuThing adapter.'],
		handoffLosses: ['detectMapViewport retains only top/bottom; proposal confidence, diagnostics, and any left/right inset are discarded.'],
		history: {
			reproduced: ['Chrome strongly pollutes bright components and ribbon-field normalization.', 'Production crop and NuThing crop share one proposal implementation.'],
			rejected: ['Maintaining a second full-screenshot annotation frame.'],
			open: ['Persist the complete production proposal and focused crop evidence in each LAB run.']
		},
		changelog: [
			{
				commit: '4a33dadc618fc9b1ded76c07e84217824bac29a4',
				availability: 'current-head',
				change: 'Moved crop-boundary measurement to native resolution.',
				why: 'Downsampled analysis shifted the measured boundary.',
				evidence: 'Commit records the correction for downsample-shifted boundaries.',
				consequences: 'Crop-local coordinates no longer inherit scale-rounding drift.',
				limit: 'Does not validate stitch geometry or content retention.'
			},
			{
				commit: '2f38e2e440050d2fb7e314f21b83d1e9420d1c61',
				availability: 'current-head',
				change: 'Reused production auto-crop in NuThing.',
				why: 'LAB measurements needed the same canonical raster as production intake.',
				evidence: 'Pool recall stayed 69/69 while assignment was known-bad at 21/66, separating crop from later stages.',
				consequences: 'Crop behavior can be evaluated independently of endpoint ownership.',
				limit: 'The commit is not an assignment baseline.'
			}
		]
	},
	{
		id: 'D01-stitch-pipeline',
		title: 'Stitch Alignment Pipeline',
		status: 'live-product',
		gates: [0],
		purpose: 'Crop and align multiple captures, then flatten them into one canonical raster while preserving each source transform.',
		implementation: [
			'src/lib/stitch/stitchPipeline.ts',
			'src/lib/stitch/semanticLandmarks.ts',
			'src/lib/stitch/cvMatch.ts',
			'src/lib/stitch/poseGraph.ts',
			'src/lib/stitch/renderComposite.ts'
		],
		input: ['One or more decoded captures plus source IDs'],
		rawEvidence: {
			measurements: ['per-source crop', 'semantic landmark candidates', 'local pixel-match evidence', 'pair transforms', 'pose graph', 'review/auto disposition'],
			images: ['cropped tiles', 'pair overlap evidence', 'source-boundary overlay', 'flattened composite'],
			provenance: canonicalProvenance
		},
		scoring: [
			'Semantic landmarks propose alignment; local pixel verification checks it.',
			'Semantic disagreement or weak placement can fall back to global OpenCV matching and force review rather than silent acceptance.'
		],
		outputMeaning: ['One flattened raster plus exact source-to-output transforms.', 'Review means the pipeline produced a hypothesis that needs visual confirmation.'],
		doNotInfer: ['A seamless-looking overlap is not necessarily geometrically correct.', 'An auto disposition is not Oracle approval.'],
		failureModes: ['Low-texture or repetitive overlap.', 'Correct local matches arranged into a globally inconsistent pose.', 'Semantic landmarks and pixels disagree.', 'OpenCV initialization or memory cost delays fallback.'],
		handoffLosses: ['The present LAB catalog is not yet wired to ingest the stitch pipeline performance report and pair diagnostics.'],
		history: {
			reproduced: ['The pipeline supports N sources and records a flattened output frame.', 'Semantic proposals are verified against pixels with explicit disagreement handling.'],
			rejected: ['Treating semantic landmark agreement as the final stitch answer.'],
			open: ['Decide which pair diagnostics are minimal but sufficient for fresh agents at Gate 0.']
		},
		changelog: [
			{
				commit: '871b591729174767c080b238a004538e63626216',
				availability: 'current-head',
				change: 'Generalized stitching to N tiles.',
				why: 'A course may require more than two overlapping captures.',
				evidence: 'One pipeline now owns multi-source placement and flattening.',
				consequences: 'Every source transform must survive into canonical-raster provenance.',
				limit: 'Capability does not prove a particular composite.'
			},
			{
				commit: '01d0daf2c91e33cfee321d37c7cadca8d04167e0',
				availability: 'current-head',
				change: 'Integrated the semantic stitch front end.',
				why: 'Landmark proposals needed pixel verification and a fallback when they disagreed.',
				evidence: 'Semantic proposals gained local verification and global fallback paths.',
				consequences: 'A stitch can preserve disagreement and request review instead of silently choosing.',
				limit: 'OpenCV remains a fallback dependency for unresolved alignment.'
			}
		]
	},
	{
		id: 'D02-badge-reader',
		title: 'Badge Plate and Digit Reader',
		status: 'active-lab',
		gates: [1, 6],
		purpose: 'Localize number-badge plates and decode their digit identities while retaining the evidence behind each digit choice.',
		implementation: ['src/lib/nuthing/badgeStage.ts: runBadgeStage', 'src/lib/nuthing/digits/readBadges.ts: readCourseBadges'],
		input: ['Canonical RGBA raster', 'Injected digit scorer/model'],
		rawEvidence: {
			measurements: ['bright/dark masks', 'component and plate geometry', 'normal or recovered plate tier', 'glyph masks', 'digit segments', 'all class scores and margins'],
			images: ['course plate candidates', 'plate crop', 'glyph mask', 'normalized per-digit mask'],
			provenance: canonicalProvenance
		},
		scoring: [
			'Normal plates must match the bright family geometry and dark-interior fraction.',
			'Dark-plate recovery uses bbox, aspect, fill, and glyph-fraction gates.',
			'Each segmented digit is scored independently; badge confidence is the minimum winning margin.'
		],
		outputMeaning: ['A BadgeReading is a measured plate, glyph segmentation, label hypothesis, alternatives, and localization.', 'Recovered plates have synthesized label -1 geometry.'],
		doNotInfer: ['The top digit label is not Oracle truth.', 'Badge identity does not establish tee or basket ownership.', 'Confidence Infinity with no digits is not high confidence; it is an empty segmentation artifact.'],
		failureModes: ['White frame merged with basket/map furniture.', 'Large bright component intrudes into a recovered plate.', 'Digit segmentation splits or joins glyphs.', 'Duplicate physical candidates decode to the same number.'],
		handoffLosses: ['The producer preserves alternatives, but downstream caches commonly retain only the chosen label and badge center.'],
		history: {
			reproduced: ['The reader preserves masks, scores, runner-up classes, and margins.', 'Dark-plate recovery changed dev badge recall from 66/72 to 72/72.'],
			rejected: ['Assuming every badge survives as a normal bright-frame component.'],
			open: ['Carry digit alternatives and real plate geometry into the progressive ledger.']
		},
		changelog: [
			{
				commit: '22c89d3347c807434707fa2b458f5e7fdc72b5a4',
				availability: 'current-head',
				change: 'Added browser-portable badge reading with retained per-digit evidence.',
				why: 'A final decoded label hid the ambiguity needed for diagnosis and replay.',
				evidence: 'Masks, scores, runner-up labels, and margins are first-class outputs.',
				consequences: 'Badge plate detection can be separated from digit interpretation.',
				limit: 'Did not address frame/sprite occlusion.'
			},
			{
				commit: '3c270b1b819c3f183c30474c0fa2fbb20b71bfa2',
				availability: 'current-head',
				change: 'Added dark-plate recovery and large-component exclusion.',
				why: 'Sprite-merged frames removed real badges and created phantom glyphs.',
				evidence: 'Dev badges improved 66/72 to 72/72; full assignment improved coverage but remained imperfect.',
				consequences: 'Recovered plates need explicit provenance and synthesized geometry.',
				limit: 'Recovered ComponentStats are synthesized and must not masquerade as ordinary components.'
			}
		]
	},
	{
		id: 'D03-basket-sprite',
		title: 'Basket Sprite Matcher',
		status: 'active-lab',
		gates: [2, 6],
		purpose: 'Find the renderer basket sprite and localize the semantic pole-tip endpoint independently of hole ownership.',
		implementation: ['src/lib/nuthing/endpoints.ts: prepareSpriteTemplate + matchBasketSprites'],
		input: ['Canonical bright mask', 'resources/nuthing-p2/endpoints/basket-sprite.json'],
		rawEvidence: {
			measurements: ['sprite bbox and center', 'onFrac', 'offFrac', 'score', 'claimed template pixels', 'fixed tip transform'],
			images: ['all course matches', 'tight sprite crop', 'template-on/template-off evidence'],
			provenance: canonicalProvenance
		},
		scoring: [
			'score = onFrac - offFrac; solid white blobs therefore score near zero.',
			'Coarse candidates are refined at stride 1, then matching-pursuit deduplication erases explained pixels and rescans echoes.'
		],
		outputMeaning: ['A SpriteMatch testifies that a basket-like fixed bitmap exists at a location.', 'tipX/tipY is the sprite bbox pole-tip transform, not its center.'],
		doNotInfer: ['A real basket candidate does not identify its hole.', 'A higher score cannot choose between two genuine baskets.', 'The fixed transform is renderer-specific, not learned per image.'],
		failureModes: ['Severe occlusion.', 'Template drift from renderer/version/scale.', 'One real overlapping sprite is erased as an echo.', 'Structured furniture partially matches both on and off masks.'],
		handoffLosses: ['pair-matrix.ts keeps tip, center, and score but drops onFrac/offFrac and suppression provenance.'],
		history: {
			reproduced: ['The original dev study found one fixed 42x66 bitmap; 60/66 clean instances were byte-identical.', 'Matched filtering reached 72/72 dev candidate recall.'],
			rejected: ['Generic bright-component family matching.', 'Using sprite center as the basket endpoint.'],
			open: ['Preserve onFrac/offFrac and deduplication testimony through every consumer.']
		},
		changelog: [
			{
				commit: 'b30c1bace119f075bce72984d05ebdf879c00dcc',
				availability: 'current-head',
				change: 'Introduced render-identity matched filtering and matching-pursuit deduplication.',
				why: 'Generic bright-component geometry was weaker than the fixed rendered basket sprite.',
				evidence: 'Reported 72/72 dev basket recall, including occluded sprites.',
				consequences: 'Basket identity and pole-tip localization become measurable before ownership.',
				limit: 'Candidate recall is not ownership accuracy or validation.'
			}
		]
	},
	{
		id: 'D04-tee-candidates',
		title: 'Tee Ring and Component Candidate Detector',
		status: 'active-lab',
		gates: [3, 6],
		purpose: 'Find visible hollow tee-pad glyphs using strong enclosed-ring evidence plus a weaker component-family fallback.',
		implementation: ['src/lib/nuthing/endpoints.ts: detectTeeRings + collectTeePoints', 'src/lib/nuthing/components.ts: ComponentStats'],
		input: ['Canonical bright mask', 'Bright components after badge exclusions', 'Basket sprite centers for exclusion'],
		rawEvidence: {
			measurements: ['ring center and hole bbox', 'hole area', 'elongation', 'PCA angle', 'ringFrac', 'component bbox/area/fill/angle before collection', 'tier and suppression cause'],
			images: ['ring/component candidates by tier', 'tight glyph crop', 'raw-mask hole and ring band'],
			provenance: canonicalProvenance
		},
		scoring: [
			'Ring tier floods enclosed raw-dark holes behind dilated bright walls, then checks area, dimension, elongation, and raw ring fraction.',
			'Component tier gates min/max dimension, area, and fill, then excludes explained rings, diamonds, and basket neighborhoods.'
		],
		outputMeaning: ['Ring tier is stronger renderer-identity evidence and retains TeeRing.', 'Component tier is a plausible visible tee component whose ring could not be closed.'],
		doNotInfer: ['Component tier is not automatically false.', 'Tee identity is not ownership.', 'Tier is not a substitute for actual ring or component measurements.'],
		failureModes: ['Outline opens into putting-circle furniture.', 'Occlusion destroys both the hole and component family.', 'Square diamond markers resemble hollow glyphs.', 'Fill changes with pad scale and rotation.'],
		handoffLosses: [
			'collectTeePoints reduces component-tier candidates to center+tier and discards their bbox, area, fill, PCA axes, and angle.',
			'The current HEAD still uses component fill >=0.20; the measured 0.12 Rec repair exists only on another ref.',
			'pair-matrix derives C2 onRing from distance to basket endpoints; it is separate from TeeRing.ringFrac.'
		],
		history: {
			reproduced: ['Ring plus component fallback reached 69/72 dev recall before occlusion recovery.', 'The Rec exposed size/rotation coupling in the component fill threshold.'],
			rejected: ['Treating component fill >=0.20 as scale/rotation invariant.', 'Fabricating ring evidence from candidate tier.'],
			open: ['Port the complete component measurement through collectTeePoints before changing scoring.']
		},
		changelog: [
			{
				commit: 'b30c1bace119f075bce72984d05ebdf879c00dcc',
				availability: 'current-head',
				change: 'Added hollow-ring detection and component fallback.',
				why: 'Some tee outlines remain enclosed rings while others open into nearby bright furniture.',
				evidence: 'Reported 69/72 dev recall; three fused Heritage tees remained missing.',
				consequences: 'Candidate tier became necessary evidence for later interpretation.',
				limit: 'Component fallback output throws away useful geometry.'
			},
			{
				commit: '209f5100708df9f93f3612f7026e4a8735cffd31',
				availability: 'other-ref',
				change: 'Lowered component fill floor to 0.12 after measuring four Rec misses.',
				why: 'Larger and rotated hollow pads measured lower bounding-box fill without ceasing to be tees.',
				evidence: 'Rec became 9/9 assigned and Dev72 remained 72/72 assigned.',
				consequences: 'Fill must be interpreted with pad scale and orientation, not as an invariant.',
				limit: 'Not present in current HEAD; rank-1 changed 65 to 64 and transfer remains unvalidated.'
			}
		]
	},
	{
		id: 'D05-occluded-tee-recovery',
		title: 'Occluded Tee Recovery',
		status: 'historical-probe',
		gates: [4, 6],
		purpose: 'Fit a known tee-border shape to a visible fragment beside a known occluder when ordinary tee detection has no candidate.',
		implementation: ['scripts/cv-probes/occluded_tee_recovery.py', 'resources/nuthing-p2/endpoints/recovered-tees.json'],
		input: ['Canonical raster/masks', 'Measured tee-border family', 'Matched basket or badge occluder', 'Historically selected missing regions'],
		rawEvidence: {
			measurements: ['fragment anchor', 'occluder mask', 'masked ring hits/misses', 'F0.5 fit score', 'candidate center and distance to historical reference'],
			images: ['missing-tee locator', 'occluder/fragment crop', 'masked border-fit overlay'],
			provenance: [...canonicalProvenance, 'truth/selection involvement; required before blind use']
		},
		scoring: ['Masked border F0.5 rewards visible ring support while excusing only pixels hidden by the measured occluder.', 'Recovered candidates received a separately swept 0.7 assignment prior in historical replay.'],
		outputMeaning: ['The probe can localize some fragmented pads with explicit occlusion evidence.', 'The frozen resource is historical experiment input, not a live blind detector product.'],
		doNotInfer: ['A frozen recovered coordinate is not truth-blind.', 'A high masked fit does not establish ownership.', 'Failure to recover a 3x7 fragment is an honest missing measurement.'],
		failureModes: ['Unanchored search fits corridor paint or ring arcs.', 'Approximate occluder boxes leave white edge pixels that mimic the pad.', 'Tiny fragments underconstrain center/orientation.', 'Historical GT selection leaks into fresh-course work.'],
		handoffLosses: ['No current blind-safe recovery stage reruns the fragment fit.', 'No app-side quick manual recovery seam is implemented in this branch.'],
		history: {
			reproduced: ['Recovered two Heritage pads at 4.8 px and 6.9 px; one 3x7 sliver stayed unresolved.', 'The probe emitted two dev false positives.'],
			rejected: ['Whole-neighborhood grid search.', 'Using recovered-tees.json during a blind experiment.'],
			open: ['Build the smallest app-side manual recovery before association.', 'Test truth-independent ribbon-termination testimony for fully hidden pads.']
		},
		changelog: [
			{
				commit: '57d6ac4660f0eb8b5208d308cfcc767ab420af37',
				availability: 'current-head',
				change: 'Added fragment-anchored masked border fitting as a probe.',
				why: 'Occlusion fused three Heritage pads into larger bright components.',
				evidence: 'Two Heritage recoveries, one honest miss, two false positives.',
				consequences: 'Focused visible fragments can constrain recovery, while weak slivers should remain unresolved.',
				limit: 'Probe regions and evaluation used historical truth context.'
			},
			{
				commit: '4abdc42d7783c163a39363b1fbeed27bcc7c3a32',
				availability: 'current-head',
				change: 'Loaded frozen recoveries into the pair pool.',
				why: 'The assignment experiment required a complete endpoint inventory.',
				evidence: 'Endpoint availability reached 18/18/18 on all four dev courses; assignment reached 65/72.',
				consequences: 'Recovered-tier behavior became measurable in assignment replay.',
				limit: 'This resource is not legal evidence for fresh-course blindness.'
			}
		]
	},
	{
		id: 'D06-ribbon-support',
		title: 'Paired-Edge Ribbon Support Field',
		status: 'active-lab',
		gates: [5, 6, 7],
		purpose: 'Measure where two roughly parallel image transitions support a corridor-sized ribbon and which direction the ribbon runs.',
		implementation: ['src/lib/nuthing/ribbon.ts: computeRibbonSupport + supportCost', 'src/lib/nuthing/badgeOcclusion.ts: optional badge-crossing repair'],
		input: ['Canonical RGBA raster', 'Scale, candidate widths, and orientation count'],
		rawEvidence: {
			measurements: ['normalized support plane', 'winning orientation plane bestTheta', 'field scale', 'width/orientation sweep parameters', 'optional badge-patch statistics'],
			images: ['support heatmap', 'orientation visualization', 'focused route support samples'],
			provenance: canonicalProvenance
		},
		scoring: [
			'For each width and orientation, opposing RGB edge transitions contribute min(edge strength) times directional cosine agreement.',
			'The maximum is normalized by the nonzero 99.5th percentile and gamma 0.7; supportCost maps low support to routing cost.'
		],
		outputMeaning: ['Support is relative ribbon-like evidence at a pixel.', 'bestTheta is the winning undirected corridor orientation, not route direction.'],
		doNotInfer: ['High support is not necessarily the target hole.', 'Walking paths, putting-circle edges, neighboring corridors, and badge edges can be ribbon-like.', 'A heatmap is measurement, not ownership or bend truth.'],
		failureModes: ['Strong non-course parallel edges.', 'Chrome distorts percentile normalization.', 'Badge/sprite occlusion cuts the paired edges.', 'Chosen width/orientation grid misses the rendered corridor.'],
		handoffLosses: ['Cached pair evidence keeps sampled route summaries, but agents often see only final pair scores instead of the support and bestTheta planes.'],
		history: {
			reproduced: ['The pure-TS field was measured against registered dev truth.', 'Badge halo capping and one-sided support repair improved crossings without suppressing entire badge regions.'],
			rejected: ['Treating raw high support as belonging to the nearest badge.', 'Suppressing all putting-circle evidence before knowing its consumer.'],
			open: ['Expose the few focused support slices that explain a current gate without dumping full planes into agent context.']
		},
		changelog: [
			{
				commit: '359c34765b99770fea9ed8ec5730a6983e4fa943',
				availability: 'current-head',
				change: 'Established middle-out ribbon endpoint discovery on the pure-TS support field.',
				why: 'Endpoint pairing needed route evidence that could run without the OpenCV fallback.',
				evidence: 'Commit reports the full dev truth discovery gate under two seconds per image.',
				consequences: 'The same immutable support field can feed multiple replayable scoring policies.',
				limit: 'Registered truth measurement is not unseen-course validation.'
			},
			{
				commit: '7ccdf674840cfd5010d0eef5f7dd956c3efc4ad1',
				availability: 'current-head',
				change: 'Added badge halo cap and one-sided edge repair with per-course width.',
				why: 'Badge crossings suppressed or distorted otherwise valid paired-edge evidence.',
				evidence: 'Measured badge-crossing failure was addressed without routing around the badge.',
				consequences: 'Known badge rendering can be attributed rather than treated as generic missing ribbon.',
				limit: 'Per-course widths are historical calibration and require provenance.'
			}
		]
	},
	{
		id: 'D07-straight-ray',
		title: 'Straight-Ray Testimony',
		status: 'historical-probe',
		gates: [5, 6],
		purpose: 'Measure whether a tee-badge-basket triple has straight-hole geometry and whether its route stays on the expected chord.',
		implementation: ['scripts/nuthing/straight-hole-test.ts', 'scripts/nuthing/pair-matrix-replay.ts: invariant and collinearity terms'],
		input: ['Candidate triple', 'Cached route/support evidence', 'Historical probe additionally reads corpus bend truth'],
		rawEvidence: {
			measurements: ['tee-to-badge versus tee-to-basket angle', 'badge fraction on chord', 'maximum/off-chord deviation', 'interference attribution'],
			images: ['straight chord overlay', 'off-chord route evidence', 'distractor attribution view'],
			provenance: [...canonicalProvenance, 'whether bend truth selected the analyzed holes']
		},
		scoring: ['Historical analysis measured geometry only on corpus-labeled straight holes.', 'Replay applies a Gaussian badge-fraction penalty and a bounded collinearity bonus, never a bent-hole penalty.'],
		outputMeaning: ['Near-collinearity is useful positive testimony for a candidate straight triple.', 'Probe statistics establish dev precedent, not a blind classifier.'],
		doNotInfer: ['Failing the test does not prove bent.', 'Passing does not prove ownership in parallel clusters.', 'The 1.4 degree maximum is not a renderer invariant until transferred.'],
		failureModes: ['Parallel false triples are also straight.', 'Walking paths/basket zones make the route leave the chord.', 'Uncertain endpoints make angle precision meaningless.', 'Truth-selected analysis is accidentally reused in a blind run.'],
		handoffLosses: ['There is no single truth-blind Straight Test stage output yet; evidence is split between a historical script and replay score terms.'],
		history: {
			reproduced: ['41 dev straight holes measured angle median 0.5 degrees, P90 0.9, max 1.4.', 'Nine chord violations were attributable to walking paths or basket zones.'],
			rejected: ['Chord adherence alone.', 'Unrestricted agreement-bearing bonus; it harmed rank and assignment.'],
			open: ['Define an abstaining blind straight-test output without corpus bend labels.']
		},
		changelog: [
			{
				commit: 'd316cf3727278e607893fde4220e6ccbef448297',
				availability: 'current-head',
				change: 'Measured the straight-ray invariant and distractor classes.',
				why: 'Residual ownership errors needed a cheap discriminator between straight and routed pairs.',
				evidence: '41-hole angle distribution and nine explained chord violations.',
				consequences: 'Collinearity became useful testimony with explicit walking-path and basket-zone caveats.',
				limit: 'The analyzed set was selected using historical bend truth.'
			},
			{
				commit: '6d7f0fe1b2b9cdd4d4c23531449d6a1cc134676c',
				availability: 'current-head',
				change: 'Added a bounded straight-line bonus and recentered badge fraction.',
				why: 'Parallel Lenard routes and Heritage H7 remained unresolved by the earlier score family.',
				evidence: 'Dev72 assignment reached 72/72; badge-fraction ablation alone also reached 72/72.',
				consequences: 'Straight evidence can assist ownership without becoming a hard route classifier.',
				limit: 'Parameters were selected on the four-course dev set.'
			}
		]
	},
	{
		id: 'D08-pair-matrix',
		title: 'MiddleOut Pair Evidence Matrix',
		status: 'active-lab',
		gates: [6],
		purpose: 'Enumerate every tee-by-basket hypothesis for each numbered badge and preserve route evidence before ownership is chosen.',
		implementation: ['scripts/nuthing/pair-matrix.ts', 'src/lib/nuthing/ribbon.ts', 'src/lib/autoAnnotation/middleOutRibbon.ts'],
		input: ['Badge readings', 'Tee and basket candidate pools', 'Ribbon support field', 'Historical script also loads truth for evaluation'],
		rawEvidence: {
			measurements: ['badge-to-endpoint Dijkstra legs', 'canonical tee-badge-basket path', 'support mean/min/fraction', 'weak spans', 'worst window', 'path length and efficiency', 'endpoint support'],
			images: ['pair routes', 'true-vs-rival historical views', 'focused weakest-window evidence'],
			provenance: [...canonicalProvenance, 'candidate generation vs truth-evaluation boundary']
		},
		scoring: ['Routes one Dijkstra tree per badge through the shared support-cost field.', 'Baseline ranks worst-window support first and support mean second; later replay layers rescore without rerouting.'],
		outputMeaning: ['One row is testimony for one ownership hypothesis.', 'The matrix is intentionally complete enough to compare alternatives rather than return a final answer.'],
		doNotInfer: ['The top row is not assignment truth.', 'The existing script is not blind-safe as a whole because it loads registered truth and writes truth judgments.', 'High support can belong to a neighboring real route.'],
		failureModes: ['Dijkstra rides foreign ribbons, walking paths, or basket zones.', 'Goal-side glyph cost differs because one badge-seeded tree serves all endpoints.', 'Truth/evaluation fields contaminate a candidate-only consumer.'],
		handoffLosses: ['The script mixes truth-free candidate production with GT evaluation in one process; blind LAB needs an isolated producer invocation.', 'Full planes and paths are expensive, so summaries can hide the discriminating pixels.'],
		history: {
			reproduced: ['Baseline false competitors were usually real neighboring endpoints reached over real support.', 'Replay can rescore cached paths without rerunning expensive field/routing work.'],
			rejected: ['Nearest endpoint and geodesic-only ownership.', 'Calling the matrix itself an endpoint detector.'],
			open: ['Extract a truth-free run product from the current branch without changing measurements.']
		},
		changelog: [
			{
				commit: '2c735159b2c236118c3510a91287957449bd62a8',
				availability: 'current-head',
				change: 'Added the complete tee-by-basket evidence matrix with no ownership inference.',
				why: 'Scoring and assignment needed replayable evidence for every competing endpoint pair.',
				evidence: 'Every pair retains paths and support diagnostics for later replay.',
				consequences: 'New scoring policies can reuse measurements without rerunning pixel extraction.',
				limit: 'The script also loads truth for scoring its experiment outputs.'
			},
			{
				commit: '3146d14fcb98cb9c19ffbff1502a1c81ef39b962',
				availability: 'other-ref',
				change: 'Extracted measurement and Dev72 scoring into library code with parity gates.',
				why: 'The monolithic experiment script obscured the measurement-to-policy seam.',
				evidence: 'A later branch separates reusable stages more cleanly.',
				consequences: 'That ref is a candidate integration source, not evidence about this branch runner.',
				limit: 'Not present in current HEAD; do not describe it as the current runner.'
			}
		]
	},
	{
		id: 'D09-global-assignment',
		title: 'Global Endpoint Assignment',
		status: 'active-lab',
		gates: [6],
		purpose: 'Choose one tee and one basket per badge under course-wide one-to-one ownership constraints.',
		implementation: ['scripts/nuthing/pair-matrix-replay.ts: --assign'],
		input: ['Rescored pair rows for every badge'],
		rawEvidence: {
			measurements: ['pre-assignment ranks and margins', 'candidate endpoint collisions', 'greedy seed order', 'single moves', 'two-badge exchanges', 'final total score and theft chains'],
			images: ['final ownership overlay', 'collision set', 'before/after theft-chain views'],
			provenance: canonicalProvenance
		},
		scoring: ['Greedy seeds by per-badge decisiveness, then deterministic single moves and two-badge exchanges seek a higher total score.', 'Several deterministic start orders are compared; raw scores remain cross-badge rather than normalized.'],
		outputMeaning: ['A globally consistent ownership hypothesis.', 'A non-rank-1 local pair may be selected because it resolves the whole permutation.'],
		doNotInfer: ['One-to-one consistency is not correctness.', '72/72 assigned does not imply 72/72 rank 1 or validate every score term.', 'Assignment cannot repair a missing true endpoint.'],
		failureModes: ['One persuasive false row starts a theft chain.', 'Parallel fairways make many permutations nearly equal.', 'Greedy/two-swap search misses a better global solution.', 'Forced completeness hides an unresolved endpoint.'],
		handoffLosses: ['Final emitted assignments do not by themselves preserve the alternative rows and moves that explain why ownership changed.'],
		history: {
			reproduced: ['Global uniqueness resolved five same-tee/wrong-basket non-rank-1 rows at the Dev72 reference.', 'Rank 1 was 65/72 while assigned was 72/72.'],
			rejected: ['Optimizing only rank-1 count.', 'Per-badge score normalization; it inflated weak false claims.'],
			open: ['Expose the smallest collision/theft-chain explanation at Gate 6.']
		},
		changelog: [
			{
				commit: '9d5ca483c1615ad15e9853db60a080fe71e37717',
				availability: 'current-head',
				change: 'Added one-to-one global assignment with greedy plus two-swap search.',
				why: 'Independent local choices reused endpoints and caused ownership theft chains.',
				evidence: 'Reached 42/61 on the then-available rows and exposed Lenard cascade failures.',
				consequences: 'Ownership became a course-wide constraint problem rather than per-hole argmax.',
				limit: 'Global consistency was not sufficient with the earlier score family.'
			},
			{
				commit: '6d7f0fe1b2b9cdd4d4c23531449d6a1cc134676c',
				availability: 'current-head',
				change: 'Reached the historical Dev72 72/72 assignment reference.',
				why: 'Seven residual ownership failures required bounded salvage and recentered priors.',
				evidence: '18/18 on each of four dev courses with perfect endpoint availability.',
				consequences: 'The commit is the exact four-course assignment reproduction point.',
				limit: 'Development reproduction, not validation or feature ablation proof.'
			}
		]
	},
	{
		id: 'D10-zfit-pair-rescue',
		title: 'Z-Fit Pair Rescue',
		status: 'active-lab',
		gates: [6, 7],
		purpose: 'Rescore a weakly routed tee-badge-basket pair using the best explicit polyline with at most two bends through the badge.',
		implementation: ['scripts/nuthing/pair-matrix-replay.ts: --zfit'],
		input: ['Cached support/orientation field', 'One candidate triple', 'Basket-zone geometry', 'Current replay score'],
		rawEvidence: {
			measurements: ['candidate vertices', 'per-window aligned support', 'bend count', 'length/connector constraints', 'routed score versus fitted score'],
			images: ['routed path versus fitted polyline', 'candidate vertex evidence', 'weakest fitted window'],
			provenance: canonicalProvenance
		},
		scoring: ['Searches zero-, one-, and two-bend polylines with per-bend Occam discounts.', 'Only rows with routed alignedWorstWindow below 0.28 are eligible; fit can raise the weak evidence term but not bypass other replay layers.'],
		outputMeaning: ['Evidence that the candidate pair may be connected by a plausible simple bend structure despite a Dijkstra detour.', 'It is a pair-scoring rescue.'],
		doNotInfer: ['Returned vertices are not precise annotation bends.', 'A better fit is not ownership truth.', 'The tool does not measure inner/outer miter corners.'],
		failureModes: ['False pairs shop for two-bend bridges.', 'A saturated support field admits many similar vertices.', 'Badge anchor or endpoints are wrong.', 'Salvage threshold selected on Dev72 does not transfer.'],
		handoffLosses: ['Assignment outputs do not normally retain the fitted alternative geometry and why it was eligible.'],
		history: {
			reproduced: ['Recovered Heritage H7 route testimony near historical bends.', 'Unconditional rescue cost two Heritage assignments.'],
			rejected: ['Unconditional Z-fit.', 'Using Z-fit vertices as final bend annotation.'],
			open: ['Keep it explicitly under Assignment unless future evidence proves annotation-grade localization.']
		},
		changelog: [
			{
				commit: '6d7f0fe1b2b9cdd4d4c23531449d6a1cc134676c',
				availability: 'current-head',
				change: 'Restricted Z-fit to weak-route salvage.',
				why: 'Unconditional two-bend fits let false pairs shop for attractive bridges.',
				evidence: 'Historical H7 fit approached reference vertices; bounded use contributed to 72/72 assignment.',
				consequences: 'Z-fit can rescue pair scoring without defining final annotation geometry.',
				limit: 'Optimized for ownership scoring, not bend localization.'
			}
		]
	},
	{
		id: 'D11-basket-backwalk',
		title: 'Basket Terminal Backwalk',
		status: 'historical-probe',
		gates: [7],
		purpose: 'Measure the direction from which corridor paint approaches a basket using terminal-zone contrast and orientation evidence.',
		implementation: ['scripts/nuthing/basket-backwalk.ts'],
		input: ['Canonical raster', 'Cached support/bestTheta planes', 'Known basket, badge, and tee locations', 'Historical bend-aware truth for evaluation'],
		rawEvidence: {
			measurements: ['full angular score profile', 'top peaks', 'flanked-rectangle contrast', 'cap-edge and opposite-side evidence', 'near-field persistence', 'short backwalk polyline'],
			images: ['angular rays', 'terminal-zone crop', 'per-radius evidence profile'],
			provenance: [...canonicalProvenance, 'truth join used only for historical evaluation']
		},
		scoring: ['Scans 360 degrees in two-degree steps using center-versus-flank contrast and support orientation.', 'Later features test semicircular cap edge, one-sidedness, persistence, and tee-on-ray interference.'],
		outputMeaning: ['A set of competing terminal-bearing measurements.', 'Raw profiles can be useful candidate-conditioned testimony even when argmax is wrong.'],
		doNotInfer: ['The highest-scoring bearing is not a reliable approach direction.', 'Reported confidence is not calibrated confidence.', 'This is not a full bend detector.'],
		failureModes: ['Neighboring corridors and walking paths.', 'Basket zones cancel or reverse near-field contrast.', 'Next-hole tee lies on a trap ray.', 'Fixed badge/tee exclusion boxes substitute for missing measured bboxes.'],
		handoffLosses: ['The probe is unwired.', 'Its most useful output is the profile/peak set, not the final argmax; consumers must not collapse it.'],
		history: {
			reproduced: ['Only 43/72 bearings were within 15 degrees and 22/72 were reversed by 130-175 degrees.', 'Rotated flanks and near-field features helped individual rival cases, while standalone argmax stayed at parity.'],
			rejected: ['Confidence-weighted soft integration.', 'Standalone argmax as the basket approach answer.'],
			open: ['Use only as candidate-conditioned evidence if a future assignment ambiguity demands it.']
		},
		changelog: [
			{
				commit: 'f2e6b7f364a5c7f2b23fbb3722dd4a65e3b47ea5',
				availability: 'current-head',
				change: 'Added the measurement-only backward-walk probe.',
				why: 'Terminal approach direction might distinguish nearby basket candidates.',
				evidence: '43/72 within 15 degrees; 22 catastrophic reversals; confidence failed to separate them.',
				consequences: 'The standalone direction-confidence hypothesis was rejected before integration.',
				limit: 'Unwired and evaluated against bend-aware truth.'
			},
			{
				commit: '66b86ac9060dad7c8210d7d32dc9c63600b2afac',
				availability: 'current-head',
				change: 'Added semicircle-aware peaks and raw radial profiles.',
				why: 'Basket-zone rendering and neighboring ribbons corrupted a single backward path.',
				evidence: 'Near-field evidence flipped two historical cases but standalone argmax remained at parity.',
				consequences: 'Raw terminal profiles remain useful candidate-conditioned testimony.',
				limit: 'Useful testimony was not sufficient for integration.'
			}
		]
	},
	{
		id: 'D12-capsule-bends',
		title: 'Capsule Corridor Bend Detector',
		status: 'live-product',
		gates: [7],
		purpose: 'Choose bend count and centerline vertices by scoring corridor regions, then refine fixed-count vertices against graded line evidence.',
		implementation: ['src/lib/autoAnnotation/corridorBendDetectionCapsule.ts', 'src/lib/autoAnnotation/corridorEvidenceGrid.ts'],
		input: ['Per-hole raster crop', 'Confirmed tee and basket', 'Optional badge anchor'],
		rawEvidence: {
			measurements: ['classic corridor evidence grid', 'straight and added-bend capsule scores', 'accepted score gains', 'coarse/hill-climb vertices', 'graded refinement scores', 'badge mask'],
			images: ['per-hole evidence grid', 'straight-versus-bent capsule overlay', 'refined centerline vertices'],
			provenance: canonicalProvenance
		},
		scoring: [
			'Each candidate polyline is dilated to a corridor-width capsule; mean evidence minus excess-length penalty scores structure.',
			'An added bend must improve score by 0.03; after bend count freezes, a trimmed-mean line scorer recenters vertices.',
			'Optional badge anchoring fixes tee-to-badge and masks badge pixels rather than routing around them.'
		],
		outputMeaning: ['Zero or more crop-local centerline bend vertices ordered tee to basket.', 'Production applies them as editable SourcePoints only when endpoints are confirmed and no manual bends exist.'],
		doNotInfer: ['A centerline vertex is not the inner or outer miter corner.', 'The plain SourcePoint output carries no confidence/provenance field.', 'Dash/Alex benchmark performance is not validation on future courses.'],
		failureModes: ['Evidence grid is wrong or saturated.', 'Confirmed endpoint ownership is wrong.', 'One badge mask does not remove other badge interference.', 'Shallow bends and within-band vertex motion have weak gradients.', 'Thrown exceptions become a silent no-op in production integration.'],
		handoffLosses: ['detectAndApplyCorridorBendsCapsule catches all exceptions and returns unchanged holes, losing the failure reason.', 'Applied SourcePoints lose scores, alternatives, evidence images, and detector provenance.', 'No inner/outer-corner measurement is emitted.'],
		history: {
			reproduced: ['Region scoring separated reference bent gains 0.057-0.386 from straight gains 0.001-0.015 around the 0.03 margin.', 'Benchmark reported 17/18 and 3/3 exact bend count, with real bend localization on 16/18 Dash holes and all three Alex bent holes.', 'The earlier shortest-path detector localized no real bends on Dash or Alex.'],
			rejected: ['Shortest path through a mask plus RDP as the production bend detector.', 'Using capsule structure vertices without the graded refinement pass.'],
			open: ['Preserve evidence/provenance through production application.', 'Measure precise renderer inner/outer miter corners separately if they are needed for annotation or review.']
		},
		changelog: [
			{
				commit: 'cc0d6734de1b8a42d318062e2612cba85831603a',
				availability: 'current-head',
				change: 'Ported capsule-region scoring and benchmarked it against shortest-path detectors.',
				why: 'Shortest-path centerlines followed attractive mask pixels without recovering real renderer bends.',
				evidence: 'Measured clean bent-versus-straight score-gain separation and improved bend counts/localization.',
				consequences: 'Bend count is selected from corridor-region support before vertex refinement.',
				limit: 'Benchmark used development/reference courses.'
			},
			{
				commit: 'd9ef2e5631d606df5f26e595d518d98dea573942',
				availability: 'current-head',
				change: 'Promoted capsule arm C into the live approval flow.',
				why: 'The benchmarked capsule detector needed to produce editable proposals in the application.',
				evidence: 'approveHolePieces now calls detectAndApplyCorridorBendsCapsule.',
				consequences: 'Confirmed endpoint pairs can receive automatic editable bend vertices.',
				limit: 'The production application discards detector evidence and catches errors silently.'
			}
		]
	}
] as const;

const ids = new Set<string>();
for (const card of DETECTOR_CARDS) {
	if (ids.has(card.id)) throw new Error(`Duplicate detector card ${card.id}`);
	ids.add(card.id);
	if (card.gates.some((gate) => gate < 0 || gate > 7)) throw new Error(`Invalid gate on ${card.id}`);
}

function printCard(card: DetectorCard): void {
	console.log(`${card.id} — ${card.title}\nstatus: ${card.status}\ngates: ${card.gates.join(', ')}\n${card.purpose}`);
	for (const [label, values] of [
		['IMPLEMENTATION', card.implementation],
		['INPUT', card.input],
		['RAW MEASUREMENTS', card.rawEvidence.measurements],
		['RAW IMAGES', card.rawEvidence.images],
		['PROVENANCE', card.rawEvidence.provenance],
		['SCORING', card.scoring],
		['OUTPUT MEANING', card.outputMeaning],
		['WHAT NOT TO INFER', card.doNotInfer],
		['KNOWN FAILURE MODES', card.failureModes],
		['CURRENT HANDOFF LOSSES', card.handoffLosses],
		['HISTORY — REPRODUCED', card.history.reproduced],
		['HISTORY — REJECTED', card.history.rejected],
		['HISTORY — OPEN', card.history.open]
	] as const) {
		console.log(`\n${label}`);
		for (const value of values) console.log(`  - ${value}`);
	}
	console.log('\nCHANGELOG');
	for (const item of card.changelog) {
		console.log(`  - ${item.commit} [${item.availability}] — ${item.change}`);
		console.log(`    why: ${item.why}`);
		console.log(`    evidence: ${item.evidence}`);
		console.log(`    consequences: ${item.consequences}`);
		console.log(`    limit: ${item.limit}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const requested = process.argv[2];
	if (requested === undefined) {
		for (const card of DETECTOR_CARDS) console.log(`${card.id} [${card.status}] — gates ${card.gates.join(', ')} — ${card.title}`);
	} else {
		const card = DETECTOR_CARDS.find(({ id }) => id === requested || id.startsWith(`${requested}-`));
		if (!card) throw new Error(`Unknown detector ${requested}`);
		printCard(card);
	}
}
