import type { MaterializedBadgeEvidence } from './badgeEvidence';
import type { MaterializedM1Representation } from './m1Representation';
import type { RgbaImage } from './types';
import { materializeM2RawFrameStatsControl, type M2RawFrameStatsControl, type M2RawFrameStatsControlOptions } from './m2RawFrameStatsControl';

/** M2 deliberately keeps the proven M1 B+W worldview intact. */
export const M2_REPRESENTATION_SCHEMA = 'chainspot.badge-representation-m2/v1' as const;

export type M2RegistrationMethod = 'same-raster-m1-geometry' | 'independent-registered-samples';
export type M2DigitCondition = 'all' | 'digit-adjacent' | 'same-digit';
export type M2SupportClass =
	'structural-common' | 'digit-conditioned' | 'unresolved' | 'unsupported';

export interface M2OverlapOptions {
	/** How samples were registered. Same-raster recurrence is not multisampling. */
	readonly registrationMethod: M2RegistrationMethod;
	/** The condition used when interpreting support, retained as provenance. */
	readonly digitCondition?: M2DigitCondition;
	/** Minimum number of aligned samples carrying a candidate. */
	readonly minimumSupportCount?: number;
	/** Minimum fraction of aligned samples carrying a candidate. */
	readonly minimumSupportFraction?: number;
	/** Optional results from larger, independently materialized context frames. */
	readonly frameSweep?: readonly M2FrameSweepSample[];
	/** Optional library-level fieldset, built once and shared by all objects. */
	readonly overlapFieldSet?: M2OverlapFieldSet;
}

export interface M2FrameSweepSample {
	/** Context margin around the stable M1 object geometry, in pixels. */
	readonly marginPx: number;
	/** Canonical object-local coordinates; these remain comparable as the frame grows. */
	readonly supportedPixels: readonly (readonly [number, number])[];
	/** Repeat-supported pixels touching this sample's outer boundary. */
	readonly boundarySupportedPixelCount: number;
	/** Source/crop truncation count; nonzero means the frame is not trustworthy. */
	readonly unobservedSampleCount?: number;
}

export interface M2FrameAssessment {
	readonly status: 'adequate' | 'insufficient' | 'not-measured';
	readonly samples: number;
	readonly latestMarginPx: number | null;
	readonly stableSet: boolean;
	readonly boundarySupportedPixelCount: number;
	readonly unobservedSampleCount: number;
	/** Exact deterministic identity for the final supported set. */
	readonly latestSetFingerprint: string | null;
	/** Exact canonical observations retained for E inspection/replay. */
	readonly sweep: readonly M2FrameSweepSample[];
	readonly reason: string;
}

export interface M2SupportObservation {
	readonly localPixel: readonly [number, number];
	readonly supportCount: number;
	readonly alignedSampleCount: number;
	readonly supportFraction: number;
	readonly class: M2SupportClass;
	readonly sampleIds: readonly string[];
}

/**
 * A lossless recurrence observation over materialized AA candidate masks.
 *
 * This is deliberately a count field, not a classifier.  `numOverlaps` is
 * the number of distinct materialized specimens whose candidate mask landed
 * at the canonical coordinate; `eligibleCount` is the number of specimens in
 * the field's condition for which that coordinate could be observed.  The
 * complete field is retained so a view may sweep a display threshold later.
 */
export interface M2OverlapObservation {
	readonly localPixel: readonly [number, number];
	readonly numOverlaps: number;
	readonly eligibleCount: number;
	readonly overlapFraction: number;
	readonly contributorIds: readonly string[];
}

export type M2OverlapChannel = 'structural' | 'digit-conditioned';

export interface M2OverlapField {
	readonly channel: M2OverlapChannel;
	/** Coordinates are centered on the channel's geometry, with a one-pixel support ring. */
	readonly coordinateFrame:
		| 'm1-bbox-plus-one-support-ring'
		| 'digit-bbox-plus-one-support-ring';
	/** Canonical raster dimensions, including the support ring. */
	readonly canonicalSize: readonly [number, number];
	readonly sampleIds: readonly string[];
	/** Samples whose evidence is valid for this field's condition. */
	readonly eligibleSampleIds: readonly string[];
	/** Per-sample audit of lossy integer registration collisions. */
	readonly contributions: readonly M2OverlapContribution[];
	/** For digit fields, this identifies the validated digit condition. */
	readonly digitCondition?: { readonly index: number; readonly character: string };
	/** Candidate pixels that could not be assigned to this channel. */
	readonly excludedCandidateCount: number;
	readonly observations: readonly M2OverlapObservation[];
}

export interface M2OverlapContribution {
	readonly sampleId: string;
	readonly sourceCandidateCount: number;
	readonly uniqueCanonicalCellCount: number;
	readonly collisionCount: number;
}

export interface M2OverlapFieldSet {
	readonly sampleIds: readonly string[];
	readonly structural: M2OverlapField;
	readonly digitConditioned: readonly M2OverlapField[];
}

export interface M2KnownSetAccounting {
	readonly availablePixels: Uint32Array;
	readonly explainedPixels: Uint32Array;
	readonly unexplainedPixels: Uint32Array;
}

export interface M2TransitionAccounting {
	readonly preservedPixels: Uint32Array;
	readonly lostPixels: Uint32Array;
	readonly discoveredPixels: Uint32Array;
	readonly newlyExplainedPixels: Uint32Array;
	readonly stillUnexplainedPixels: Uint32Array;
	readonly regressionLoss: number | null;
	readonly discoveryLoss: number | null;
}

export interface MaterializedBadgeM2Representation {
	readonly schema: typeof M2_REPRESENTATION_SCHEMA;
	readonly objectId: string;
	readonly registration: {
		readonly method: M2RegistrationMethod;
		/** Number of real input specimens supplied to the overlap calculation. */
		readonly sampleCount: number;
		/** Number whose M1 geometry was compatible with the target. */
		readonly alignedSampleCount: number;
		/** Distinct badge objects used as observations, not repeated reads of one object. */
		readonly sampleUnit: 'distinct-badge-objects';
		readonly alignedSampleIds: readonly string[];
		readonly excludedSampleIds: readonly string[];
		/** Exact dimension gate; each aligned sample is translated to local M1 coordinates. */
		readonly alignment: 'exact-m1-owned-bbox-dimensions-plus-top-left-translation';
		readonly digitCondition: M2DigitCondition;
		readonly minimumSupportCount: number;
		readonly minimumSupportFraction: number;
		readonly provenance: string;
	};
	readonly m1: M2KnownSetAccounting;
	readonly m2: M2KnownSetAccounting;
	readonly aa: {
		/** Existing naive AA candidates; none are silently discarded as noise. */
		readonly candidatePixels: Uint32Array;
		/** Candidate pixels promoted only after an adequate expanded-frame sweep. */
		readonly explainedPixels: Uint32Array;
		/** Supported by recurrence but held provisional until frame adequacy is proven. */
		readonly provisionalPixels: Uint32Array;
		/** Candidates without enough support to claim ownership. */
		readonly unresolvedPixels: Uint32Array;
		readonly observations: readonly M2SupportObservation[];
	};
	readonly transition: M2TransitionAccounting;
	readonly frame: M2FrameAssessment;
	/** Stable pointer to the library-level fieldset; the fieldset is not duplicated per object. */
	readonly overlapRef: 'badgeEvidence.m2Library.overlap';
	/** Raw-source trace when this representation came from the expanded-frame probe. */
	readonly rawTrace?: M2TargetRawTrace;
}

function sorted(values: Iterable<number>): Uint32Array {
	return Uint32Array.from([...new Set(values)].sort((a, b) => a - b));
}

function asSet(values: Iterable<number>): Set<number> {
	return new Set(values);
}

function difference(left: Set<number>, right: Set<number>): Uint32Array {
	return sorted([...left].filter((value) => !right.has(value)));
}

function intersection(left: Set<number>, right: Set<number>): Uint32Array {
	return sorted([...left].filter((value) => right.has(value)));
}

function fingerprint(values: Iterable<readonly [number, number]>): string {
	return [...values]
		.sort((a, b) => a[1] - b[1] || a[0] - b[0])
		.map(([x, y]) => `${x}:${y}`)
		.join(',');
}

function pixelXY(specimen: MaterializedBadgeEvidence, pixel: number): readonly [number, number] {
	const x = pixel % specimen.raster.width;
	return [x, (pixel - x) / specimen.raster.width];
}

export function m2RegistrationBounds(
	specimen: MaterializedBadgeEvidence
): readonly [number, number, number, number] {
	if (!specimen.ownedBwPixels.length) throw new Error(`${specimen.id}: M1 has no owned pixels`);
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const pixel of specimen.ownedBwPixels) {
		const [x, y] = pixelXY(specimen, pixel);
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}
	return [minX, minY, maxX - minX + 1, maxY - minY + 1];
}

