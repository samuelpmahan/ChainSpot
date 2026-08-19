import { existsSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { LabLedger, type LedgerStatusSummary } from './core/ledger';
import { ImmutableObjectStore } from './core/objectStore';
import type { LabConfig } from './config';

export interface LabStatusReport {
	readonly repoRoot: string;
	readonly corpusRoot: string;
	readonly evidenceStoreRoot: string;
	readonly ledgerPath: string;
	readonly ledgerExists: boolean;
	readonly storeFreeBytes: number;
	readonly ledger: LedgerStatusSummary | null;
	readonly runContexts: Readonly<Record<string, {
		readonly experimentName: string | null;
		readonly suiteName: string | null;
		readonly caseId: string | null;
		readonly course: string | null;
		readonly metadataError: string | null;
	}>>;
}

function existingAncestor(path: string): string {
	let current = path;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return current;
}

/** Bounded operational summary; it never accepts caller-provided SQL or filesystem paths. */
export function collectStatusReport(config: LabConfig, latestRunLimit = 5): LabStatusReport {
	let ledger: LedgerStatusSummary | null = null;
	const runContexts: Record<string, {
		experimentName: string | null;
		suiteName: string | null;
		caseId: string | null;
		course: string | null;
		metadataError: string | null;
	}> = {};
	if (existsSync(config.ledgerPath)) {
		const connection = new LabLedger(config.ledgerPath, { readOnly: true });
		try {
			ledger = connection.statusSummary(latestRunLimit);
		} finally {
			connection.close();
		}
		const store = new ImmutableObjectStore(config.evidenceStore.path);
		for (const run of ledger.latestRuns) {
			try {
				const manifest = store.readJson<{ name?: string }>(run.resolvedManifestObjectHash);
				const suite = store.readJson<{
					name?: string;
					course?: string;
					case?: { id?: string; course?: string };
				}>(run.resolvedSuiteObjectHash);
				runContexts[run.runId] = {
					experimentName: manifest.name ?? null,
					suiteName: suite.name ?? null,
					caseId: suite.case?.id ?? null,
					course: suite.case?.course ?? suite.course ?? null,
					metadataError: null
				};
			} catch (error) {
				runContexts[run.runId] = {
					experimentName: null,
					suiteName: null,
					caseId: null,
					course: null,
					metadataError: error instanceof Error ? error.message : String(error)
				};
			}
		}
	}
	const filesystem = statfsSync(existingAncestor(config.evidenceStore.path), { bigint: true });
	return {
		repoRoot: config.repoRoot,
		corpusRoot: config.corpus.path,
		evidenceStoreRoot: config.evidenceStore.path,
		ledgerPath: config.ledgerPath,
		ledgerExists: ledger !== null,
		storeFreeBytes: Number(filesystem.bavail * filesystem.bsize),
		ledger,
		runContexts
	};
}
