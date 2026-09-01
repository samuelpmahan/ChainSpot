/**
 * A Storybook-only view of one materialized M2 Badge.
 *
 * The source is deliberately supplied by the E adapter.  Nothing in this
 * module discovers AA, derives transition sets, or changes the accounting
 * universe; it only paints the identity sets that E already emitted.
 */
export type M2Projection =
	| 'm1-available'
	| 'm1-explained'
	| 'm2-available'
	| 'm2-explained'
	| 'preserved'
	| 'lost'
	| 'discovered'
	| 'provisional'
	| 'newly-explained'
	| 'still-unexplained'
	| 'support-count'
	| 'transition';

export const M2_PROJECTIONS: readonly M2Projection[] = [
	'm1-available',
	'm1-explained',
	'm2-available',
	'm2-explained',
	'preserved',
	'lost',
	'discovered',
	'provisional',
	'newly-explained',
	'still-unexplained',
	'support-count',
	'transition'
];

export interface M2BadgeProjectionSubject {
	readonly id: string;
	readonly title?: string;
	readonly crop: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
	/** Width of the raster whose pixel identities E stored. */
	readonly rasterWidth: number;
	/** Materialized E M2 evidence; Storybook does not reconstruct its sets. */
	readonly m2: {
		readonly m1: {
			readonly availablePixels: ArrayLike<number>;
			readonly explainedPixels: ArrayLike<number>;
			readonly unexplainedPixels: ArrayLike<number>;
		};
		readonly m2: {
			readonly availablePixels: ArrayLike<number>;
			readonly explainedPixels: ArrayLike<number>;
			readonly unexplainedPixels: ArrayLike<number>;
		};
		readonly transition: {
			readonly preservedPixels: ArrayLike<number>;
			readonly lostPixels: ArrayLike<number>;
			readonly discoveredPixels: ArrayLike<number>;
			readonly newlyExplainedPixels: ArrayLike<number>;
			readonly stillUnexplainedPixels: ArrayLike<number>;
			readonly regressionLoss: number | null;
			readonly discoveryLoss: number | null;
		};
		readonly aa: {
			readonly candidatePixels: ArrayLike<number>;
			readonly explainedPixels: ArrayLike<number>;
			readonly provisionalPixels?: ArrayLike<number>;
			readonly unresolvedPixels: ArrayLike<number>;
			/** E's per-candidate recurrence observations, when materialized. */
			readonly observations?: readonly {
				readonly localPixel: readonly [number, number];
				readonly supportCount: number;
				readonly alignedSampleCount: number;
			}[];
		};
		readonly registration: {
			readonly method: string;
			readonly sampleCount: number;
			readonly alignedSampleCount: number;
			readonly digitCondition: string;
			readonly minimumSupportCount: number;
			readonly minimumSupportFraction: number;
			readonly provenance: string;
		};
		readonly frame: {
			readonly status: string;
			readonly samples: number;
			readonly latestMarginPx: number | null;
			readonly stableSet: boolean;
			readonly boundarySupportedPixelCount: number;
			readonly reason: string;
		};
	};
	/**
	 * The one E-owned expanded-frame testimony used by both the Storybook
	 * renderer and the receipt formatter.  It is optional only for the legacy
	 * M1/M2 accounting stories; raw-frame stories must provide it.
	 */
	readonly rawTrace?: M2RawFrameTrace;
}

export type M2RawPartition = 'm1-owned' | 'old-aa' | 'old-residue' | 'exterior';
export type M2BoundaryStatus = 'clear' | 'touching' | 'unknown-truncated';
export type M2AppearanceVariant = 'exact-baseline' | 'quantized-diagnostic';

export interface M2TraceIdentity {
	readonly runId: string;
	readonly imageId: string;
	readonly paramsHash: string;
	readonly featureId: string;
	readonly traceHash: string;
}

export interface M2RawFrameMargin {
	readonly marginPx: number;
	readonly status: M2BoundaryStatus;
	readonly supportedPixelCount: number;
	readonly boundarySupportedPixelCount: number;
	readonly unobservedSampleCount: number;
	readonly sides?: Readonly<Record<'top' | 'right' | 'bottom' | 'left', M2BoundaryStatus>>;
	readonly reason?: string;
}

/**
 * E's materialized raw-frame contract.  Coordinates in this object are
 * frame-local (`[0, 0]` is the top-left of `crop`), and `rawRgba` is the
 * exact decoded crop.  The projection deliberately has no detector input or
 * candidate-generation knobs: it can only display this testimony.
 */
export interface M2RawFrameTrace {
	readonly identity: M2TraceIdentity;
	readonly objectId: string;
	readonly coordinateFrame: 'm1-owned-bbox-local';
	readonly crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	readonly marginPx: number;
	readonly rawRgba: ArrayLike<number>;
	readonly exactBaselinePixels: readonly (readonly [number, number])[];
	readonly partition: Readonly<Record<M2RawPartition, readonly (readonly [number, number])[]>>;
	readonly glyph: {
		readonly exactPixels: readonly (readonly [number, number])[];
		readonly haloPixels: readonly (readonly [number, number])[];
	};
	readonly support: {
		readonly exactCount: number;
		readonly minimumSupportCount: number;
		readonly minimumSupportFraction: number | null;
		readonly sampleCount: number;
		readonly alignedSampleCount: number;
		readonly registration: string;
	};
	readonly boundaryByMargin: readonly M2RawFrameMargin[];
	readonly frameBoundary: readonly [number, number, number, number];
	readonly finalSupportPartition?: Readonly<Record<M2RawPartition, number>>;
	readonly jpegCaveat?: string;
	/** Optional display-only quantization; never used for support or boundary verdicts. */
	readonly quantizedDiagnostic?: { readonly rgba: ArrayLike<number>; readonly binWidth: number };
	readonly statistics?: M2RawSupportStatistics;
}

