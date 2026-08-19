import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpus, freemem, hostname, platform, release, totalmem } from 'node:os';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
	DEFAULT_STEP_TWO_ABLATION_ID,
	resolveStepTwoAblation,
	type ResolvedStepTwoAblation
} from './ablation';
import type { LabConfig } from './config';

export interface StorageSnapshot {
	readonly requestedPath: string;
	readonly measuredPath: string;
	readonly exists: boolean;
	readonly totalBytes: number;
	readonly freeBytes: number;
}

export interface DependencyReadiness {
	readonly name: string;
	readonly ready: boolean;
	readonly version?: string;
	readonly detail?: string;
}

export interface DoctorReport {
	readonly ready: boolean;
	readonly host: {
		readonly hostname: string;
		readonly platform: string;
		readonly kernelRelease: string;
		readonly wsl: boolean;
		readonly wslDistro: string | null;
		readonly osPrettyName: string | null;
	};
	readonly repo: {
		readonly root: string;
		readonly sha: string | null;
		readonly dirty: boolean | null;
	};
	readonly locations: {
		readonly corpusRoot: string;
		readonly corpusSource: 'environment' | 'default';
		readonly stepTwoRaster: string;
		readonly stepTwoRasterExists: boolean;
		readonly evidenceStoreRoot: string;
		readonly evidenceStoreSource: 'environment' | 'default';
		readonly ledgerPath: string;
		readonly ablationId: string;
		readonly ablationPath: string | null;
		readonly ablationError: string | null;
		readonly selectedCase: string | null;
		readonly selectedCourse: string | null;
	};
	readonly compute: {
		readonly cpuModel: string;
		readonly logicalCpuCount: number;
		readonly ramTotalBytes: number;
		readonly ramFreeBytes: number;
		readonly gpu: {
			readonly available: boolean;
			readonly name?: string;
			readonly vramMiB?: number;
			readonly driverVersion?: string;
			readonly cudaVersion?: string;
			readonly detail?: string;
		};
	};
	readonly storage: readonly StorageSnapshot[];
	readonly dependencies: readonly DependencyReadiness[];
}

function fixedCommand(command: string, args: readonly string[], cwd?: string): string | null {
	try {
		return execFileSync(command, args, {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 5_000
		}).trim();
	} catch {
		return null;
	}
}

function osPrettyName(): string | null {
	try {
		const row = readFileSync('/etc/os-release', 'utf8')
			.split('\n')
			.find((line) => line.startsWith('PRETTY_NAME='));
		return row ? row.slice('PRETTY_NAME='.length).replace(/^"|"$/g, '') : null;
	} catch {
		return null;
	}
}

function nearestExistingPath(path: string): string {
	let current = path;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return current;
		current = parent;
	}
	return current;
}

function storageSnapshot(path: string): StorageSnapshot {
	const measuredPath = nearestExistingPath(path);
	const stats = statfsSync(measuredPath, { bigint: true });
	return {
		requestedPath: path,
		measuredPath,
		exists: existsSync(path),
		totalBytes: Number(stats.blocks * stats.bsize),
		freeBytes: Number(stats.bavail * stats.bsize)
	};
}

function packageReadiness(name: string): DependencyReadiness {
	try {
		const require = createRequire(import.meta.url);
		const packageJsonPath = require.resolve(`${name}/package.json`);
		const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
		return { name, ready: true, version: packageJson.version };
	} catch (error) {
		return { name, ready: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

function gpuSnapshot(): DoctorReport['compute']['gpu'] {
	const row = fixedCommand('/usr/lib/wsl/lib/nvidia-smi', [
		'--query-gpu=name,memory.total,driver_version',
		'--format=csv,noheader,nounits'
	]);
	if (!row) return { available: false, detail: 'nvidia-smi did not return a WSL GPU' };
	const [name, memory, driverVersion] = row.split(',').map((value) => value.trim());
	const header = fixedCommand('/usr/lib/wsl/lib/nvidia-smi', []);
	const cudaVersion = header?.match(/CUDA Version:\s*([^|\s]+)/)?.[1];
	return {
		available: true,
		name,
		vramMiB: Number(memory),
		driverVersion,
		cudaVersion
	};
}

/** Bounded host/configuration inspection shared by CLI and future read-only transports. */
export function collectDoctorReport(
	config: LabConfig,
	ablationId = DEFAULT_STEP_TWO_ABLATION_ID
): DoctorReport {
	const sha = fixedCommand('git', ['rev-parse', 'HEAD'], config.repoRoot);
	const dirtyOutput = fixedCommand('git', ['status', '--porcelain'], config.repoRoot);
	const dependencies: DependencyReadiness[] = [
		{
			name: 'node',
			ready: Number(process.versions.node.split('.')[0]) >= 22,
			version: process.versions.node,
			detail: process.execPath
		},
		{ name: 'git', ready: fixedCommand('git', ['--version']) !== null, version: fixedCommand('git', ['--version']) ?? undefined },
		{ name: 'python3', ready: fixedCommand('python3', ['--version']) !== null, version: fixedCommand('python3', ['--version']) ?? undefined },
		{ name: 'node:sqlite', ready: Boolean(process.versions.sqlite), version: process.versions.sqlite },
		packageReadiness('jpeg-js'),
		packageReadiness('pngjs'),
		packageReadiness('tsx')
	];
	let ablation: ResolvedStepTwoAblation | null = null;
	let ablationError: string | null = null;
	try {
		ablation = resolveStepTwoAblation(config, ablationId);
	} catch (error) {
		ablationError = error instanceof Error ? error.message : String(error);
	}
	const rasterPath = ablation?.rasterPath ?? '';
	const report: DoctorReport = {
		ready: false,
		host: {
			hostname: hostname(),
			platform: platform(),
			kernelRelease: release(),
			wsl: Boolean(process.env.WSL_DISTRO_NAME || release().toLowerCase().includes('microsoft')),
			wslDistro: process.env.WSL_DISTRO_NAME ?? null,
			osPrettyName: osPrettyName()
		},
		repo: {
			root: config.repoRoot,
			sha,
			dirty: dirtyOutput === null ? null : dirtyOutput.length > 0
		},
		locations: {
			corpusRoot: config.corpus.path,
			corpusSource: config.corpus.source,
			stepTwoRaster: rasterPath,
			stepTwoRasterExists: rasterPath.length > 0 && existsSync(rasterPath),
			evidenceStoreRoot: config.evidenceStore.path,
			evidenceStoreSource: config.evidenceStore.source,
			ledgerPath: config.ledgerPath,
			ablationId,
			ablationPath: ablation?.definitionPath ?? null,
			ablationError,
			selectedCase: ablation?.definition.suite.case.id ?? null,
			selectedCourse: ablation?.definition.suite.case.course ?? null
		},
		compute: {
			cpuModel: cpus()[0]?.model ?? 'unknown',
			logicalCpuCount: cpus().length,
			ramTotalBytes: totalmem(),
			ramFreeBytes: freemem(),
			gpu: gpuSnapshot()
		},
		storage: [
			storageSnapshot(config.repoRoot),
			storageSnapshot(config.corpus.path),
			storageSnapshot(config.evidenceStore.path)
		],
		dependencies
	};
	return {
		...report,
		ready:
			report.host.wsl &&
			report.repo.sha !== null &&
			report.locations.stepTwoRasterExists &&
			dependencies.every((dependency) => dependency.ready)
	};
}
