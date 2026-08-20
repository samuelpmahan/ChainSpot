/**
 * Pancake 4: whole-course ribbon/component ownership.
 *
 * P3 supplies candidate badge sets; it does not own a badge authoritatively.
 * This stage segments the raster once, attaches all P1/P2 objects to that
 * shared component map, and uses component connectivity only to eliminate
 * unsupported candidates.
 */

import {
	DEFAULT_RIBBON_MASS_PARAMS,
	nearestComponentLabel,
	segmentRibbonMass
} from './ribbonMass';
import {
	DEFAULT_CORRIDOR_EVIDENCE_GRID_PARAMS,
	DEFAULT_RING_RADIUS_DISCOVERY_PARAMS,
	discoverBasketRingRadiiPx
} from './corridorEvidenceGridRibbonMass';
import type { RibbonMassParams, RibbonMassRaster, RibbonMassSegmentation } from './ribbonMass';
import type { RawMaskBasket, RawMaskTee } from './rawObjectMask';
import type { P2LabeledBadge, P3OwnershipResult } from './rawObjectOwnership';

export interface P4BadgeCandidateEvidence {
	readonly holeNumber: number;
	readonly badgeComponentLabel: number | null;
	readonly teeComponentLabel: number | null;
	readonly teeContactDistancePx: number | null;
	readonly teeTouchesComponent: boolean;
	readonly badgeAxisErrorPx: number;
}

export interface P4TeeResolution {
	readonly teeIndex: number;
	readonly candidateHoleNumbers: readonly number[];
	readonly candidateEvidence: readonly P4BadgeCandidateEvidence[];
	readonly status: 'resolved' | 'ambiguous' | 'noRibbonSupport';
	readonly resolvedHoleNumber?: number;
}

export interface P4BasketEvidence {
	readonly holeNumber: number;
	readonly basketIndex: number;
	readonly componentLabel: number | null;
	readonly contactDistancePx: number | null;
}

export interface P4HoleRibbonResult {
	readonly holeNumber: number;
	readonly teeIndex?: number;
	readonly ribbonComponentLabel?: number;
	readonly basketIndexes: readonly number[];
	readonly basketContactDistancesPx: readonly number[];
	readonly status:
		| 'teeResolved'
		| 'basketResolved'
		| 'basketAmbiguous'
		| 'noBasket'
		| 'sharedComponent'
		| 'unresolved';
}

export interface P4RibbonOwnershipResult {
	readonly teeResolutions: readonly P4TeeResolution[];
	readonly basketEvidence: readonly P4BasketEvidence[];
	readonly holes: readonly P4HoleRibbonResult[];
	readonly sharedComponentLabels: readonly number[];
	readonly endpointContactRadiusPx: number;
}

export interface P45ChangedHole {
	readonly holeNumber: number;
	readonly beforeTeeStatus: P4TeeResolution['status'] | 'unresolved';
	readonly afterTeeStatus: P4TeeResolution['status'] | 'unresolved';
	readonly candidateBadges: readonly number[];
	readonly component: number | null;
	readonly beforeTeeContact: number | null;
	readonly afterTeeContact: number | null;
	readonly beforeBasketStatus: P4HoleRibbonResult['status'];
	readonly afterBasketStatus: P4HoleRibbonResult['status'];
	/** Hole ownership labels, not internal basket-array indexes. */
	readonly basketHoles: readonly number[];
}

export interface P45EndpointBridgeResult {
	readonly bridgeRadiusPx: number;
	readonly bridgeBandHalfWidthPx: number;
	readonly gapThresholdsPx: readonly number[];
	/** Original P4 timing, including the one shared segmentation pass. */
	readonly originalMs: number;
	readonly original: P4RibbonOwnershipResult;
	readonly bridged: P4RibbonOwnershipResult;
	readonly newlyResolvedHoleNumbers: readonly number[];
	readonly newlyBasketResolvedHoleNumbers: readonly number[];
	readonly newlyAmbiguousHoleNumbers: readonly number[];
	/** Previously resolved hole numbers that became ambiguous, unresolved, or changed owner. */
	readonly ownershipChangedHoleNumbers: readonly number[];
	/** Every accepted local bridge contact, including repeated contacts at distinct endpoints. */
	readonly acceptedBridgeGapsPx: readonly number[];
	readonly changedHoles: readonly P45ChangedHole[];
}

