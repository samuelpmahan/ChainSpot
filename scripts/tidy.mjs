import { createHash } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const MANIFEST_NAME = 'tidy.manifest.yaml';
const repo = process.cwd();
const manifestPath = resolve(repo, MANIFEST_NAME);

function report(label, pass, detail = '') {
	const dots = '.'.repeat(Math.max(1, 30 - label.length));
	console.log(`${label} ${dots} ${pass ? 'PASS' : 'FAIL'}${detail ? ` ${detail}` : ''}`);
}

function parseManifestText(text) {
	if (text.includes('\t')) throw new Error('tabs are not valid manifest indentation');
	const lines = text
		.split(/\r?\n/)
		.map((line, index) => ({ line, number: index + 1 }))
		.filter(({ line }) => line.trim() && !line.trimStart().startsWith('#'));
	if (lines.length === 1 && lines[0].line === 'stages: {}') return { stages: {} };
	if (lines.length === 0 || lines[0].line !== 'stages:') {
		throw new Error("manifest must begin with 'stages:'");
	}
	const stages = {};
	let stage;
	for (const { line, number } of lines.slice(1)) {
		const stageMatch = /^  ([A-Za-z0-9._-]+):$/.exec(line);
		if (stageMatch) {
			stage = { id: stageMatch[1], value: {} };
			if (stages[stage.id]) throw new Error(`duplicate Stage '${stage.id}'`);
			stages[stage.id] = stage.value;
			continue;
		}
		const fieldMatch = /^    (version|clean|hash): (\S.*)$/.exec(line);
		if (!fieldMatch || !stage) throw new Error(`unexpected manifest syntax at line ${number}`);
		const [, field, value] = fieldMatch;
		if (field in stage.value) throw new Error(`duplicate '${field}' for Stage '${stage.id}'`);
		stage.value[field] = value;
	}
	for (const [id, value] of Object.entries(stages)) {
		for (const field of ['version', 'clean', 'hash']) {
			if (typeof value[field] !== 'string') throw new Error(`Stage '${id}' is missing '${field}'`);
		}
		if (Object.keys(value).length !== 3) throw new Error(`Stage '${id}' has unsupported fields`);
	}
	return { stages };
}

function manifestText(manifest) {
	const ids = Object.keys(manifest.stages);
	if (ids.length === 0) return 'stages: {}\n';
	const lines = ['stages:'];
	for (const id of ids) {
		const stage = manifest.stages[id];
		lines.push(`  ${id}:`);
		lines.push(`    version: ${stage.version}`);
		lines.push(`    clean: ${stage.clean}`);
		lines.push(`    hash: ${stage.hash}`);
	}
	return `${lines.join('\n')}\n`;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemver(version) {
	const match = SEMVER.exec(version);
	if (!match) return undefined;
	return {
		major: BigInt(match[1]),
		minor: BigInt(match[2]),
		patch: BigInt(match[3]),
		prerelease: match[4]?.split('.') ?? []
	};
}

function compareSemver(left, right) {
	const a = parseSemver(left);
	const b = parseSemver(right);
	if (!a || !b) throw new Error('cannot compare malformed semver');
	for (const field of ['major', 'minor', 'patch']) {
		if (a[field] < b[field]) return -1;
		if (a[field] > b[field]) return 1;
	}
	if (a.prerelease.length === 0 || b.prerelease.length === 0) {
		return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
	}
	for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
		const av = a.prerelease[index];
		const bv = b.prerelease[index];
		if (av === undefined) return -1;
		if (bv === undefined) return 1;
		if (av === bv) continue;
		const an = /^\d+$/.test(av);
		const bn = /^\d+$/.test(bv);
		if (an && bn) return BigInt(av) < BigInt(bv) ? -1 : 1;
		if (an !== bn) return an ? -1 : 1;
		return av < bv ? -1 : 1;
	}
	return 0;
}