function localKey(specimen: MaterializedBadgeEvidence, pixel: number): string {
	const [x0, y0] = m2RegistrationBounds(specimen);
	const [x, y] = pixelXY(specimen, pixel);
	return `${x - x0},${y - y0}`;
}

function localCoordinate(
	specimen: MaterializedBadgeEvidence,
	pixel: number
): readonly [number, number] {
	const [x0, y0] = m2RegistrationBounds(specimen);
	const [x, y] = pixelXY(specimen, pixel);
	return [x - x0, y - y0];
}

export const m2LocalCoordinate = localCoordinate;

interface M2CanonicalFrame {
	readonly width: number;
	readonly height: number;
}

/**
 * Map a pixel-center from one M1-relative frame to a common integer frame.
 *
 * M1 supplies the only geometry used here: the tight owned B+W bbox.  The
 * candidate support ring is represented by local coordinates -1..width (and
 * -1..height), so candidates immediately outside the object remain visible.
 * When bbox sizes differ, pixel centers are linearly mapped into the largest
 * observed ring and rounded to its integer lattice.  This is intentionally a
 * small, explicit registration rule; it is not a geometric fit or a new
 * detector.  Collisions are counted once per specimen at a canonical cell.
 */
function canonicalCoordinate(
	specimen: MaterializedBadgeEvidence,
	pixel: number,
	frame: M2CanonicalFrame,
	anchor?: readonly [number, number, number, number]
): readonly [number, number] {
	const [x0, y0, width, height] = anchor ?? m2RegistrationBounds(specimen);
	const [x, y] = pixelXY(specimen, pixel);
	const sourceWidth = width + 2;
	const sourceHeight = height + 2;
	const sourceX = x - x0 + 1;
	const sourceY = y - y0 + 1;
	const canonicalX = Math.round(((sourceX + 0.5) * frame.width) / sourceWidth - 0.5);
	const canonicalY = Math.round(((sourceY + 0.5) * frame.height) / sourceHeight - 0.5);
	return [canonicalX - 1, canonicalY - 1];
}

export function m2CanonicalCoordinate(
	specimen: MaterializedBadgeEvidence,
	pixel: number,
	canonicalSize: readonly [number, number]
): readonly [number, number] {
	if (!canonicalSize.every((value) => Number.isInteger(value) && value >= 3))
		throw new RangeError('M2 canonical size must be integer dimensions of at least 3');
	return canonicalCoordinate(specimen, pixel, {
		width: canonicalSize[0],
		height: canonicalSize[1]
	});
}

function maxObjectFrame(specimens: readonly MaterializedBadgeEvidence[]): M2CanonicalFrame {
	if (!specimens.length) throw new Error('M2 overlap field needs at least one specimen');
	let width = 0;
	let height = 0;
	for (const specimen of specimens) {
		const [, , specimenWidth, specimenHeight] = m2RegistrationBounds(specimen);
		width = Math.max(width, specimenWidth + 2);
		height = Math.max(height, specimenHeight + 2);
	}
	return { width, height };
}

function maxDigitFrame(
	specimens: readonly MaterializedBadgeEvidence[],
	index: number,
	character: string
): M2CanonicalFrame {
	let maxWidth = 3;
	let maxHeight = 3;
	for (const specimen of specimens) {
		const label = specimen.badge.label;
		for (const [digitIndex, digit] of specimen.badge.digits.entries()) {
			if (
				label !== null &&
				label[digitIndex] === digit.predicted &&
				digit.predicted === character &&
				digitIndex === index
			) {
				maxWidth = Math.max(maxWidth, digit.bbox[2] + 2);
				maxHeight = Math.max(maxHeight, digit.bbox[3] + 2);
			}
		}
	}
	return { width: maxWidth, height: maxHeight };
}

function validDigitContextForPixel(
	specimen: MaterializedBadgeEvidence,
	pixel: number
): DigitContext | null {
	const context = digitContext(specimen, pixel);
	return context?.valid ? context : null;
}

function supportObservationMap(
	observations: Map<string, { coordinate: readonly [number, number]; ids: Set<string> }>,
	eligibleSampleIds: readonly string[]
): readonly M2OverlapObservation[] {
	return [...observations.entries()]
		.sort(([, left], [, right]) => left.coordinate[1] - right.coordinate[1] || left.coordinate[0] - right.coordinate[0])
		.map(([, value]) => ({
			localPixel: value.coordinate,
			numOverlaps: value.ids.size,
			eligibleCount: eligibleSampleIds.length,
			overlapFraction: eligibleSampleIds.length ? value.ids.size / eligibleSampleIds.length : 0,
			contributorIds: [...value.ids].sort()
		}));
}

function specimenIds(specimens: readonly MaterializedBadgeEvidence[]): string[] {
	const ids = new Set<string>();
	for (const specimen of specimens) {
		if (ids.has(specimen.id)) throw new Error(`duplicate M2 overlap specimen '${specimen.id}'`);
		ids.add(specimen.id);
	}
	return [...ids];
}

/** Build the global structural recurrence field from every supplied sample. */
export function buildM2StructuralOverlapField(
	specimens: readonly MaterializedBadgeEvidence[]
): M2OverlapField {
	const ids = specimenIds(specimens);
	const frame = maxObjectFrame(specimens);
	const map = new Map<string, { coordinate: readonly [number, number]; ids: Set<string> }>();
	const contributions: M2OverlapContribution[] = [];
	let excludedCandidateCount = 0;
	for (const specimen of specimens) {
		const seen = new Set<string>();
		const sourcePixels = new Set(specimen.aaPixels);
		let sourceCandidateCount = 0;
		for (const pixel of sourcePixels) {
			// A validated digit is a separate coordinate population.  An
			// unvalidated digit is intentionally excluded rather than guessed.
			if (digitContext(specimen, pixel)) {
				excludedCandidateCount++;
				continue;
			}
			sourceCandidateCount++;
			const coordinate = canonicalCoordinate(specimen, pixel, frame);
			const key = `${coordinate[0]},${coordinate[1]}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const observation = map.get(key) ?? { coordinate, ids: new Set<string>() };
			observation.ids.add(specimen.id);
			map.set(key, observation);
		}
		contributions.push({
			sampleId: specimen.id,
			sourceCandidateCount,
			uniqueCanonicalCellCount: seen.size,
			collisionCount: sourceCandidateCount - seen.size
		});
	}
	return {
		channel: 'structural',
		coordinateFrame: 'm1-bbox-plus-one-support-ring',
		canonicalSize: [frame.width, frame.height],
		sampleIds: ids,
		eligibleSampleIds: ids,
		contributions,
		excludedCandidateCount,
		observations: supportObservationMap(map, ids)
	};
}

/**
 * Build one digit-conditioned recurrence field.  It is keyed by the
 * validated digit's position and character, and coordinates are relative to
 * that digit bbox rather than pretending different glyphs share the same
 * object-local geometry.
 */
export function buildM2DigitConditionedOverlapField(
	specimens: readonly MaterializedBadgeEvidence[],
	index: number,
	character: string
): M2OverlapField {
	const ids = specimenIds(specimens);
	const eligible = specimens.filter((specimen) =>
		specimen.badge.label !== null &&
		specimen.badge.label[index] === character &&
		specimen.badge.digits[index]?.predicted === character
	);
	const eligibleIds = eligible.map((specimen) => specimen.id);
	const frame = maxDigitFrame(specimens, index, character);
	const map = new Map<string, { coordinate: readonly [number, number]; ids: Set<string> }>();
	const contributions: M2OverlapContribution[] = [];
	let excludedCandidateCount = 0;
	for (const specimen of eligible) {
		const digit = specimen.badge.digits[index];
		if (!digit) continue;
		const seen = new Set<string>();
		const sourcePixels = new Set(specimen.aaPixels);
		let sourceCandidateCount = 0;
		for (const pixel of sourcePixels) {
			const context = validDigitContextForPixel(specimen, pixel);
			if (!context || context.index !== index || context.character !== character) {
				excludedCandidateCount++;
				continue;
			}
			sourceCandidateCount++;
			const coordinate = canonicalCoordinate(specimen, pixel, frame, digit.bbox);
			const key = `${coordinate[0]},${coordinate[1]}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const observation = map.get(key) ?? { coordinate, ids: new Set<string>() };
			observation.ids.add(specimen.id);
			map.set(key, observation);
		}
		contributions.push({
			sampleId: specimen.id,
			sourceCandidateCount,
			uniqueCanonicalCellCount: seen.size,
			collisionCount: sourceCandidateCount - seen.size
		});
	}
	return {
		channel: 'digit-conditioned',
		coordinateFrame: 'digit-bbox-plus-one-support-ring',
		canonicalSize: [frame.width, frame.height],
		sampleIds: ids,
		eligibleSampleIds: eligibleIds,
		contributions,
		digitCondition: { index, character },
		excludedCandidateCount,
		observations: supportObservationMap(map, eligibleIds)
	};
}

