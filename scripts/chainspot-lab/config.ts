import { dirname, join, resolve } from 'node:path';

export interface LabLocation {
	readonly path: string;
	readonly source: 'environment' | 'default';
}

export interface LabConfig {
	readonly repoRoot: string;
	readonly corpus: LabLocation;
	readonly evidenceStore: LabLocation;
	readonly ledgerPath: string;
}

function configuredPath(
	environment: NodeJS.ProcessEnv,
	name: string,
	fallback: string
): LabLocation {
	const value = environment[name];
	return value
		? { path: resolve(value), source: 'environment' }
		: { path: resolve(fallback), source: 'default' };
}

/** Resolve lab locations once so CLI and future transports share the same rules. */
export function resolveLabConfig(
	repoRoot: string,
	environment: NodeJS.ProcessEnv = process.env
): LabConfig {
	const resolvedRepo = resolve(repoRoot);
	const workspaceRoot = dirname(resolvedRepo);
	const corpus = configuredPath(
		environment,
		'CHAINSPOT_CORPUS_ROOT',
		join(workspaceRoot, 'chainspot-corpus')
	);
	const evidenceStore = configuredPath(
		environment,
		'CHAINSPOT_LAB_STORE_ROOT',
		join(workspaceRoot, 'chainspot-lab-evidence')
	);
	return {
		repoRoot: resolvedRepo,
		corpus,
		evidenceStore,
		ledgerPath: join(evidenceStore.path, 'ledger.sqlite')
	};
}