export interface M2RawSupportStatistics {
	/** Modal exact tuple and its retained sample values, supplied by E. */
	readonly modalExactTuple?: readonly [number, number, number, number];
	readonly modalExactCount?: number;
	readonly modalExactFraction?: number;
	readonly retainedSampleValues?: readonly { readonly sampleId: string; readonly rgba: readonly [number, number, number, number] }[];
	readonly channelStandardDeviation?: Readonly<Record<'r' | 'g' | 'b' | 'a', number>>;
	readonly assumedP?: number;
	readonly allSamplesExactCount?: number;
	readonly sampleTotal?: number;
	readonly exactProbability?: number;
	readonly exactProbabilityPercent?: number;
	readonly nullModel?: string;
	readonly independenceCaveat?: string;
	readonly empiricalNull?: M2EmpiricalNullSummary;
}

export interface M2EmpiricalNullSummary {
	readonly controlSeed: number | string;
	readonly B: number;
	readonly ownershipSignificant?: boolean;
	readonly thresholds: readonly M2EmpiricalNullThreshold[];
	readonly outermostClearedRingNegativeControl?: M2EmpiricalNullMetric;
}

export interface M2EmpiricalNullThreshold {
	readonly threshold: number;
	readonly globalMaxOverlap: M2EmpiricalNullMetric;
	readonly largest8ConnectedCluster: M2EmpiricalNullMetric;
}

export interface M2EmpiricalNullMetric {
	readonly observed: number;
	readonly nullMean: number;
	readonly nullSd: number;
	readonly nullQuantiles: Readonly<Record<string, number>>;
	readonly nullMax: number;
	readonly empiricalP: number | null;
	readonly verdict?: 'significant' | 'not-significant' | 'unknown';
}

/** Shape emitted by the alg-side m2RawFrameStatsControl module. */
export interface M2RawFrameStatsControlLike {
	readonly controlSeed: string;
	readonly replicateCount: number;
	readonly margins: readonly {
		readonly marginPx: number;
		readonly bySupportThreshold: Readonly<Record<string, {
			readonly globalMaxExactOverlap: M2RawNullSummaryLike;
			readonly largestEightConnectedCluster: M2RawNullSummaryLike;
		}>>;
		readonly outermostClearedRing?: M2RawNullSummaryLike;
	}[];
}

export interface M2RawNullSummaryLike {
	readonly observed: number;
	readonly nullMean: number;
	readonly nullSampleSd: number;
	readonly nullQuantiles: Readonly<Record<string, number>>;
	readonly nullMaximum: number;
	readonly empiricalP: number;
}

export interface M2RawFrameVisual {
	readonly identity: M2TraceIdentity;
	readonly objectId: string;
	readonly coordinateFrame: M2RawFrameTrace['coordinateFrame'];
	readonly crop: M2RawFrameTrace['crop'];
	readonly marginPx: number;
	readonly width: number;
	readonly height: number;
	readonly rawRgba: Uint8ClampedArray;
	readonly frameBoundary: readonly [number, number, number, number];
	readonly layers: readonly {
		readonly name: string;
		readonly color: readonly [number, number, number, number];
		readonly pixels: readonly (readonly [number, number])[];
	}[];
	readonly boundaryByMargin: readonly M2RawFrameMargin[];
	readonly partitionCounts: Readonly<Record<M2RawPartition, number>>;
	readonly glyphCounts: { readonly exact: number; readonly halo: number };
	readonly support: M2RawFrameTrace['support'];
	readonly jpegCaveat: string;
	readonly appearanceVariant: M2AppearanceVariant;
	readonly appearanceLabel: string;
	readonly statistics?: M2RawSupportStatistics;
	readonly ownershipDisplayAllowed: boolean;
}

export interface M2RawFrameBehaviorTrace {
	readonly objectId: string;
	readonly coordinateFrame: 'm1-owned-bbox-local';
	readonly crop: M2RawFrameTrace['crop'];
	readonly marginPx: number;
	readonly rawRgba: ArrayLike<number>;
	readonly exactBaselinePixels: M2RawFrameTrace['exactBaselinePixels'];
	readonly targetPartitions: M2RawFrameTrace['partition'];
	readonly glyph: M2RawFrameTrace['glyph'];
	readonly registrations: M2RawFrameTrace['support'];
	readonly margins: M2RawFrameTrace['boundaryByMargin'];
	readonly frameBoundary: M2RawFrameTrace['frameBoundary'];
	readonly finalSupportPartition?: M2RawFrameTrace['finalSupportPartition'];
	readonly jpegCaveat?: string;
	readonly quantizedDiagnostic?: M2RawFrameTrace['quantizedDiagnostic'];
}

/** Duck-typed producer payload used to bridge the alg raw-source probe. */
export interface M2RawSourceProbeLike {
	readonly statistics?: M2RawSupportStatistics;
	readonly control?: M2RawFrameStatsControlLike;
	readonly algorithm: {
		readonly exact: { readonly minimumSupportCount: number };
		readonly quantized?: { readonly binWidth: number };
		readonly modelProvenance?: string;
	};
	readonly margins: readonly {
		readonly marginPx: number;
		readonly exactSupportedCoordinates: readonly (readonly [number, number])[];
		readonly exactBoundary: {
			readonly total: number;
			readonly status: 'clear' | 'supported' | 'unknown';
			readonly left?: { readonly status: 'clear' | 'supported' | 'unknown' };
			readonly right?: { readonly status: 'clear' | 'supported' | 'unknown' };
			readonly top?: { readonly status: 'clear' | 'supported' | 'unknown' };
			readonly bottom?: { readonly status: 'clear' | 'supported' | 'unknown' };
		};
		readonly unobservedSampleCount: number;
		readonly clippedSampleIds?: readonly string[];
	}[];
	readonly registrations: readonly {
		readonly sampleId: string;
		readonly ownedBbox: readonly [number, number, number, number];
		readonly translation: readonly [number, number];
		readonly glyphExactCoordinates: readonly (readonly [number, number])[];
		readonly glyphHaloCoordinates: readonly (readonly [number, number])[];
		readonly provenance?: string;
	}[];
	readonly final: {
		readonly finalMarginPx: number | null;
		readonly targets: readonly {
		readonly targetId: string;
			readonly finalExactSupportedCoordinates: readonly (readonly [number, number])[];
			readonly partition: {
				readonly byPartition: Readonly<Record<M2RawPartition, readonly (readonly [number, number])[]>>;
				readonly counts: Readonly<Record<M2RawPartition, number>>;
			};
		}[];
	};
}