/** Validated v2 annulus-closing constants, kept exact for this experiment. */
export const P45_BAND_HALF_WIDTH_PX = DEFAULT_CORRIDOR_EVIDENCE_GRID_PARAMS.ringBandHalfWidthPx;
export const P45_MAX_CLOSE_PX = DEFAULT_CORRIDOR_EVIDENCE_GRID_PARAMS.maxBridgeGapPx;
export const P45_GAP_THRESHOLDS_PX = [6, 9, 12, 15, 18] as const;

interface P45BridgeContact {
	readonly contactDistancePx: number;
	readonly gapPx: number | null;
}

interface P45BridgeContext {
	readonly band: Uint8Array;
	readonly maxClosePx: number;
	readonly acceptedGapsPx: number[];
}

function componentAt(
	segmentation: ReturnType<typeof segmentRibbonMass>,
	xPx: number,
	yPx: number,
	searchRadiusPx: number
): number | null {
	return nearestComponentLabel(
		segmentation.labels,
		segmentation.widthEv,
		segmentation.heightEv,
		segmentation.scale,
		xPx,
		yPx,
		searchRadiusPx
	);
}

function nearestDistanceToComponentPx(
	segmentation: RibbonMassSegmentation,
	componentLabel: number | null,
	xSrcPx: number,
	ySrcPx: number,
	maxSearchRadiusPx: number
): number | null {
	if (componentLabel === null || maxSearchRadiusPx < 0) return null;
	const x = Math.trunc(xSrcPx / segmentation.scale);
	const y = Math.trunc(ySrcPx / segmentation.scale);
	if (x < 0 || x >= segmentation.widthEv || y < 0 || y >= segmentation.heightEv) return null;
	const radiusEv = maxSearchRadiusPx / segmentation.scale;
	const radiusEvCeil = Math.ceil(radiusEv);
	const radiusSq = radiusEv * radiusEv;
	const x0 = Math.max(0, x - radiusEvCeil);
	const x1 = Math.min(segmentation.widthEv - 1, x + radiusEvCeil);
	const y0 = Math.max(0, y - radiusEvCeil);
	const y1 = Math.min(segmentation.heightEv - 1, y + radiusEvCeil);
	let bestDistanceSq = Infinity;
	for (let row = y0; row <= y1; row += 1) {
		for (let column = x0; column <= x1; column += 1) {
			if (segmentation.labels[row * segmentation.widthEv + column] !== componentLabel) continue;
			const dx = column - x;
			const dy = row - y;
			const distanceSq = dx * dx + dy * dy;
			if (distanceSq <= radiusSq && distanceSq < bestDistanceSq) bestDistanceSq = distanceSq;
		}
	}
	return Number.isFinite(bestDistanceSq) ? Math.sqrt(bestDistanceSq) * segmentation.scale : null;
}

/**
 * Candidate-specific annulus bridge adapted from the validated v2 wavefront
 * rule. The original segmentation is never mutated and no other component can
 * become a bridge source. The only eligible pixels are the short gap segment
 * inside the caller-supplied 12px ring band.
 */