/** Materialize both non-overlapping observational channels for an E library. */
export function buildM2OverlapFieldSet(
	specimens: readonly MaterializedBadgeEvidence[]
): M2OverlapFieldSet {
	const structural = buildM2StructuralOverlapField(specimens);
	const descriptors = new Set<string>();
	for (const specimen of specimens) {
		const label = specimen.badge.label;
		if (label === null) continue;
		for (const [index, digit] of specimen.badge.digits.entries()) {
			if (label[index] !== digit.predicted) continue;
			const key = `${index}:${digit.predicted}`;
			descriptors.add(key);
		}
	}
	const digitConditioned = [...descriptors]
		.sort()
		.map((descriptor) => {
			const [indexValue, character] = descriptor.split(':');
			return buildM2DigitConditionedOverlapField(
				specimens,
				Number(indexValue),
				character
			);
		});
	return { sampleIds: specimenIds(specimens), structural, digitConditioned };
}

function hasValidatedDigitEvidence(specimen: MaterializedBadgeEvidence): boolean {
	const label = specimen.badge.label;
	if (label === null || specimen.badge.digits.length !== label.length) return false;
	return specimen.badge.digits.every((digit, index) => digit.predicted === label[index]);
}

function adjacentToDigitGeometry(specimen: MaterializedBadgeEvidence, pixel: number): boolean {
	const [x, y] = pixelXY(specimen, pixel);
	for (const digit of specimen.badge.digits) {
		const [x0, y0, width, height] = digit.bbox;
		if (x >= x0 - 1 && x <= x0 + width && y >= y0 - 1 && y <= y0 + height) return true;
	}
	return false;
}

interface DigitContext {
	readonly index: number;
	readonly character: string;
	readonly bbox: readonly [number, number, number, number];
	readonly valid: boolean;
}

function digitContext(specimen: MaterializedBadgeEvidence, pixel: number): DigitContext | null {
	const [x, y] = pixelXY(specimen, pixel);
	const label = specimen.badge.label;
	return (
		specimen.badge.digits
			.map((digit, index) => ({
				index,
				character: digit.predicted,
				bbox: digit.bbox,
				valid:
					label !== null &&
					label.length === specimen.badge.digits.length &&
					label[index] === digit.predicted
			}))
			.find(({ bbox }) => {
				const [x0, y0, width, height] = bbox;
				return x >= x0 - 1 && x <= x0 + width && y >= y0 - 1 && y <= y0 + height;
			}) ?? null
	);
}

function sameDigitContext(
	target: DigitContext,
	peer: DigitContext,
	condition: M2DigitCondition
): boolean {
	if (!peer.valid || peer.character !== target.character) return false;
	if (condition === 'same-digit') return true;
	return peer.index === target.index;
}

function validateOptions(
	options: M2OverlapOptions
): Required<Omit<M2OverlapOptions, 'frameSweep' | 'overlapFieldSet'>> &
	Pick<M2OverlapOptions, 'frameSweep'> {
	const minimumSupportCount = options.minimumSupportCount ?? 2;
	const minimumSupportFraction = options.minimumSupportFraction ?? 1;
	return {
		registrationMethod: options.registrationMethod,
		digitCondition: options.digitCondition ?? 'all',
		minimumSupportCount,
		minimumSupportFraction,
		frameSweep: options.frameSweep
	};
}

/**
 * Judge whether a sequence of increasingly large context frames has stopped
 * discovering repeat-supported signal. The final two exact support sets must
 * match and the final set must not touch the frame boundary.
 */
export function assessM2FrameSweep(samples: readonly M2FrameSweepSample[]): M2FrameAssessment {
	if (!samples.length)
		return {
			status: 'not-measured',
			samples: 0,
			latestMarginPx: null,
			stableSet: false,
			boundarySupportedPixelCount: 0,
			unobservedSampleCount: 0,
			latestSetFingerprint: null,
			sweep: [],
			reason: 'no expanded context frames were materialized'
		};
	const ordered = [...samples].sort((a, b) => a.marginPx - b.marginPx);
	const latest = ordered[ordered.length - 1];
	const prior = ordered.length > 1 ? ordered[ordered.length - 2] : undefined;
	const latestSetFingerprint = fingerprint(latest.supportedPixels);
	const stableSet = !!prior && latestSetFingerprint === fingerprint(prior.supportedPixels);
	const unobservedSampleCount = latest.unobservedSampleCount ?? 0;
	const adequate =
		stableSet && latest.boundarySupportedPixelCount === 0 && unobservedSampleCount === 0;
	const sweep = ordered.map((sample) => ({
		...sample,
		supportedPixels: sample.supportedPixels.map(([x, y]) => [x, y] as const)
	}));
	return {
		status: adequate ? 'adequate' : 'insufficient',
		samples: ordered.length,
		latestMarginPx: latest.marginPx,
		stableSet,
		boundarySupportedPixelCount: latest.boundarySupportedPixelCount,
		unobservedSampleCount,
		latestSetFingerprint,
		sweep,
		reason: adequate
			? 'repeat-supported set stabilized across the final expansion and clears the boundary'
			: unobservedSampleCount > 0
				? 'source/crop truncation leaves part of the latest frame unobserved'
				: !stableSet
					? 'repeat-supported set changed at the latest expansion'
					: 'repeat-supported signal still touches the latest frame boundary'
	};
}

/**
 * Compute exact M1→M2 accounting from retained pixel identities. This is a
 * projection over sets, not a score and not a detector: M1 pixels are copied
 * verbatim and only supplied AA candidates may expand the M2 universe.
 */
export function transitionM1ToM2(
	m1AvailablePixels: Iterable<number>,
	m1ExplainedPixels: Iterable<number>,
	discoveredPixels: Iterable<number>,
	newlyExplainedPixels: Iterable<number>
): { m1: M2KnownSetAccounting; m2: M2KnownSetAccounting; transition: M2TransitionAccounting } {
	const m1Available = asSet(m1AvailablePixels);
	const m1Explained = asSet(m1ExplainedPixels);
	const discovered = asSet(discoveredPixels);
	const newlyExplained = asSet(newlyExplainedPixels);
	if ([...m1Explained].some((pixel) => !m1Available.has(pixel)))
		throw new Error('M1 explained pixels must be a subset of M1 available pixels');
	if ([...discovered].some((pixel) => m1Available.has(pixel)))
		throw new Error('M2 discovered pixels must be new relative to M1 available pixels');
	if ([...newlyExplained].some((pixel) => !discovered.has(pixel)))
		throw new Error('M2 newly explained pixels must be a subset of discovered pixels');
	const m2Available = new Set([...m1Available, ...discovered]);
	const m2Explained = new Set([...m1Explained, ...newlyExplained]);
	if ([...m2Explained].some((pixel) => !m2Available.has(pixel)))
		throw new Error('M2 explained pixels must be a subset of M2 available pixels');
	const preserved = intersection(m1Explained, m2Explained);
	const lost = difference(m1Explained, m2Explained);
	const unexplained = difference(m2Available, m2Explained);
	const stillUnexplained = difference(discovered, m2Explained);
	return {
		m1: {
			availablePixels: sorted(m1Available),
			explainedPixels: sorted(m1Explained),
			unexplainedPixels: difference(m1Available, m1Explained)
		},
		m2: {
			availablePixels: sorted(m2Available),
			explainedPixels: sorted(m2Explained),
			unexplainedPixels: unexplained
		},
		transition: {
			preservedPixels: preserved,
			lostPixels: lost,
			discoveredPixels: sorted(discovered),
			newlyExplainedPixels: sorted(newlyExplained),
			stillUnexplainedPixels: stillUnexplained,
			regressionLoss: m1Explained.size ? lost.length / m1Explained.size : null,
			discoveryLoss: discovered.size ? stillUnexplained.length / discovered.size : null
		}
	};
}

function findOverlapObservation(
	field: M2OverlapField,
	coordinate: readonly [number, number]
): M2OverlapObservation | undefined {
	return field.observations.find(
		(observation) =>
			observation.localPixel[0] === coordinate[0] &&
			observation.localPixel[1] === coordinate[1]
	);
}

