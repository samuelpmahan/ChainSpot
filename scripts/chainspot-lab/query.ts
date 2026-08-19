import type { LabConfig } from './config';
import { LabLedger, type LedgerRunSummary } from './core/ledger';
import { ImmutableObjectStore } from './core/objectStore';
import type { EndpointEvaluationObjectV1 } from './nodes/endpointEvaluate';

export interface EndpointRunQueryResult {
	readonly run: LedgerRunSummary;
	readonly cases: readonly {
		readonly nodeId: string;
		readonly outputHash: string;
		readonly evaluation: EndpointEvaluationObjectV1;
	}[];
}

/** Bounded semantic run lookup; callers never receive a SQL or filesystem handle. */
export function collectRun(config: LabConfig, runId: string): LedgerRunSummary {
	const ledger = new LabLedger(config.ledgerPath, { readOnly: true });
	try {
		const run = ledger.runSummary(runId);
		if (!run) throw new Error(`Lab run was not found: ${runId}`);
		return run;
	} finally {
		ledger.close();
	}
}

/** Read only the endpoint-evaluation objects produced by one known run. */
export function collectEndpointRun(
	config: LabConfig,
	runId: string
): EndpointRunQueryResult {
	const run = collectRun(config, runId);
	const store = new ImmutableObjectStore(config.evidenceStore.path, { readOnly: true });
	const cases = run.nodes
		.filter((node) => node.nodeType === 'endpoints.evaluate' && node.outputHash)
		.map((node) => {
			const outputHash = node.outputHash as string;
			const descriptor = store.descriptor(outputHash);
			if (descriptor.kind !== 'endpoints.evaluation.v1') {
				throw new TypeError(`Endpoint evaluation object has unexpected kind: ${descriptor.kind}`);
			}
			return {
				nodeId: node.nodeId,
				outputHash,
				evaluation: store.readJson<EndpointEvaluationObjectV1>(outputHash)
			};
		});
	return { run, cases };
}