export function bridgeComponentNearEndpoint(
	segmentation: RibbonMassSegmentation,
	band: Uint8Array,
	componentLabel: number | null,
	endpointXSrcPx: number,
	endpointYSrcPx: number,
	maxClosePx: number,
	contactRadiusPx: number
): P45BridgeContact | null {
	const directDistance = nearestDistanceToComponentPx(
		segmentation,
		componentLabel,
		endpointXSrcPx,
		endpointYSrcPx,
		contactRadiusPx
	);
	if (directDistance !== null) return { contactDistancePx: directDistance, gapPx: null };
	if (maxClosePx <= 0) return null;
	if (componentLabel === null) return null;

	const endpointXEv = Math.trunc(endpointXSrcPx / segmentation.scale);
	const endpointYEv = Math.trunc(endpointYSrcPx / segmentation.scale);
	if (
		endpointXEv < 0 ||
		endpointXEv >= segmentation.widthEv ||
		endpointYEv < 0 ||
		endpointYEv >= segmentation.heightEv
	)
		return null;

	// Multi-source BFS, but only from THIS candidate label and only through
	// background cells in the local annulus. This is the v2 mechanism without
	// its global component union: no foreign label can become reachable.
	const maxSteps = Math.ceil(maxClosePx / segmentation.scale);
	const localRadiusEv = (contactRadiusPx + maxClosePx) / segmentation.scale;
	const localRadiusSq = localRadiusEv * localRadiusEv;
	const distance = new Int32Array(segmentation.labels.length).fill(-1);
	let frontier: number[] = [];
	const isLocal = (xEv: number, yEv: number): boolean => {
		const dx = xEv - endpointXEv;
		const dy = yEv - endpointYEv;
		return dx * dx + dy * dy <= localRadiusSq;
	};
	const contactDistanceAt = (xEv: number, yEv: number): number =>
		Math.hypot(xEv - endpointXEv, yEv - endpointYEv) * segmentation.scale;
	const accept = (xEv: number, yEv: number, steps: number): P45BridgeContact | null => {
		const contactDistancePx = contactDistanceAt(xEv, yEv);
		if (contactDistancePx > contactRadiusPx) return null;
		const gapPx = steps * segmentation.scale;
		return gapPx <= maxClosePx ? { contactDistancePx, gapPx } : null;
	};

	// Seed the wavefront from the candidate component's pixels at the edge of
	// the annulus; direct <=40px contacts already returned above.
	for (let y = Math.max(0, endpointYEv - Math.ceil(localRadiusEv)); y <= Math.min(segmentation.heightEv - 1, endpointYEv + Math.ceil(localRadiusEv)); y += 1) {
		for (let x = Math.max(0, endpointXEv - Math.ceil(localRadiusEv)); x <= Math.min(segmentation.widthEv - 1, endpointXEv + Math.ceil(localRadiusEv)); x += 1) {
			if (!isLocal(x, y) || segmentation.labels[y * segmentation.widthEv + x] !== componentLabel) continue;
			for (let dy = -1; dy <= 1; dy += 1) {
				for (let dx = -1; dx <= 1; dx += 1) {
					if (dx === 0 && dy === 0) continue;
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || nx >= segmentation.widthEv || ny < 0 || ny >= segmentation.heightEv) continue;
					const index = ny * segmentation.widthEv + nx;
					if (!isLocal(nx, ny) || band[index] === 0 || segmentation.labels[index] !== 0 || distance[index] !== -1) continue;
					distance[index] = 1;
					frontier.push(index);
				}
			}
		}
	}

	for (let step = 1; step <= maxSteps && frontier.length > 0; step += 1) {
		const next: number[] = [];
		for (const index of frontier) {
			const x = index % segmentation.widthEv;
			const y = (index - x) / segmentation.widthEv;
			const accepted = accept(x, y, step);
			if (accepted !== null) return accepted;
			for (let dy = -1; dy <= 1; dy += 1) {
				for (let dx = -1; dx <= 1; dx += 1) {
					if (dx === 0 && dy === 0) continue;
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || nx >= segmentation.widthEv || ny < 0 || ny >= segmentation.heightEv) continue;
					const nextIndex = ny * segmentation.widthEv + nx;
					if (
						!isLocal(nx, ny) ||
						band[nextIndex] === 0 ||
						segmentation.labels[nextIndex] !== 0 ||
						distance[nextIndex] !== -1
					)
						continue;
					distance[nextIndex] = step + 1;
					next.push(nextIndex);
				}
			}
		}
		frontier = next;
	}
	return null;
}