function targetOverlapObservation(
	target: MaterializedBadgeEvidence,
	pixel: number,
	fields: M2OverlapFieldSet
): { observation?: M2OverlapObservation; class: M2SupportClass } {
	const context = digitContext(target, pixel);
	if (context && !context.valid) return { class: 'unsupported' };
	if (context) {
		const field = fields.digitConditioned.find(
			(candidate) =>
				candidate.digitCondition?.index === context.index &&
				candidate.digitCondition.character === context.character
		);
		if (field) {
			const coordinate = canonicalCoordinate(
				target,
				pixel,
				{ width: field.canonicalSize[0], height: field.canonicalSize[1] },
				context.bbox
			);
			const observation = findOverlapObservation(field, coordinate);
			return {
				observation,
				class: observation && observation.numOverlaps > 1 ? 'digit-conditioned' : 'unresolved'
			};
		}
		return { class: 'unresolved' };
	}
	const coordinate = m2CanonicalCoordinate(target, pixel, fields.structural.canonicalSize);
	const observation = findOverlapObservation(fields.structural, coordinate);
	return {
		observation,
		// This label is a projection for the legacy observation shape only.
		// The complete numOverlaps field remains authoritative; one specimen is
		// intentionally not called "common".
		class: observation && observation.numOverlaps > 1 ? 'structural-common' : 'unresolved'
	};
}

/** Materialize one Badge M2 from the existing Badge AA candidates. */
export function materializeBadgeM2Representation(
	target: MaterializedBadgeEvidence,
	peers: readonly MaterializedBadgeEvidence[],
	options: M2OverlapOptions
): MaterializedBadgeM2Representation {
	const resolved = validateOptions(options);
	const specimens = [target, ...peers];
	const ids = new Set<string>();
	for (const specimen of specimens) {
		if (ids.has(specimen.id)) throw new Error(`duplicate M2 specimen id '${specimen.id}'`);
		ids.add(specimen.id);
		const owned = asSet(specimen.ownedBwPixels);
		const aa = asSet(specimen.aaPixels);
		if ([...owned].some((pixel) => aa.has(pixel)))
			throw new Error(`${specimen.id}: M1-owned and AA candidate pixels overlap`);
	}
	const overlap = options.overlapFieldSet ?? buildM2OverlapFieldSet(specimens);
	const alignedSampleIds = overlap.sampleIds;
	const excludedSampleIds: string[] = [];
	const candidatePixels = sorted(target.aaPixels);
	const observations: M2SupportObservation[] = [];
	for (const pixel of candidatePixels) {
		const resolvedObservation = targetOverlapObservation(target, pixel, overlap);
		const support = resolvedObservation.observation;
		const [x, y] = localCoordinate(target, pixel);
		observations.push({
			localPixel: [x, y],
			supportCount: support?.numOverlaps ?? 0,
			alignedSampleCount: support?.eligibleCount ?? 0,
			supportFraction: support?.overlapFraction ?? 0,
			class: resolvedObservation.class,
			sampleIds: [...(support?.contributorIds ?? [])]
		});
	}
	// Count recurrence is an observation, never an ownership promotion.  The
	// first M2 slice deliberately leaves every newly recognized candidate
	// unexplained until a later, explicitly named refinement consumes it.
	const frame = assessM2FrameSweep([]);
	const graduatedAa: number[] = [];
	const provisionalAa: number[] = [];
	const unresolvedAa = candidatePixels;
	const accounting = transitionM1ToM2(
		target.ownedBwPixels,
		target.ownedBwPixels,
		candidatePixels,
		graduatedAa
	);
	const digitCondition = resolved.digitCondition;
	return {
		schema: M2_REPRESENTATION_SCHEMA,
		objectId: target.id,
		registration: {
			method: resolved.registrationMethod,
			sampleCount: specimens.length,
			alignedSampleCount: specimens.length,
			sampleUnit: 'distinct-badge-objects',
			alignedSampleIds,
			excludedSampleIds,
			alignment: 'exact-m1-owned-bbox-dimensions-plus-top-left-translation',
			digitCondition,
			minimumSupportCount: resolved.minimumSupportCount,
			minimumSupportFraction: resolved.minimumSupportFraction,
			provenance:
				resolved.registrationMethod === 'same-raster-m1-geometry'
					? 'same-raster recurrence over independently addressed M1 badge geometries; not multisampling'
					: 'independently registered materialized samples'
		},
		m1: accounting.m1,
		m2: accounting.m2,
		aa: {
			candidatePixels,
			explainedPixels: sorted(graduatedAa),
			provisionalPixels: sorted(provisionalAa),
			unresolvedPixels: sorted(unresolvedAa),
			observations
		},
		transition: accounting.transition,
		frame,
		overlapRef: 'badgeEvidence.m2Library.overlap'
	};
}

/** Stable content payload for the E/Storybook seam. */
export function encodeMaterializedBadgeM2Representation(
	value: MaterializedBadgeM2Representation
): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify(value, (_key, field: unknown) =>
			field instanceof Uint32Array
				? { $chainspotTypedArray: 'u32', data: Array.from(field) }
				: field
		)
	);
}

export function decodeMaterializedBadgeM2Representation(
	bytes: Uint8Array
): MaterializedBadgeM2Representation {
	const value = JSON.parse(new TextDecoder().decode(bytes), (_key, field: unknown) => {
		if (!field || typeof field !== 'object' || !('$chainspotTypedArray' in field)) return field;
		const tagged = field as { $chainspotTypedArray: unknown; data: unknown };
		if (tagged.$chainspotTypedArray !== 'u32' || !Array.isArray(tagged.data))
			throw new Error('M2 representation has an unsupported typed-array payload');
		return Uint32Array.from(tagged.data);
	}) as MaterializedBadgeM2Representation;
	if (value.schema !== M2_REPRESENTATION_SCHEMA)
		throw new Error(`unsupported M2 representation schema '${String(value.schema)}'`);
	return value;
}

/* ------------------------------------------------------------------------- *
 * M2 expanded-frame raw-source probe
 *
 * The functions above are retained as a wire-compatible adapter for old E
 * artifacts.  New M2 work must use the probe below.  In particular, the
 * probe never uses aaPixels, residuePixels, or region.rgba to discover a
 * repeat.  It reads every requested crop directly from the full RGBA source.
 * ------------------------------------------------------------------------- */

export const M2_RAW_SOURCE_PROBE_SCHEMA = 'chainspot.badge-m2-raw-source/v1' as const;

export type M2RawPartition = 'm1-owned' | 'old-aa' | 'old-residue' | 'exterior';

export interface M2RawSourceProbeOptions {
	/** First symmetric context margin. The contract's old region was ±1. */
	readonly startMarginPx?: number;
	/** Alias accepted by callers that name the sweep fields explicitly. */
	readonly marginStartPx?: number;
	/** Symmetric margin increment. */
	readonly marginStepPx?: number;
	/** Last margin to try before returning explicit insufficient/UNKNOWN. */
	readonly safetyCapMarginPx?: number;
	/** Alias for safetyCapMarginPx. */
	readonly maxMarginPx?: number;
	/** Authoritative minimum exact-RGBA support among eligible specimens. */
	readonly minimumSupportCount?: number;
	/** Diagnostic quantizer only; it never changes the exact verdict. */
	readonly quantizedBinWidth?: number;
	/** Ownership remains OFF unless an independent measured control passes. */
	readonly ownershipGate?: {
		readonly status: 'measured' | 'unknown';
		readonly significant: boolean;
		readonly criterion: string;
	};
}

export interface M2RawSourceProbeInput {
	readonly image: RgbaImage;
	readonly specimens: readonly MaterializedBadgeEvidence[];
	readonly m1: MaterializedM1Representation;
	readonly options?: M2RawSourceProbeOptions;
}

export interface M2RawSourceProbeWithControlOptions extends M2RawSourceProbeOptions {
	readonly control: Omit<M2RawFrameStatsControlOptions, 'imageId' | 'paramsHash' | 'featureId'> & {
		readonly alpha?: number;
	};
}

export interface M2RawRegistration {
	readonly sampleId: string;
	readonly m1ObjectId: string;
	/** Tight bbox computed from that object's M1-owned pixels. */
	readonly ownedBbox: readonly [number, number, number, number];
	/** Translation only: source = bbox top-left + local coordinate. */
	readonly translation: readonly [number, number];
	readonly glyphExactCount: number;
	readonly glyphHaloCount: number;
	readonly glyphExactCoordinates: readonly (readonly [number, number])[];
	readonly glyphHaloCoordinates: readonly (readonly [number, number])[];
	readonly sourceFrame: 'full-rgba-image';
	readonly provenance: string;
}

export interface M2RawValueGroup {
	readonly rgba: readonly [number, number, number, number];
	readonly sampleIds: readonly string[];
	readonly count: number;
}

export interface M2RawQuantizedValueGroup {
	readonly bins: readonly [number, number, number, number];
	readonly sampleIds: readonly string[];
	readonly count: number;
}

