import { pathToFileURL } from 'node:url';

import { DETECTOR_CARDS } from './detectors';
import { LAB_GATES } from './gates';

export type InvariantStrength =
	| 'hard-control'
	| 'renderer-family-observed'
	| 'dev72-measured'
	| 'model-bound'
	| 'negative-result';

export type InvariantCard = {
	id: string;
	title: string;
	strength: InvariantStrength;
	gates: readonly number[];
	detectors: readonly string[];
	claim: string;
	scope: string;
	evidence: readonly string[];
	use: readonly string[];
	doNotInfer: readonly string[];
	breakers: readonly string[];
	retest: string;
	sources: readonly string[];
};

export const INVARIANT_CARDS: readonly InvariantCard[] = [
	{
		id: 'I00-canonical-crop-frame',
		title: 'Canonical Crop-Local Frame',
		strength: 'hard-control',
		gates: [0, 1, 2, 3, 4, 5, 6, 7],
		detectors: ['D00-map-viewport-crop', 'D01-stitch-pipeline'],
		claim: 'UI chrome does not exist downstream; every measurement, annotation, render, and gate uses the flattened crop-local raster.',
		scope: 'All ChainSpot LAB runs.',
		evidence: ['The source-row/source-tile transforms are sufficient provenance for returning to inputs.', 'A missed viewport.top subtraction previously displaced an entire overlay.'],
		use: ['Reject mixed-frame comparisons before interpreting detector error.'],
		doNotInfer: ['Source-frame coordinates are not a second valid annotation system.'],
		breakers: ['Subtracting the crop offset zero or two times.', 'Measuring a source tile after the canonical composite exists.'],
		retest: 'Hash and dimension the canonical raster, then project known landmarks through every recorded source transform.',
		sources: ['LAB experiment control', 'docs/nuthing-p2/cx-catalog.md: CX-038']
	},
	{
		id: 'I01-render-stack-order',
		title: 'Render Stack Order',
		strength: 'renderer-family-observed',
		gates: [1, 2, 3, 4, 5, 7],
		detectors: ['D02-badge-reader', 'D03-basket-sprite', 'D04-tee-candidates', 'D05-occluded-tee-recovery', 'D06-ribbon-support'],
		claim: 'Observed order is badges > basket sprites > basket rings/fills > corridor > tee pads > walking path > satellite imagery.',
		scope: 'Measured UDisc renderer family represented by Dev72.',
		evidence: ['Corridor paint covers tee borders.', 'Sprites and badges occlude lower layers rather than being displaced by them.'],
		use: ['Name the likely occluder and decide which missing pixels may be excused.'],
		doNotInfer: ['Occlusion does not license inventing the hidden object center.'],
		breakers: ['A UDisc renderer update.', 'A screenshot produced by a different map/overlay mode.'],
		retest: 'Inspect repeated overlap cases and verify which layer owns the topmost pixels.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-001']
	},
	{
		id: 'I02-corridor-render-primitive',
		title: 'Constant-Width Corridor Primitive',
		strength: 'renderer-family-observed',
		gates: [4, 5, 7],
		detectors: ['D05-occluded-tee-recovery', 'D06-ribbon-support', 'D07-straight-ray', 'D12-capsule-bends'],
		claim: 'The route is a constant-width polyline-like graphic with straight arms, constructed bend joins, and semicircular endpoint caps.',
		scope: 'Dev72 renderer evidence; Alex miter observations are transfer precedent, not a universal join law.',
		evidence: ['Historical cap probes place cap centers about 4.5 px inside endpoints with radius W/2.', 'Alex visual review supported mitered inner/outer bend corners.'],
		use: ['Fit sustained arms and paired edges; treat endpoint caps and bend joins as different geometry.'],
		doNotInfer: ['A centerline bend vertex is not either visible miter corner.', 'An isolated edge-like pixel is not a corridor arm.'],
		breakers: ['Antialiasing and alpha blending over terrain.', 'A renderer using rounded joins or variable width.'],
		retest: 'Measure both rails and endpoint profiles on a new course before transferring join/cap assumptions.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-002', 'AlexClark Oracle visual session precedent']
	},
	{
		id: 'I03-one-width-per-course',
		title: 'One Corridor Width per Course',
		strength: 'dev72-measured',
		gates: [4, 5, 7],
		detectors: ['D05-occluded-tee-recovery', 'D06-ribbon-support', 'D12-capsule-bends'],
		claim: 'Within each measured course, corridor width is approximately constant even though it differs between courses.',
		scope: 'Dev72: annotated widths 40, 30, 37, and 37 px; unseen courses require fresh measurement.',
		evidence: ['Full-width-at-half-maximum estimates broadly agree with annotation-derived widths.'],
		use: ['Set paired-edge separation, cap radius, masks, and bend-capsule width from one course measurement.'],
		doNotInfer: ['Do not reuse a Dash width on NorthPark.', 'A single local width sample may be contaminated.'],
		breakers: ['Mixed zoom screenshots.', 'Perspective/resampling or a renderer with width varying by hole.'],
		retest: 'Measure several clean perpendicular cross-sections and report their spread before choosing W.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-003', 'src/lib/nuthing/badgeOcclusion.ts']
	},
	{
		id: 'I04-alpha-composite-paint',
		title: 'Corridor Is Alpha-Composited Paint',
		strength: 'dev72-measured',
		gates: [4, 5, 7],
		detectors: ['D05-occluded-tee-recovery', 'D06-ribbon-support', 'D12-capsule-bends'],
		claim: 'The same corridor color composites differently over local ground, so absolute brightness is not stable evidence.',
		scope: 'Measured overview captures; historical estimates C≈RGB[150,155,145], alpha≈0.61–0.90.',
		evidence: ['Corridor over dark trees measured far darker than corridor over open ground.', 'Tree underlay caused both detector and annotation centerline bias.'],
		use: ['Prefer local flanked contrast over a global brightness threshold.'],
		doNotInfer: ['A dark-looking segment is not automatically missing ribbon.'],
		breakers: ['Contaminated background-reference windows.', 'Terrain edges aligned with the corridor.'],
		retest: 'Compare the candidate strip with perpendicular local background on both sides.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-004, CX-028, CX-034']
	},
	{
		id: 'I05-basket-sprite-anchor',
		title: 'Basket Sprite and Pole-Tip Anchor',
		strength: 'renderer-family-observed',
		gates: [2, 4, 6, 7],
		detectors: ['D03-basket-sprite', 'D05-occluded-tee-recovery', 'D06-ribbon-support', 'D11-basket-backwalk'],
		claim: 'The measured basket family uses a 42×66 sprite; the semantic endpoint is the pole tip, approximately sprite bottom +4 px, not the sprite center.',
		scope: 'Dev72 UDisc basket sprite family.',
		evidence: ['Occlusion-tolerant template matching reached 72/72 Dev72 candidate recall.', 'Instances show small compression variation rather than byte identity.'],
		use: ['Localize the visible sprite, then apply the recorded pole-tip transform.'],
		doNotInfer: ['A matched sprite does not identify its hole owner.'],
		breakers: ['Different sprite scale/theme.', 'Cropping or compression that changes apparent bounds.'],
		retest: 'Stack true-looking candidates, estimate modal bbox and pole transform, and retain onFrac/offFrac.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-005', 'src/lib/nuthing/endpoints.ts: matchBasketSprites']
	},
	{
		id: 'I06-anchor-locked-basket-zone',
		title: 'Basket Zone Is Anchor-Locked Furniture',
		strength: 'dev72-measured',
		gates: [2, 4, 5, 7],
		detectors: ['D03-basket-sprite', 'D05-occluded-tee-recovery', 'D06-ribbon-support', 'D11-basket-backwalk'],
		claim: 'C1/C2 rings and fills repeat at basket-centered radii and can occlude or imitate corridor/tee evidence.',
		scope: 'Dev72: C1 solid ring roughly 44±8 px; C2 dashed ring roughly 84±12 px for band scoring.',
		evidence: ['Anchor-centered stacks reproduce the repeated zone stamp.', 'Radial fills defeat ordinary perpendicular-flank tests.'],
		use: ['Attribute circular evidence before treating it as a tee or route edge.'],
		doNotInfer: ['Furniture proximity is not an endpoint veto.', 'Band tolerances are not literal stroke thickness.'],
		breakers: ['Different zoom or scoring-circle display settings.', 'Neighbor objects at non-repeating offsets.'],
		retest: 'Estimate radial profiles around all basket candidates and look for repeated peaks.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-006, CX-030, CX-032']
	},
	{
		id: 'I07-badge-anatomy',
		title: 'Badge Frame, Dark Plate, and Digit Glyphs',
		strength: 'renderer-family-observed',
		gates: [1, 4, 6],
		detectors: ['D02-badge-reader', 'D04-tee-candidates', 'D05-occluded-tee-recovery'],
		claim: 'A badge is a white frame around a dark plate containing white digit glyphs; the frame may merge with sprites while the dark plate remains recoverable.',
		scope: 'Dev72 badge family; approximate frame 54×42 and plate 48×36 px.',
		evidence: ['Dark-plate recovery restored six sprite-merged badges and reached 72/72 badge availability.'],
		use: ['Separate plate detection, glyph decoding, and synthesized frame localization.'],
		doNotInfer: ['A white rectangular frame is not necessarily a tee.', 'Recovered geometry is not an ordinary component measurement.'],
		breakers: ['Different badge scale/theme.', 'Sprite intrusion creating phantom digit components.'],
		retest: 'Inspect plate geometry, glyph alternatives, and frame overlap independently.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-007, CX-024, CX-025']
	},
	{
		id: 'I08-relative-lift-families',
		title: 'Renderer Families Have Different Local Lift',
		strength: 'dev72-measured',
		gates: [4, 5, 7],
		detectors: ['D05-occluded-tee-recovery', 'D06-ribbon-support'],
		claim: 'Control-corrected local gray lift separated corridor, walking path, and zone fill families on Dev72.',
		scope: 'Historical measurements: tee→badge +48, badge→basket +33, walking path +17, C2 fill −7.',
		evidence: ['The measured separation motivated a 24-lift solid-versus-dashed discriminator.'],
		use: ['Compare candidate paint with nearby ground before classifying it.'],
		doNotInfer: ['These four numbers are not universal thresholds for NorthPark.'],
		breakers: ['Different imagery/color processing.', 'Reference windows containing the candidate itself.'],
		retest: 'Re-estimate each family from clean, labeled local cross-sections on the new raster.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-008', 'scripts/nuthing/lift-signatures.ts']
	},
	{
		id: 'I09-tee-glyph-anatomy',
		title: 'Tee Is an Oriented Hollow Glyph',
		strength: 'renderer-family-observed',
		gates: [3, 4, 6],
		detectors: ['D04-tee-candidates', 'D05-occluded-tee-recovery'],
		claim: 'Visible tees are hollow white rectangular glyphs whose principal axis carries route-direction information.',
		scope: 'Dev72 renderer family; modal size varies by course.',
		evidence: ['Ring-tier components preserve enclosing-hole and principal-axis measurements.', 'Walking-path dashes and badge frames are dominant false-positive families.'],
		use: ['Retain bbox, axes, angle, fill, ring fraction, and provenance—not center alone.'],
		doNotInfer: ['A rectangle-like component is not automatically a tee.', 'Component tier does not manufacture enclosing-ring evidence.'],
		breakers: ['Occlusion opening the ring.', 'Scale/rotation changing bounding-box fill.'],
		retest: 'Measure the complete component and compare its orientation with competing badges.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-009', 'src/lib/nuthing/endpoints.ts: detectTeeRings + collectTeePoints']
	},
	{
		id: 'I10-tee-aims-at-badge',
		title: 'Tee Axis Aims at Its Badge',
		strength: 'dev72-measured',
		gates: [3, 5, 6],
		detectors: ['D04-tee-candidates', 'D07-straight-ray', 'D08-pair-matrix'],
		claim: 'The visible tee body aims along its own badge ray, but component PCA is a noisy orientation instrument and does not define a trustworthy hard maximum.',
		scope: 'Cold rerun of current straight-hole annotations: 40 measurable ring-tier PCA axes; median 1.08°, P90 2.45°.',
		evidence: ['Three PCA readings exceeded the historical 2.65° P90: TowneLake H5 11.28°, Heritage H17 6.10°, Lenard H16 2.71°.', 'Focused pixels show the TowneLake H5 tee and badge ray essentially vertical while PCA is visibly skewed.'],
		use: ['Rank badge ownership hypotheses and diagnose flipped tee orientation.'],
		doNotInfer: ['The historical 11.3° maximum is a real geometric tail; it reproduced as a PCA contamination artifact.', '“Directly” means a tight measured relationship, not exact zero degrees.', 'Axis direction is 180° ambiguous without badge position.'],
		breakers: ['Bad PCA geometry after handoff.', 'A pad whose visible fragment biases its measured axis.'],
		retest: 'Measure absolute acute angle from tee major axis to every badge and preserve alternatives.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-010', 'docs/tee-overfit-harness.md']
	},
	{
		id: 'I11-badge-before-bend',
		title: 'Badge Lies Before the First Bend',
		strength: 'dev72-measured',
		gates: [5, 6, 7],
		detectors: ['D07-straight-ray', 'D08-pair-matrix', 'D10-zfit-pair-rescue', 'D11-basket-backwalk'],
		claim: 'On the measured Dev72 family, the badge lies on the first corridor segment, so tee→badge estimates departure direction.',
		scope: 'Dev72 historical annotations and renderer measurements.',
		evidence: ['Used to seed Z-fit first-segment direction.', 'Basket→badge failed as dogleg approach truth precisely because the badge precedes the bend.'],
		use: ['Constrain tee ownership and first-segment geometry.'],
		doNotInfer: ['Badge→basket is not the terminal approach direction on a bent hole.'],
		breakers: ['A future renderer placing badges after a bend.', 'Wrong badge ownership.'],
		retest: 'For every visibly bent route, locate the first bend and test badge containment on the tee-side arm.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-011, CX-040']
	},
	{
		id: 'I12-badge-longitudinal-band',
		title: 'Badge Occupies an Early Longitudinal Band',
		strength: 'dev72-measured',
		gates: [5, 6],
		detectors: ['D07-straight-ray', 'D08-pair-matrix', 'D09-global-assignment'],
		claim: 'Badge projection along the tee→basket chord measured 0.17–0.54, median 0.51, on 72 Dev holes.',
		scope: 'Dev72; the scoring prior was recentered to 0.36±0.19.',
		evidence: ['Recentered band alone restored the last Dev72 assignment in ablation.'],
		use: ['Downweight ownership hypotheses placing the badge far behind the tee or beyond the basket.'],
		doNotInfer: ['The median is not the correct center of a symmetric prior.', 'Chord fraction does not describe along-route distance on doglegs.'],
		breakers: ['Strong bends that distort chord projection.', 'A new layout convention.'],
		retest: 'Measure the complete distribution before choosing a scoring function; retain extrema.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-012', 'commit 6d7f0fe']
	},
	{
		id: 'I13-straight-hole-collinearity',
		title: 'Straight Holes Are Nearly Collinear',
		strength: 'dev72-measured',
		gates: [5, 6],
		detectors: ['D07-straight-ray', 'D08-pair-matrix', 'D09-global-assignment'],
		claim: 'For known straight holes, tee→badge and tee→basket directions differed by at most 1.4° in Dev72.',
		scope: '41 historical straight holes; median 0.5°, P90 0.9°.',
		evidence: ['A bounded collinearity bonus resolved six Lenard cluster thefts without measured regression.'],
		use: ['Reward a strongly supported straight hypothesis.'],
		doNotInfer: ['Non-collinearity does not prove a bend.', 'Do not penalize every hole for failing a subset invariant.'],
		breakers: ['Wrong endpoint ownership.', 'Parallel neighboring fairways producing a false perfect line.'],
		retest: 'Compare angle and paired-edge support; never classify from angle alone.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-013', 'docs/nuthing-p2/distractor-attribution.md']
	},
	{
		id: 'I14-simple-path-discipline',
		title: 'True Tee→Badge→Basket Paths Do Not Double Back',
		strength: 'dev72-measured',
		gates: [5, 6],
		detectors: ['D06-ribbon-support', 'D08-pair-matrix', 'D09-global-assignment'],
		claim: 'Within the historical cached route extraction, the concatenated true route had zero self-overlap in all 61 measured pairs, while false competitors reached 0.88.',
		scope: 'Dev72 pair-matrix rows available at the time of measurement.',
		evidence: ['Replay used multiplier (1−overlap)².'],
		use: ['Reject routes that reuse the same ribbon segment in opposite directions.'],
		doNotInfer: ['A non-overlapping path is not necessarily the correct path.'],
		breakers: ['Looping course graphics.', 'Path extraction jumping between parallel ribbons.'],
		retest: 'Measure directed spatial overlap separately from total route length.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-014']
	},
	{
		id: 'I15-one-sided-basket-termination',
		title: 'Corridor Terminates One-Sidedly at the Basket',
		strength: 'dev72-measured',
		gates: [4, 5, 7],
		detectors: ['D05-occluded-tee-recovery', 'D06-ribbon-support', 'D11-basket-backwalk'],
		claim: 'In the measured Dev72 corridor family, hole paint approaches the basket anchor from one side and ends in a cap.',
		scope: 'Dev72 corridor renderer; other overlay families may leave the anchor in other directions.',
		evidence: ['Endpoint-cap probes support one-sided corridor geometry.', 'Naive direction tests suffered 180° traps from walking paths and neighboring corridors.'],
		use: ['Test terminal approach candidates and hidden endpoint evidence.'],
		doNotInfer: ['All paint leaving the basket is not the hole corridor.', 'A high backwalk confidence is not correctness.'],
		breakers: ['Walking trace leaving opposite the approach.', 'Radial C1/C2 fills and neighboring corridors.'],
		retest: 'Require agreement between independent in-zone and out-of-zone instruments or abstain.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-015, CX-031, CX-033']
	},
	{
		id: 'I16-two-bend-model-bound',
		title: 'At Most Two Bends Is a Model Bound',
		strength: 'model-bound',
		gates: [6, 7],
		detectors: ['D10-zfit-pair-rescue', 'D12-capsule-bends'],
		claim: 'A ≤2-bend search with bend angle ≤60°, connector ≤3W, and total length ≤1.4× chord covered every Dev72 hole.',
		scope: 'Historical Dev72 model coverage, including the cancelling-S case.',
		evidence: ['The bounded Z-fit could represent all development annotations.'],
		use: ['Keep rescue search finite and interpretable.'],
		doNotInfer: ['UDisc cannot render three bends.', 'The best-scoring Z-fit is final annotation geometry.'],
		breakers: ['A future three-bend course.', 'Brightness-biased evidence producing a false bridge.'],
		retest: 'Inspect unexplained residual support before expanding the bend-count bound.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-016, CX-037']
	},
	{
		id: 'I17-tee-on-neighbor-ring',
		title: 'Neighbor C2 Proximity Is Not a Tee Veto',
		strength: 'dev72-measured',
		gates: [3, 4, 6],
		detectors: ['D04-tee-candidates', 'D05-occluded-tee-recovery'],
		claim: 'Sixteen real Dev72 tees lie on another basket’s dashed C2 ring.',
		scope: 'Dev72 spatial corner case.',
		evidence: ['Early ring-furniture exclusion deleted these real tees; retaining and tagging onRing restored recall.'],
		use: ['Preserve actual onRing evidence as provenance rather than rejecting the candidate.'],
		doNotInfer: ['A candidate on a ring is therefore a tee.', 'Tier may not be substituted for measured onRing.'],
		breakers: ['C2 dash fragments imitating hollow tee geometry.'],
		retest: 'Measure candidate geometry first, then record ring intersection independently.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-017']
	},
	{
		id: 'I18-one-to-one-ownership',
		title: 'Endpoint Ownership Is Course-Wide One-to-One',
		strength: 'model-bound',
		gates: [6],
		detectors: ['D08-pair-matrix', 'D09-global-assignment'],
		claim: 'Within the current 18-hole assignment model, each numbered badge owns one tee and one basket, and each candidate endpoint is used once.',
		scope: 'Current ChainSpot solver grammar; not asserted as universal UDisc physics.',
		evidence: ['Global uniqueness resolved ownership cases that remained locally below rank 1.', 'Missing endpoints caused theft chains rather than becoming harmless omissions.'],
		use: ['Resolve permutations only after candidate identity and inventory are trustworthy.'],
		doNotInfer: ['One-to-one consistency proves the selected permutation.', 'A complete permutation should be forced when an endpoint is missing.'],
		breakers: ['Duplicate/missing detector candidates.', 'Layouts sharing a physical tee or basket outside the current grammar.'],
		retest: 'Surface every endpoint reuse, omission, and displaced ownership rather than only aggregate assignment count.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-029, CX-042', 'scripts/nuthing/pair-matrix-replay.ts']
	},
	{
		id: 'I19-rank1-is-not-assignment',
		title: 'Local Rank 1 Is Not the Ownership Result',
		strength: 'negative-result',
		gates: [6],
		detectors: ['D08-pair-matrix', 'D09-global-assignment', 'D10-zfit-pair-rescue'],
		claim: 'At Dev72, local true-pair rank 1 saturated at 65/72 while one-to-one assignment was 72/72.',
		scope: 'Exact Dev72 score family at commit 6d7f0fe.',
		evidence: ['Five of seven non-rank-1 rows were same-tee/wrong-basket rivals.', 'Cached tuning attempts were inert or regressed assignment to 63–67.'],
		use: ['Report candidate rank and final ownership separately; inspect rival-conditioned structure.'],
		doNotInfer: ['A lower rank means the assignment is wrong.', 'More local score multipliers will necessarily improve ownership.'],
		breakers: ['A validation course where true pairs fall beyond the shallow candidate pool.', 'A changed score family with new independent evidence.'],
		retest: 'Track rank-1, rank≤3, assigned ownership, and theft chains after every algorithm change.',
		sources: ['docs/nuthing-p2/cx-catalog.md: CX-042', 'commit 5796281']
	},
	{
		id: 'I20-useful-family-signal',
		title: 'Useful Family Signal',
		strength: 'renderer-family-observed',
		gates: [3, 4, 6],
		detectors: ['D04-tee-candidates', 'D05-occluded-tee-recovery'],
		claim: 'An intact tee is best identified as a course-local renderer family whose white component geometry, enclosed-hole size, and gray interior payload repeat tightly together; no single scalar is the family.',
		scope: 'Dev72 annotation-graded intact tee rings plus blind held-out validation family measurements from Beaver Ranch Gold, Coleto Creek, Fountain Hills, and SeaTac on 2026-08-22. Validation family membership remains provisional until Oracle truth exists.',
		evidence: [
			'Annotation-confirmed Dev72 intact-ring hole-area ranges were tight within each course despite large cross-course scale changes: DashsTrack 295–346 px, Heritage 42–52, Lenard 71–74, TowneLake 76–82.',
			'Held-out validation dominant white-family hole-area ranges were likewise tight: Beaver Ranch Gold 97–102 px, Coleto Creek 65–71, Fountain Hills 83–91, SeaTac 52–59.',
			'Gray payload also repeated tightly inside each validation family but changed with scale: Beaver 77–84 px, Coleto 50–55, Fountain 67–72, SeaTac 36–45. Raw gray count is therefore course-local evidence, not a transferable threshold.',
			'High raw gray count can be a false signal when the enclosed hole has the wrong family size: a Coleto non-family candidate carried 105 gray pixels inside a 210-px hole versus real-family holes 65–71 px; a SeaTac non-family candidate carried 53 gray pixels inside a 290-px hole versus real-family holes 52–59 px.',
			'On validation, neighborhood filtering and gray-support checks removed large false-positive families without deleting any member of the dominant white tee family in the measured pass.'
		],
		use: [
			'Learn the course-local intact tee family before tuning individual candidate thresholds.',
			'Preserve white-component bbox/area/fill, rotated geometry, enclosed-hole area, gray count/fraction, edge/corner evidence, and neighborhood support as separate measurements rather than collapsing them into one persuasive score.',
			'For an unoccluded candidate, require compatibility with both family geometry and interior material evidence; a high gray count in an oversized or otherwise non-family hole is not tee evidence.',
			'If the intact-family inventory is short of badge cardinality, treat the deficit as a recovery/TeeShard problem rather than widening the intact family until junk enters.'
		],
		doNotInfer: [
			'The dominant measured family is automatically Oracle truth; repeated map furniture can form its own family.',
			'Raw gray P100 transfers between courses or zoom levels.',
			'A candidate outside the intact family is false; occlusion, renderer merges, and TeeShards can destroy ordinary family geometry.',
			'One family statistic should replace the raw evidence ledger.'
		],
		breakers: [
			'Mixed zoom or resampling within one raster.',
			'A renderer/theme update that changes tee border scale, interior material, or antialiasing.',
			'Bootstrapping from a dominant repeated false-positive family without independent neighborhood/object context.',
			'Using heavily occluded or merged candidates to estimate the intact family.'
		],
		retest: 'On each fresh raster, print the distributions of white-component geometry, enclosed-hole area, gray count/fraction, and neighborhood support. With truth, report real minimum/P50/P100 and maximum false-positive values; without truth, keep family/non-family labels provisional and print the pixels before changing thresholds.',
		sources: ['2026-08-22 LAB tee gray/shape study across Dev72 + Beaver/Coleto/Fountain/SeaTac validation', 'I09 tee-glyph anatomy', 'C00 Tee Shard case semantics']
	}
] as const;

