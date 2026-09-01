<script lang="ts">
	import {
		M2_PROJECTIONS,
		formatM2RawFrameCliText,
		projectM2Image,
		projectM2RawFrameImage,
		projectM2RawFrameVisual,
		supportRange,
		type M2AppearanceVariant,
		type M2BadgeProjectionSubject,
		type M2Projection
	} from './m2Projection';

	let {
		subject,
		projection = 'transition',
		zoom = 8,
		showGrid = false,
		showReceipt = true,
		supportThreshold = 0,
		appearanceVariant = 'exact-baseline'
	}: {
		subject: M2BadgeProjectionSubject;
		projection?: M2Projection;
		zoom?: number;
		showGrid?: boolean;
		showReceipt?: boolean;
		/** View-only cutoff; it never changes the materialized evidence. */
		supportThreshold?: number;
		appearanceVariant?: M2AppearanceVariant;
	} = $props();

	let canvas: HTMLCanvasElement;
	let image = $derived(projectM2Image(subject, projection, supportThreshold));
	let rawVisual = $derived(subject.rawTrace ? projectM2RawFrameVisual(subject.rawTrace, subject.rawTrace.objectId, appearanceVariant) : null);
	let rawImage = $derived(subject.rawTrace ? projectM2RawFrameImage(subject.rawTrace, appearanceVariant) : null);
	let displayedImage = $derived(rawImage ?? image);
	let title = $derived(subject.title ?? subject.id);
	let m1 = $derived(subject.m2.m1);
	let m2 = $derived(subject.m2.m2);
	let transition = $derived(subject.m2.transition);
	let aa = $derived(subject.m2.aa);
	let frame = $derived(subject.m2.frame);
	let registration = $derived(subject.m2.registration);
	let support = $derived(supportRange(subject));

	$effect(() => {
		if (!canvas) return;
		canvas.width = displayedImage.width;
		canvas.height = displayedImage.height;
		const context = canvas.getContext('2d');
		if (!context) return;
		context.putImageData(
			new ImageData(Uint8ClampedArray.from(displayedImage.rgba), displayedImage.width, displayedImage.height),
			0,
			0
		);
	});

	function percent(value: number | null): string {
		return value === null ? 'UNKNOWN' : `${(value * 100).toFixed(2)}%`;
	}

	const projectionLabels: Record<M2Projection, string> = {
		'm1-available': 'M1 available',
		'm1-explained': 'M1 explained',
		'm2-available': 'M2 available',
		'm2-explained': 'M2 explained',
		preserved: 'Preserved M1',
		lost: 'Lost M1',
		discovered: 'AA candidate control',
		provisional: 'Repeat-supported AA (provisional)',
		'newly-explained': 'Newly explained AA',
		'still-unexplained': 'Still unexplained',
		'support-count': 'AA candidate overlap count',
		transition: 'M1 → M2 transition'
	};
</script>

