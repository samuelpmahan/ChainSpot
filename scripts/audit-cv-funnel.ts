import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { loadCv } from '../src/lib/stitch/cvMatch';
import { labelKnownHoleNumberBadges, type HoleNumberTemplate } from '../src/lib/autoAnnotation/holeNumberDetection';
import { detectRawObjectMask, RAW_MASK_HISTORICAL_DEFAULTS } from '../src/lib/autoAnnotation/rawObjectMask';
import { deriveP3Ownership } from '../src/lib/autoAnnotation/rawObjectOwnership';
import { deriveP4RibbonOwnership } from '../src/lib/autoAnnotation/p4RibbonOwnership';
import { DEFAULT_RIBBON_MASS_PARAMS, segmentRibbonMass } from '../src/lib/autoAnnotation/ribbonMass';
import { deriveP5SparseAssignment } from '../src/lib/autoAnnotation/p5SparseAssignment';
import { deriveP6LowParBasketAssignment } from '../src/lib/autoAnnotation/p6LowParBasketAssignment';
import { buildPancakeDisplayGrammar } from '../src/lib/autoAnnotation/pancakeCourseDisplay';
import {
	asNumberTemplateScale,
	deriveBasketTemplateScale,
	deriveUDiscCalibration,
	validateCvTemplateManifest
} from '../src/lib/autoAnnotation/cvCalibration';
import type { CvTemplateManifest } from '../src/lib/autoAnnotation/cvCalibration';
import type { BasketTemplateRaster } from '../src/lib/autoAnnotation/basketTemplateDetection';
import { DEFAULT_VISION_FLAGS, type VisionFlags } from '../src/lib/autoAnnotation/visionFlags';
import type { CourseDetectionResult } from '../src/lib/autoAnnotation/basketDetection';
import {
	buildCourseLandmarkTraces,
	type CourseLandmarkTruth
} from '../src/lib/autoAnnotation/courseLandmarkTrace';
import { buildLandmarkFunnelAudit } from '../src/lib/cv/funnelAudit';
import {
	localFeatureSnapDetailed,
	type LocalSnapCalibration,
	type LocalSnapKind,
	type LocalSnapPoint,
	type LocalSnapRaster
} from '../src/lib/cv/localSnap';

interface Args {
	readonly inputPath: string;
	readonly truthPath: string;
	readonly outputDir: string;
	readonly tolerancePx: number;
	readonly templateDir: string;
	readonly snapOffsetPx: number;
	readonly p1Profile: 'tuned' | 'historical';
}

interface DecodedRaster {
	readonly rgba: Uint8Array;
	readonly widthPx: number;
	readonly heightPx: number;
}

interface TruthManifest {
	readonly schemaVersion: number;
	readonly fixtureId: string;
	readonly source: {
		readonly fileName: string;
		readonly widthPx: number;
		readonly heightPx: number;
		readonly sha256: string;
		readonly note?: string;
	};
	readonly semanticAnchors?: Readonly<Record<'tee' | 'basket', string>>;
	readonly holes: readonly {
		readonly number: number;
		readonly tee?: LocalSnapPoint;
		readonly basket?: LocalSnapPoint;
	}[];
}

interface SnapProbeRow {
	readonly course: string;
	readonly hole: number;
	readonly object: LocalSnapKind;
	readonly clickCase: string;
	readonly clickPx: LocalSnapPoint;
	readonly detectorAccepted: boolean;
	readonly rejectReason: string | null;
	readonly candidateCount: number | null;
	readonly inRadiusCandidateCount: number | null;
	readonly score: { readonly name: string; readonly value: number } | null;
	readonly knownRecommendationDistancePx: number | null;
	readonly snappedPoint: LocalSnapPoint | null;
	readonly semanticPointErrorPx: number | null;
}

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), '..');
const defaultTemplateDir = join(projectRoot, 'static', 'resources', 'chainspot_cv_templates');

function usage(): string {
	return [
		'Usage: npm run audit:cv-funnel -- <image> --truth <fixture.json> --out <directory> --tolerance-px <px>',
		'',
		'Runs the exact staged Pancake P1→P6 course path, scores only truth-backed',
		'hole/object rows, and separately probes local snap at the truth point plus',
		'four deterministic offsets. The source SHA in the truth manifest must match.',
		'',
		'Options:',
		'  --templates <directory>     CV template pack (default: static/resources/chainspot_cv_templates)',
		'  --snap-offset-px <px>       Local-snap probe offset (default: 12)',
		'  --p1-profile tuned|historical (default: tuned)',
		'  --help'
	].join('\n');
}