export interface M2RawCoordinateObservation {
	readonly localPixel: readonly [number, number];
	readonly eligibleSampleIds: readonly string[];
	readonly exactGroups: readonly M2RawValueGroup[];
	readonly quantizedGroups: readonly M2RawQuantizedValueGroup[];
	readonly exactSupportCount: number;
	readonly exactSupported: boolean;
	/** Lexicographically deterministic modal tuple (ties choose lowest tuple). */
	readonly modalRgba: readonly [number, number, number, number] | null;
	readonly modalSupportCount: number;
	readonly modalSupportFraction: number;
	/** Per-channel sample standard deviation over eligible observations. */
	readonly sampleSd: readonly [number, number, number, number] | null;
	readonly sampleSdDenominator: 'n-1' | null;
	readonly nullModel: {
		readonly p: 0.5;
		readonly sampleCount: number;
		readonly probabilityAllMatch: number | null;
		readonly percentAllMatch: number | null;
	};
	readonly quantizedSupportCount: number;
	readonly quantizedSupported: boolean;
}

export interface M2RawBoundarySides {
	readonly left: M2RawBoundarySide;
	readonly right: M2RawBoundarySide;
	readonly top: M2RawBoundarySide;
	readonly bottom: M2RawBoundarySide;
	readonly total: number;
	readonly status: 'clear' | 'supported' | 'unknown';
}

export interface M2RawBoundarySide {
	readonly count: number;
	readonly status: 'clear' | 'supported' | 'unknown';
	/** Samples clipped on this side of the requested source crop. */
	readonly affectedSampleIds: readonly string[];
}

export interface M2RawMarginTrace {
	readonly marginPx: number;
	readonly frameSize: readonly [number, number];
	readonly observations: readonly M2RawCoordinateObservation[];
	readonly exactSupportedCoordinates: readonly (readonly [number, number])[];
	readonly exactModalSupportedCoordinates: readonly (readonly [number, number])[];
	readonly quantizedSupportedCoordinates: readonly (readonly [number, number])[];
	readonly exactBoundary: M2RawBoundarySides;
	readonly quantizedBoundary: M2RawBoundarySides;
	readonly clippedSampleIds: readonly string[];
	readonly unobservedSampleCount: number;
	readonly status: 'measured' | 'unknown';
}

export interface M2RawTargetPartition {
	readonly targetId: string;
	readonly exactSupportedCoordinates: readonly (readonly [number, number])[];
	readonly exactOwnedCoordinates: readonly (readonly [number, number])[];
	readonly byPartition: Readonly<Record<M2RawPartition, readonly (readonly [number, number])[]>>;
	readonly counts: Readonly<Record<M2RawPartition, number>>;
}

export interface M2TargetRawTrace {
	readonly targetId: string;
	readonly finalMarginPx: number | null;
	/** Final-margin raw observations for this target, before partition tagging. */
	readonly observations: readonly M2RawCoordinateObservation[];
	readonly finalExactSupportedCoordinates: readonly (readonly [number, number])[];
	readonly exactOwnedCoordinates: readonly (readonly [number, number])[];
	readonly partition: M2RawTargetPartition;
}

export interface M2RawSourceProbeTrace {
	readonly algorithm: {
		readonly exact: {
			readonly authoritative: true;
			readonly equality: 'exact-rgba-tuple';
		readonly tuple: '(r,g,b,a)';
		readonly minimumSupportCount: number;
		readonly nullModel: {
			readonly p: 0.5;
			readonly eighteenSampleProbability: 3.814697265625e-6;
			readonly eighteenSamplePercent: 0.0003814697265625;
			readonly assumption: 'independent Bernoulli trials';
		};
		};
		readonly quantized: {
			readonly authoritative: false;
			readonly equality: 'floor-channel-bin';
			readonly binWidth: number;
			readonly equation: 'q(c)=floor(c/binWidth)';
		};
		readonly modelProvenance: string;
	};
	/** Deterministic circular-shift control, when the one-call seam ran it. */
	readonly control?: M2RawFrameStatsControl;
	readonly statistics?: M2RawFrameStatsControl;
	readonly margins: readonly M2RawMarginTrace[];
	readonly registrations: readonly M2RawRegistration[];
	readonly excludedSampleIds: readonly string[];
	readonly final: {
		readonly status: 'adequate' | 'insufficient' | 'unknown';
		readonly reason: string;
		readonly targets: readonly M2TargetRawTrace[];
		readonly exactSupportedCoordinates: readonly (readonly [number, number])[];
		readonly exactModalSupportedCoordinates: readonly (readonly [number, number])[];
		readonly quantizedSupportedCoordinates: readonly (readonly [number, number])[];
		readonly finalMarginPx: number | null;
		readonly ownership: {
			readonly promoted: boolean;
			readonly criterion: string;
		};
	};
}

export interface MaterializedExpandedBadgeRawFrameProbe {
	readonly schema: typeof M2_RAW_SOURCE_PROBE_SCHEMA;
	readonly state: 'materialized' | 'insufficient';
	readonly provenance: {
		readonly source: 'full-rgba-image';
		readonly exactBaseline: 'authoritative';
		readonly quantizedDiagnostic: 'non-authoritative';
		readonly jpegCaveat: string;
	};
	readonly trace: M2RawSourceProbeTrace;
	readonly representations: readonly MaterializedBadgeM2Representation[];
	readonly statistics?: M2RawFrameStatsControl;
}

type RawRegistrationInternal = M2RawRegistration & {
	readonly specimen: MaterializedBadgeEvidence;
	readonly m1OwnedSet: ReadonlySet<number>;
	readonly glyphExactSet: ReadonlySet<string>;
	readonly glyphHaloSet: ReadonlySet<string>;
	};

function rawKey(x: number, y: number): string {
	return `${x},${y}`;
}

function sortedCoordinates(values: Iterable<string>): readonly (readonly [number, number])[] {
	return [...new Set(values)]
		.map((value) => value.split(',').map(Number) as [number, number])
		.sort((a, b) => a[1] - b[1] || a[0] - b[0])
		.map(([x, y]) => [x, y] as const);
}

function rawRgba(image: RgbaImage, x: number, y: number): readonly [number, number, number, number] {
	const offset = (y * image.width + x) * 4;
	return [image.data[offset] ?? 0, image.data[offset + 1] ?? 0, image.data[offset + 2] ?? 0, image.data[offset + 3] ?? 0];
}

function rawM1Object(
	 specimen: MaterializedBadgeEvidence,
	 m1: MaterializedM1Representation
): { object: NonNullable<MaterializedM1Representation['objects'][number]>; bbox: readonly [number, number, number, number] } | null {
	const object = m1.objects.find((candidate) => candidate.id === specimen.id && candidate.kind === 'badge');
	if (!object || object.accounting.status !== 'known' || !object.accounting.availablePixels.length) return null;
	const pixels = object.accounting.availablePixels;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const pixel of pixels) {
		const x = pixel % m1.raster.width;
		const y = Math.floor(pixel / m1.raster.width);
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}
	return { object, bbox: [minX, minY, maxX - minX + 1, maxY - minY + 1] };
}

function registrationFor(
	specimen: MaterializedBadgeEvidence,
	m1: MaterializedM1Representation,
	image: RgbaImage
): RawRegistrationInternal | null {
	const found = rawM1Object(specimen, m1);
	if (!found) return null;
	const [x0, y0, width, height] = found.bbox;
	const exact = new Set<string>();
	for (const use of found.object.componentUses) {
		if (use.role !== 'glyph') continue;
		const component = m1.components.find((candidate) => candidate.id === use.componentId);
		if (!component) continue;
		for (const pixel of component.pixels) {
			const x = pixel % m1.raster.width;
			const y = Math.floor(pixel / m1.raster.width);
			exact.add(rawKey(x - x0, y - y0));
		}
	}
	const halo = new Set<string>();
	for (const value of exact) {
		const [x, y] = value.split(',').map(Number);
		for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
			if (dx === 0 && dy === 0) continue;
			const xx = x + dx;
			const yy = y + dy;
			halo.add(rawKey(xx, yy));
		}
	}
	for (const value of exact) halo.delete(value);
	const clippedSides = [x0 < 0 ? 'left' : '', y0 < 0 ? 'top' : '', x0 + width > image.width ? 'right' : '', y0 + height > image.height ? 'bottom' : ''].filter(Boolean);
	return {
		sampleId: specimen.id,
		m1ObjectId: found.object.id,
		ownedBbox: found.bbox,
		translation: [x0, y0],
		glyphExactCount: exact.size,
		glyphHaloCount: halo.size,
		glyphExactCoordinates: sortedCoordinates(exact),
		glyphHaloCoordinates: sortedCoordinates(halo),
		sourceFrame: 'full-rgba-image',
		provenance: `M1 owned bbox [${found.bbox.join(',')}], integer top-left translation only; glyph exact components + 1px halo; no resampling/fit${clippedSides.length ? `; source clipping=${clippedSides.join('|')}` : ''}`,
		specimen,
		glyphExactSet: exact,
		glyphHaloSet: halo,
		m1OwnedSet: new Set(found.object.accounting.status === 'known' ? found.object.accounting.availablePixels : [])
	};
}