function buildP45RingBandMask(
	segmentation: RibbonMassSegmentation,
	baskets: readonly RawMaskBasket[],
	ringRadiiPx: readonly number[]
): Uint8Array {
	const band = new Uint8Array(segmentation.widthEv * segmentation.heightEv);
	for (const basket of baskets) {
		const basketXEv = basket.centerXPx / segmentation.scale;
		const basketYEv = basket.centerYPx / segmentation.scale;
		for (const radiusPx of ringRadiiPx) {
			const radiusEv = radiusPx / segmentation.scale;
			const halfWidthEv = P45_BAND_HALF_WIDTH_PX / segmentation.scale;
			const x0 = Math.max(0, Math.floor(basketXEv - radiusEv - halfWidthEv));
			const x1 = Math.min(segmentation.widthEv - 1, Math.ceil(basketXEv + radiusEv + halfWidthEv));
			const y0 = Math.max(0, Math.floor(basketYEv - radiusEv - halfWidthEv));
			const y1 = Math.min(segmentation.heightEv - 1, Math.ceil(basketYEv + radiusEv + halfWidthEv));
			for (let y = y0; y <= y1; y += 1) {
				for (let x = x0; x <= x1; x += 1) {
					const distancePx = Math.hypot(x - basketXEv, y - basketYEv) * segmentation.scale;
					if (Math.abs(distancePx - radiusPx) <= P45_BAND_HALF_WIDTH_PX) {
						band[y * segmentation.widthEv + x] = 1;
					}
				}
			}
		}
	}
	return band;
}

function uniqueNumbers(values: readonly number[]): number[] {
	return Array.from(new Set(values));
}

/** The validated v2 maximum total annulus gap, source px. */
export const P45_ENDPOINT_BRIDGE_RADIUS_PX = P45_MAX_CLOSE_PX;

