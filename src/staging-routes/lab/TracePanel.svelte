<script lang="ts">
	// Per-unit trace: knobs (deviations bolded), timings, exact measurement
	// aggregates. Spatial drawables render in the parent's SVG, not here.
	import type { RunTrace } from '@chainspot/alg/detectors/threeFactor';

	let { trace }: { trace: RunTrace } = $props();
</script>

<details open style="border: 1px solid black; padding: 0.4rem; font-family: monospace; font-size: 12.5px;">
	<summary>
		<strong>trace</strong> · config {trace.configName} · hash {trace.paramsHash.slice(0, 12)}…
		· order: {trace.execution.join(' → ')}
	</summary>
	{#each trace.units as unit (unit.id)}
		<details style="margin: 0.3rem 0 0 0.6rem;">
			<summary>
				[{unit.gate}] <strong>{unit.id}</strong> · {unit.ms.toFixed(1)}ms
				· {unit.enabled ? 'on' : 'OFF'}
				· {unit.drawables.length} drawables
			</summary>
			{#if Object.keys(unit.knobs).length > 0}
				<div style="margin-left: 1rem;">
					knobs:
					{#each Object.entries(unit.knobs) as [name, value] (name)}
						{#if unit.knobsDeviating.includes(name)}
							<strong> {name}={JSON.stringify(value)}*</strong>
						{:else}
							<span> {name}={JSON.stringify(value)}</span>
						{/if}
					{/each}
				</div>
			{/if}
			{#each unit.measurements as m (m.name)}
				<div style="margin-left: 1rem;">
					{m.name}: n={m.count} min={m.min.toFixed(3)} max={m.max.toFixed(3)} mean={(m.sum / Math.max(1, m.count)).toFixed(3)}
				</div>
			{/each}
		</details>
	{/each}
</details>
