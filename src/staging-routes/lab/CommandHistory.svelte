<script lang="ts">
	// The command equivalent of every click.
	//
	// Rendering is deliberately identical to what `lab run-script FILE` prints
	// (bin/lab.mjs runScript): it numbers EVERY line of the file, echoes command
	// lines as `lab[N]> cmd`, and silently skips lines starting with `#`. So the
	// panel below is a faithful preview of the replay, not a prettified log —
	// paste the copied text into a file, run it, and the terminal scrolls past
	// the same numbered lines in the same order.
	//
	// `note` is display-only and is NEVER copied. Anything that must survive the
	// round trip has to be inside `cmd`, and `cmd` must be a line `run-script`
	// accepts: a real LAB command, or a `#` comment.
	export type HistoryEntry = { cmd: string; note?: string };

	let { entries, onclear }: { entries: HistoryEntry[]; onclear: () => void } = $props();

	let copied = $state(false);
	let list = $state<HTMLDivElement | null>(null);

	let script = $derived(entries.map((e) => e.cmd).join('\n') + '\n');

	// newest line stays in view without stealing the page scroll
	$effect(() => {
		void entries.length;
		if (list) list.scrollTop = list.scrollHeight;
	});

	async function copy() {
		try {
			await navigator.clipboard.writeText(script);
			copied = true;
			setTimeout(() => (copied = false), 1200);
		} catch {
			// clipboard blocked (insecure origin, denied permission) — the <div>
			// is selectable text, so say so instead of failing silently
			copied = false;
			alert('Clipboard blocked. Select the lines and copy manually.');
		}
	}
</script>

<section
	style="border: 1px solid black; margin: 0.4rem 0; font-family: monospace; font-size: 12.5px;"
>
	<header
		style="display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; padding: 0.3rem 0.4rem; border-bottom: 1px solid #ccc;"
	>
		<strong>lab commands</strong>
		<span style="color: #666;">{entries.length} lines · every click is one of these</span>
		<span style="flex: 1;"></span>
		<button onclick={copy}>{copied ? 'copied' : 'copy script'}</button>
		<button onclick={onclear}>clear</button>
	</header>

	<div
		bind:this={list}
		style="max-height: 11rem; overflow: auto; padding: 0.3rem 0.4rem; white-space: pre-wrap; user-select: text;"
	>
		{#each entries as e, i (i)}
			{#if e.cmd.startsWith('#')}
				<!-- run-script skips these; shown dim, still copied, still numbered -->
				<div style="color: #777;">{e.cmd}</div>
			{:else}
				<div>
					<span style="color: #777;">lab[{i + 1}]&gt;</span>
					<!-- separator lives inside the expression: Svelte trims template
					     whitespace, so a bare leading space here would vanish -->
					{e.cmd}{#if e.note}<span style="color: #777;">{`  — ${e.note}`}</span>{/if}
				</div>
			{/if}
		{/each}
	</div>

	<footer style="padding: 0.3rem 0.4rem; border-top: 1px solid #ccc; color: #666;">
		Paths are the file names the browser was handed — replay from the directory holding them.
		Save the copied lines to FILE, then: <strong>lab run-script FILE</strong>
	</footer>
</section>
