/**
 * Vitest resolution stub for SvelteKit's `$app/navigation` (no `sveltekit()`
 * Vite plugin runs under vitest.config.ts, only `$lib`, so the real generated
 * module is never resolvable here). Aliased in vitest.config.ts; individual
 * test files that need to observe navigation replace this via
 * `vi.mock('$app/navigation', ...)`.
 */
export async function goto(_url: string): Promise<void> {
	// No-op default; tests that care about navigation calls mock this module.
}