export interface M2ProjectionImage {
	readonly width: number;
	readonly height: number;
	readonly x: number;
	readonly y: number;
	readonly rgba: Uint8ClampedArray;
}

const COLORS = {
	available: [250, 204, 21, 255],
	explained: [34, 197, 94, 255],
	preserved: [22, 163, 74, 255],
	lost: [220, 38, 38, 255],
	discovered: [124, 58, 237, 255],
	provisional: [99, 102, 241, 255],
	newlyExplained: [6, 182, 212, 255],
	stillUnexplained: [245, 158, 11, 255],
	/** Exact-baseline partition colors. Kept separate from the legacy M2 UI. */
	m1Owned: [34, 197, 94, 255],
	oldAa: [59, 130, 246, 255],
	oldResidue: [245, 158, 11, 255],
	newExterior: [168, 85, 247, 255],
	glyphExact: [248, 250, 252, 255],
	glyphHalo: [236, 72, 153, 255],
	transparent: [0, 0, 0, 0]
} as const;

const RAW_PARTITION_COLORS: Readonly<Record<M2RawPartition, readonly [number, number, number, number]>> = {
	'm1-owned': COLORS.m1Owned,
	'old-aa': COLORS.oldAa,
	'old-residue': COLORS.oldResidue,
	exterior: COLORS.newExterior
};

const RAW_PARTITION_LABELS: Readonly<Record<M2RawPartition, string>> = {
	'm1-owned': 'M1 owned',
	'old-aa': 'old AA',
	'old-residue': 'old residue',
	exterior: 'new exterior'
};

function put(out: Uint8ClampedArray, offset: number, color: readonly number[]): void {
	out.set(color, offset * 4);
}

function localPixel(subject: M2BadgeProjectionSubject, pixel: number): number | null {
	const x = pixel % subject.rasterWidth;
	const y = (pixel - x) / subject.rasterWidth;
	if (
		x < subject.crop.x ||
		y < subject.crop.y ||
		x >= subject.crop.x + subject.crop.width ||
		y >= subject.crop.y + subject.crop.height
	)
		return null;
	return (y - subject.crop.y) * subject.crop.width + x - subject.crop.x;
}

function paint(
	out: Uint8ClampedArray,
	subject: M2BadgeProjectionSubject,
	pixels: ArrayLike<number>,
	color: readonly number[]
): void {
	for (let index = 0; index < pixels.length; index++) {
		const pixel = pixels[index];
		const local = localPixel(subject, pixel);
		if (local !== null) put(out, local, color);
	}
}

function supportColor(fraction: number): readonly [number, number, number, number] {
	// A view-only blue -> yellow -> red scale makes recurrence visible without
	// turning a display threshold into evidence ownership.
	const clamped = Math.max(0, Math.min(1, fraction));
	const hue = (1 - clamped) * 220;
	const chroma = 0.9;
	const lightness = 0.55;
	const c = (1 - Math.abs(2 * lightness - 1)) * chroma;
	const h = hue / 60;
	const x = c * (1 - Math.abs((h % 2) - 1));
	const [r, g, b] =
		h < 1
			? [c, x, 0]
			: h < 2
				? [x, c, 0]
				: h < 3
					? [0, c, x]
					: h < 4
						? [0, x, c]
						: h < 5
							? [x, 0, c]
							: [c, 0, x];
	const m = lightness - c / 2;
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255), 255];
}

export function supportRange(subject: M2BadgeProjectionSubject): {
	readonly minimum: number;
	readonly maximum: number;
	readonly sampleMaximum: number;
} {
	const observations = subject.m2.aa.observations ?? [];
	return {
		minimum: observations.reduce(
			(minimum, observation) => Math.min(minimum, observation.supportCount),
			0
		),
		maximum: observations.reduce(
			(maximum, observation) => Math.max(maximum, observation.supportCount),
			0
		),
		sampleMaximum: observations.reduce(
			(maximum, observation) => Math.max(maximum, observation.alignedSampleCount),
			0
		)
	};
}

function sameIdentitySet(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
	if (left.length !== right.length) return false;
	const values = Array.from(left).sort((a, b) => a - b);
	const other = Array.from(right).sort((a, b) => a - b);
	return values.every((value, index) => value === other[index]);
}