function deriveP4RibbonOwnershipFromSegmentation(
	segmentation: RibbonMassSegmentation,
	tees: readonly RawMaskTee[],
	badges: readonly P2LabeledBadge[],
	baskets: readonly RawMaskBasket[],
	p3Ownership: P3OwnershipResult,
	params: RibbonMassParams,
	bridgeContext: P45BridgeContext | null = null
): P4RibbonOwnershipResult {
	const endpointContactRadiusPx = params.seedRadiusPx;
	const contactDistanceToComponent = (
		componentLabel: number | null,
		xSrcPx: number,
		ySrcPx: number
	): number | null =>
		bridgeContext
			? (() => {
					const contact = bridgeComponentNearEndpoint(
					segmentation,
					bridgeContext.band,
					componentLabel,
					xSrcPx,
					ySrcPx,
					bridgeContext.maxClosePx,
					endpointContactRadiusPx
					);
					if (contact?.gapPx !== null && contact?.gapPx !== undefined) {
						bridgeContext.acceptedGapsPx.push(contact.gapPx);
					}
					return contact?.contactDistancePx ?? null;
				})()
			: nearestDistanceToComponentPx(
					segmentation,
					componentLabel,
					xSrcPx,
					ySrcPx,
					endpointContactRadiusPx
				);
	const teeComponentLabels = tees.map((tee) =>
		componentAt(segmentation, tee.xPx, tee.yPx, params.seedRadiusPx)
	);
	const badgeComponentLabels = new Map<number, number | null>();
	for (const badge of badges) {
		badgeComponentLabels.set(
			badge.holeNumber,
			componentAt(segmentation, badge.xPx, badge.yPx, params.seedRadiusPx)
		);
	}
	const basketComponentLabels = baskets.map((basket) =>
		componentAt(segmentation, basket.centerXPx, basket.centerYPx, params.seedRadiusPx)
	);
	const p3DiagnosticsByTee = new Map(
		p3Ownership.teeDiagnostics.map((diagnostic) => [diagnostic.teeIndex, diagnostic])
	);

	const teeResolutions = tees.map((_, teeIndex): P4TeeResolution => {
		const diagnostic = p3DiagnosticsByTee.get(teeIndex);
		const candidateHoleNumbers = uniqueNumbers(diagnostic?.candidateHoleNumbers ?? []);
		const teeComponentLabel = teeComponentLabels[teeIndex];
		// P3's per-candidate axis error (`candidateBadgeEvidence`, populated for both
		// `owned` and conflicted tees) rather than `teeBadgeHits` (populated only for
		// `owned` tees) -- the latter is always empty for a conflicted tee, so its
		// candidates' axis errors were previously invisible to P4 entirely.
		const axisErrorByHole = new Map(
			(diagnostic?.candidateBadgeEvidence ?? []).map((evidence) => [evidence.holeNumber, evidence.badgeAxisErrorPx])
		);
		const candidateEvidence = candidateHoleNumbers.map((holeNumber): P4BadgeCandidateEvidence => {
			const badgeComponentLabel = badgeComponentLabels.get(holeNumber) ?? null;
			const teeContactDistancePx = contactDistanceToComponent(
				badgeComponentLabel,
				tees[teeIndex].xPx,
				tees[teeIndex].yPx
			);
			return {
				holeNumber,
				badgeComponentLabel,
				teeComponentLabel,
				teeContactDistancePx,
				teeTouchesComponent: teeContactDistancePx !== null,
				badgeAxisErrorPx: axisErrorByHole.get(holeNumber) ?? Number.NaN
			};
		});
		const supported = candidateEvidence.filter((candidate) => candidate.teeTouchesComponent);
		if (supported.length === 1) {
			const resolvedCandidate = supported[0];
			// Topology picked a single candidate, but only trust that pick when P3's
			// own geometry doesn't actively contradict it. A candidate the ribbon
			// merely brushes (contact right at the tolerance edge) can still win
			// `supported.length === 1` outright when the true tee-to-badge relation
			// simply never touches any component -- exactly the shape of a false
			// positive. Ordinal, not a magic distance: if some OTHER candidate's axis
			// error is strictly better than the resolved candidate's own, geometry
			// disagrees with topology and neither signal alone is trustworthy here,
			// so abstain rather than lock in a pick that may be topology's own wrong
			// contact. When topology's pick also has the best (or tied-best) axis
			// error, geometry corroborates it and the resolution stands as before.
			const contradictedByGeometry = candidateEvidence.some(
				(candidate) => candidate.holeNumber !== resolvedCandidate.holeNumber && candidate.badgeAxisErrorPx < resolvedCandidate.badgeAxisErrorPx
			);
			if (!contradictedByGeometry) {
				return {
					teeIndex,
					candidateHoleNumbers,
					candidateEvidence,
					status: 'resolved',
					resolvedHoleNumber: resolvedCandidate.holeNumber
				};
			}
		}
		return {
			teeIndex,
			candidateHoleNumbers,
			candidateEvidence,
			status: supported.length > 1 ? 'ambiguous' : 'noRibbonSupport'
		};
	});

	const resolvedPairs = teeResolutions
		.filter(
			(resolution): resolution is P4TeeResolution & { readonly resolvedHoleNumber: number } =>
				resolution.status === 'resolved' && resolution.resolvedHoleNumber !== undefined
		)
		.map((resolution) => {
			const resolvedEvidence = resolution.candidateEvidence.find(
				(evidence) => evidence.holeNumber === resolution.resolvedHoleNumber
			);
			return {
				holeNumber: resolution.resolvedHoleNumber,
				teeIndex: resolution.teeIndex,
				componentLabel: resolvedEvidence?.badgeComponentLabel ?? null
			};
		});
	const holesByComponent = new Map<number, number[]>();
	for (const pair of resolvedPairs) {
		if (pair.componentLabel === null) continue;
		const holes = holesByComponent.get(pair.componentLabel) ?? [];
		holes.push(pair.holeNumber);
		holesByComponent.set(pair.componentLabel, holes);
	}
	const sharedComponentLabels = Array.from(holesByComponent.entries())
		.filter(([, holeNumbers]) => uniqueNumbers(holeNumbers).length > 1)
		.map(([label]) => label);
	const sharedComponents = new Set(sharedComponentLabels);

	const basketEvidence: P4BasketEvidence[] = [];
	const holes: P4HoleRibbonResult[] = [];
	const resolvedHoleNumbers = new Set<number>();
	for (const pair of resolvedPairs) {
		resolvedHoleNumbers.add(pair.holeNumber);
		const basketContacts = baskets.flatMap((basket, basketIndex) => {
			const contactDistancePx = contactDistanceToComponent(
				pair.componentLabel,
				basket.centerXPx,
				basket.centerYPx
			);
			return contactDistancePx === null ? [] : [{ basketIndex, contactDistancePx }];
		});
		const basketIndexes = basketContacts.map((contact) => contact.basketIndex);
		const basketContactDistancesPx = basketContacts.map((contact) => contact.contactDistancePx);
		for (const contact of basketContacts) {
			basketEvidence.push({
				holeNumber: pair.holeNumber,
				basketIndex: contact.basketIndex,
				componentLabel: basketComponentLabels[contact.basketIndex],
				contactDistancePx: contact.contactDistancePx
			});
		}

		let status: P4HoleRibbonResult['status'];
		if (pair.componentLabel === null) {
			status = 'unresolved';
		} else if (sharedComponents.has(pair.componentLabel)) {
			status = 'sharedComponent';
		} else if (basketIndexes.length === 0) {
			status = 'noBasket';
		} else if (basketIndexes.length === 1) {
			status = 'basketResolved';
		} else {
			status = 'basketAmbiguous';
		}
		holes.push({
			holeNumber: pair.holeNumber,
			teeIndex: pair.teeIndex,
			ribbonComponentLabel: pair.componentLabel ?? undefined,
			basketIndexes,
			basketContactDistancesPx,
			status
		});
	}

	for (const badge of badges) {
		if (resolvedHoleNumbers.has(badge.holeNumber)) continue;
		holes.push({
			holeNumber: badge.holeNumber,
			basketIndexes: [],
			basketContactDistancesPx: [],
			status: 'unresolved'
		});
	}

	return { teeResolutions, basketEvidence, holes, sharedComponentLabels, endpointContactRadiusPx };
}