const gateIds = new Set(LAB_GATES.map(({ id }) => id));
const detectorIds = new Set(DETECTOR_CARDS.map(({ id }) => id));
const invariantIds = new Set<string>();
for (const card of INVARIANT_CARDS) {
	if (invariantIds.has(card.id)) throw new Error(`Duplicate invariant card ${card.id}`);
	invariantIds.add(card.id);
	for (const gate of card.gates) if (!gateIds.has(gate)) throw new Error(`${card.id} names unknown gate ${gate}`);
	for (const detector of card.detectors) {
		if (!detectorIds.has(detector)) throw new Error(`${card.id} names unknown detector ${detector}`);
	}
}

function printCard(card: InvariantCard): void {
	console.log(`${card.id} — ${card.title}\nstrength: ${card.strength}\ngates: ${card.gates.join(', ')}\n${card.claim}`);
	for (const [label, values] of [
		['SCOPE', [card.scope]],
		['REPRODUCED EVIDENCE', card.evidence],
		['OPERATIONAL USE', card.use],
		['WHAT NOT TO INFER', card.doNotInfer],
		['KNOWN BREAKERS', card.breakers],
		['RETEST ON A FRESH COURSE', [card.retest]],
		['SOURCES', card.sources],
		['INFLUENCED DETECTORS', card.detectors]
	] as const) {
		console.log(`\n${label}`);
		for (const value of values) console.log(`  - ${value}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const requested = process.argv[2];
	if (requested === undefined) {
		for (const card of INVARIANT_CARDS) console.log(`${card.id} [${card.strength}] — ${card.title}`);
	} else {
		const card = INVARIANT_CARDS.find(({ id }) => id === requested || id.startsWith(`${requested}-`));
		if (!card) throw new Error(`Unknown invariant ${requested}`);
		printCard(card);
	}
}