/** Storybook canvas and CI receipt render the same supplied identity sets. */
export function projectM2Image(
	subject: M2BadgeProjectionSubject,
	projection: M2Projection,
	supportThreshold = 0
): M2ProjectionImage {
	const { width, height } = subject.crop;
	const out = new Uint8ClampedArray(width * height * 4);
	const { m1, m2, transition, aa } = subject.m2;
	if (projection === 'm1-available') paint(out, subject, m1.availablePixels, COLORS.available);
	if (projection === 'm1-explained') paint(out, subject, m1.explainedPixels, COLORS.explained);
	if (projection === 'm2-available') paint(out, subject, m2.availablePixels, COLORS.available);
	if (projection === 'm2-explained') paint(out, subject, m2.explainedPixels, COLORS.explained);
	if (projection === 'preserved') paint(out, subject, transition.preservedPixels, COLORS.preserved);
	if (projection === 'lost') paint(out, subject, transition.lostPixels, COLORS.lost);
	if (projection === 'discovered')
		paint(out, subject, transition.discoveredPixels, COLORS.discovered);
	if (projection === 'provisional' && aa.provisionalPixels)
		paint(out, subject, aa.provisionalPixels, COLORS.provisional);
	if (projection === 'newly-explained')
		paint(out, subject, transition.newlyExplainedPixels, COLORS.newlyExplained);
	if (projection === 'still-unexplained')
		paint(out, subject, transition.stillUnexplainedPixels, COLORS.stillUnexplained);
	if (projection === 'support-count') {
		const observations = aa.observations;
		if (!observations) return { width, height, x: subject.crop.x, y: subject.crop.y, rgba: out };
		if (observations.length !== aa.candidatePixels.length)
			throw new Error('E AA observations and candidate identities have different lengths');
		for (let index = 0; index < observations.length; index++) {
			const observation = observations[index];
			if (observation.supportCount < supportThreshold) continue;
			const local = localPixel(subject, aa.candidatePixels[index]);
			if (local === null) continue;
			const denominator = Math.max(1, observation.alignedSampleCount);
			put(out, local, supportColor(observation.supportCount / denominator));
		}
	}
	if (projection === 'transition') {
		// Paint disjoint transition categories in an explicit precedence order.
		// The sets themselves remain E-owned; this is only display layering.
		paint(out, subject, transition.preservedPixels, COLORS.preserved);
		paint(out, subject, transition.lostPixels, COLORS.lost);
		paint(out, subject, transition.newlyExplainedPixels, COLORS.newlyExplained);
		paint(out, subject, transition.stillUnexplainedPixels, COLORS.stillUnexplained);
	}
	return { width, height, x: subject.crop.x, y: subject.crop.y, rgba: out };
}

/** Validate supplied accounting without reconstructing any set from another. */
export function assertM2ProjectionSource(subject: M2BadgeProjectionSubject): void {
	const { m1, transition, aa } = subject.m2;
	const sets = [
		['preserved', transition.preservedPixels],
		['lost', transition.lostPixels],
		['discovered', transition.discoveredPixels],
		['newly-explained', transition.newlyExplainedPixels],
		['still-unexplained', transition.stillUnexplainedPixels]
	] as const;
	for (const [name, values] of sets) {
		if (new Set(Array.from(values)).size !== values.length)
			throw new Error(`${name} contains duplicate pixels`);
	}
	if (
		m1.explainedPixels.length > 0 &&
		transition.lostPixels.length === 0 &&
		transition.regressionLoss !== 0
	)
		throw new Error('E supplied no lost pixels but regression loss is not zero');
	if (transition.lostPixels.length > 0 && transition.regressionLoss === 0)
		throw new Error('E supplied lost pixels but regression loss is zero');
	if (m1.explainedPixels.length === 0 && transition.regressionLoss !== null)
		throw new Error('E supplied empty M1 explanation with non-empty regression denominator');
	if (!sameIdentitySet(aa.candidatePixels, transition.discoveredPixels))
		throw new Error('E AA candidate and discovered sets disagree');
	if (!sameIdentitySet(aa.explainedPixels, transition.newlyExplainedPixels))
		throw new Error('E AA explained and newly-explained sets disagree');
	if (
		aa.provisionalPixels &&
		!Array.from(aa.provisionalPixels).every((pixel) =>
			Array.from(aa.candidatePixels).includes(pixel)
		)
	)
		throw new Error('E provisional AA pixels are not in the candidate control');
	if (!sameIdentitySet(aa.unresolvedPixels, transition.stillUnexplainedPixels))
		throw new Error('E AA unresolved and still-unexplained sets disagree');
	if (aa.observations && aa.observations.length !== aa.candidatePixels.length)
		throw new Error('E AA observations and candidate identities have different lengths');
}

function rawPixelKey(pixel: readonly [number, number]): string {
	return `${pixel[0]},${pixel[1]}`;
}

function rawPixelList(values: readonly (readonly [number, number])[], name: string, width: number, height: number): void {
	for (const pixel of values) {
		if (
			!Number.isInteger(pixel[0]) ||
			!Number.isInteger(pixel[1]) ||
			pixel[0] < 0 ||
			pixel[1] < 0 ||
			pixel[0] >= width ||
			pixel[1] >= height
		)
			throw new Error(`M2 raw trace ${name} contains an out-of-frame pixel`);
	}
}

function requireIdentity(identity: M2TraceIdentity): void {
	for (const field of ['runId', 'imageId', 'paramsHash', 'featureId', 'traceHash'] as const) {
		if (typeof identity[field] !== 'string' || identity[field].length === 0)
			throw new Error(`M2 raw trace is missing trace identity '${field}'`);
	}
}