/**
 * `segmentation` is supplied by the caller rather than computed here — the
 * pancake worker builds it once (see `basketDetection.worker.ts`) and shares
 * it with P6.2, so ribbon segmentation runs exactly once per detection pass.
 */
export function deriveP4RibbonOwnership(
	segmentation: RibbonMassSegmentation,
	tees: readonly RawMaskTee[],
	badges: readonly P2LabeledBadge[],
	baskets: readonly RawMaskBasket[],
	p3Ownership: P3OwnershipResult,
	params: RibbonMassParams = DEFAULT_RIBBON_MASS_PARAMS
): P4RibbonOwnershipResult {
	return deriveP4RibbonOwnershipFromSegmentation(segmentation, tees, badges, baskets, p3Ownership, params);
}

function teeStatusForHole(
	result: P4RibbonOwnershipResult,
	holeNumber: number
): P4TeeResolution['status'] | 'unresolved' {
	const hole = result.holes.find((candidate) => candidate.holeNumber === holeNumber);
	if (hole?.teeIndex !== undefined) {
		return result.teeResolutions.find((resolution) => resolution.teeIndex === hole.teeIndex)?.status ?? 'unresolved';
	}
	const resolutions = result.teeResolutions.filter((resolution) =>
		resolution.candidateHoleNumbers.includes(holeNumber)
	);
	if (resolutions.some((resolution) => resolution.resolvedHoleNumber === holeNumber)) return 'resolved';
	if (resolutions.some((resolution) => resolution.status === 'ambiguous')) return 'ambiguous';
	if (resolutions.some((resolution) => resolution.status === 'noRibbonSupport')) return 'noRibbonSupport';
	return 'unresolved';
}

function teeEvidenceForHole(
	result: P4RibbonOwnershipResult,
	holeNumber: number
): P4BadgeCandidateEvidence | null {
	const hole = result.holes.find((candidate) => candidate.holeNumber === holeNumber);
	const exactResolution =
		hole?.teeIndex === undefined
			? null
			: result.teeResolutions.find((resolution) => resolution.teeIndex === hole.teeIndex) ?? null;
	return (
		exactResolution?.candidateEvidence.find((evidence) => evidence.holeNumber === holeNumber) ??
		result.teeResolutions
			.map((resolution) => resolution.candidateEvidence.find((evidence) => evidence.holeNumber === holeNumber))
			.find((evidence): evidence is P4BadgeCandidateEvidence => evidence !== undefined) ??
		null
	);
}

