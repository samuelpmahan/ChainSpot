// Feature-owned receipt/render seam for the G5 directed-corridor Straight Test.
//
// This module is intentionally trace-only. The producer has already chosen
// and measured every basket-tip hypothesis; rendering only groups the exact
// drawables it emitted. No geometry, ranking, pixel read, or ownership is
// recomputed here.

import type { Drawable, FeatureRender, FeatureRenderPlan, RunTrace, UnitTrace } from './types';

const UNIT_ID = 'straightTest';
const LOCAL_IMAGE_ARTIFACT = 'badgeStage.masks.localImage';

function role(drawable: Drawable): string | undefined {
	return drawable.metadata?.straightRole;
}

function byRole(unit: UnitTrace, name: string): Drawable[] {
	return unit.drawables.filter((drawable) => role(drawable) === name);
}

function numberValue(drawable: Drawable, name: string): string {
	const value = drawable.values?.[name];
	return typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toFixed(3))) : 'UNKNOWN';
}

function routeLines(routes: readonly Drawable[]): string[] {
	if (routes.length === 0) return ['resolved straight holes: 0'];
	return [
		`resolved straight holes: ${routes.length} (source: accepted straight-route drawables)`,
		'H | tee | badge | basket TIP | alongPx | perpPx | corridorTips | nextTipMarginPx',
		...routes.map((route) => {
			const h = numberValue(route, 'hole');
			const m = route.metadata ?? {};
			return [
				h === 'UNKNOWN' ? 'UNKNOWN' : `H${h}`,
				m.teeId ?? 'UNKNOWN',
				m.badgeId ?? 'UNKNOWN',
				m.basketId ?? 'UNKNOWN',
				numberValue(route, 'alongPx'),
				numberValue(route, 'perpendicularPx'),
				numberValue(route, 'corridorCandidateCount'),
				numberValue(route, 'nextTipMarginPx')
			].join(' | ');
		})
	];
}

export const STRAIGHT_TEST_RENDER: FeatureRender = {
	units: [UNIT_ID],
	draw(unit: UnitTrace, run: RunTrace): FeatureRenderPlan {
		const sourceLocks = run.units
			.find((candidate) => candidate.id === 'teeBadgeLock')
			?.drawables.filter(
				(drawable) => drawable.type === 'polyline' && drawable.verdict === 'accepted' && drawable.visualRole === 'tee-badge-path'
			) ?? [];
		const corridorEdges = byRole(unit, 'corridor-edge');
		const routes = byRole(unit, 'straight-route');
		const winningTips = byRole(unit, 'winning-basket-tip');
		const laterTips = byRole(unit, 'later-basket-tip');
		const abstentions = byRole(unit, 'straight-abstention');
		return {
			title: `G5 Straight Test — first basket TIP in directed corridor (${run.configName})`,
			base: LOCAL_IMAGE_ARTIFACT,
			layers: [
				{
					name: 'known Tee→Badge locks',
					note: 'upstream G4 testimony; forwarded unchanged',
					drawables: sourceLocks
				},
				{
					name: 'straight corridor edges',
					note: 'producer-emitted boundaries at ± corridorWidthPx/2 around the directed tee→badge ray',
					drawables: corridorEdges
				},
				{
					name: 'resolved straight Tee→Badge→Basket TIP route',
					note: 'the first forward basket TIP encountered inside the corridor',
					drawables: routes
				},
				{
					name: 'winning basket TIPs',
					note: 'semantic basket endpoints selected by encounter order, never bbox contact',
					drawables: winningTips
				},
				{
					name: 'later basket TIPs in the same corridor',
					note: 'rejected alternatives that are geometrically plausible but occur after the first endpoint',
					drawables: laterTips
				},
				{
					name: 'straight-test abstentions',
					note: 'known tee→badge locks with no unique forward basket TIP in the corridor',
					drawables: abstentions
				}
			],
			notes: [
				`feature: straightTest — ${unit.gate}, trace unit '${unit.id}'`,
				`config: ${run.configName}`,
				`paramsHash: ${run.paramsHash || 'UNKNOWN'}`,
				"rule: extend the accepted Tee→Badge direction; among semantic basket TIPs forward of the badge and within corridorWidthPx/2, the first TIP encountered is the straight-hole endpoint.",
				'no renderer recomputation: every line, corridor edge, point, and number below comes from Straight Test producer drawables.',
				...routeLines(routes),
				`later in-corridor alternatives: ${laterTips.length}`,
				`abstentions: ${abstentions.length}`
			]
		};
	}
};