/** Validate the materialized raw-frame testimony before either presentation path consumes it. */
export function assertM2RawFrameTrace(trace: M2RawFrameTrace): void {
	if (!trace || typeof trace !== 'object') throw new Error('M2 raw frame trace is missing');
	requireIdentity(trace.identity);
	if (!trace.objectId) throw new Error('M2 raw trace is missing object identity');
	if (trace.coordinateFrame !== 'm1-owned-bbox-local')
		throw new Error(`M2 raw trace has unsupported coordinate frame '${String(trace.coordinateFrame)}'`);
	const { width, height } = trace.crop;
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
		throw new Error('M2 raw trace has an invalid crop size');
	if (trace.rawRgba.length !== width * height * 4)
		throw new Error('M2 raw trace RGBA length does not match its crop');
	if (!Number.isInteger(trace.marginPx) || trace.marginPx < 2)
		throw new Error('M2 raw trace final margin must be at least 2px');
	if (
		trace.frameBoundary[0] !== 0 ||
		trace.frameBoundary[1] !== 0 ||
		trace.frameBoundary[2] !== width ||
		trace.frameBoundary[3] !== height
	)
		throw new Error('M2 raw trace frame boundary does not enclose the materialized crop');

	const baseline = new Set(trace.exactBaselinePixels.map(rawPixelKey));
	if (baseline.size !== trace.exactBaselinePixels.length)
		throw new Error('M2 raw trace exact baseline contains duplicate pixels');
	if (trace.support.exactCount !== trace.exactBaselinePixels.length)
		throw new Error('M2 raw trace exact baseline count disagrees with support testimony');
	const partitionKeys = new Set<string>();
	for (const partition of Object.keys(RAW_PARTITION_COLORS) as M2RawPartition[]) {
		const values = trace.partition[partition];
		rawPixelList(values, partition, width, height);
		for (const pixel of values) {
			const key = rawPixelKey(pixel);
			if (partitionKeys.has(key)) throw new Error('M2 raw trace support partition overlaps itself');
			partitionKeys.add(key);
			if (!baseline.has(key))
				throw new Error(`M2 raw trace partition '${partition}' is not in the exact baseline`);
		}
	}
	if (partitionKeys.size !== baseline.size || [...baseline].some((key) => !partitionKeys.has(key)))
		throw new Error('M2 raw trace support partition does not equal the exact baseline');
	rawPixelList(trace.exactBaselinePixels, 'exact baseline', width, height);
	rawPixelList(trace.glyph.exactPixels, 'glyph exact mask', width, height);
	rawPixelList(trace.glyph.haloPixels, 'glyph halo/support', width, height);
	if (trace.glyph.exactPixels.some((pixel) => trace.glyph.haloPixels.some((halo) => rawPixelKey(pixel) === rawPixelKey(halo))))
		throw new Error('M2 raw trace glyph exact mask overlaps its halo/support');
	if (trace.boundaryByMargin.length === 0)
		throw new Error('M2 raw trace has no per-margin boundary outcomes');
	if (trace.boundaryByMargin[0].marginPx !== 2)
		throw new Error('M2 raw trace boundary sweep must start at margin 2px');
	for (const outcome of trace.boundaryByMargin) {
		if (!Number.isInteger(outcome.marginPx) || outcome.marginPx < 2)
			throw new Error('M2 raw trace has an invalid boundary margin');
		if (!['clear', 'touching', 'unknown-truncated'].includes(outcome.status))
			throw new Error(`M2 raw trace has an invalid boundary status '${String(outcome.status)}'`);
		if (outcome.sides) {
			for (const side of ['top', 'right', 'bottom', 'left'] as const) {
				if (!['clear', 'touching', 'unknown-truncated'].includes(outcome.sides[side]))
					throw new Error(`M2 raw trace has an invalid ${side} boundary status`);
			}
		}
	}
	if (trace.finalSupportPartition) {
		for (const partition of Object.keys(RAW_PARTITION_COLORS) as M2RawPartition[]) {
			if (trace.finalSupportPartition[partition] !== trace.partition[partition].length)
				throw new Error(`M2 raw trace final '${partition}' count disagrees with its pixels`);
		}
	}
}

/**
 * Seal the producer's raw behavior trace with the RunTrace identity and one
 * copied crop.  Call this at the artifact boundary exactly once; all later
 * receipt and visual work should use the returned object.
 */
export function materializeM2RawFrameTrace(input: {
	readonly identity: M2TraceIdentity;
	readonly behavior: M2RawFrameBehaviorTrace;
}): M2RawFrameTrace {
	const behavior = input.behavior;
	const trace: M2RawFrameTrace = {
		identity: input.identity,
		objectId: behavior.objectId,
		coordinateFrame: behavior.coordinateFrame,
		crop: behavior.crop,
		marginPx: behavior.marginPx,
		rawRgba: Uint8ClampedArray.from(behavior.rawRgba),
		exactBaselinePixels: behavior.exactBaselinePixels,
		partition: behavior.targetPartitions,
		glyph: behavior.glyph,
		support: behavior.registrations,
		boundaryByMargin: behavior.margins,
		frameBoundary: behavior.frameBoundary,
		...(behavior.finalSupportPartition ? { finalSupportPartition: behavior.finalSupportPartition } : {}),
		...(behavior.jpegCaveat ? { jpegCaveat: behavior.jpegCaveat } : {}),
		...(behavior.quantizedDiagnostic ? { quantizedDiagnostic: behavior.quantizedDiagnostic } : {})
	};
	assertM2RawFrameTrace(trace);
	return trace;
}

