/**
 * Node-side stand-in for SvelteKit's `$app/paths` so library modules that
 * read the deployment base path (`renderComposite.ts`) load under tsx
 * harnesses. Headless runs serve nothing, so the base is empty.
 */
export const base = '';
