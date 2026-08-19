import type { LabConfig } from './config';
import { collectDoctorReport, type DoctorReport } from './doctor';
import {
	runStepTwoReplay,
	type StepTwoRunOptions,
	type StepTwoRunResult
} from './executor';
import { collectStatusReport, type LabStatusReport } from './status';
import {
	collectEndpointRun,
	collectRun,
	type EndpointRunQueryResult
} from './query';
import type { LedgerRunSummary } from './core/ledger';
import {
	runStepThreeBaseline,
	type StepThreeRunOptions,
	type StepThreeRunResult
} from './step3Executor';

/** Semantic, bounded read API for CLI today and a read-only MCP adapter later. */
export class LabReadService {
	constructor(private readonly config: LabConfig) {}

	doctor(ablationId?: string): DoctorReport {
		return collectDoctorReport(this.config, ablationId);
	}

	status(latestRunLimit = 5): LabStatusReport {
		return collectStatusReport(this.config, latestRunLimit);
	}

	showRun(runId: string): LedgerRunSummary {
		return collectRun(this.config, runId);
	}

	queryEndpointRun(runId: string): EndpointRunQueryResult {
		return collectEndpointRun(this.config, runId);
	}
}

/** Write/dispatch API kept separate so a future MCP can permission it independently. */
export class LabExecutionService {
	constructor(private readonly config: LabConfig) {}

	runStepTwoReplay(options: StepTwoRunOptions = {}): StepTwoRunResult {
		return runStepTwoReplay(this.config, options);
	}

	runStepThreeBaseline(options: StepThreeRunOptions = {}): StepThreeRunResult {
		return runStepThreeBaseline(this.config, options);
	}
}