<article class="evidence-view" data-projection={projection} data-specimen={subject.id}>
	<header>
		<div>
			<strong>{title}</strong>
			<span>{projectionLabels[projection]}</span>
		</div>
	<code>{displayedImage.width}×{displayedImage.height} px · ({displayedImage.x},{displayedImage.y})</code>
	</header>
	<div class:grid={showGrid} class="canvas-shell" data-frame-boundary={rawVisual ? rawVisual.frameBoundary.join(',') : undefined}>
		<canvas
			bind:this={canvas}
			style:width={`${displayedImage.width * zoom}px`}
			style:height={`${displayedImage.height * zoom}px`}
			aria-label={`${title} ${projectionLabels[projection]} projection`}
		></canvas>
	</div>
	{#if showReceipt}
		{#if rawVisual}
		<section class="receipt-section raw-receipt" data-trace-hash={rawVisual.identity.traceHash}>
			<h2>Raw expanded-frame trace · exact RGBA baseline</h2>
			<p class:warning={rawVisual.appearanceVariant === 'quantized-diagnostic'} class="note"><strong>{rawVisual.appearanceLabel}</strong>{rawVisual.appearanceVariant === 'quantized-diagnostic' ? ' — support and boundary verdicts remain from exact baseline.' : ''}</p>
			<p class="identity"><code>runId={rawVisual.identity.runId}</code> · <code>imageId={rawVisual.identity.imageId}</code></p>
			<p class="identity"><code>paramsHash={rawVisual.identity.paramsHash}</code> · <code>featureId={rawVisual.identity.featureId}</code> · <code>traceHash={rawVisual.identity.traceHash}</code></p>
			<p class="note">Frame: {rawVisual.coordinateFrame}; crop boundary is {rawVisual.width}×{rawVisual.height}px at ({rawVisual.crop.x},{rawVisual.crop.y}), final margin {rawVisual.marginPx}px.</p>
			<p class:warning={!rawVisual.ownershipDisplayAllowed} class="note"><strong>Ownership display: {rawVisual.ownershipDisplayAllowed ? 'CONTROL-SIGNIFICANT' : 'UNKNOWN — empirical control significance required; partition is evidence only'}</strong></p>
			<div class="legend" aria-label="Exact baseline partition legend">
				{#each rawVisual.layers as layer}
					<span><i style:background={`rgb(${layer.color[0]} ${layer.color[1]} ${layer.color[2]})`}></i>{layer.name} ({layer.pixels.length})</span>
				{/each}
			</div>
			<dl class="receipt compact">
				<div><dt>Exact baseline RGBA</dt><dd>{rawVisual.support.exactCount}</dd></div>
				<div><dt>Minimum support count</dt><dd>{rawVisual.support.minimumSupportCount}</dd></div>
				<div><dt>Glyph exact mask</dt><dd>{rawVisual.glyphCounts.exact}</dd></div>
				<div><dt>Glyph halo/support</dt><dd>{rawVisual.glyphCounts.halo}</dd></div>
			</dl>
			<table class="boundary-table">
				<thead><tr><th>Margin</th><th>Status</th><th>Sides T/R/B/L</th><th>Supported</th><th>Touching</th><th>Unknown/truncated</th></tr></thead>
				<tbody>{#each rawVisual.boundaryByMargin as outcome}<tr><td>{outcome.marginPx}px</td><td class:warning={outcome.status !== 'clear'}>{outcome.status}</td><td>{outcome.sides ? `${outcome.sides.top}/${outcome.sides.right}/${outcome.sides.bottom}/${outcome.sides.left}` : 'UNKNOWN'}</td><td>{outcome.supportedPixelCount}</td><td>{outcome.boundarySupportedPixelCount}</td><td>{outcome.unobservedSampleCount}</td></tr>{/each}</tbody>
			</table>
			<p class="note">{rawVisual.jpegCaveat}</p>
			{#if rawVisual.statistics?.empiricalNull}
				{@const empirical = rawVisual.statistics.empiricalNull}
				<section class="null-section">
					<h3>Empirical circular-shift null · ownership gate</h3>
					<p class="note">controlSeed={empirical.controlSeed} · B={empirical.B} · ownership significance={empirical.ownershipSignificant ?? 'UNKNOWN'}; spatial dependence is controlled empirically, so adjacent-pixel probabilities are not multiplied.</p>
					<table class="boundary-table"><thead><tr><th>Threshold</th><th>Metric</th><th>Observed</th><th>Null mean±SD</th><th>Null quantiles</th><th>Null max</th><th>Empirical p</th><th>Verdict</th></tr></thead><tbody>
						{#each empirical.thresholds as threshold}
							<tr><td rowspan="2">{threshold.threshold}</td><td>Global max overlap</td><td>{threshold.globalMaxOverlap.observed}</td><td>{threshold.globalMaxOverlap.nullMean} ± {threshold.globalMaxOverlap.nullSd}</td><td>{JSON.stringify(threshold.globalMaxOverlap.nullQuantiles)}</td><td>{threshold.globalMaxOverlap.nullMax}</td><td>{threshold.globalMaxOverlap.empiricalP ?? 'UNKNOWN'}</td><td>{threshold.globalMaxOverlap.verdict ?? 'UNKNOWN'}</td></tr>
							<tr><td>Largest 8-connected cluster</td><td>{threshold.largest8ConnectedCluster.observed}</td><td>{threshold.largest8ConnectedCluster.nullMean} ± {threshold.largest8ConnectedCluster.nullSd}</td><td>{JSON.stringify(threshold.largest8ConnectedCluster.nullQuantiles)}</td><td>{threshold.largest8ConnectedCluster.nullMax}</td><td>{threshold.largest8ConnectedCluster.empiricalP ?? 'UNKNOWN'}</td><td>{threshold.largest8ConnectedCluster.verdict ?? 'UNKNOWN'}</td></tr>
						{/each}
					</tbody></table>
					{#if empirical.outermostClearedRingNegativeControl}<p class="note">Outermost-cleared-ring negative control: observed {empirical.outermostClearedRingNegativeControl.observed}, empirical p {empirical.outermostClearedRingNegativeControl.empiricalP ?? 'UNKNOWN'}, verdict {empirical.outermostClearedRingNegativeControl.verdict ?? 'UNKNOWN'}.</p>{/if}
				</section>
			{/if}
			<details><summary>CLI receipt text (same trace identity)</summary><pre>{formatM2RawFrameCliText(subject.rawTrace!)}</pre></details>
		</section>
		{/if}
		<section class="receipt-section">
			<h2>Representation accounting</h2>
			<dl class="receipt">
				<div>
					<dt>M1 available</dt>
					<dd>{m1.availablePixels.length}</dd>
				</div>
				<div>
					<dt>M1 explained</dt>
					<dd>{m1.explainedPixels.length}</dd>
				</div>
				<div>
					<dt>M2 available</dt>
					<dd>{m2.availablePixels.length}</dd>
				</div>
				<div>
					<dt>M2 explained</dt>
					<dd>{m2.explainedPixels.length}</dd>
				</div>
				<div>
					<dt>Preserved</dt>
					<dd>{transition.preservedPixels.length}</dd>
				</div>
				<div class:danger={transition.lostPixels.length > 0}>
					<dt>Lost</dt>
					<dd>{transition.lostPixels.length}</dd>
				</div>
				<div>
					<dt>Discovered</dt>
					<dd>{transition.discoveredPixels.length}</dd>
				</div>
				<div>
					<dt>Newly explained</dt>
					<dd>{transition.newlyExplainedPixels.length}</dd>
				</div>
				<div>
					<dt>Still unexplained</dt>
					<dd>{transition.stillUnexplainedPixels.length}</dd>
				</div>
				<div>
					<dt>Regression loss</dt>
					<dd>{percent(transition.regressionLoss)}</dd>
				</div>
				<div>
					<dt>Discovery loss</dt>
					<dd>{percent(transition.discoveryLoss)}</dd>
				</div>
			</dl>
		</section>
		<section class="receipt-section">
			<h2>Candidate control and support</h2>
			<dl class="receipt compact">
				<div>
					<dt>AA candidates</dt>
					<dd>{aa.candidatePixels.length}</dd>
				</div>
				<div>
					<dt>Supported AA</dt>
					<dd>{aa.explainedPixels.length}</dd>
				</div>
				<div>
					<dt>Provisional AA</dt>
					<dd>{aa.provisionalPixels?.length ?? 0}</dd>
				</div>
				<div>
					<dt>Unresolved AA</dt>
					<dd>{aa.unresolvedPixels.length}</dd>
				</div>
				<div>
					<dt>Frame</dt>
					<dd>{frame.status}</dd>
				</div>
				<div>
					<dt>Max raw overlap</dt>
					<dd>{support.maximum}</dd>
				</div>
			</dl>
			<p class="note">
				Gradient normalizes each materialized AA candidate by its own eligible sample count; structural
				and digit-conditioned candidates may therefore have different denominators. Threshold
				{supportThreshold} is view-only.
			</p>
			<p class="note">{registration.provenance}</p>
			<p class="note">
				Registration: {registration.method}; {registration.alignedSampleCount}/{registration.sampleCount}
				materialized badge objects. The complete count field stays in E; this view threshold does not
				change ownership.
			</p>
			<p class:warning={frame.status !== 'adequate'} class="note">
				Frame: {frame.reason}{frame.latestMarginPx === null
					? ''
					: ` · margin ${frame.latestMarginPx}px`}
			</p>
		</section>
	{/if}
</article>

<style>
	.evidence-view {
		display: grid;
		gap: 0.75rem;
		padding: 1rem;
		color: #171717;
		font:
			14px/1.35 ui-sans-serif,
			system-ui,
			sans-serif;
	}
	header {
		display: flex;
		align-items: end;
		justify-content: space-between;
		gap: 1rem;
	}
	header div {
		display: grid;
		gap: 0.1rem;
	}
	header span {
		color: #6d28d9;
		font-size: 0.72rem;
		font-weight: 650;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	header code {
		color: #737373;
		font-size: 0.75rem;
	}
	.canvas-shell {
		width: fit-content;
		max-width: 100%;
		overflow: auto;
		border: 1px solid #a3a3a3;
		background: repeating-conic-gradient(#e5e5e5 0 25%, white 0 50%) 0 / 16px 16px;
	}
	.canvas-shell.grid {
		background-size: 8px 8px;
	}
	canvas {
		display: block;
		image-rendering: pixelated;
	}
	.grid canvas {
		background-image:
			linear-gradient(#0002 1px, transparent 1px),
			linear-gradient(90deg, #0002 1px, transparent 1px);
	}
	.receipt-section {
		display: grid;
		gap: 0.45rem;
		max-width: 52rem;
	}
	h2 {
		margin: 0;
		font-size: 0.85rem;
	}
	.receipt {
		display: grid;
		grid-template-columns: repeat(4, minmax(7rem, 1fr));
		gap: 0.5rem;
		margin: 0;
	}
	.receipt.compact {
		grid-template-columns: repeat(4, minmax(9rem, 1fr));
	}
	.receipt div {
		padding: 0.55rem 0.7rem;
		border: 1px solid #d4d4d4;
		background: #fafafa;
	}
	.receipt div.danger {
		border-color: #fca5a5;
		background: #fef2f2;
	}
	.receipt dt {
		color: #737373;
		font-size: 0.7rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.receipt dd {
		margin: 0.15rem 0 0;
		font-size: 1.1rem;
		font-variant-numeric: tabular-nums;
		font-weight: 700;
	}
	.note {
		margin: 0;
		color: #525252;
		font-size: 0.78rem;
	}
	.identity {
		margin: 0;
		color: #334155;
		font-size: 0.72rem;
		overflow-wrap: anywhere;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 0.8rem;
		font-size: 0.75rem;
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.legend i {
		display: inline-block;
		width: 0.8rem;
		height: 0.8rem;
		border: 1px solid #737373;
	}
	.boundary-table {
		border-collapse: collapse;
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}
	.boundary-table th,
	.boundary-table td {
		padding: 0.3rem 0.45rem;
		border: 1px solid #d4d4d4;
		text-align: right;
	}
	.boundary-table th {
		color: #525252;
		font-size: 0.68rem;
		text-transform: uppercase;
	}
	.boundary-table td:nth-child(2) {
		font-weight: 700;
		text-align: center;
	}
	details {
		max-width: 70rem;
	}
	.null-section {
		display: grid;
		gap: 0.4rem;
		overflow-x: auto;
	}
	.null-section h3 {
		margin: 0;
		font-size: 0.82rem;
	}
	pre {
		max-height: 20rem;
		margin: 0.4rem 0 0;
		padding: 0.6rem;
		overflow: auto;
		background: #171717;
		color: #e5e5e5;
		font-size: 0.7rem;
		white-space: pre-wrap;
	}
	.warning {
		color: #b45309;
	}
	@media (max-width: 38rem) {
		.receipt,
		.receipt.compact {
			grid-template-columns: repeat(2, minmax(7rem, 1fr));
		}
	}
</style>
