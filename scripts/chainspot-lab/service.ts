import type { LabConfig } from './config';
import { collectDoctorReport, type DoctorReport } from './doctor';
import {
	runStepTwoReplay,
	type StepTwoRunOptions,
	type StepTwoRunResult
} from './executor';
import { collectStatusReport, type LabStatusReport } from './status';

/** Semantic, bounded read API for CLI today and a read-only MCP adapter later. */
export class LabReadService {
	constructor(private readonly config: LabConfig) {}

	doctor(ablationId?: string): DoctorReport {
		return collectDoctorReport(this.config, ablationId);
	}

	status(latestRunLimit = 5): LabStatusReport {
		return collectStatusReport(this.config, latestRunLimit);
	}
}

/** Write/dispatch API kept separate so a future MCP can permission it independently. */
export class LabExecutionService {
	constructor(private readonly config: LabConfig) {}

	runStepTwoReplay(options: StepTwoRunOptions = {}): StepTwoRunResult {
		return runStepTwoReplay(this.config, options);
	}
}