function requireValue(argv: readonly string[], index: number, option: string): string {
	const value = argv[index + 1];
	if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.\n\n${usage()}`);
	return value;
}

function positiveFinite(value: string, option: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${option} must be a positive finite number.`);
	return parsed;
}

function parseArgs(argv: readonly string[]): Args {
	if (argv.includes('--help')) throw new Error(usage());
	const inputPath = argv.find((value) => !value.startsWith('--'));
	if (!inputPath) throw new Error(`Input image is required.\n\n${usage()}`);
	let truthPath: string | undefined;
	let outputDir: string | undefined;
	let tolerancePx: number | undefined;
	let templateDir = defaultTemplateDir;
	let snapOffsetPx = 12;
	let p1Profile: Args['p1Profile'] = 'tuned';
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (!argument.startsWith('--')) continue;
		switch (argument) {
			case '--truth':
				truthPath = requireValue(argv, index, argument);
				index += 1;
				break;
			case '--out':
				outputDir = requireValue(argv, index, argument);
				index += 1;
				break;
			case '--tolerance-px':
				tolerancePx = positiveFinite(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--templates':
				templateDir = requireValue(argv, index, argument);
				index += 1;
				break;
			case '--snap-offset-px':
				snapOffsetPx = positiveFinite(requireValue(argv, index, argument), argument);
				index += 1;
				break;
			case '--p1-profile': {
				const profile = requireValue(argv, index, argument);
				if (profile !== 'tuned' && profile !== 'historical') throw new Error('--p1-profile must be tuned or historical.');
				p1Profile = profile;
				index += 1;
				break;
			}
			default:
				throw new Error(`Unknown option '${argument}'.\n\n${usage()}`);
		}
	}
	if (!truthPath || !outputDir || tolerancePx === undefined) {
		throw new Error(`--truth, --out, and --tolerance-px are required.\n\n${usage()}`);
	}
	return { inputPath, truthPath, outputDir, tolerancePx, templateDir, snapOffsetPx, p1Profile };
}

function decodeRaster(bytes: Uint8Array, fileName: string): DecodedRaster {
	const extension = extname(fileName).toLowerCase();
	if (extension === '.png') {
		const decoded = PNG.sync.read(Buffer.from(bytes));
		return { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height };
	}
	if (extension === '.jpg' || extension === '.jpeg') {
		const decoded = jpeg.decode(Buffer.from(bytes), { useTArray: true });
		return { rgba: new Uint8Array(decoded.data), widthPx: decoded.width, heightPx: decoded.height };
	}
	throw new Error(`Unsupported image '${fileName}'. Use PNG or JPEG.`);
}

function gray(raster: DecodedRaster): Uint8Array {
	const output = new Uint8Array(raster.widthPx * raster.heightPx);
	for (let pixel = 0, offset = 0; pixel < output.length; pixel += 1, offset += 4) {
		output[pixel] = (raster.rgba[offset] * 0.299 + raster.rgba[offset + 1] * 0.587 + raster.rgba[offset + 2] * 0.114 + 0.5) | 0;
	}
	return output;
}

function sourceSha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function loadManifest(path: string): TruthManifest {
	const parsed = JSON.parse(readFileSync(path, 'utf8')) as TruthManifest;
	if (!parsed || !Array.isArray(parsed.holes) || typeof parsed.source?.sha256 !== 'string') {
		throw new Error(`Truth fixture '${path}' is malformed.`);
	}
	return parsed;
}

function loadTemplateManifest(templateDir: string): CvTemplateManifest {
	const path = join(resolve(templateDir), 'manifest.json');
	if (!existsSync(path)) throw new Error(`CV template manifest is missing: ${path}`);
	return validateCvTemplateManifest(JSON.parse(readFileSync(path, 'utf8')));
}

function loadNumberTemplates(templateDir: string, manifest: CvTemplateManifest): readonly HoleNumberTemplate[] {
	return manifest.templates.holeNumbers.map((fileName, index) => {
		const path = join(resolve(templateDir), fileName);
		const decoded = decodeRaster(new Uint8Array(readFileSync(path)), path);
		return {
			label: index + 1,
			raster: { format: 'rgba', widthPx: decoded.widthPx, heightPx: decoded.heightPx, data: decoded.rgba }
		};
	});
}