function quantizedRgba(
	rgba: readonly [number, number, number, number],
	binWidth: number
): readonly [number, number, number, number] {
	return [
		Math.floor(rgba[0] / binWidth),
		Math.floor(rgba[1] / binWidth),
		Math.floor(rgba[2] / binWidth),
		Math.floor(rgba[3] / binWidth)
	];
}

function groupKey(rgba: readonly [number, number, number, number]): string {
	return rgba.join(',');
}

function boundaryFor(
	coordinates: readonly (readonly [number, number])[],
	margin: number,
	baseWidth: number,
	baseHeight: number,
	clippedBySide: Readonly<Record<'left' | 'right' | 'top' | 'bottom', readonly string[]>>
): M2RawBoundarySides {
	const count = {
		left: coordinates.filter(([x]) => x === -margin).length,
		right: coordinates.filter(([x]) => x === baseWidth + margin - 1).length,
		top: coordinates.filter(([, y]) => y === -margin).length,
		bottom: coordinates.filter(([, y]) => y === baseHeight + margin - 1).length
	};
	const side = (name: 'left' | 'right' | 'top' | 'bottom'): M2RawBoundarySide => ({
		count: count[name],
		status: clippedBySide[name].length ? 'unknown' : count[name] ? 'supported' : 'clear',
		affectedSampleIds: [...clippedBySide[name]].sort()
	});
	return {
		left: side('left'),
		right: side('right'),
		top: side('top'),
		bottom: side('bottom'),
		total: new Set(coordinates.filter(([x, y]) =>
			x === -margin || x === baseWidth + margin - 1 || y === -margin || y === baseHeight + margin - 1
		).map(([x, y]) => rawKey(x, y))).size,
		status: Object.values(clippedBySide).some((values) => values.length) ? 'unknown' : count.left + count.right + count.top + count.bottom ? 'supported' : 'clear'
	};
}

function scanRawMargin(
	image: RgbaImage,
	registrations: readonly RawRegistrationInternal[],
	margin: number,
	baseWidth: number,
	baseHeight: number,
	minimumSupportCount: number,
	binWidth: number
): M2RawMarginTrace {
	const clippedBySide: Record<'left' | 'right' | 'top' | 'bottom', string[]> = { left: [], right: [], top: [], bottom: [] };
	for (const registration of registrations) {
		const [x, y, width, height] = registration.ownedBbox;
		if (x - margin < 0) clippedBySide.left.push(registration.sampleId);
		if (x + width + margin > image.width) clippedBySide.right.push(registration.sampleId);
		if (y - margin < 0) clippedBySide.top.push(registration.sampleId);
		if (y + height + margin > image.height) clippedBySide.bottom.push(registration.sampleId);
	}
	const clippedSampleIds = [...new Set(Object.values(clippedBySide).flat())].sort();
	const clippedSet = new Set(clippedSampleIds);
	const observations: M2RawCoordinateObservation[] = [];
	const exactSupported: string[] = [];
	const exactModalSupported: string[] = [];
	const quantizedSupported: string[] = [];
	for (let y = -margin; y < baseHeight + margin; y++) {
		for (let x = -margin; x < baseWidth + margin; x++) {
			const exactGroups = new Map<string, { rgba: readonly [number, number, number, number]; ids: string[] }>();
			const quantizedGroups = new Map<string, { bins: readonly [number, number, number, number]; ids: string[] }>();
			const eligibleSampleIds: string[] = [];
			const eligibleRgba: (readonly [number, number, number, number])[] = [];
			for (const registration of registrations) {
				const [, , sampleWidth, sampleHeight] = registration.ownedBbox;
				if (x < -margin || y < -margin || x >= sampleWidth + margin || y >= sampleHeight + margin) continue;
				const local = rawKey(x, y);
				if (registration.glyphExactSet.has(local) || registration.glyphHaloSet.has(local)) continue;
				const [x0, y0] = registration.translation;
				const sourceX = x0 + x;
				const sourceY = y0 + y;
				if (sourceX < 0 || sourceY < 0 || sourceX >= image.width || sourceY >= image.height) continue;
				const rgba = rawRgba(image, sourceX, sourceY);
				eligibleSampleIds.push(registration.sampleId);
				eligibleRgba.push(rgba);
				const exactKey = groupKey(rgba);
				const exactPrior = exactGroups.get(exactKey) ?? { rgba, ids: [] };
				exactPrior.ids.push(registration.sampleId);
				exactGroups.set(exactKey, exactPrior);
				const bins = quantizedRgba(rgba, binWidth);
				const quantizedKey = groupKey(bins);
				const quantizedPrior = quantizedGroups.get(quantizedKey) ?? { bins, ids: [] };
				quantizedPrior.ids.push(registration.sampleId);
				quantizedGroups.set(quantizedKey, quantizedPrior);
			}
			const exactValues = [...exactGroups.values()].sort((a, b) => groupKey(a.rgba).localeCompare(groupKey(b.rgba)));
			const quantizedValues = [...quantizedGroups.values()].sort((a, b) => groupKey(a.bins).localeCompare(groupKey(b.bins)));
			const exactSupportCount = exactValues.reduce((max, group) => Math.max(max, group.ids.length), 0);
			const modalGroup = exactValues.reduce((best, group) => group.ids.length > (best?.ids.length ?? -1) ? group : best, undefined as { rgba: readonly [number, number, number, number]; ids: string[] } | undefined);
			const modalRgba = modalGroup?.rgba ?? null;
			const modalSupportCount = modalGroup?.ids.length ?? 0;
			const modalSupportFraction = eligibleSampleIds.length ? modalSupportCount / eligibleSampleIds.length : 0;
			const sampleSd = eligibleRgba.length >= 2
				? ([0, 1, 2, 3].map((channel) => {
					const mean = eligibleRgba.reduce((sum, value) => sum + value[channel], 0) / eligibleRgba.length;
					return Math.sqrt(eligibleRgba.reduce((sum, value) => sum + (value[channel] - mean) ** 2, 0) / (eligibleRgba.length - 1));
				}) as [number, number, number, number])
				: null;
			const quantizedSupportCount = quantizedValues.reduce((max, group) => Math.max(max, group.ids.length), 0);
			const exactSupportedValue = exactSupportCount >= minimumSupportCount;
			const quantizedSupportedValue = quantizedSupportCount >= minimumSupportCount;
			if (exactSupportedValue) exactSupported.push(rawKey(x, y));
			if (modalSupportCount >= minimumSupportCount) exactModalSupported.push(rawKey(x, y));
			if (quantizedSupportedValue) quantizedSupported.push(rawKey(x, y));
			observations.push({
				localPixel: [x, y],
				eligibleSampleIds: eligibleSampleIds.sort(),
				exactGroups: exactValues.map((group) => ({ rgba: group.rgba, sampleIds: [...group.ids].sort(), count: group.ids.length })),
				quantizedGroups: quantizedValues.map((group) => ({ bins: group.bins, sampleIds: [...group.ids].sort(), count: group.ids.length })),
				exactSupportCount,
				exactSupported: exactSupportedValue,
				modalRgba,
				modalSupportCount,
				modalSupportFraction,
				sampleSd,
				sampleSdDenominator: sampleSd ? 'n-1' : null,
				nullModel: {
					p: 0.5,
					sampleCount: eligibleSampleIds.length,
					probabilityAllMatch: eligibleSampleIds.length === 18 ? 3.814697265625e-6 : null,
					percentAllMatch: eligibleSampleIds.length === 18 ? 0.0003814697265625 : null
				},
				quantizedSupportCount,
				quantizedSupported: quantizedSupportedValue
			});
		}
	}
	const exactCoordinates = sortedCoordinates(exactSupported);
	const quantizedCoordinates = sortedCoordinates(quantizedSupported);
	return {
		marginPx: margin,
		frameSize: [baseWidth + margin * 2, baseHeight + margin * 2],
		observations,
		exactSupportedCoordinates: exactCoordinates,
		exactModalSupportedCoordinates: sortedCoordinates(exactModalSupported),
		quantizedSupportedCoordinates: quantizedCoordinates,
		exactBoundary: boundaryFor(exactCoordinates, margin, baseWidth, baseHeight, clippedBySide),
		quantizedBoundary: boundaryFor(quantizedCoordinates, margin, baseWidth, baseHeight, clippedBySide),
		clippedSampleIds,
		unobservedSampleCount: clippedSet.size,
		status: clippedSet.size ? 'unknown' : 'measured'
	};
}

