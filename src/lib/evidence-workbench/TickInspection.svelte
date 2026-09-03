<script lang="ts">
	import type { Pcr } from '@chainspot/alg/exec';

	let {
		pcr,
		tickId,
		residue = []
	}: {
		pcr: Pcr;
		tickId: string;
		residue?: readonly {
			readonly label: string;
			readonly count: number | null;
			readonly note: string;
		}[];
	} = $props();
	let checkpoint = $derived(
		pcr.ticks.find((candidate) => candidate.operation.id === tickId) ?? pcr.ticks[0]
	);
	let tick = $derived(checkpoint?.testimony);
	let operation = $derived(checkpoint?.operation);
	let missingInputs = $derived(
		operation?.consumes.filter((address) => !tick?.actualConsumes.includes(address)) ?? []
	);
	let missingOutputs = $derived(
		operation?.produces.filter((address) => !tick?.actualProduces.includes(address)) ?? []
	);
</script>

{#if tick && operation}
	<article class="tick-inspection" data-pcr={pcr.id} data-tick={tick.opId}>
		<header>
			<div>
				<span>{pcr.title}</span>
				<h2>{tick.opId}</h2>
			</div>
			<code>{tick.durationMs.toFixed(3)} ms</code>
		</header>

		<dl class="identity-strip">
			<div>
				<dt>Run Args identity</dt>
				<dd><code>{pcr.paramsHash ?? 'UNKNOWN'}</code></dd>
			</div>
			<div>
				<dt>Plan</dt>
				<dd><code>{pcr.planFingerprint}</code></dd>
			</div>
			<div>
				<dt>Run result</dt>
				<dd><code>{pcr.runResultId}</code></dd>
			</div>
		</dl>
		<p class="identity-limit">
			<strong>{pcr.runResultIdentityScope}</strong> — {pcr.runResultIdentityLimitation}
		</p>

		<div class="flow">
			<section>
				<h3>Exact PxC inputs</h3>
				<ul>
					{#each tick.actualConsumes as address (address)}<li><code>{address}</code></li>{/each}
					{#if tick.actualConsumes.length === 0}<li class="unknown">[] — none read</li>{/if}
				</ul>
				{#if missingInputs.length}<p class="warning">
						Declared but unread: {missingInputs.join(', ')}
					</p>{/if}
			</section>

			<section class="calculation">
				<h3>Calculation identity</h3>
				<ul>
					{#each tick.frozenCalculations as calculation (calculation.address)}
						<li>
							<strong><code>{calculation.address}</code></strong>
							<small>{calculation.identityScope} SHA-256 {calculation.implementationHash}</small>
							<small class="warning">Not transitive: {calculation.limitation}</small>
						</li>
					{/each}
				</ul>
			</section>

			<section>
				<h3>Exact PxC outputs</h3>
				<ul>
					{#each tick.writes as write (write.address)}
						<li>
							<code>{write.address}</code>
							<span class:replacement={write.kind === 'replacement'}>{write.kind}</span>
						</li>
					{/each}
					{#if tick.writes.length === 0}<li class="unknown">[] — nothing written</li>{/if}
				</ul>
				{#if missingOutputs.length}<p class="warning">
						Declared but unwritten: {missingOutputs.join(', ')}
					</p>{/if}
			</section>
		</div>

		<section class="materializations">
			<h3>Materializations emitted by this Tick</h3>
			{#if tick.artifacts.length}
				<ul>
					{#each tick.artifacts as materialization (materialization.id)}
						<li>
							<code>{materialization.kind} · {materialization.id}</code>
							<small
								>SHA-256 {materialization.sha256}{materialization.dims
									? ` · ${materialization.dims.width}×${materialization.dims.height}`
									: ''}</small
							>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="unknown">
					No persisted Materialization at this boundary. PxC outputs remain inspectable by address.
				</p>
			{/if}
		</section>

		<section class="residue">
			<h3>Residue / UNKNOWN</h3>
			{#if residue.length}
				<ul>
					{#each residue as line (line.label)}<li>
							<strong>{line.label}: {line.count ?? 'UNKNOWN'}</strong> — {line.note}
						</li>{/each}
				</ul>
			{:else}
				<p class="unknown">UNKNOWN — this Tick establishes no molecule-specific residue account.</p>
			{/if}
		</section>
	</article>
{:else}
	<p class="warning">PCR Tick unavailable: {tickId}</p>
{/if}

<style>
	.tick-inspection {
		display: grid;
		gap: 1rem;
		color: #171717;
		font:
			14px/1.4 ui-sans-serif,
			system-ui,
			sans-serif;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: end;
		gap: 1rem;
	}
	header span,
	h3,
	dt {
		color: #6d28d9;
		font-size: 0.72rem;
		font-weight: 750;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	h2 {
		margin: 0.15rem 0 0;
		font:
			700 1.2rem/1.2 ui-monospace,
			monospace;
	}
	code {
		overflow-wrap: anywhere;
	}
	.identity-strip {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.5rem;
		margin: 0;
	}
	.identity-strip div,
	section {
		border: 1px solid #d4d4d4;
		background: #fafafa;
		padding: 0.75rem;
	}
	dt {
		margin-bottom: 0.25rem;
	}
	dd {
		margin: 0;
		font-size: 0.72rem;
	}
	.flow {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr) minmax(0, 1fr);
		gap: 0.75rem;
	}
	h3 {
		margin: 0 0 0.45rem;
	}
	ul {
		margin: 0;
		padding-left: 1.1rem;
	}
	li + li {
		margin-top: 0.35rem;
	}
	.calculation li,
	.materializations li {
		display: grid;
		gap: 0.15rem;
	}
	small {
		color: #737373;
		overflow-wrap: anywhere;
	}
	.unknown {
		color: #737373;
	}
	.warning,
	.replacement {
		color: #a21caf;
		font-weight: 700;
	}
	.identity-limit {
		margin: -0.5rem 0 0;
		color: #737373;
		font-size: 0.75rem;
	}
	@media (max-width: 780px) {
		.flow,
		.identity-strip {
			grid-template-columns: 1fr;
		}
	}
</style>