function loadBasketTemplate(templateDir: string, manifest: CvTemplateManifest): BasketTemplateRaster {
	const path = join(resolve(templateDir), manifest.templates.basket);
	const decoded = decodeRaster(new Uint8Array(readFileSync(path)), path);
	return { gray: gray(decoded), widthPx: decoded.widthPx, heightPx: decoded.heightPx };
}

function toTruth(manifest: TruthManifest): readonly CourseLandmarkTruth[] {
	return manifest.holes.map((hole) => ({
		holeNumber: hole.number,
		...(hole.tee ? { tee: hole.tee } : {}),
		...(hole.basket ? { basket: hole.basket } : {})
	}));
}

function csvValue(value: unknown): string {
	const text = value === undefined || value === null
		? ''
		: typeof value === 'string'
			? value
			: typeof value === 'object'
				? JSON.stringify(value)
				: String(value);
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function rowsToCsv(rows: readonly Record<string, unknown>[]): string {
	if (rows.length === 0) return '';
	const headers = Object.keys(rows[0]);
	return `${headers.map(csvValue).join(',')}\n${rows.map((row) => headers.map((header) => csvValue(row[header])).join(',')).join('\n')}\n`;
}

function clickCases(point: LocalSnapPoint, offsetPx: number): readonly { name: string; point: LocalSnapPoint }[] {
	return [
		{ name: 'truth', point },
		{ name: `+x${offsetPx}`, point: { xPx: point.xPx + offsetPx, yPx: point.yPx } },
		{ name: `-x${offsetPx}`, point: { xPx: point.xPx - offsetPx, yPx: point.yPx } },
		{ name: `+y${offsetPx}`, point: { xPx: point.xPx, yPx: point.yPx + offsetPx } },
		{ name: `-y${offsetPx}`, point: { xPx: point.xPx, yPx: point.yPx - offsetPx } }
	];
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const inputPath = resolve(args.inputPath);
	const truthPath = resolve(args.truthPath);
	const outputDir = resolve(args.outputDir);
	const inputBytes = new Uint8Array(readFileSync(inputPath));
	const truthManifest = loadManifest(truthPath);
	const sha256 = sourceSha256(inputBytes);
	if (sha256 !== truthManifest.source.sha256) {
		throw new Error(`Source SHA mismatch: fixture requires ${truthManifest.source.sha256}, received ${sha256}.`);
	}
	const raster = decodeRaster(inputBytes, inputPath);
	if (raster.widthPx !== truthManifest.source.widthPx || raster.heightPx !== truthManifest.source.heightPx) {
		throw new Error(
			`Source dimensions ${raster.widthPx}×${raster.heightPx} do not match fixture ${truthManifest.source.widthPx}×${truthManifest.source.heightPx}.`
		);
	}
	mkdirSync(outputDir, { recursive: true });

	const [cv, templateManifest] = await Promise.all([
		loadCv(),
		Promise.resolve(loadTemplateManifest(args.templateDir))
	]);
	const numberTemplates = loadNumberTemplates(args.templateDir, templateManifest);
	const basketTemplate = loadBasketTemplate(args.templateDir, templateManifest);
	const visionFlags: VisionFlags = Object.freeze({ ...DEFAULT_VISION_FLAGS, p1Profile: args.p1Profile });
	const p1Tuning = args.p1Profile === 'historical' ? RAW_MASK_HISTORICAL_DEFAULTS : undefined;

	// Exact staged/demo Pancake P1→P6 sequence from basketDetection.worker.ts.
	const rawMaskObjects = detectRawObjectMask(
		{ rgba: raster.rgba, widthPx: raster.widthPx, heightPx: raster.heightPx },
		undefined,
		p1Tuning
	);
	const p2Raw = labelKnownHoleNumberBadges(
		cv,
		{ format: 'rgba', widthPx: raster.widthPx, heightPx: raster.heightPx, data: raster.rgba },
		numberTemplates,
		rawMaskObjects.badges
	);
	const p2BadgeDetection = {
		...p2Raw,
		anchor: p2Raw.anchor ? { ...p2Raw.anchor, scale: asNumberTemplateScale(p2Raw.anchor.scale) } : null,
		candidates: p2Raw.candidates.map((candidate) => ({ ...candidate, scale: asNumberTemplateScale(candidate.scale) }))
	};
	const p2LabeledBadges = p2BadgeDetection.candidates
		.filter((candidate): candidate is typeof candidate & { label: number; glyphScore: number } =>
			candidate.label !== undefined && candidate.glyphScore !== undefined
		)
		.map((candidate) => ({
			holeNumber: candidate.label,
			glyphScore: candidate.glyphScore,
			xPx: candidate.xPx,
			yPx: candidate.yPx,
			widthPx: candidate.widthPx,
			heightPx: candidate.heightPx
		}));
	const p3Ownership = deriveP3Ownership(rawMaskObjects.tees, p2LabeledBadges, rawMaskObjects.baskets, visionFlags);
	const ribbonSegmentation = segmentRibbonMass(
		{ data: raster.rgba, widthPx: raster.widthPx, heightPx: raster.heightPx, channels: 4 },
		p2LabeledBadges.map((badge) => ({ xPx: badge.xPx, yPx: badge.yPx })),
		DEFAULT_RIBBON_MASS_PARAMS
	);
	const p4RibbonOwnership = deriveP4RibbonOwnership(
		ribbonSegmentation,
		rawMaskObjects.tees,
		p2LabeledBadges,
		rawMaskObjects.baskets,
		p3Ownership
	);
	const p5SparseAssignment = deriveP5SparseAssignment(
		rawMaskObjects.tees,
		p2LabeledBadges,
		p3Ownership,
		p4RibbonOwnership
	);
	const p6LowParBasketAssignment = deriveP6LowParBasketAssignment(
		{
			data: raster.rgba,
			widthPx: raster.widthPx,
			heightPx: raster.heightPx,
			originXPx: 0,
			originYPx: 0,
			scale: 1,
			channels: 4
		},
		rawMaskObjects.tees,
		rawMaskObjects.baskets,
		p2LabeledBadges,
		p5SparseAssignment,
		p4RibbonOwnership,
		ribbonSegmentation,
		visionFlags
	);
	const grammar = buildPancakeDisplayGrammar(rawMaskObjects, p2BadgeDetection, p5SparseAssignment, p6LowParBasketAssignment);
	const detection: CourseDetectionResult = {
		numberDetection: p2BadgeDetection,
		tees: [],
		baskets: [],
		grammar,
		rawMaskObjects,
		p2BadgeDetection,
		p3Ownership,
		p4RibbonOwnership,
		p5SparseAssignment,
		p6LowParBasketAssignment,
		visionFlags
	};

	const truth = toTruth(truthManifest);
	const truthHoleNumbers = new Set(truth.map((hole) => hole.holeNumber));
	const allTraces = buildCourseLandmarkTraces(detection, { truth, tolerancePx: args.tolerancePx });
	const scoredTraces = allTraces.filter((trace) => truthHoleNumbers.has(trace.holeNumber));
	const audit = buildLandmarkFunnelAudit(truthManifest.fixtureId, scoredTraces);
	const unexpectedRecommendations = allTraces
		.filter((trace) => !truthHoleNumbers.has(trace.holeNumber) && trace.recommendation.emitted)
		.map((trace) => ({
			hole: trace.holeNumber,
			object: trace.kind,
			candidateIndex: trace.assignedCandidateIndex ?? null,
			point: trace.recommendation.point ?? null,
			score: trace.recommendation.score ?? null
		}));

	const snapProbeRows: SnapProbeRow[] = [];
	const numberAnchor = p2BadgeDetection.anchor;
	if (numberAnchor) {
		const udisc = deriveUDiscCalibration(
			{ scale: numberAnchor.scale, widthPx: numberAnchor.widthPx, heightPx: numberAnchor.heightPx },
			templateManifest.calibration.canonicalNumberBadge
		);
		const basketTemplateScale = deriveBasketTemplateScale(numberAnchor.scale, templateManifest.calibration);
		const fullGray = gray(raster);
		for (const hole of truthManifest.holes) {
			for (const kind of ['tee', 'basket'] as const) {
				const expected = hole[kind];
				if (!expected) continue;
				const proposal = grammar.holes.find((entry) => entry.number === hole.number);
				const assignment = kind === 'tee' ? proposal?.tee : proposal?.basket;
				const rawCandidate = assignment
					? kind === 'tee'
						? rawMaskObjects.tees[assignment.candidateIndex]
						: rawMaskObjects.baskets[assignment.candidateIndex]
					: undefined;
				const knownRecommendation = assignment
					? {
						point: { xPx: assignment.xPx, yPx: assignment.yPx },
						holeNumber: hole.number,
						...(rawCandidate ? { featureFootprintPx: Math.max(rawCandidate.widthPx, rawCandidate.heightPx) } : {})
					}
					: undefined;
				const calibration: LocalSnapCalibration = kind === 'tee'
					? {
						uiScalePx: udisc.uiScalePx,
						...(knownRecommendation ? { knownRecommendation } : {})
					}
					: {
						uiScalePx: udisc.uiScalePx,
						basket: { template: basketTemplate, templateScale: basketTemplateScale },
						...(knownRecommendation ? { knownRecommendation } : {})
					};
				const localRaster: LocalSnapRaster = kind === 'tee'
					? { rgba: raster.rgba, widthPx: raster.widthPx, heightPx: raster.heightPx, sourceScale: 1 }
					: { gray: fullGray, widthPx: raster.widthPx, heightPx: raster.heightPx, sourceScale: 1 };
				for (const clickCase of clickCases(expected, args.snapOffsetPx)) {
					const outcome = localFeatureSnapDetailed(kind, cv, localRaster, clickCase.point, calibration);
					snapProbeRows.push({
						course: truthManifest.fixtureId,
						hole: hole.number,
						object: kind,
						clickCase: clickCase.name,
						clickPx: clickCase.point,
						detectorAccepted: outcome.trace.accepted,
						rejectReason: outcome.trace.rejectReason ?? null,
						candidateCount: outcome.trace.candidateCount ?? null,
						inRadiusCandidateCount: outcome.trace.inRadiusCandidateCount ?? null,
						score: outcome.trace.bestCandidateScore
							? { name: outcome.trace.bestCandidateScore.name, value: outcome.trace.bestCandidateScore.value }
							: null,
						knownRecommendationDistancePx: outcome.trace.knownRecommendationDistancePx ?? null,
						snappedPoint: outcome.point,
						semanticPointErrorPx: outcome.point ? Math.hypot(outcome.point.xPx - expected.xPx, outcome.point.yPx - expected.yPx) : null
					});
				}
			}
		}
	}

	const result = {
		schemaVersion: 1,
		fixture: {
			id: truthManifest.fixtureId,
			sourcePath: inputPath,
			sha256,
			widthPx: raster.widthPx,
			heightPx: raster.heightPx,
			tolerancePx: args.tolerancePx,
			snapOffsetPx: args.snapOffsetPx,
			p1Profile: args.p1Profile
		},
		stageCounts: {
			p1Tees: rawMaskObjects.tees.length,
			p1Baskets: rawMaskObjects.baskets.length,
			p1Badges: rawMaskObjects.badges.length,
			p2LabeledBadges: p2LabeledBadges.length,
			p3OwnedTees: p3Ownership.teeBadgeHits.length,
			p4ResolvedTees: p4RibbonOwnership.teeResolutions.filter((entry) => entry.status === 'resolved').length,
			p5AssignedTees: p5SparseAssignment.assignedTees,
			p6Assigned: p6LowParBasketAssignment.assignments.filter((entry) => entry.assignedBasketIndex !== null).length,
			p6SwapsApplied: p6LowParBasketAssignment.swapAdjudication?.swapsApplied ?? 0
		},
		audit,
		unexpectedRecommendations,
		localSnap: {
			instrumented: Boolean(numberAnchor),
			...(numberAnchor ? {} : { reason: 'P2 produced no number-badge calibration anchor; staged UI would not issue local snap.' }),
			rows: snapProbeRows
		}
	};

	writeFileSync(join(outputDir, 'funnel-audit.json'), `${JSON.stringify(result, null, 2)}\n`);
	writeFileSync(join(outputDir, 'funnel-audit.csv'), rowsToCsv(audit.rows as unknown as readonly Record<string, unknown>[]));
	writeFileSync(join(outputDir, 'local-snap-probes.csv'), rowsToCsv(snapProbeRows as unknown as readonly Record<string, unknown>[]));

	console.log(`${truthManifest.fixtureId}: ${audit.metrics.map((metric) => `${metric.name} ${metric.numerator}/${metric.denominator}${metric.notInstrumented ? ` (+${metric.notInstrumented} NI)` : ''}`).join(' · ')}`);
	console.log(`P1 inventory: tees ${rawMaskObjects.tees.length}, baskets ${rawMaskObjects.baskets.length}, badges ${rawMaskObjects.badges.length}; P5 assigned tees ${p5SparseAssignment.assignedTees}; P6 assigned baskets ${p6LowParBasketAssignment.assignments.filter((entry) => entry.assignedBasketIndex !== null).length}.`);
	console.log(`Local snap probes: ${snapProbeRows.filter((row) => row.detectorAccepted).length}/${snapProbeRows.length} detector-accepted; these are not counted as settled UI snaps.`);
	console.log(`Audit: ${join(outputDir, 'funnel-audit.json')}`);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
