import { resolveLabConfig } from './config';
import type { DoctorReport } from './doctor';
import type { StepTwoRunResult } from './executor';
import { LabExecutionService, LabReadService } from './service';
import type { LabStatusReport } from './status';

function formatBytes(bytes: number): string {
	const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function renderDoctor(report: DoctorReport): string {
	const lines = [
		`ChainSpot Lab doctor: ${report.ready ? 'READY' : 'NOT READY'}`,
		`Host: ${report.host.osPrettyName ?? report.host.platform}; WSL=${report.host.wsl ? 'yes' : 'no'} (${report.host.wslDistro ?? 'unknown distro'}); kernel=${report.host.kernelRelease}`,
		`Repository: ${report.repo.root}`,
		`Repository SHA: ${report.repo.sha ?? 'unavailable'}${report.repo.dirty ? ' (dirty)' : ''}`,
		`Corpus: ${report.locations.corpusRoot} [${report.locations.corpusSource}]`,
		`Ablation: ${report.locations.ablationId}; case=${report.locations.selectedCase ?? 'unresolved'}; course=${report.locations.selectedCourse ?? 'unresolved'}`,
		`Step 2 raster: ${report.locations.stepTwoRaster || 'unresolved'} (${report.locations.stepTwoRasterExists ? 'present' : 'missing'})${report.locations.ablationError ? ` — ${report.locations.ablationError}` : ''}`,
		`Evidence store: ${report.locations.evidenceStoreRoot} [${report.locations.evidenceStoreSource}]`,
		`Ledger: ${report.locations.ledgerPath}`,
		`CPU: ${report.compute.cpuModel}; ${report.compute.logicalCpuCount} logical CPUs`,
		`RAM: ${formatBytes(report.compute.ramFreeBytes)} free / ${formatBytes(report.compute.ramTotalBytes)} total`,
		report.compute.gpu.available
			? `GPU: ${report.compute.gpu.name}; ${report.compute.gpu.vramMiB} MiB VRAM; driver ${report.compute.gpu.driverVersion}; CUDA ${report.compute.gpu.cudaVersion ?? 'unknown'}`
			: `GPU: unavailable (${report.compute.gpu.detail ?? 'not detected'})`,
		'Storage:'
	];
	for (const storage of report.storage) {
		lines.push(
			`  ${storage.requestedPath}: ${formatBytes(storage.freeBytes)} free / ${formatBytes(storage.totalBytes)} total${storage.exists ? '' : ` (path absent; measured ${storage.measuredPath})`}`
		);
	}
	lines.push('Dependencies:');
	for (const dependency of report.dependencies) {
		lines.push(
			`  ${dependency.ready ? 'ready' : 'missing'} ${dependency.name}${dependency.version ? ` ${dependency.version}` : ''}${dependency.detail ? ` — ${dependency.detail}` : ''}`
		);
	}
	return lines.join('\n');
}

function renderStatus(report: LabStatusReport): string {
	const lines = [
		'ChainSpot Lab status',
		`Repository: ${report.repoRoot}`,
		`Corpus: ${report.corpusRoot}`,
		`Evidence store: ${report.evidenceStoreRoot} (${formatBytes(report.storeFreeBytes)} free)`,
		`Ledger: ${report.ledgerExists ? report.ledgerPath : `${report.ledgerPath} (not created)`}`
	];
	if (!report.ledger) {
		lines.push('No runs yet. Execute: npm run lab -- run-smoke');
		return lines.join('\n');
	}
	lines.push(
		`State: ${report.ledger.counts.runs} runs; ${report.ledger.counts.experiments} experiments; ${report.ledger.counts.implementations} implementations`,
		`Cache/store: ${report.ledger.counts.cacheEntries} cache entries; ${report.ledger.counts.objects} immutable objects; ${formatBytes(report.ledger.objectPayloadBytes)} payloads`,
		'Latest runs:'
	);
	for (const run of report.ledger.latestRuns) {
		const context = report.runContexts[run.runId];
		const hits = run.nodes.filter((node) => node.cacheStatus === 'hit' && node.status === 'completed').length;
		const misses = run.nodes.filter((node) => node.cacheStatus === 'miss' && node.status === 'completed').length;
		lines.push(
			`  ${run.runId} ${run.status}; ${context?.experimentName ?? 'unknown experiment'}; course=${context?.course ?? 'unknown'}${context?.caseId ? `/${context.caseId}` : ''}; experiment=${run.experimentHash.slice(0, 12)}; cache=${hits} hit/${misses} miss; started=${run.startedAt}${context?.metadataError ? `; metadata-error=${context.metadataError}` : ''}`
		);
		for (const node of run.nodes) {
			lines.push(
				`    ${node.nodeId}: ${node.status}${node.cacheStatus ? `/${node.cacheStatus}` : ''}; ${node.runtimeMs?.toFixed(1) ?? '?'} ms; output=${node.outputHash?.slice(0, 12) ?? 'none'}${node.error ? `; error=${JSON.stringify(node.error)}` : ''}`
			);
		}
	}
	return lines.join('\n');
}

function renderRun(result: StepTwoRunResult): string {
	return [
		`Run ${result.runId} completed`,
		`Experiment: ${result.experimentHash}`,
		`Ablation: ${result.ablationId}; case=${result.suiteCaseId}`,
		`Course: ${result.course}; source=${result.sourceObjectHash}`,
		`Viewport: ${JSON.stringify(result.viewportParameters)}`,
		...result.nodes.map(
			(node) =>
				`${node.nodeId}: ${node.cacheStatus}; ${node.runtimeMs.toFixed(1)} ms; output=${node.outputHash}`
		),
		`Output: ${result.output.width}x${result.output.height} at source y=${result.output.originY}; bright=${result.output.brightPixelCount}; dark=${result.output.darkPixelCount}`
	].join('\n');
}

function integerOption(args: readonly string[], name: string): number | undefined {
	const prefix = `--${name}=`;
	const token = args.find((argument) => argument.startsWith(prefix));
	if (!token) return undefined;
	const value = Number(token.slice(prefix.length));
	if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer`);
	return value;
}

function stringOption(args: readonly string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function usage(): string {
	return [
		'Usage: npm run lab -- <command> [--json]',
		'Commands:',
		'  doctor [--ablation=ID]',
		'  status',
		'  run-smoke [--ablation=ID] [--viewport-top-inset=N] [--viewport-bottom-inset=N]'
	].join('\n');
}

function main(): void {
	const [command, ...args] = process.argv.slice(2);
	const json = args.includes('--json');
	const ablationId = stringOption(args, 'ablation');
	const config = resolveLabConfig(process.cwd());
	const reads = new LabReadService(config);
	const execution = new LabExecutionService(config);
	let result: unknown;
	let rendered: string;
	if (command === 'doctor') {
		const report = reads.doctor(ablationId);
		result = report;
		rendered = renderDoctor(report);
	} else if (command === 'status') {
		const report = reads.status();
		result = report;
		rendered = renderStatus(report);
	} else if (command === 'run-smoke') {
		const topInsetPx = integerOption(args, 'viewport-top-inset');
		const bottomInsetPx = integerOption(args, 'viewport-bottom-inset');
		const report = execution.runStepTwoReplay({
			ablationId,
			viewportParametersOverride:
				topInsetPx === undefined && bottomInsetPx === undefined
					? undefined
					: {
							strategy: 'explicit-insets',
							topInsetPx: topInsetPx ?? 0,
							bottomInsetPx: bottomInsetPx ?? 0
						}
		});
		result = report;
		rendered = renderRun(report);
	} else {
		throw new Error(usage());
	}
	console.log(json ? JSON.stringify(result, null, 2) : rendered);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