function incrementSemver(version, type) {
	const parsed = parseSemver(version);
	if (!parsed) return undefined;
	if (type === 'MAJOR') return `${parsed.major + 1n}.0.0`;
	if (type === 'MINOR') return `${parsed.major}.${parsed.minor + 1n}.0`;
	if (type === 'PATCH') return `${parsed.major}.${parsed.minor}.${parsed.patch + 1n}`;
	return undefined;
}

function readCurrentManifest() {
	if (!existsSync(manifestPath)) throw new Error(`${MANIFEST_NAME} does not exist`);
	const text = readFileSync(manifestPath, 'utf8');
	return {
		text,
		manifest: parseManifestText(text)
	};
}

function cleanAbsolute(clean) {
	if (!clean || clean.startsWith('/') || /^[A-Za-z]:[\\/]/.test(clean)) {
		throw new Error('clean path must be repo-relative');
	}
	const absolute = resolve(repo, clean);
	const rel = relative(repo, absolute);
	if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('clean path escapes repository');
	return absolute;
}

function filesUnder(root, cursor = root) {
	const files = [];
	for (const name of readdirSync(cursor).sort()) {
		const absolute = resolve(cursor, name);
		const stat = lstatSync(absolute);
		if (stat.isSymbolicLink()) throw new Error(`symbolic link not supported: ${relative(root, absolute)}`);
		if (stat.isDirectory()) files.push(...filesUnder(root, absolute));
		else if (stat.isFile()) files.push(absolute);
	}
	return files;
}

function u32(value) {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32BE(value);
	return buffer;
}

function u64(value) {
	const buffer = Buffer.alloc(8);
	buffer.writeBigUInt64BE(BigInt(value));
	return buffer;
}

export function hashCleanDirectory(clean) {
	const root = cleanAbsolute(clean);
	if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error('clean path is not a directory');
	const hash = createHash('sha256');
	const files = filesUnder(root).sort((left, right) => {
		const a = relative(root, left).split(sep).join('/');
		const b = relative(root, right).split(sep).join('/');
		return Buffer.compare(Buffer.from(a), Buffer.from(b));
	});
	for (const file of files) {
		const pathBytes = Buffer.from(relative(root, file).split(sep).join('/'));
		const contents = readFileSync(file);
		hash.update(u32(pathBytes.length));
		hash.update(pathBytes);
		hash.update(u64(contents.length));
		hash.update(contents);
	}
	return `sha256:${hash.digest('hex')}`;
}

function readHeadManifest() {
	const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repo, encoding: 'utf8' });
	if (head.status !== 0) return { kind: 'absent', detail: 'no Git HEAD' };
	const shown = spawnSync('git', ['show', `HEAD:${MANIFEST_NAME}`], {
		cwd: repo,
		encoding: 'utf8'
	});
	if (shown.status !== 0) return { kind: 'absent', detail: 'not present at HEAD' };
	try {
		return { kind: 'present', manifest: parseManifestText(shown.stdout) };
	} catch (error) {
		return {
			kind: 'invalid',
			detail: error instanceof Error ? error.message : String(error)
		};
	}
}

