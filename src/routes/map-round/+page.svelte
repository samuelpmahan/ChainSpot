<script lang="ts">
	/**
	 * Map Round page — renders a clean-course SVG showing hole geometry and walked trajectory.
	 *
	 * Data consumption:
	 * - MappedRound.walk: ordered polyline trace (composite px, pre-read during Import phase)
	 * - MappedRound.droplets: landing-marker circles (composite px)
	 * - CourseMap.transform: WorldTransform for distance measurements; null means "locked transform unavailable"
	 *
	 * Pre-read requirement: by the time a MappedRound lands in session storage, all UDisc-derived
	 * pixels have already been discarded per the fair-use clause in docs/rebuild-spec.md.
	 * See src/lib/detectors/TODO-thrown-round-preread.md for why the walk/droplets must be extracted
	 * during the Import phase before pixels are released.
	 */

	import { getCourseMap, getMappedRound } from '$lib/session';
	import type { CourseMap, MappedRound } from '$lib/session';

	let courseMap = $state<CourseMap | null>(null);
	let mappedRound = $state<MappedRound | null>(null);

	$effect.pre(() => {
		courseMap = getCourseMap();
		mappedRound = getMappedRound();
	});

	/**
	 * Compute viewBox from hole positions (tee, basket, badge) with 80px padding,
	 * matching the derivation from the Import page's cleanBBox.
	 */
	function computeViewBox(map: CourseMap): { x: number; y: number; w: number; h: number } {
		let x0 = Infinity,
			y0 = Infinity,
			x1 = -Infinity,
			y1 = -Infinity;

		const eatPoint = (p: { xPx: number; yPx: number } | null) => {
			if (!p) return;
			x0 = Math.min(x0, p.xPx);
			y0 = Math.min(y0, p.yPx);
			x1 = Math.max(x1, p.xPx);
			y1 = Math.max(y1, p.yPx);
		};

		for (const h of map.holes) {
			eatPoint(h.badge);
			eatPoint(h.tee);
			eatPoint(h.basket);
			for (const b of h.bends) eatPoint(b);
		}

		if (x0 === Infinity) return { x: 0, y: 0, w: 100, h: 100 };
		const pad = 80;
		return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
	}
</script>

{#if !courseMap}
	<div style="padding: 2rem;">
		<p>No course imported yet.</p>
		<p><a href="/">Go to Import Data</a></p>
	</div>
{:else}
	{@const viewBox = computeViewBox(courseMap)}

	<!-- Controls row -->
	<div style="display: flex; gap: 0.5rem; align-items: center; padding: 0.5rem; border-bottom: 1px solid #ccc;">
		<button disabled title="Not implemented">Project round</button>
		<button disabled title="Not implemented">Re-run projection</button>
		<button disabled title="Not implemented">Per-hole corrections</button>
		<button disabled title="Not implemented">Continue → Create Graphics</button>
		<a href="/" style="margin-left: auto;">
			<button>Back to Import</button>
		</a>
	</div>

	<!-- Course SVG with optional walk trace and droplets -->
	<svg
		width="100%"
		style="height: calc(100vh - 60px); border: 1px solid #ccc; background: #f2efe6; display: block;"
		viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
		role="img"
		aria-label="Course map with walk trace"
	>
		<!-- Walk trace (dashed polyline, under hole markings) -->
		{#if mappedRound?.walk && mappedRound.walk.length > 1}
			<polyline
				points={mappedRound.walk.map((p) => `${p.xPx},${p.yPx}`).join(' ')}
				stroke="rgba(204, 119, 119, 0.6)"
				stroke-width="2"
				fill="none"
				stroke-dasharray="4,4"
			/>
		{/if}

		<!-- Hole markings -->
		{#each courseMap.holes as h (h.n)}
			<!-- Path from tee to basket through bends -->
			{#if h.tee && h.basket}
				<path
					d={`M ${h.tee.xPx} ${h.tee.yPx} ${h.bends.length ? `Q ${h.bends[0].xPx} ${h.bends[0].yPx}` : 'L'} ${h.basket.xPx} ${h.basket.yPx}`}
					stroke="#465446"
					fill="none"
					stroke-width="4"
				/>
			{/if}

			<!-- Tee marker (green triangle) -->
			{#if h.tee}
				<path
					d={`M ${h.tee.xPx} ${h.tee.yPx - 14} L ${h.tee.xPx - 14} ${h.tee.yPx + 12} L ${h.tee.xPx + 14} ${h.tee.yPx + 12} Z`}
					fill="#2c4a2c"
				/>
			{/if}

			<!-- Basket marker (ring + dot) -->
			{#if h.basket}
				<circle cx={h.basket.xPx} cy={h.basket.yPx} r="13" fill="none" stroke="#2c4a2c" stroke-width="5" />
				<circle cx={h.basket.xPx} cy={h.basket.yPx} r="4" fill="#2c4a2c" />
			{/if}

			<!-- Bend markers (small gray dots) -->
			{#each h.bends as b (b.xPx + ':' + b.yPx)}
				<circle cx={b.xPx} cy={b.yPx} r="6" fill="#465446" />
			{/each}

			<!-- Badge chip (white square with number) -->
			<rect x={h.badge.xPx - 16} y={h.badge.yPx - 16} width="32" height="32" fill="#ffffff" stroke="#2c4a2c" stroke-width="3" />
			<text x={h.badge.xPx} y={h.badge.yPx + 8} font-size="24" fill="#2c4a2c" text-anchor="middle">{h.n}</text>
		{/each}

		<!-- Droplets (landing markers, on top) -->
		{#if mappedRound?.droplets}
			{#each mappedRound.droplets as d (d.xPx + ':' + d.yPx)}
				<circle cx={d.xPx} cy={d.yPx} r="8" fill="#3399cc" stroke="#ffffff" stroke-width="2" />
			{/each}
		{/if}

		<!-- Transform lock indicator -->
		{#if courseMap.transform === null}
			<text
				x={viewBox.x + 10}
				y={viewBox.y + 30}
				font-size="14"
				fill="#999"
				font-style="italic"
			>
				world transform not locked — distances unavailable
			</text>
		{/if}
	</svg>
{/if}

<style>
	a {
		text-decoration: none;
	}

	a button {
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
