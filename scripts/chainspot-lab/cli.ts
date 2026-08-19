import { resolveLabConfig } from './config';
import type { DoctorReport } from './doctor';
import type { StepTwoRunResult } from './executor';
import { LabExecutionService, LabReadService } from './service';
import type { LabStatusReport } from './status';
import type { EndpointRunQueryResult } from './query';
import type { StepThreeRunResult } from './step3Executor';

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
		`Ablation: ${report.locations.ablationId}; cases=${report.locations.selectedCases.join(',') || 'unresolved'}; courses=${report.locations.selectedCourses.join(',') || 'unresolved'}`,
		`Raster inputs: ${report.locations.rasters.length || 0} (${report.locations.rasters.every((path) => path.length > 0) && report.locations.stepTwoRasterExists ? 'present' : 'missing'})${report.locations.ablationError ? ` — ${report.locations.ablationError}` : ''}`,
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
			`  ${run.runId} ${run.status}; ${context?.experimentName ?? 'unknown experiment'}; ${context?.courses.length ? `courses=${context.courses.join(',')}` : `course=${context?.course ?? 'unknown'}${context?.caseId ? `/${context.caseId}` : ''}`}; experiment=${run.experimentHash.slice(0, 12)}; cache=${hits} hit/${misses} miss; started=${run.startedAt}${context?.metadataError ? `; metadata-error=${context.metadataError}` : ''}`
		);
		if ((context?.caseIds.length ?? 0) > 1) {
			const nodeTypes = [...new Set(run.nodes.map((node) => node.nodeType))];
			for (const nodeType of nodeTypes) {
				const nodes = run.nodes.filter((node) => node.nodeType === nodeType);
				const typeHits = nodes.filter((node) => node.cacheStatus === 'hit').length;
				const typeMisses = nodes.filter((node) => node.cacheStatus === 'miss').length;
				const failures = nodes.filter((node) => node.status === 'failed').length;
				lines.push(`    ${nodeType}: ${typeHits} hit/${typeMisses} miss${failures ? `/${failures} failed` : ''}`);
			}
		} else {
			for (const node of run.nodes) {
				lines.push(
					`    ${node.nodeId}: ${node.status}${node.cacheStatus ? `/${node.cacheStatus}` : ''}; ${node.runtimeMs?.toFixed(1) ?? '?'} ms; output=${node.outputHash?.slice(0, 12) ?? 'none'}${node.error ? `; error=${JSON.stringify(node.error)}` : ''}`
				);
			}
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

function renderEndpointRun(result: StepThreeRunResult): string {
	const lines = [
		`Run ${result.runId} completed`,
		`Experiment: ${result.experimentHash}`,
		`Ablation: ${result.ablationId}; chrome=${result.chromeImplementationId}`,
		`Cache: ${result.cache.hits} hit / ${result.cache.misses} miss`,
		'Course endpoint baseline:'
	];
	for (const entry of result.cases) {
		const row = entry.evaluation;
		lines.push(
			`  ${entry.course}: truth=${row.truthCount}; raw/free/chrome=${row.rawTeeCandidateCount}/${row.freeTeeCandidateCount}/${row.chromeSuppressedCount}; tee=${row.teeRecallCount}/${row.truthCount}${row.teeMissHoleNumbers.length ? ` miss H${row.teeMissHoleNumbers.join(',H')}` : ''}; basket=${row.basketRecallCount}/${row.truthCount}; FP chrome/basket/unexplained=${row.teeFalsePositiveClasses.screenChrome}/${row.teeFalsePositiveClasses.basketFurniture}/${row.teeFalsePositiveClasses.unexplained}${entry.historicalReference ? `; reference(${entry.historicalReference.rasterDecode})=${entry.historicalReference.matches ? 'match' : `diff expected ${entry.historicalReference.expected.raw}/${entry.historicalReference.expected.free}/${entry.historicalReference.expected.chromeSuppressed}`}` : ''}`
		);
	}
	return lines.join('\n');
}

function renderEndpointQuery(result: EndpointRunQueryResult): string {
	const lines = [
		`Endpoint evidence for run ${result.run.runId} (${result.run.status})`,
		`Experiment: ${result.run.experimentHash}`
	];
	for (const entry of result.cases) {
		const row = entry.evaluation;
		lines.push(
			`  ${row.course}: tee=${row.teeRecallCount}/${row.truthCount}; basket=${row.basketRecallCount}/${row.truthCount}; raw/free/chrome=${row.rawTeeCandidateCount}/${row.freeTeeCandidateCount}/${row.chromeSuppressedCount}; object=${entry.outputHash}`
		);
	}
	return lines.join('\n');
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
		'  show --run=RUN_ID',
		'  query-endpoints --run=RUN_ID',
		'  run-smoke [--ablation=ID] [--viewport-top-inset=N] [--viewport-bottom-inset=N]',
		'  run-endpoints [--chrome=chrome.screen-space-v1|chrome.none]'
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
	} else if (command === 'run-endpoints') {
		const chrome = stringOption(args, 'chrome');
		if (chrome && chrome !== 'chrome.none' && chrome !== 'chrome.screen-space-v1') {
			throw new TypeError(`Unsupported chrome implementation: ${chrome}`);
		}
		const chromeImplementationId =
			chrome === 'chrome.none' || chrome === 'chrome.screen-space-v1' ? chrome : undefined;
		const report = execution.runStepThreeBaseline({
			chromeImplementationId,
			progress: json
				? undefined
				: (event) => console.error(`  ${event.caseId} ${event.nodeType}: ${event.cacheStatus}`)
		});
		result = report;
		rendered = renderEndpointRun(report);
	} else if (command === 'show') {
		const runId = stringOption(args, 'run');
		if (!runId) throw new TypeError('show requires --run=RUN_ID');
		const report = reads.showRun(runId);
		result = report;
		rendered = JSON.stringify(report, null, 2);
	} else if (command === 'query-endpoints') {
		const runId = stringOption(args, 'run');
		if (!runId) throw new TypeError('query-endpoints requires --run=RUN_ID');
		const report = reads.queryEndpointRun(runId);
		result = report;
		rendered = renderEndpointQuery(report);
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