export function checkTidy() {
	let current;
	try {
		current = readCurrentManifest().manifest;
		report('manifest.parse', true);
	} catch (error) {
		report('manifest.parse', false, error instanceof Error ? error.message : String(error));
		console.log('\nNOT TIDY');
		return false;
	}

	const stageEntries = Object.entries(current.stages);
	report('manifest.stages', true, String(stageEntries.length));
	const head = readHeadManifest();
	if (head.kind === 'invalid') report('head.manifest', false, head.detail);
	else report('head.manifest', true, head.kind === 'absent' ? head.detail : 'parsed');
	let tidy = head.kind !== 'invalid';

	for (const [id, stage] of stageEntries) {
		const validVersion = parseSemver(stage.version) !== undefined;
		report(`${id}.version.semver`, validVersion, stage.version);
		tidy &&= validVersion;

		let cleanExists = false;
		try {
			const absolute = cleanAbsolute(stage.clean);
			cleanExists = existsSync(absolute) && lstatSync(absolute).isDirectory();
		} catch {
			cleanExists = false;
		}
		report(`${id}.clean.exists`, cleanExists, stage.clean);
		tidy &&= cleanExists;

		let actualHash;
		if (cleanExists) {
			try {
				actualHash = hashCleanDirectory(stage.clean);
				report(`${id}.hash.compute`, true, actualHash.slice(7, 19));
			} catch (error) {
				report(`${id}.hash.compute`, false, error instanceof Error ? error.message : String(error));
				tidy = false;
			}
		} else {
			report(`${id}.hash.compute`, false, 'clean unavailable');
			tidy = false;
		}

		const hashMatches = actualHash !== undefined && stage.hash === actualHash;
		report(
			`${id}.hash.manifest`,
			hashMatches,
			hashMatches
				? actualHash.slice(7, 19)
				: `manifest=${stage.hash.slice(0, 19)} actual=${actualHash?.slice(0, 19) ?? 'unavailable'}`
		);
		tidy &&= hashMatches;

		if (head.kind !== 'present') {
			report(`${id}.head.manifest`, true, 'new Stage');
			report(`${id}.version.history`, validVersion, 'initial enrollment');
			tidy &&= validVersion;
			continue;
		}

		const previous = head.manifest.stages[id];
		if (!previous) {
			report(`${id}.head.manifest`, true, 'new Stage');
			report(`${id}.version.history`, validVersion, 'initial enrollment');
			tidy &&= validVersion;
			continue;
		}
		report(`${id}.head.manifest`, true, previous.version);
		const versionsComparable = validVersion && parseSemver(previous.version) !== undefined;
		const regressed = !versionsComparable || compareSemver(stage.version, previous.version) < 0;
		const surfaceChanged = actualHash !== previous.hash || stage.clean !== previous.clean;
		const historyPass = !regressed && (!surfaceChanged || compareSemver(stage.version, previous.version) > 0);
		report(
			`${id}.version.history`,
			historyPass,
			regressed
				? `regressed from ${previous.version}`
				: surfaceChanged
					? historyPass
						? `promoted from ${previous.version}`
						: `frozen surface changed; version still ${stage.version}`
					: 'unchanged surface'
		);
		tidy &&= historyPass;
	}

	if (head.kind === 'present') {
		for (const id of Object.keys(head.manifest.stages)) {
			if (!(id in current.stages)) {
				report(`${id}.manifest.custody`, false, 'Stage removed from manifest');
				tidy = false;
			}
		}
	}

	console.log(`\n${tidy ? 'TIDY' : 'NOT TIDY'}`);
	return tidy;
}

function writeManifest(manifest) {
	writeFileSync(manifestPath, manifestText(manifest));
}

function valueAfter(args, names) {
	for (const name of names) {
		const index = args.indexOf(name);
		if (index !== -1) return args[index + 1];
	}
	return undefined;
}

function valuesAfter(args, names) {
	const values = [];
	for (let index = 0; index < args.length; index++) {
		if (names.includes(args[index]) && args[index + 1] !== undefined) values.push(args[index + 1]);
	}
	return values;
}

function refuse(message) {
	if (message) console.log(message);
	console.log('\nREFUSED');
	process.exitCode = 2;
}

function addStage(args) {
	const id = valueAfter(args, ['-id', '--id']);
	const clean = valueAfter(args, ['-cleanDir', '--cleanDir']);
	if (!id || !clean) return refuse('usage: tidy add -id <Stage> -cleanDir <repo-relative-path>');
	let original;
	try {
		original = readCurrentManifest();
		report('manifest.parse', true);
		if (original.manifest.stages[id]) return refuse(`Stage '${id}' is already in Tidy.`);
		const hash = hashCleanDirectory(clean);
		const next = structuredClone(original.manifest);
		next.stages[id] = { version: '0.1.0', clean, hash };
		writeManifest(next);
		if (!checkTidy()) {
			writeFileSync(manifestPath, original.text);
			return refuse('Enrollment failed Tidy check; manifest restored.');
		}
		console.log(`\nADDED ${id} 0.1.0`);
	} catch (error) {
		return refuse(error instanceof Error ? error.message : String(error));
	}
}