/** Build the presentation trace from E's raw-source probe without re-running it. */
export function materializeM2RawFrameTraceFromProbe(input: {
	readonly identity: M2TraceIdentity;
	readonly probe: M2RawSourceProbeLike;
	readonly image: { readonly width: number; readonly height: number; readonly data: ArrayLike<number> };
	readonly objectId: string;
}): M2RawFrameTrace {
	const target = input.probe.final.targets.find((value) => value.targetId === input.objectId);
	if (!target) throw new Error(`M2 raw probe has no target '${input.objectId}'`);
	const finalMargin = input.probe.final.finalMarginPx;
	if (finalMargin === null) throw new Error('M2 raw probe has no materialized final margin');
	const registration = input.probe.registrations.find((value) => value.sampleId === input.objectId);
	if (!registration) throw new Error(`M2 raw probe has no registration for '${input.objectId}'`);
	const [x0, y0, baseWidth, baseHeight] = registration.ownedBbox;
	const crop = { x: x0 - finalMargin, y: y0 - finalMargin, width: baseWidth + finalMargin * 2, height: baseHeight + finalMargin * 2 };
	const cropRgba = new Uint8ClampedArray(crop.width * crop.height * 4);
	for (let y = 0; y < crop.height; y++) {
		for (let x = 0; x < crop.width; x++) {
			const sourceX = crop.x + x;
			const sourceY = crop.y + y;
			const targetOffset = (y * crop.width + x) * 4;
			if (sourceX < 0 || sourceY < 0 || sourceX >= input.image.width || sourceY >= input.image.height) continue;
			const sourceOffset = (sourceY * input.image.width + sourceX) * 4;
			for (let channel = 0; channel < 4; channel++) cropRgba[targetOffset + channel] = input.image.data[sourceOffset + channel] ?? 0;
		}
	}
	const shift = (pixels: readonly (readonly [number, number])[]) => pixels.map(([x, y]) => [x + finalMargin, y + finalMargin] as const);
	const finalMarginTrace = input.probe.margins.find((value) => value.marginPx === finalMargin);
	if (!finalMarginTrace) throw new Error(`M2 raw probe has no margin ${finalMargin}px trace`);
	const status = (value: 'clear' | 'supported' | 'unknown'): M2BoundaryStatus => value === 'clear' ? 'clear' : value === 'supported' ? 'touching' : 'unknown-truncated';
	const exactBoundary = finalMarginTrace.exactBoundary;
	const sideStatuses = (boundary: typeof exactBoundary) => boundary.left && boundary.right && boundary.top && boundary.bottom
		? { left: status(boundary.left.status), right: status(boundary.right.status), top: status(boundary.top.status), bottom: status(boundary.bottom.status) }
		: undefined;
	const trace: M2RawFrameTrace = {
		identity: input.identity,
		objectId: input.objectId,
		coordinateFrame: 'm1-owned-bbox-local',
		crop,
		marginPx: finalMargin,
		rawRgba: cropRgba,
		exactBaselinePixels: shift(target.finalExactSupportedCoordinates),
		partition: {
			'm1-owned': shift(target.partition.byPartition['m1-owned']),
			'old-aa': shift(target.partition.byPartition['old-aa']),
			'old-residue': shift(target.partition.byPartition['old-residue']),
			exterior: shift(target.partition.byPartition.exterior)
		},
		glyph: { exactPixels: shift(registration.glyphExactCoordinates), haloPixels: shift(registration.glyphHaloCoordinates) },
		support: {
			exactCount: target.finalExactSupportedCoordinates.length,
			minimumSupportCount: input.probe.algorithm.exact.minimumSupportCount,
			minimumSupportFraction: null,
			sampleCount: input.probe.registrations.length,
			alignedSampleCount: input.probe.registrations.length,
			registration: input.probe.algorithm.modelProvenance ?? 'full-rgba-image; integer M1 top-left translation'
		},
		boundaryByMargin: input.probe.margins.map((value) => ({
			marginPx: value.marginPx,
			status: status(value.exactBoundary.status),
			supportedPixelCount: value.exactSupportedCoordinates.length,
			boundarySupportedPixelCount: value.exactBoundary.total,
			unobservedSampleCount: value.unobservedSampleCount,
			...(sideStatuses(value.exactBoundary) ? { sides: sideStatuses(value.exactBoundary) } : {})
		})),
		frameBoundary: [0, 0, crop.width, crop.height],
		jpegCaveat: 'Exact RGBA recurrence is authoritative for this raster; JPEG recompression can alter channel tuples.',
		...(input.probe.statistics || input.probe.control ? {
			statistics: {
				...(input.probe.statistics ?? {}),
				...(input.probe.control ? { empiricalNull: adaptM2RawFrameStatsControl(input.probe.control) } : {})
			}
		} : {})
	};
	assertM2RawFrameTrace(trace);
	return trace;
}

function partitionCounts(
	partition: Readonly<Record<M2RawPartition, readonly (readonly [number, number])[]>>
): Record<M2RawPartition, number> {
	return {
		'm1-owned': partition['m1-owned'].length,
		'old-aa': partition['old-aa'].length,
		'old-residue': partition['old-residue'].length,
		exterior: partition.exterior.length
	};
}

/**
 * Build the declarative visual model from the supplied trace.  This is the
 * only visual entry point for the expanded-frame story and receipt script;
 * importantly, it never looks at a raster to discover or classify pixels.
 */
export function projectM2RawFrameVisual(
	trace: M2RawFrameTrace,
	subjectId = trace.objectId,
	appearanceVariant: M2AppearanceVariant = 'exact-baseline'
): M2RawFrameVisual {
	assertM2RawFrameTrace(trace);
	if (subjectId !== trace.objectId)
		throw new Error(`M2 raw trace object '${trace.objectId}' does not match subject '${subjectId}'`);
	const layers = (Object.keys(RAW_PARTITION_COLORS) as M2RawPartition[]).map((partition) => ({
		name: `exact baseline · ${RAW_PARTITION_LABELS[partition]}`,
		color: RAW_PARTITION_COLORS[partition],
		pixels: trace.partition[partition]
	}));
	layers.push(
		{ name: 'glyph halo/support', color: COLORS.glyphHalo, pixels: trace.glyph.haloPixels },
		{ name: 'glyph exact mask', color: COLORS.glyphExact, pixels: trace.glyph.exactPixels }
	);
	let rawRgba = Uint8ClampedArray.from(trace.rawRgba);
	let appearanceLabel = 'AUTHORITATIVE exact RGBA baseline';
	if (appearanceVariant === 'quantized-diagnostic') {
		const diagnostic = trace.quantizedDiagnostic;
		if (!diagnostic || !Number.isFinite(diagnostic.binWidth) || diagnostic.binWidth <= 0)
			throw new Error('M2 quantized diagnostic requested but no valid bin width/data was supplied');
		if (diagnostic.rgba.length !== rawRgba.length)
			throw new Error('M2 quantized diagnostic RGBA length does not match the exact crop');
		rawRgba = Uint8ClampedArray.from(diagnostic.rgba);
		appearanceLabel = `NON-AUTHORITATIVE quantized RGBA · q(c)=floor(c/${diagnostic.binWidth})×${diagnostic.binWidth}`;
	}
	return {
		identity: trace.identity,
		objectId: trace.objectId,
		coordinateFrame: trace.coordinateFrame,
		crop: trace.crop,
		marginPx: trace.marginPx,
		width: trace.crop.width,
		height: trace.crop.height,
		rawRgba,
		frameBoundary: trace.frameBoundary,
		layers,
		boundaryByMargin: trace.boundaryByMargin,
		partitionCounts: partitionCounts(trace.partition),
		glyphCounts: { exact: trace.glyph.exactPixels.length, halo: trace.glyph.haloPixels.length },
		support: trace.support,
		jpegCaveat:
			trace.jpegCaveat ??
			'JPEG values are decoded samples, not lossless source colors; exact RGBA means exact decoded RGBA bytes.',
		appearanceVariant,
		appearanceLabel,
		...(trace.statistics ? { statistics: trace.statistics } : {}),
		ownershipDisplayAllowed: trace.statistics?.empiricalNull?.ownershipSignificant === true
	};
}