function candidateBadgesForHole(
	results: readonly P4RibbonOwnershipResult[],
	holeNumber: number
): number[] {
	return uniqueNumbers(
		results.flatMap((result) =>
			result.teeResolutions
				.filter((resolution) => resolution.candidateHoleNumbers.includes(holeNumber))
				.flatMap((resolution) => resolution.candidateHoleNumbers)
		)
	);
}

function equalNumbers(left: readonly number[], right: readonly number[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function deriveP45EndpointBridgeExperiment(
	raster: RibbonMassRaster,
	tees: readonly RawMaskTee[],
	badges: readonly P2LabeledBadge[],
	baskets: readonly RawMaskBasket[],
	p3Ownership: P3OwnershipResult,
	params: RibbonMassParams = DEFAULT_RIBBON_MASS_PARAMS,
	bridgeRadiusPx = P45_ENDPOINT_BRIDGE_RADIUS_PX
): P45EndpointBridgeResult {
	const originalStartedAt = performance.now();
	const segmentation = segmentRibbonMass(
		raster,
		badges.map((badge) => ({ xPx: badge.xPx, yPx: badge.yPx })),
		params
	);
	const original = deriveP4RibbonOwnershipFromSegmentation(
		segmentation,
		tees,
		badges,
		baskets,
		p3Ownership,
		params
	);
	const originalMs = performance.now() - originalStartedAt;
	const ringRadiiPx = discoverBasketRingRadiiPx(
		raster,
		baskets.map((basket) => ({ xPx: basket.centerXPx, yPx: basket.centerYPx })),
		DEFAULT_RING_RADIUS_DISCOVERY_PARAMS
	);
	const bridgeBand = buildP45RingBandMask(segmentation, baskets, ringRadiiPx);
	const acceptedBridgeGapsPx: number[] = [];
	const bridged = deriveP4RibbonOwnershipFromSegmentation(
		segmentation,
		tees,
		badges,
		baskets,
		p3Ownership,
		params,
		{
			band: bridgeBand,
			maxClosePx: bridgeRadiusPx,
			acceptedGapsPx: acceptedBridgeGapsPx
		}
	);

	const beforeByTee = new Map(original.teeResolutions.map((resolution) => [resolution.teeIndex, resolution]));
	const afterByTee = new Map(bridged.teeResolutions.map((resolution) => [resolution.teeIndex, resolution]));
	const newlyResolvedHoleNumbers: number[] = [];
	const newlyAmbiguousHoleNumbers: number[] = [];
	const ownershipChangedHoleNumbers: number[] = [];
	for (const teeIndex of uniqueNumbers([...beforeByTee.keys(), ...afterByTee.keys()])) {
		const before = beforeByTee.get(teeIndex);
		const after = afterByTee.get(teeIndex);
		if (!before || !after) continue;
		if (after.status === 'resolved' && after.resolvedHoleNumber !== undefined) {
			if (before.status !== 'resolved' || before.resolvedHoleNumber === undefined) {
				newlyResolvedHoleNumbers.push(after.resolvedHoleNumber);
			} else if (before.resolvedHoleNumber !== after.resolvedHoleNumber) {
				ownershipChangedHoleNumbers.push(before.resolvedHoleNumber, after.resolvedHoleNumber);
			}
		}
		if (after.status === 'ambiguous' && before.status !== 'ambiguous') {
			newlyAmbiguousHoleNumbers.push(...after.candidateHoleNumbers);
		}
		if (
			before.status === 'resolved' &&
			(before.resolvedHoleNumber === undefined || after.status !== 'resolved') &&
			before.resolvedHoleNumber !== undefined
		) {
			ownershipChangedHoleNumbers.push(before.resolvedHoleNumber);
		}
	}

	const beforeHoleByNumber = new Map(original.holes.map((hole) => [hole.holeNumber, hole]));
	const afterHoleByNumber = new Map(bridged.holes.map((hole) => [hole.holeNumber, hole]));
	const newlyBasketResolvedHoleNumbers = Array.from(afterHoleByNumber.keys()).filter((holeNumber) => {
		const beforeStatus = beforeHoleByNumber.get(holeNumber)?.status ?? 'unresolved';
		return afterHoleByNumber.get(holeNumber)?.status === 'basketResolved' && beforeStatus !== 'basketResolved';
	});
	for (const hole of bridged.holes) {
		const beforeStatus = beforeHoleByNumber.get(hole.holeNumber)?.status ?? 'unresolved';
		if (hole.status === 'basketAmbiguous' && beforeStatus !== 'basketAmbiguous') {
			newlyAmbiguousHoleNumbers.push(hole.holeNumber);
		}
	}

	const holeNumbers = uniqueNumbers([
		...original.holes.map((hole) => hole.holeNumber),
		...bridged.holes.map((hole) => hole.holeNumber),
		...original.teeResolutions.flatMap((resolution) => resolution.candidateHoleNumbers),
		...bridged.teeResolutions.flatMap((resolution) => resolution.candidateHoleNumbers)
	]);
	const changedHoles: P45ChangedHole[] = [];
	for (const holeNumber of holeNumbers) {
		const beforeHole = beforeHoleByNumber.get(holeNumber);
		const afterHole = afterHoleByNumber.get(holeNumber);
		const beforeEvidence = teeEvidenceForHole(original, holeNumber);
		const afterEvidence = teeEvidenceForHole(bridged, holeNumber);
		const beforeTeeStatus = teeStatusForHole(original, holeNumber);
		const afterTeeStatus = teeStatusForHole(bridged, holeNumber);
		const beforeBasketStatus = beforeHole?.status ?? 'unresolved';
		const afterBasketStatus = afterHole?.status ?? 'unresolved';
		const beforeComponent = beforeHole?.ribbonComponentLabel ?? null;
		const afterComponent = afterHole?.ribbonComponentLabel ?? null;
		const beforeBasketContacts = beforeHole?.basketIndexes ?? [];
		const afterBasketContacts = afterHole?.basketIndexes ?? [];
		const changed =
			beforeTeeStatus !== afterTeeStatus ||
			beforeBasketStatus !== afterBasketStatus ||
			beforeComponent !== afterComponent ||
			beforeEvidence?.teeContactDistancePx !== afterEvidence?.teeContactDistancePx ||
			!equalNumbers(beforeBasketContacts, afterBasketContacts);
		if (!changed) continue;
		changedHoles.push({
			holeNumber,
			beforeTeeStatus,
			afterTeeStatus,
			candidateBadges: candidateBadgesForHole([original, bridged], holeNumber),
			component: afterComponent ?? beforeComponent,
			beforeTeeContact: beforeEvidence?.teeContactDistancePx ?? null,
			afterTeeContact: afterEvidence?.teeContactDistancePx ?? null,
			beforeBasketStatus,
			afterBasketStatus,
			basketHoles: afterBasketContacts.length > 0 ? [holeNumber] : []
		});
	}

	return {
		bridgeRadiusPx,
		bridgeBandHalfWidthPx: P45_BAND_HALF_WIDTH_PX,
		gapThresholdsPx: P45_GAP_THRESHOLDS_PX,
		originalMs,
		original,
		bridged,
		newlyResolvedHoleNumbers: uniqueNumbers(newlyResolvedHoleNumbers),
		newlyBasketResolvedHoleNumbers: uniqueNumbers(newlyBasketResolvedHoleNumbers),
		newlyAmbiguousHoleNumbers: uniqueNumbers(newlyAmbiguousHoleNumbers),
		ownershipChangedHoleNumbers: uniqueNumbers(ownershipChangedHoleNumbers),
		acceptedBridgeGapsPx,
		changedHoles
	};
}