function promote(args) {
	const guardValues = valuesAfter(args, ['-v', '--version']);
	if (guardValues.length === 0) {
		return refuse(
			'usage: tidy up -v PATCH:<expected> | tidy up -v S0=MINOR:<expected> -v S1=PATCH:<expected>'
		);
	}
	let original;
	try {
		original = readCurrentManifest();
		report('manifest.parse', true);
		const dirty = Object.entries(original.manifest.stages)
			.map(([id, stage]) => ({ id, stage, actualHash: hashCleanDirectory(stage.clean) }))
			.filter(({ stage, actualHash }) => stage.hash !== actualHash);
		if (dirty.length === 0) return refuse('tidy up found no changed Stage surfaces.');

		const guards = new Map();
		const singleMatch = /^(PATCH|MINOR|MAJOR):(.+)$/.exec(guardValues[0]);
		if (guardValues.length === 1 && singleMatch && dirty.length === 1) {
			guards.set(dirty[0].id, { type: singleMatch[1], expected: singleMatch[2] });
		} else {
			for (const value of guardValues) {
				const match = /^([A-Za-z0-9._-]+)=(PATCH|MINOR|MAJOR):(.+)$/.exec(value);
				if (!match) {
					return refuse(
						`invalid batch guard '${value}'; expected <Stage>=PATCH|MINOR|MAJOR:<expected-current-semver>`
					);
				}
				const [, id, type, expected] = match;
				if (guards.has(id)) return refuse(`duplicate batch guard for Stage '${id}'.`);
				guards.set(id, { type, expected });
			}
		}

		const dirtyIds = new Set(dirty.map(({ id }) => id));
		const missing = [...dirtyIds].filter((id) => !guards.has(id));
		const extra = [...guards.keys()].filter((id) => !dirtyIds.has(id));
		if (missing.length || extra.length) {
			return refuse(
				`batch must name every changed Stage exactly once; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`
			);
		}

		const next = structuredClone(original.manifest);
		const promotions = [];
		for (const { id, stage, actualHash } of dirty) {
			const { type, expected } = guards.get(id);
			console.log(`${id}.manifest version ........ ${stage.version}`);
			console.log(`${id}.requested guard ......... ${expected}`);
			if (stage.version !== expected) return refuse();
			if (!parseSemver(stage.version)) return refuse(`Stage '${id}' version is not valid semver.`);
			const nextVersion = incrementSemver(stage.version, type);
			if (!nextVersion) return refuse(`Could not increment Stage '${id}' version.`);
			next.stages[id] = { ...stage, version: nextVersion, hash: actualHash };
			promotions.push({ id, previous: stage.version, next: nextVersion });
		}
		writeManifest(next);
		if (!checkTidy()) {
			writeFileSync(manifestPath, original.text);
			return refuse('Promotion failed Tidy check; manifest restored.');
		}
		for (const promotion of promotions) {
			console.log(`\nPROMOTED ${promotion.id} ${promotion.previous} → ${promotion.next}`);
		}
		if (promotions.length > 1) console.log(`PROMOTED BATCH ${promotions.length}`);
	} catch (error) {
		return refuse(error instanceof Error ? error.message : String(error));
	}
}

const [command, ...args] = process.argv.slice(2);
if (command === 'check') process.exitCode = checkTidy() ? 0 : 1;
else if (command === 'add') addStage(args);
else if (command === 'up') promote(args);
else {
	console.log('usage: tidy <check|add|up>');
	process.exitCode = 2;
}