function targetPartition(
	target: MaterializedBadgeEvidence,
	registration: RawRegistrationInternal,
	coordinates: readonly (readonly [number, number])[],
	ownedCoordinates: readonly (readonly [number, number])[]
): M2RawTargetPartition {
	const m1 = registration.m1OwnedSet;
	const aa = new Set(target.aaPixels);
	const residue = new Set(target.residuePixels);
	const byPartition: Record<M2RawPartition, readonly (readonly [number, number])[]> = {
		'm1-owned': [],
		'old-aa': [],
		'old-residue': [],
		exterior: []
	};
	for (const coordinate of coordinates) {
		const [x, y] = coordinate;
		const sourceX = registration.translation[0] + x;
		const sourceY = registration.translation[1] + y;
		const globalPixel = sourceX >= 0 && sourceY >= 0 && sourceX < target.raster.width && sourceY < target.raster.height
			? sourceY * target.raster.width + sourceX
			: -1;
		const partition: M2RawPartition = globalPixel >= 0 && m1.has(globalPixel)
			? 'm1-owned'
			: globalPixel >= 0 && aa.has(globalPixel)
				? 'old-aa'
				: globalPixel >= 0 && residue.has(globalPixel)
					? 'old-residue'
					: 'exterior';
			(byPartition[partition] as (readonly [number, number])[]).push([x, y]);
	}
	const ordered = Object.fromEntries((Object.keys(byPartition) as M2RawPartition[]).map((key) => [key, byPartition[key].map(([x, y]) => [x, y] as const)])) as unknown as Record<M2RawPartition, readonly (readonly [number, number])[]>;
	return {
		targetId: target.id,
		exactSupportedCoordinates: coordinates,
		exactOwnedCoordinates: ownedCoordinates,
		byPartition: ordered,
		counts: {
			'm1-owned': ordered['m1-owned'].length,
			'old-aa': ordered['old-aa'].length,
			'old-residue': ordered['old-residue'].length,
			exterior: ordered.exterior.length
		}
	};
}

function m1AccountingFor(
	specimen: MaterializedBadgeEvidence,
	m1: MaterializedM1Representation
): M2KnownSetAccounting {
	const object = m1.objects.find((candidate) => candidate.id === specimen.id && candidate.kind === 'badge');
	if (!object || object.accounting.status !== 'known') {
		return { availablePixels: new Uint32Array(), explainedPixels: new Uint32Array(), unexplainedPixels: new Uint32Array() };
	}
	return {
		availablePixels: Uint32Array.from(object.accounting.availablePixels),
		explainedPixels: Uint32Array.from(object.accounting.explainedPixels),
		unexplainedPixels: Uint32Array.from(object.accounting.unexplainedPixels)
	};
}

function rawRepresentation(
	target: MaterializedBadgeEvidence,
	registration: RawRegistrationInternal,
	m1: MaterializedM1Representation,
	margins: readonly M2RawMarginTrace[],
	adequate: boolean,
	minimumSupportCount: number,
	allRegistrations: readonly RawRegistrationInternal[],
	targetTrace: M2TargetRawTrace
): MaterializedBadgeM2Representation {
	const m1Accounting = m1AccountingFor(target, m1);
	const candidatePixels = sorted(target.aaPixels);
	const margin = margins[margins.length - 1];
	const observationByKey = new Map((margin?.observations ?? []).map((observation) => [rawKey(...observation.localPixel), observation]));
	const ownedCoordinateSet = new Set(targetTrace.exactOwnedCoordinates.map(([x, y]) => rawKey(x, y)));
	const observations: M2SupportObservation[] = [];
	for (const pixel of candidatePixels) {
		const x = pixel % target.raster.width - registration.translation[0];
		const y = Math.floor(pixel / target.raster.width) - registration.translation[1];
		const observation = observationByKey.get(rawKey(x, y));
		const group = observation?.exactGroups.reduce((best, value) => value.count > (best?.count ?? 0) ? value : best, undefined as M2RawValueGroup | undefined);
		observations.push({
			localPixel: [x, y],
			supportCount: observation?.exactSupportCount ?? 0,
			alignedSampleCount: observation?.eligibleSampleIds.length ?? 0,
			supportFraction: observation?.eligibleSampleIds.length ? (observation.exactSupportCount / observation.eligibleSampleIds.length) : 0,
			class: observation?.exactSupported ? 'structural-common' : 'unresolved',
			sampleIds: group?.sampleIds ?? []
		});
	}
	const m1Set = new Set(m1Accounting.availablePixels);
	const discovered: number[] = [];
	for (const [x, y] of targetTrace.exactOwnedCoordinates) {
		const sourceX = registration.translation[0] + x;
		const sourceY = registration.translation[1] + y;
		if (sourceX < 0 || sourceY < 0 || sourceX >= target.raster.width || sourceY >= target.raster.height) continue;
		const pixel = sourceY * target.raster.width + sourceX;
		if (!m1Set.has(pixel)) discovered.push(pixel);
	}
	const accounting = transitionM1ToM2(m1Accounting.availablePixels, m1Accounting.explainedPixels, discovered, discovered);
	const provisional: number[] = adequate
		? Array.from(candidatePixels).filter((pixel) => {
			const observation = observationByKey.get(rawKey(pixel % target.raster.width - registration.translation[0], Math.floor(pixel / target.raster.width) - registration.translation[1]));
			return !!observation?.exactSupported && observation.modalSupportCount < allRegistrations.length;
		})
		: [];
	const explainedCandidates: number[] = adequate
		? Array.from(candidatePixels).filter((pixel) => {
			const observation = observationByKey.get(rawKey(pixel % target.raster.width - registration.translation[0], Math.floor(pixel / target.raster.width) - registration.translation[1]));
			const localKey = rawKey(pixel % target.raster.width - registration.translation[0], Math.floor(pixel / target.raster.width) - registration.translation[1]);
			return ownedCoordinateSet.has(localKey) && !!observation && observation.modalSupportCount === allRegistrations.length && observation.eligibleSampleIds.length === allRegistrations.length;
		})
		: [];
	const unresolved = candidatePixels.filter((pixel) => !provisional.includes(pixel) && !explainedCandidates.includes(pixel));
	return {
		schema: M2_REPRESENTATION_SCHEMA,
		objectId: target.id,
		registration: {
			method: 'independent-registered-samples',
			sampleCount: allRegistrations.length,
			alignedSampleCount: allRegistrations.length,
			sampleUnit: 'distinct-badge-objects',
			alignedSampleIds: allRegistrations.map((value) => value.sampleId).sort(),
			excludedSampleIds: [],
			alignment: 'exact-m1-owned-bbox-dimensions-plus-top-left-translation',
			digitCondition: 'all',
			minimumSupportCount,
			minimumSupportFraction: 0,
			provenance: 'full RGBA source expanded-frame recurrence; integer M1 top-left translation only; exact RGBA is authoritative; not JPEG-safe'
		},
		m1: accounting.m1,
		m2: accounting.m2,
		aa: {
			candidatePixels,
			explainedPixels: sorted(explainedCandidates),
			provisionalPixels: sorted(provisional),
			unresolvedPixels: sorted(unresolved),
			observations
		},
		transition: accounting.transition,
		frame: assessM2FrameSweep(margins.map((value) => ({
			marginPx: value.marginPx,
			supportedPixels: value.exactSupportedCoordinates,
			boundarySupportedPixelCount: value.exactBoundary.total,
			unobservedSampleCount: value.unobservedSampleCount
		}))),
		overlapRef: 'badgeEvidence.m2Library.overlap',
		rawTrace: targetTrace
	};
}

/**
 * Materialize the M2 expanded-frame model from the real source raster.
 * Every sample is translated by its M1-owned bbox top-left. No scaling,
 * fitting, candidate mask, residue mask, or pre-cropped region participates
 * in discovery. The final exact support set is the only authoritative result.
 */
