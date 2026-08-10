/**
 * Pure geometry for the Annotate Round radial (pie) menu.
 *
 * The menu is rendered as SVG content positioned at the clicked point in
 * source-image pixel space (see +page.svelte's `overlay` snippet), so all
 * geometry here is in a local coordinate system centered on the origin —
 * the caller translates the whole group to the click point and applies a
 * `1 / zoom` counter-scale so the menu holds a constant on-screen size.
 */

export interface RadialWedgeLayout {
	/** SVG `<path d>` for this wedge's annulus sector (outer radius → hub). */
	readonly path: string;
	/** Point at the mid-angle/mid-radius of the wedge, for icon/label placement. */
	readonly labelX: number;
	readonly labelY: number;
}

export interface RadialMenuLayout {
	readonly wedges: readonly RadialWedgeLayout[];
	/** Radius of the center hub (cancel target); wedges start outside this. */
	readonly hubRadius: number;
	readonly outerRadius: number;
}

const DEFAULT_HUB_RADIUS = 20;
const DEFAULT_OUTER_RADIUS = 64;

function polarPoint(radius: number, angleRad: number): { x: number; y: number } {
	return { x: radius * Math.sin(angleRad), y: -radius * Math.cos(angleRad) };
}

function annulusSectorPath(
	hubRadius: number,
	outerRadius: number,
	startAngleRad: number,
	endAngleRad: number
): string {
	const outerStart = polarPoint(outerRadius, startAngleRad);
	const outerEnd = polarPoint(outerRadius, endAngleRad);
	const hubEnd = polarPoint(hubRadius, endAngleRad);
	const hubStart = polarPoint(hubRadius, startAngleRad);
	const largeArc = endAngleRad - startAngleRad > Math.PI ? 1 : 0;
	return [
		`M ${outerStart.x} ${outerStart.y}`,
		`A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
		`L ${hubEnd.x} ${hubEnd.y}`,
		`A ${hubRadius} ${hubRadius} 0 ${largeArc} 0 ${hubStart.x} ${hubStart.y}`,
		'Z'
	].join(' ');
}

/**
 * Lays out `wedgeCount` equal wedges in a full circle starting at the top
 * (12 o'clock) going clockwise, each an annulus sector from `hubRadius` out
 * to `outerRadius`. A single wedge renders as a full ring around the hub —
 * used for the delete-only menu — rather than a distinct code path.
 */
export function radialWedges(
	wedgeCount: number,
	options: { hubRadius?: number; outerRadius?: number } = {}
): RadialMenuLayout {
	const hubRadius = options.hubRadius ?? DEFAULT_HUB_RADIUS;
	const outerRadius = options.outerRadius ?? DEFAULT_OUTER_RADIUS;
	const count = Math.max(1, Math.floor(wedgeCount));
	const angleStep = (Math.PI * 2) / count;
	const labelRadius = (hubRadius + outerRadius) / 2;

	const wedges: RadialWedgeLayout[] = [];
	for (let index = 0; index < count; index += 1) {
		const startAngle = index * angleStep;
		const endAngle = startAngle + angleStep;
		const midAngle = startAngle + angleStep / 2;
		const label = polarPoint(labelRadius, midAngle);
		wedges.push({
			path:
				count === 1
					? annulusSectorPath(hubRadius, outerRadius, 0, Math.PI * 2 - 0.0001)
					: annulusSectorPath(hubRadius, outerRadius, startAngle, endAngle),
			labelX: label.x,
			labelY: label.y
		});
	}

	return { wedges, hubRadius, outerRadius };
}
