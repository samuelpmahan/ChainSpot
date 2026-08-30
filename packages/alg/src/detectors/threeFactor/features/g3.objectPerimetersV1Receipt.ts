import type { Drawable, FeatureRender, FeatureRenderPlan, RunTrace, UnitTrace } from './types';

function selected(unit: UnitTrace, role: string): readonly Drawable[] {
	return unit.drawables.filter((drawable) => drawable.metadata?.role === role);
}

export const objectPerimetersV1Render: FeatureRender = {
	units: ['objectPerimetersV1'],
	draw(unit: UnitTrace, run: RunTrace): FeatureRenderPlan {
		const owned = selected(unit, 'owned-union');
		const perimeter = selected(unit, 'canonical-perimeter');
		const failures = selected(unit, 'v1-failure');
		const byKind = (drawables: readonly Drawable[], kind: string) =>
			drawables.filter((drawable) => drawable.metadata?.objectKind === kind);
		const count = (name: string) => unit.measurements.find((measurement) => measurement.name === name)?.sum;
		return {
			title: `G3 objectPerimetersV1 -- canonical clean-object custody (${run.configName})`,
			base: 'badgeStage.masks.bright',
			layers: [
				{
					name: 'exact owned component unions',
					note: 'faint fill: exact selected bright/dark connected-component cells only; no inferred or fitted pixels',
					drawables: owned
				},
				{
					name: 'canonical stored perimeters',
					note: 'solid outline testimony: exact exposed boundary of the stored owned-pixel union; tee/badge outer component is bright, basket outer component is dark',
					drawables: perimeter
				},
				{
					name: 'V1 loud failures',
					note: 'no perimeter is fabricated; overlap/recovery/fused topology is explicitly handed to V2',
					drawables: failures
				}
			],
			notes: [
				`assembledObjects: ${count('assembledObjects') ?? 'UNKNOWN'} (source: objectPerimetersV1 trace aggregate)`,
				`v1Failures: ${count('v1Failures') ?? 'UNKNOWN'} (source: objectPerimetersV1 trace aggregate)`,
				`badges rendered: ${byKind(perimeter, 'badge').length}; V1 failures: ${byKind(failures, 'badge').length}`,
				`tees rendered: ${byKind(perimeter, 'tee').length}; V1 failures: ${byKind(failures, 'tee').length}`,
				`baskets rendered: ${byKind(perimeter, 'basket').length}; V1 failures: ${byKind(failures, 'basket').length}`,
				'V1 contract: tee + badge physical outside is the accepted white/bright border component; basket physical outside is the accepted black/dark shell component.',
				'V1 never splits fused components, invents overlap ownership, re-thresholds, dilates, fills, or substitutes detector/fitted bboxes for physical perimeter.',
				'Visual contract: successful objects show exact owned union + exact stored perimeter; failed objects show only loud rejected seed geometry and reason.'
			]
		};
	}
};