export function materializeExpandedBadgeRawFrameProbe(
	input: M2RawSourceProbeInput
): MaterializedExpandedBadgeRawFrameProbe {
	const { image, specimens, m1 } = input;
	if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0)
		throw new RangeError('M2 raw source image dimensions must be positive integers');
	if (image.data.length !== image.width * image.height * 4)
		throw new Error('M2 raw source image RGBA does not match declared dimensions');
	const options = input.options ?? {};
	const start = options.startMarginPx ?? options.marginStartPx ?? 2;
	const step = options.marginStepPx ?? 1;
	const cap = options.safetyCapMarginPx ?? options.maxMarginPx ?? 32;
	const minimumSupportCount = options.minimumSupportCount ?? 2;
	const binWidth = options.quantizedBinWidth ?? 8;
	if (!Number.isInteger(start) || start < 2 || !Number.isInteger(step) || step < 1 || !Number.isInteger(cap) || cap < start)
		throw new RangeError('M2 raw source margins require start >= 2, positive step, and cap >= start');
	if (!Number.isInteger(minimumSupportCount) || minimumSupportCount < 2)
		throw new RangeError('M2 exact RGBA minimum support must be an integer >= 2');
	if (!Number.isInteger(binWidth) || binWidth < 1)
		throw new RangeError('M2 quantized RGBA bin width must be a positive integer');
	const ids = new Set<string>();
	for (const specimen of specimens) {
		if (ids.has(specimen.id)) throw new Error(`duplicate M2 raw specimen id '${specimen.id}'`);
		ids.add(specimen.id);
	}
	const registrations: RawRegistrationInternal[] = [];
	const excludedSampleIds: string[] = [];
	for (const specimen of [...specimens].sort((a, b) => a.id.localeCompare(b.id))) {
		if (specimen.raster.width !== image.width || specimen.raster.height !== image.height) {
			excludedSampleIds.push(specimen.id);
			continue;
		}
		const registration = registrationFor(specimen, m1, image);
		if (registration) registrations.push(registration);
		else excludedSampleIds.push(specimen.id);
	}
	const baseWidth = registrations.length ? Math.max(...registrations.map((value) => value.ownedBbox[2])) : 0;
	const baseHeight = registrations.length ? Math.max(...registrations.map((value) => value.ownedBbox[3])) : 0;
	const margins: M2RawMarginTrace[] = [];
	const sampleCountValid = specimens.length === 18;
	const ownershipGate = options.ownershipGate;
	const ownershipEnabled = ownershipGate?.status === 'measured' && ownershipGate.significant;
	let status: 'adequate' | 'insufficient' | 'unknown' = registrations.length && sampleCountValid && !excludedSampleIds.length ? 'insufficient' : 'unknown';
	let reason = !sampleCountValid
		? `expected exactly 18 distinct MaterializedBadgeEvidence samples; received ${specimens.length}`
		: excludedSampleIds.length
			? `M1 registration unavailable for samples: ${excludedSampleIds.join(', ')}`
			: 'safety cap reached before exact support stabilized and cleared every boundary';
	let finalMargin: M2RawMarginTrace | undefined;
	let previous: M2RawMarginTrace | undefined;
	for (let margin = start; margin <= cap; margin += step) {
		const current = scanRawMargin(image, registrations, margin, baseWidth, baseHeight, minimumSupportCount, binWidth);
		margins.push(current);
		finalMargin = current;
		const stable = !!previous && fingerprint(previous.exactSupportedCoordinates) === fingerprint(current.exactSupportedCoordinates);
		if (sampleCountValid && !excludedSampleIds.length && stable && current.unobservedSampleCount === 0 && current.exactBoundary.total === 0) {
			status = 'adequate';
			reason = 'exact RGBA repeat support stabilized and clears every untruncated frame boundary';
			break;
		}
		previous = current;
	}
	if (status !== 'adequate' && finalMargin?.unobservedSampleCount) {
		status = 'unknown';
		reason = !sampleCountValid
			? `${reason}; source clipping leaves part of the latest expanded frame unobserved`
			: 'source clipping leaves part of the latest expanded frame unobserved';
	}
	const targets: M2TargetRawTrace[] = [];
	const representations: MaterializedBadgeM2Representation[] = [];
	for (const registration of registrations) {
		const target = registration.specimen;
		const exactOwnedCoordinates = ownershipEnabled && status === 'adequate' && finalMargin
			? finalMargin.observations.filter((observation) => observation.modalSupportCount === 18 && observation.eligibleSampleIds.length === 18).map((observation) => observation.localPixel)
			: [];
		const partition = targetPartition(target, registration, finalMargin?.exactSupportedCoordinates ?? [], exactOwnedCoordinates);
		const targetTrace: M2TargetRawTrace = {
			targetId: target.id,
			finalMarginPx: finalMargin?.marginPx ?? null,
			observations: finalMargin?.observations ?? [],
			finalExactSupportedCoordinates: finalMargin?.exactSupportedCoordinates ?? [],
			exactOwnedCoordinates,
			partition
		};
		targets.push(targetTrace);
		representations.push(rawRepresentation(target, registration, m1, margins, status === 'adequate', minimumSupportCount, registrations, targetTrace));
	}
	const trace: M2RawSourceProbeTrace = {
		algorithm: {
			exact: { authoritative: true, equality: 'exact-rgba-tuple', tuple: '(r,g,b,a)', minimumSupportCount, nullModel: { p: 0.5, eighteenSampleProbability: 3.814697265625e-6, eighteenSamplePercent: 0.0003814697265625, assumption: 'independent Bernoulli trials' } },
			quantized: { authoritative: false, equality: 'floor-channel-bin', binWidth, equation: 'q(c)=floor(c/binWidth)' },
			modelProvenance: 'Raw source RGB(A) appearance at every registered coordinate; exact tuple equality is baseline. JPEG/compressed images can change exact tuples, so exact recurrence is not a JPEG-invariant claim.'
		},
		margins,
		registrations: registrations.map(({ specimen: _specimen, glyphExactSet: _exact, glyphHaloSet: _halo, ...registration }) => registration),
		excludedSampleIds,
		final: {
			status,
			reason,
			targets,
			exactSupportedCoordinates: finalMargin?.exactSupportedCoordinates ?? [],
			exactModalSupportedCoordinates: finalMargin?.exactModalSupportedCoordinates ?? [],
			quantizedSupportedCoordinates: finalMargin?.quantizedSupportedCoordinates ?? [],
			finalMarginPx: finalMargin?.marginPx ?? null,
			ownership: {
				promoted: ownershipEnabled && status === 'adequate',
				criterion: ownershipGate?.criterion ?? 'OFF: requires adequate frame and measured significant circular-shift control'
			}
		}
	};
	return {
		schema: M2_RAW_SOURCE_PROBE_SCHEMA,
		state: status === 'adequate' ? 'materialized' : 'insufficient',
		provenance: {
			source: 'full-rgba-image',
			exactBaseline: 'authoritative',
			quantizedDiagnostic: 'non-authoritative',
			jpegCaveat: 'Exact RGBA recurrence is authoritative for this raster; JPEG recompression may alter channel tuples and is not an exact-match guarantee.'
		},
		trace,
		representations
	};
}

/** Alias with the longer name used by some callers. */
export const materializeExpandedBadgeRawSourceFrame = materializeExpandedBadgeRawFrameProbe;

/**
 * One-call producer seam: discover the raw trace, run the deterministic
 * circular-shift control, then decorate the same trace with the gated 18/18
 * ownership projection. The initial discovery is never repeated by a caller.
 */
export function materializeExpandedBadgeRawFrameProbeWithControl(
	input: M2RawSourceProbeInput & { readonly options: M2RawSourceProbeWithControlOptions }
): MaterializedExpandedBadgeRawFrameProbe {
	const { control, ...rawOptions } = input.options;
	const discovered = materializeExpandedBadgeRawFrameProbe({ ...input, options: rawOptions });
	const controlResult = materializeM2RawFrameStatsControl(discovered.trace, {
		...control,
		imageId: input.m1.provenance.imageId,
		paramsHash: input.m1.provenance.paramsHash,
		featureId: 'badgeM2Aa'
	});
	const alpha = control.alpha ?? 0.05;
	const finalStats = controlResult.margins.find((margin) => margin.marginPx === discovered.trace.final.finalMarginPx)?.bySupportThreshold['18'];
	const significant = discovered.trace.final.status === 'adequate' && controlResult.status === 'measured' && !!finalStats && finalStats.globalMaxExactOverlap.observed === 18 && finalStats.globalMaxExactOverlap.empiricalP <= alpha;
	const criterion = `adequate frame AND exact modal 18/18 AND circular-shift global-max empirical p<=${alpha}; observed=${finalStats?.globalMaxExactOverlap.observed ?? 'UNKNOWN'} p=${finalStats?.globalMaxExactOverlap.empiricalP ?? 'UNKNOWN'}; cluster statistic is corroborative, not multiplied`;
	const finalized = materializeExpandedBadgeRawFrameProbe({
		...input,
		options: {
			...rawOptions,
			ownershipGate: { status: controlResult.status, significant, criterion }
		}
	});
	return {
		...finalized,
		statistics: controlResult,
		trace: { ...finalized.trace, control: controlResult, statistics: controlResult }
	};
}
