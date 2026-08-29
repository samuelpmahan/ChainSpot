import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';

const targetDir = 'C:\\Users\\tenni\\workspace\\ChainSpot-chspt-82';
const outputRoot = path.resolve(process.cwd(), 'artifacts', 'lab', 'orient');
const sourceDir = '/home/mahansa/workspace/ChainSpot-three-factor-dev72-lab';
const evidenceDir = '/home/mahansa/workspace/chainspot-lab-evidence-nuthing-p2-6d7-20260819';
const evidenceWinDir =
	'\\\\wsl$\\Ubuntu\\home\\mahansa\\workspace\\chainspot-lab-evidence-nuthing-p2-6d7-20260819';
const expectedBranch =
	'samuelpmahan/chspt-82-frontend-rebuild-rederive-the-mvp-from-a-clean-room-app';
const expectedTag = 'Dev72LabRepro';
const expectedTagCommit = '6d7f0fe1b2b9cdd4d4c23531449d6a1cc134676c';
const expectedExtractCommit = '3146d14fcb98cb9c19ffbff1502a1c81ef39b962';
const verbose = process.argv.slice(2).includes('--verbose');
const startedAt = new Date();
const runId = `${startedAt.toISOString().replace(/[-:.]/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
const runDir = path.join(outputRoot, runId);
const rawDir = path.join(runDir, 'raw');
const commandsDir = path.join(runDir, 'commands');
const transcript = [];
const findings = [];
const files = [];
const pipedAnswers = process.stdin.isTTY ? null : fs.readFileSync(0, 'utf8').split(/\r?\n/);

fs.mkdirSync(commandsDir, { recursive: true });
fs.mkdirSync(rawDir, { recursive: true });

function record(line = '') {
	transcript.push(line);
	console.log(line);
}

function writeText(relativePath, value) {
	const filePath = path.join(runDir, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, value, 'utf8');
	files.push(relativePath);
	return filePath;
}

function run(command, args, relativePath) {
	const result = spawnSync(command, args, { cwd: targetDir, encoding: 'utf8', windowsHide: true });
	const stdout = result.stdout ?? '';
	const stderr = result.stderr ?? '';
	const body = [
		`command=${command} ${args.join(' ')}`,
		`exitCode=${result.status ?? 'null'}`,
		`signal=${result.signal ?? ''}`,
		'--- stdout ---',
		stdout,
		'--- stderr ---',
		stderr
	].join('\n');
	writeText(`commands/${relativePath}`, body);
	if (verbose) {
		record(`[command] ${command} ${args.join(' ')}`);
		if (stdout.trim()) record(stdout.trimEnd());
		if (stderr.trim()) record(stderr.trimEnd());
	}
	return { command, args, stdout, stderr, status: result.status, ok: result.status === 0 };
}

function wsl(command, relativePath) {
	return run('wsl.exe', ['bash', '-lc', command], relativePath);
}

function addFinding(finding) {
	findings.push(finding);
	record(`${finding.status.toUpperCase()}: ${finding.title}`);
	record(`  evidence: ${finding.evidence}`);
	record(`  next: ${finding.nextAction}`);
}

function lineOf(relativePath, pattern) {
	const filePath = path.join(targetDir, relativePath);
	if (!fs.existsSync(filePath)) return `${relativePath}:missing`;
	const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
	const index = lines.findIndex((line) => line.includes(pattern));
	return index < 0 ? `${relativePath}:pattern-not-found` : `${relativePath}:${index + 1}`;
}

function copyWslFile(name) {
	const sourcePath = path.join(evidenceWinDir, path.basename(name));
	const bytes = fs.existsSync(sourcePath) ? fs.statSync(sourcePath).size : 0;
	const checksum = wsl(
		`sha256sum ${evidenceDir}/${path.basename(name)}`,
		`evidence/${name}.sha256.txt`
	);
	const smallText =
		bytes > 0 && bytes <= 1024 * 1024 && /\.(txt|log|json|csv|jsonl|md|tsv)$/i.test(name);
	if (smallText) {
		const destination = path.join(rawDir, 'evidence', name);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.copyFileSync(sourcePath, destination);
		files.push(path.relative(runDir, destination));
	}
	return {
		name,
		bytes,
		ok: fs.existsSync(sourcePath),
		checksum: checksum.stdout.trim(),
		preserved: smallText ? 'copied' : 'checksum-and-size-only'
	};
}

async function ask(question) {
	if (pipedAnswers) {
		const input = (pipedAnswers.shift() ?? '').trim();
		process.stdout.write(question);
		transcript.push(`${question}${input}`);
		return input;
	}
	const input = await new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: false
		});
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
	transcript.push(`${question}${input}`);
	return input;
}

function checkTarget() {
	const branch = run('git', ['branch', '--show-current'], 'target-branch.txt');
	const status = run('git', ['status', '--short', '--branch'], 'target-status.txt');
	const head = run('git', ['rev-parse', 'HEAD'], 'target-head.txt');
	const actualBranch = branch.stdout.trim();
	const branchOk = actualBranch === expectedBranch;
	addFinding({
		id: 'target-branch',
		title: branchOk
			? 'Target branch is the requested rebuild branch.'
			: 'Target branch does not match the requested rebuild branch.',
		status: branchOk ? 'pass' : 'blocked',
		evidence: `commands/target-branch.txt (${actualBranch || 'empty'})`,
		nextAction: branchOk
			? 'Continue with read-only orientation.'
			: `Switch to ${expectedBranch} before using this practicum.`
	});
	addFinding({
		id: 'target-dirty-state',
		title: 'Target status was captured without changing the checkout.',
		status: status.ok ? 'pass' : 'blocked',
		evidence: 'commands/target-status.txt and commands/target-head.txt',
		nextAction:
			'Treat listed edits as pre-existing; this practicum does not clean, stage, or commit them.'
	});
	return {
		branch: actualBranch,
		status: status.stdout,
		head: head.stdout.trim(),
		branchOk,
		statusOk: status.ok
	};
}

function checkSource() {
	const tag = wsl(
		`git -C ${sourceDir} rev-parse --verify ${expectedTag}^{commit}`,
		'source-tag.txt'
	);
	const extracted = wsl(
		`git -C ${sourceDir} cat-file -e ${expectedExtractCommit}^{commit}`,
		'source-extract-commit.txt'
	);
	const branch = wsl(`git -C ${sourceDir} branch --show-current`, 'source-branch.txt');
	const head = wsl(`git -C ${sourceDir} rev-parse HEAD`, 'source-head.txt');
	const status = wsl(`git -C ${sourceDir} status --short --branch`, 'source-status.txt');
	const tagCommit = tag.stdout.trim();
	const sourceBranch = branch.stdout.trim();
	const tagOk = tag.ok && tagCommit === expectedTagCommit;
	const extractOk = extracted.ok;
	const headAtTag = head.stdout.trim() === expectedTagCommit;
	addFinding({
		id: 'source-reference',
		title:
			tagOk && extractOk
				? 'Exact Dev72 source tag and extraction commit are present.'
				: 'Exact Dev72 source reference is unavailable or moved.',
		status: tagOk && extractOk ? 'pass' : 'blocked',
		evidence: `commands/source-tag.txt (${tagCommit || 'empty'}), commands/source-extract-commit.txt`,
		nextAction:
			tagOk && extractOk
				? 'Use the frozen tag for parity comparisons; do not infer parity from the moving worktree HEAD.'
				: 'Restore the exact Dev72LabRepro tag at 6d7f0fe and the 3146d14 extraction commit.'
	});
	addFinding({
		id: 'source-provenance',
		title: headAtTag
			? 'Source worktree HEAD is the exact reference tag.'
			: `Source worktree HEAD differs from ${expectedTag}.`,
		status: headAtTag ? 'pass' : 'review',
		evidence: `commands/source-head.txt and commands/source-branch.txt (${sourceBranch || 'empty'})`,
		nextAction: headAtTag
			? 'Proceed with exact-source review.'
			: 'Compare files against the immutable tag before accepting any current-worktree result.'
	});
	return {
		tagCommit,
		extractOk,
		sourceBranch,
		sourceHead: head.stdout.trim(),
		status: status.stdout,
		tagOk,
		headAtTag
	};
}

function checkEvidence() {
	const directory = wsl(`test -d ${evidenceDir}`, 'evidence-directory.txt');
	const listing = wsl(
		`find ${evidenceDir} -maxdepth 1 -type f -printf '%f\\n' | sort`,
		'evidence-listing.txt'
	);
	const names = listing.stdout
		.split(/\r?\n/)
		.map((name) => name.trim())
		.filter(Boolean);
	const copied = names.length ? names.map(copyWslFile) : [];
	const nonEmptyRaw = copied.filter((file) => file.bytes > 0);
	const usable = directory.ok && copied.length > 0 && nonEmptyRaw.length > 0;
	addFinding({
		id: 'frozen-evidence',
		title: usable
			? 'Frozen ledger evidence contains non-empty frozen files; large binaries are checksum-only.'
			: 'Frozen ledger evidence is missing or metadata-only.',
		status: usable ? 'pass' : 'blocked',
		evidence: `commands/evidence-listing.txt and per-file sha256 outputs (${copied.map((file) => `${file.name}=${file.bytes}B/${file.preserved}`).join(', ') || 'none'})`,
		nextAction: usable
			? 'Review the preserved raw producer ledger before making a parity claim; this orientation does not interpret its verdict.'
			: 'Acquire the raw exact-6d7 replay ledger and its checksums; this run must not fabricate a 68/72 or 72/72 result.'
	});
	return { directoryOk: directory.ok, names, copied, usable };
}

function runSource(prediction, target) {
	record('SOURCE lane: reference provenance first; no replay is run here.');
	const source = checkSource();
	const evidence = checkEvidence();
	addFinding({
		id: 'parity-ablation-gate',
		title: 'Parity and ablation gates remain unresolved in this orientation run.',
		status: 'unresolved',
		evidence:
			'No replay or ablation command was invoked; only immutable reference and raw-evidence provenance were inspected.',
		nextAction:
			'Run the separately approved exact-source replay after raw ledger evidence is restored; record every ablation as a new evidence artifact.'
	});
	const discrepancy = [];
	if (!source.tagOk)
		discrepancy.push('Dev72LabRepro does not resolve to the required 6d7f0fe commit.');
	if (!source.headAtTag)
		discrepancy.push('The source worktree HEAD is not the immutable Dev72LabRepro tag.');
	if (!evidence.usable)
		discrepancy.push('The frozen evidence directory has no non-empty raw ledger output.');
	const nextAction =
		!source.tagOk || !evidence.usable
			? 'Stop at provenance: restore/locate immutable 6d7f0fe source plus non-empty ledger outputs before any 3factor parity or 68/72/72/72 claim.'
			: !source.headAtTag
				? `Use immutable ${expectedTag} at ${expectedTagCommit} for parity; the moving source HEAD must not be treated as reference.`
				: 'Next gate: independently replay the exact source and compare preserved raw outputs; this orientation does not claim accuracy.';
	return { lane: 'SOURCE', prediction, target, source, evidence, discrepancy, nextAction };
}

function runMvp(prediction, target) {
	record('MVP lane: source inspection only; no browser, detector, or stitch run is invoked.');
	const preStitch = lineOf('src/routes/+page.svelte', 'await labEndpointDetector(raster');
	const crop = lineOf('src/routes/+page.svelte', 'rasters = rasters.map((raster) => cropRaster');
	const stitch = lineOf('src/routes/+page.svelte', 'const offset = findBestTranslation');
	const grayContract = lineOf('src/lib/raster.ts', 'export interface GrayRaster');
	const seedProjection = lineOf('src/routes/+page.svelte', 'seeds.push({');
	const nullGeometry = lineOf('src/lib/courseDetect.ts', 'tee: null');
	const findings = [
		{
			id: 'pre-stitch-detector',
			title: 'Detector invocation precedes crop and stitch.',
			status: 'blocked',
			evidence: `${preStitch}; crop follows at ${crop}; pixel placement search at ${stitch}`,
			impact: '3factor measurements are per-tile and cannot see the approved post-stitch composite.'
		},
		{
			id: 'canonical-rgba-missing',
			title: 'No canonical post-stitch RGBA composite is built.',
			status: 'blocked',
			evidence: `${grayContract}; ${stitch}; stitch stores placements while rasters remain grayscale and per-tile`,
			impact: 'A post-stitch detector call has no authoritative RGBA pixel source.'
		},
		{
			id: 'measurement-loss',
			title: 'Annotation carries only badge seeds; endpoint measurements are absent.',
			status: 'blocked',
			evidence: `${seedProjection}; ${nullGeometry}; detector emissions are consumed as n/x/y in enterAnnotate`,
			impact:
				'Basket bbox/tip/onFrac/offFrac, tee tier/angle/ring evidence, and badge alternatives/margins cannot reach review.'
		}
	];
	for (const finding of findings)
		addFinding({
			...finding,
			nextAction:
				'Insert a canonical composite-and-detection seam after crop/stitch, then preserve raw measurements before annotation consumes badge seeds.'
		});
	const nextAction =
		'Next failing gate: create the post-stitch canonical RGBA seam and a measurement inventory before wiring 3factor emissions into review.';
	return {
		lane: 'MVP',
		prediction,
		target,
		seam: { preStitch, crop, stitch, grayContract, seedProjection, nullGeometry },
		discrepancy: findings.map(({ id, title, status, evidence, impact }) => ({
			id,
			title,
			status,
			evidence,
			impact
		})),
		nextAction
	};
}

async function main() {
	record(`3fd72 orientation run ${runId}`);
	record(`Output: ${runDir}`);
	record('Read-only practicum: source and target checkouts are never modified.');
	const laneAnswer = (await ask('Select lane [SOURCE/MVP]: ')).toUpperCase();
	const lane = laneAnswer === 'SOURCE' || laneAnswer === 'MVP' ? laneAnswer : null;
	const prediction = await ask('Before evidence, what do you predict is the first failing seam? ');
	const target = checkTarget();
	let result;
	if (!lane) {
		addFinding({
			id: 'lane-selection',
			title: 'No valid lane was selected.',
			status: 'blocked',
			evidence: `interactive answer: ${laneAnswer || '(empty)'}`,
			nextAction: 'Run `lab orient 3fd72` and select SOURCE or MVP.'
		});
		result = {
			lane: null,
			prediction,
			target,
			discrepancy: ['The practicum did not disclose lane-specific evidence.'],
			nextAction: 'Select SOURCE or MVP on the next run.'
		};
	} else if (!target.branchOk) {
		addFinding({
			id: 'target-gate',
			title: 'Target branch gate stopped lane evidence.',
			status: 'blocked',
			evidence: 'commands/target-branch.txt',
			nextAction: `Switch to ${expectedBranch}; no lane claims are made.`
		});
		result = {
			lane,
			prediction,
			target,
			discrepancy: ['Target branch mismatch; lane evidence was intentionally withheld.'],
			nextAction: `Switch to ${expectedBranch} and rerun.`
		};
	} else if (lane === 'SOURCE') {
		result = runSource(prediction, target);
	} else {
		result = runMvp(prediction, target);
	}
	const manifest = {
		runId,
		startedAt: startedAt.toISOString(),
		finishedAt: new Date().toISOString(),
		command: 'lab orient 3fd72',
		verbose,
		lane: result.lane,
		prediction,
		workspace: targetDir,
		expectedBranch,
		readOnly: true,
		reference: { sourceDir, expectedTag, expectedTagCommit, expectedExtractCommit, evidenceDir },
		result,
		files: [...files, 'manifest.json', 'transcript.txt', 'findings.json', 'hashes.txt']
	};
	writeText(
		'findings.json',
		JSON.stringify({ runId, lane: result.lane, prediction, findings }, null, 2)
	);
	writeText('manifest.json', JSON.stringify(manifest, null, 2));
	record(`Next action: ${result.nextAction}`);
	record(`Evidence preserved under ${runDir}`);
	writeText('transcript.txt', `${transcript.join('\n')}\n`);
	const hashLines = [];
	for (const relativePath of [...files]) {
		if (relativePath === 'hashes.txt') continue;
		const filePath = path.join(runDir, relativePath);
		if (fs.existsSync(filePath))
			hashLines.push(
				`${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}  ${relativePath}`
			);
	}
	writeText('hashes.txt', `${hashLines.join('\n')}\n`);
	return result.discrepancy?.length ? 1 : 0;
}

main()
	.then((code) => (process.exitCode = code))
	.catch((error) => {
		console.error(error instanceof Error ? error.stack : String(error));
		process.exitCode = 1;
	});