/** Return the same raw crop with the exact-baseline partition composited over it. */
export function projectM2RawFrameImage(
	trace: M2RawFrameTrace,
	appearanceVariant: M2AppearanceVariant = 'exact-baseline'
): M2ProjectionImage {
	const visual = projectM2RawFrameVisual(trace, trace.objectId, appearanceVariant);
	const rgba = Uint8ClampedArray.from(visual.rawRgba);
	for (const layer of visual.layers) {
		for (const [x, y] of layer.pixels) {
			const offset = (y * visual.width + x) * 4;
			// Keep the photograph legible below the authoritative partition color.
			const alpha = layer.name === 'glyph exact mask' ? 0.95 : layer.name === 'glyph halo/support' ? 0.72 : 0.78;
			for (let channel = 0; channel < 3; channel++)
				rgba[offset + channel] = Math.round(rgba[offset + channel] * (1 - alpha) + layer.color[channel] * alpha);
			rgba[offset + 3] = 255;
		}
	}
	return { width: visual.width, height: visual.height, x: visual.crop.x, y: visual.crop.y, rgba };
}

function countText(counts: Readonly<Record<M2RawPartition, number>>): string {
	return (Object.keys(RAW_PARTITION_LABELS) as M2RawPartition[])
		.map((partition) => `${RAW_PARTITION_LABELS[partition]}=${counts[partition]}`)
		.join(' ');
}

/** Convert producer control rows without recalculating any statistic. */
export function adaptM2RawFrameStatsControl(control: M2RawFrameStatsControlLike): M2EmpiricalNullSummary {
	const metric = (value: M2RawNullSummaryLike): M2EmpiricalNullMetric => ({
		observed: value.observed,
		nullMean: value.nullMean,
		nullSd: value.nullSampleSd,
		nullQuantiles: value.nullQuantiles,
		nullMax: value.nullMaximum,
		empiricalP: value.empiricalP
	});
	const thresholds = new Map<number, M2EmpiricalNullThreshold>();
	for (const margin of control.margins) {
		for (const [thresholdText, values] of Object.entries(margin.bySupportThreshold)) {
			const threshold = Number(thresholdText);
			if (!Number.isFinite(threshold)) continue;
			thresholds.set(threshold, {
				threshold,
				globalMaxOverlap: metric(values.globalMaxExactOverlap),
				largest8ConnectedCluster: metric(values.largestEightConnectedCluster)
			});
		}
	}
	const outermost = control.margins.find((margin) => margin.outermostClearedRing)?.outermostClearedRing;
	return {
		controlSeed: control.controlSeed,
		B: control.replicateCount,
		thresholds: [...thresholds.values()].sort((a, b) => a.threshold - b.threshold),
		...(outermost ? { outermostClearedRingNegativeControl: metric(outermost) } : {})
	};
}

/** Format the concise human receipt from exactly the same trace as the visual model. */
export function formatM2RawFrameCliText(trace: M2RawFrameTrace): string {
	const visual = projectM2RawFrameVisual(trace);
	const lines = [
		`M2 RAW FRAME RECEIPT · object=${visual.objectId}`,
		`runId=${visual.identity.runId} imageId=${visual.identity.imageId}`,
		`paramsHash=${visual.identity.paramsHash} featureId=${visual.identity.featureId} traceHash=${visual.identity.traceHash}`,
		`coordinateFrame=${visual.coordinateFrame} crop=(${visual.crop.x},${visual.crop.y}) ${visual.width}×${visual.height}px finalMarginPx=${visual.marginPx}`,
		`raw crop: ${visual.width * visual.height} pixels · exact decoded RGBA source`,
		`samples=${visual.support.sampleCount} aligned=${visual.support.alignedSampleCount} registration=${visual.support.registration}`,
		`exact baseline RGBA=${trace.exactBaselinePixels.length} pixels · minimum support count=${visual.support.minimumSupportCount} fraction=${visual.support.minimumSupportFraction === null ? 'UNKNOWN' : visual.support.minimumSupportFraction}`,
		`glyph exact mask=${visual.glyphCounts.exact} pixels · glyph halo/support=${visual.glyphCounts.halo} pixels`,
		...(visual.statistics ? formatM2RawSupportStatistics(visual.statistics) : [
			'null model: assumed p=.5; for 18/18 exact samples, 0.5^18 = 3.814697265625e-6 = 0.00038147%',
			'caveat: adjacent-pixel probabilities are NOT multiplied without justified independence'
		]),
		...visual.boundaryByMargin.map(
			(outcome) =>
				`margin ${outcome.marginPx}px: boundary=${outcome.status} sides=${outcome.sides ? `top:${outcome.sides.top},right:${outcome.sides.right},bottom:${outcome.sides.bottom},left:${outcome.sides.left}` : 'UNKNOWN'} supported=${outcome.supportedPixelCount} touching=${outcome.boundarySupportedPixelCount} unknownTruncated=${outcome.unobservedSampleCount}${outcome.reason ? ` reason=${outcome.reason}` : ''}`
		),
		`final support partition: ${countText(visual.partitionCounts)}`,
		`ownership display: ${visual.ownershipDisplayAllowed ? 'CONTROL-SIGNIFICANT' : 'UNKNOWN — empirical control significance required; partition is evidence only'}`,
		`frame boundary: x=${visual.frameBoundary[0]} y=${visual.frameBoundary[1]} width=${visual.frameBoundary[2]} height=${visual.frameBoundary[3]}`,
		`CAVEAT: ${visual.jpegCaveat}`,
		`visual/trace identity: runId=${visual.identity.runId} imageId=${visual.identity.imageId} traceHash=${visual.identity.traceHash}`
	];
	return lines.join('\n');
}

