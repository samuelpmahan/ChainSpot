/**
 * Internal-only visualization of a stored `RibbonMassShadowRun` — the
 * dev-tools counterpart of the research probes' `*-ribbon-mass.png`
 * overlays, pointed at the LIVE production shadow pass instead of the two
 * labeled fixtures. Renders the production experiment's recommended mask
 * (seed ∪ texture) colored by what Phase 2 actually knows:
 *
 *   green  — component owned by exactly ONE hole's seeds (the only case
 *            with unambiguous ownership; still says nothing about the tee)
 *   amber  — component touched by MULTIPLE holes' seeds (connectivity
 *            without ownership; the arbitration backlog)
 *   blue   — texture-admitted component no seed reaches (anchor-independent
 *            baseline signal)
 *
 * Per the pipeline-debug-view doc's ground rules: this is for Sam, never
 * shipped to an end user, and components/holes are always identified by
 * hole number — never by a raw internal candidate index.
 *
 * Unlike the research figures, per-hole ownership here comes from
 * `seed_component_owners`' port, so this shows Phase-2 attribution, not
 * just the Phase-1 global mask the committed PNGs render.
 */
import { decodeLabelMap } from './ribbonMassShadowRun';
import type { RibbonMassShadowRun } from './ribbonMassShadowRun';
import type { RibbonMassTopologyBucket } from './ribbonMass';

export interface ShadowOverlaySplitLine {
	readonly holeNumber: number;
	readonly badge: { readonly xPx: number; readonly yPx: number };
	readonly basket: { readonly xPx: number; readonly yPx: number };
}

export interface ShadowOverlayRender {
	/** PNG data URL of the colored mask, at evidence-map resolution. */
	readonly dataUrl: string;
	/** Source-px extent the data URL covers (evidence dims × scale; may undershoot the image by <scale px). */
	readonly widthPx: number;
	readonly heightPx: number;
	/** Kept-component counts by ownership class, for the legend. */
	readonly counts: { readonly exclusive: number; readonly shared: number; readonly textureOnly: number };
	readonly topologyCounts: Readonly<Record<RibbonMassTopologyBucket, number>>;
	/** Badge→basket connectors for holes whose corridor is split across components. */
	readonly splitLines: readonly ShadowOverlaySplitLine[];
}

const EXCLUSIVE_RGBA = [34, 197, 94, 120] as const;
const SHARED_RGBA = [245, 158, 11, 130] as const;
const TEXTURE_ONLY_RGBA = [96, 165, 250, 100] as const;

/** Returns null when the run has no production experiment or canvas is unavailable. */
export function renderShadowRunOverlay(run: RibbonMassShadowRun): ShadowOverlayRender | null {
	const production = run.experiments.production;
	if (!production || typeof document === 'undefined') return null;

	const ownersByLabel = new Map<number, Set<number>>();
	for (const seed of production.seedAssignments) {
		if (seed.componentLabel === null || seed.holeNumber === null) continue;
		let owners = ownersByLabel.get(seed.componentLabel);
		if (!owners) {
			owners = new Set<number>();
			ownersByLabel.set(seed.componentLabel, owners);
		}
		owners.add(seed.holeNumber);
	}
	const colorByLabel = new Map<number, readonly [number, number, number, number]>();
	const counts = { exclusive: 0, shared: 0, textureOnly: 0 };
	for (const label of production.recommended.keptLabels) {
		const owners = ownersByLabel.get(label);
		if (!owners || owners.size === 0) {
			colorByLabel.set(label, TEXTURE_ONLY_RGBA);
			counts.textureOnly += 1;
		} else if (owners.size === 1) {
			colorByLabel.set(label, EXCLUSIVE_RGBA);
			counts.exclusive += 1;
		} else {
			colorByLabel.set(label, SHARED_RGBA);
			counts.shared += 1;
		}
	}

	const { widthEv, heightEv, scale } = run.labelMap;
	const labels = decodeLabelMap(run.labelMap);
	const canvas = document.createElement('canvas');
	canvas.width = widthEv;
	canvas.height = heightEv;
	const context = canvas.getContext('2d');
	if (!context) return null;
	const imageData = context.createImageData(widthEv, heightEv);
	for (let i = 0; i < labels.length; i += 1) {
		const color = colorByLabel.get(labels[i]);
		if (!color) continue;
		const p = i * 4;
		imageData.data[p] = color[0];
		imageData.data[p + 1] = color[1];
		imageData.data[p + 2] = color[2];
		imageData.data[p + 3] = color[3];
	}
	context.putImageData(imageData, 0, 0);

	const badgeByHole = new Map(
		run.productionSnapshot.badges.map((badge) => [badge.productionHoleAssignment, badge])
	);
	const basketByHole = new Map(
		run.productionSnapshot.baskets
			.filter((basket) => basket.productionHoleAssignment !== null)
			.map((basket) => [basket.productionHoleAssignment as number, basket])
	);
	const splitLines: ShadowOverlaySplitLine[] = [];
	for (const hole of production.topology.perHole) {
		if (hole.bucket !== 'split') continue;
		const badge = badgeByHole.get(hole.holeNumber);
		const basket = basketByHole.get(hole.holeNumber);
		if (!badge || !basket) continue;
		splitLines.push({
			holeNumber: hole.holeNumber,
			badge: { xPx: badge.xPx, yPx: badge.yPx },
			basket: { xPx: basket.xPx, yPx: basket.yPx }
		});
	}

	return {
		dataUrl: canvas.toDataURL('image/png'),
		widthPx: widthEv * scale,
		heightPx: heightEv * scale,
		counts,
		topologyCounts: production.topology.counts,
		splitLines
	};
}