function formatM2RawSupportStatistics(statistics: M2RawSupportStatistics): readonly string[] {
	const lines: string[] = [];
	if (statistics.modalExactTuple) lines.push(`modal exact tuple RGBA=(${statistics.modalExactTuple.join(',')}) count=${statistics.modalExactCount ?? 'UNKNOWN'} fraction=${statistics.modalExactFraction ?? 'UNKNOWN'}`);
	if (statistics.retainedSampleValues) lines.push(`retained per-sample RGBA values: ${statistics.retainedSampleValues.map((value) => `${value.sampleId}=(${value.rgba.join(',')})`).join(' ')}`);
	if (statistics.channelStandardDeviation) lines.push(`per-channel sample SD: r=${statistics.channelStandardDeviation.r} g=${statistics.channelStandardDeviation.g} b=${statistics.channelStandardDeviation.b} a=${statistics.channelStandardDeviation.a}`);
	if (statistics.assumedP !== undefined) lines.push(`null model: assumed p=${statistics.assumedP}`);
	if (statistics.allSamplesExactCount !== undefined && statistics.sampleTotal !== undefined) lines.push(`exact sample support=${statistics.allSamplesExactCount}/${statistics.sampleTotal}`);
	if (statistics.exactProbability !== undefined) lines.push(`exact support probability=${statistics.exactProbability}${statistics.exactProbabilityPercent === undefined ? '' : ` = ${statistics.exactProbabilityPercent}%`}`);
	if (statistics.nullModel) lines.push(`null model detail: ${statistics.nullModel}`);
	if (statistics.independenceCaveat) lines.push(`independence caveat: ${statistics.independenceCaveat}`);
	if (statistics.assumedP === 0.5 && statistics.allSamplesExactCount === 18 && statistics.sampleTotal === 18 && statistics.exactProbability === undefined)
		lines.push('18/18 => 0.5^18 = 3.814697265625e-6 = 0.00038147%');
	if (!statistics.independenceCaveat)
		lines.push('caveat: adjacent-pixel probabilities are NOT multiplied without justified independence');
	if (statistics.empiricalNull) {
		const empirical = statistics.empiricalNull;
		lines.push(`empirical circular-shift null: controlSeed=${empirical.controlSeed} B=${empirical.B} ownershipSignificant=${empirical.ownershipSignificant ?? 'UNKNOWN'}`);
		for (const threshold of empirical.thresholds) {
			lines.push(`threshold=${threshold.threshold} global-max-overlap ${formatEmpiricalMetric(threshold.globalMaxOverlap)}`);
			lines.push(`threshold=${threshold.threshold} largest-8-connected-cluster ${formatEmpiricalMetric(threshold.largest8ConnectedCluster)}`);
		}
		if (empirical.outermostClearedRingNegativeControl)
			lines.push(`outermost-cleared-ring negative control ${formatEmpiricalMetric(empirical.outermostClearedRingNegativeControl)}`);
	}
	lines.push('simple reference only (not ownership gate): assumed p=.5; 18/18 => 0.5^18 = 3.814697265625e-6 = 0.00038147%');
	return lines;
}

function formatEmpiricalMetric(metric: M2EmpiricalNullMetric): string {
	return `observed=${metric.observed} nullMean=${metric.nullMean} nullSD=${metric.nullSd} nullQuantiles=${JSON.stringify(metric.nullQuantiles)} nullMax=${metric.nullMax} empiricalP=${metric.empiricalP ?? 'UNKNOWN'} verdict=${metric.verdict ?? 'UNKNOWN'}`;
}

/** Ensure the visual and CLI receipt remain two presentations of one trace. */
export function assertM2RawFrameCorrespondence(input: {
	readonly trace: M2RawFrameTrace;
	readonly visual?: M2RawFrameVisual;
	readonly cliText?: string;
}): void {
	const visual = input.visual ?? projectM2RawFrameVisual(input.trace);
	const cliText = input.cliText ?? formatM2RawFrameCliText(input.trace);
	const expected = projectM2RawFrameVisual(input.trace);
	if (visual.identity !== input.trace.identity && JSON.stringify(visual.identity) !== JSON.stringify(input.trace.identity))
		throw new Error('M2 visual identity does not match supplied raw trace identity');
	if (visual.objectId !== input.trace.objectId || visual.marginPx !== input.trace.marginPx)
		throw new Error('M2 visual object/frame identity does not match supplied raw trace');
	if (JSON.stringify(visual.partitionCounts) !== JSON.stringify(expected.partitionCounts))
		throw new Error('M2 visual partition counts do not match supplied raw trace');
	for (const field of ['runId', 'imageId', 'paramsHash', 'featureId', 'traceHash'] as const) {
		if (!cliText.includes(`${field}=${input.trace.identity[field]}`))
			throw new Error(`M2 CLI receipt is missing trace identity '${field}'`);
	}
	for (const outcome of input.trace.boundaryByMargin) {
		if (!cliText.includes(`margin ${outcome.marginPx}px: boundary=${outcome.status}`))
			throw new Error(`M2 CLI receipt is missing margin ${outcome.marginPx}px boundary outcome`);
	}
	if (!cliText.includes(`final support partition: ${countText(expected.partitionCounts)}`))
		throw new Error('M2 CLI receipt final partition disagrees with visual trace');
}
