// Sweep canonical raster intake.
//
// Raw capture(s) are decoded, StripChrome removes capture chrome, AutoStitch
// solves multi-tile placement, and only the resulting canonical raster crosses
// the boundary into presentation or algorithm code.

import { existsSync, readFileSync } from 'node:fs';
import { decodeNodeFile } from '@chainspot/alg/adapters/node';
import { toGrayRaster, type InputAsset } from '@chainspot/alg/g0/inputAsset';
import { stripChromeProposal, type StripChromeResult } from '@chainspot/alg/g0/stripChrome';
import { cropRaster } from '@chainspot/alg/raster';
import { solvePixelStitch } from '@chainspot/alg/g0/stitchSolve';
import { materializeComposite, compositeIdBytes } from '@chainspot/alg/g0/composite';
import { sha256Hex } from '@chainspot/alg/g0/hash';
import { appendEntries, createLedger, type CoordinateTransformLedger, type LedgerEntry } from '@chainspot/alg/g0/ledger';
import { matchTruth, type AnnotationPoint, type CanonicalTruth, type TruthMatch } from '@chainspot/alg/g0/truth';
import type { RgbaImage } from '@chainspot/alg/detectors/threeFactor/types';
import type { Placement } from '@chainspot/alg/g0/types';

// BUG (2026-08-29 audit): Scope/Search/Traverse all funnel a single-file
// input through this same canonicalizeInputs() -- including a file that IS
// ALREADY a G0 canonical output (e.g. a sweep's own
// renders/input/g0.canonical.png), because nothing here ever asked "have I
// already done this?" StripChrome would then re-detect a few rows of
// (mis-taken) chrome in the already-clean raster and crop it AGAIN, so every
// y-coordinate a second pass prints is off by the crop it silently redid.
//
// Fix: when Sweep writes a canonical PNG, it writes a `<path>.json` sidecar
// beside it (the same "render + .json sidecar" convention scope/render.ts
// already uses) recording the exact content-addressed composite imageId that
// PNG carries. On a later single-file load, if that sidecar exists AND the
// freshly-decoded pixels re-hash (via the SAME compositeIdBytes definition
// materializeComposite uses -- never the raw-file-bytes InputAsset.imageId,
// which a lossless PNG re-encode would not reproduce) to the sidecar's
// recorded id, this is provably the literal bytes G0 already canonicalized:
// StripChrome is skipped entirely. Dimensions alone are never the check --
// a coincidentally same-size raw capture must still be stripped.
const CANONICAL_PROVENANCE_KIND = 'g0-canonical-provenance' as const;

export interface CanonicalProvenanceSidecar {
	readonly kind: typeof CANONICAL_PROVENANCE_KIND;
	readonly imageId: string;
	readonly widthPx: number;
	readonly heightPx: number;
}

export function canonicalProvenanceSidecarPath(canonicalPngPath: string): string {
	return `${canonicalPngPath}.json`;
}

/** Pure builder for the sidecar's bytes; operation.ts (the node-bound half
 * that already owns writing g0.canonical.png) does the actual write. */
export function canonicalProvenanceSidecarJson(imageId: string, widthPx: number, heightPx: number): string {
	const sidecar: CanonicalProvenanceSidecar = { kind: CANONICAL_PROVENANCE_KIND, imageId, widthPx, heightPx };
	return `${JSON.stringify(sidecar, null, 2)}\n`;
}

function readCanonicalProvenance(filePath: string): CanonicalProvenanceSidecar | undefined {
	const sidecarPath = canonicalProvenanceSidecarPath(filePath);
	if (!existsSync(sidecarPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(sidecarPath, 'utf8'));
		if (
			parsed?.kind === CANONICAL_PROVENANCE_KIND &&
			typeof parsed.imageId === 'string' &&
			typeof parsed.widthPx === 'number' &&
			typeof parsed.heightPx === 'number'
		) {
			return parsed as CanonicalProvenanceSidecar;
		}
	} catch {
		// A malformed/foreign sidecar is not proof of anything -- fall through
		// to the normal StripChrome path rather than trust it.
	}
	return undefined;
}

async function detectAlreadyCanonical(
	filePaths: readonly string[],
	assets: readonly InputAsset[]
): Promise<boolean> {
	if (filePaths.length !== 1 || assets.length !== 1) return false;
	const provenance = readCanonicalProvenance(filePaths[0]);
	if (!provenance) return false;
	if (provenance.widthPx !== assets[0].widthPx || provenance.heightPx !== assets[0].heightPx) return false;
	const recomputedId = await sha256Hex(
		compositeIdBytes(assets[0].widthPx, assets[0].heightPx, assets[0].rgba)
	);
	return recomputedId === provenance.imageId;
}

export interface G0Report {
	readonly shimmed: false;
	readonly filePaths: readonly string[];
	readonly rawImageIds: readonly string[];
	readonly imageId: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly sourceByteLength: number;
	readonly stripChrome: StripChromeResult;
	/** True when intake proved (via canonicalProvenanceSidecarJson provenance,
	 * never dimensions alone) that the single supplied file is already the
	 * literal bytes a prior G0 canonicalization produced, and skipped
	 * StripChrome entirely rather than re-cropping an already-canonical
	 * raster. Always false for a raw capture or a multi-source stitch. */
	readonly alreadyCanonicalInput: boolean;
	readonly autoStitch: {
		readonly sourceCount: number;
		readonly hadFallback: boolean;
		readonly placements: readonly Placement[];
	};
	readonly ledger: CoordinateTransformLedger;
	readonly singleSourceOffset?: { readonly xPx: number; readonly yPx: number };
	readonly truthMatch: TruthMatch | null;
}

export interface DecodedInput {
	readonly report: G0Report;
	readonly image: RgbaImage;
	readonly canonicalTruth?: CanonicalTruth;
}

function sameDimensions(assets: readonly InputAsset[]): boolean {
	const first = assets[0];
	return assets.every((asset) => asset.widthPx === first.widthPx && asset.heightPx === first.heightPx);
}

function transformedTruthForSingleSource(
	truth: CanonicalTruth | undefined,
	canonicalImageId: string,
	canonicalWidthPx: number,
	canonicalHeightPx: number,
	left: number,
	top: number
): CanonicalTruth | undefined {
	if (!truth) return undefined;
	const shift = (point: AnnotationPoint): AnnotationPoint => ({ xPx: point.xPx - left, yPx: point.yPx - top });
	return {
		...truth,
		sourceImage: { ...truth.sourceImage, widthPx: canonicalWidthPx, heightPx: canonicalHeightPx, sha256: canonicalImageId },
		holes: truth.holes.map((hole) => ({
			...hole,
			tee: shift(hole.tee),
			basket: shift(hole.basket),
			corridorBends: hole.corridorBends.map(shift),
			...(hole.numberBadge ? { numberBadge: shift(hole.numberBadge) } : {}),
			...(hole.badge ? { badge: shift(hole.badge) } : {})
		}))
	};
}

/** A reconciled match can map one cropped source into its canonical frame,
 * but it cannot establish which source frame a stitched multi-input
 * annotation belongs to. Preserve exact composite-byte matches and downgrade
 * only the ambiguous reconciliation case. */
export function normalizeTruthMatchForInputCount(
	sourceCount: number,
	truthMatch: TruthMatch | null
): TruthMatch | null {
	if (sourceCount <= 1 || truthMatch?.level !== 'reconciled-verified') return truthMatch;
	return {
		level: 'dims-only',
		warning:
			'Multiple source placements do not establish how one Annotation coordinate frame maps into the stitched canonical composite. Treat this match as unverified.'
	};
}

export async function canonicalizeInputs(filePaths: readonly string[], truth?: CanonicalTruth): Promise<DecodedInput> {
	if (filePaths.length === 0) throw new Error('LAB intake requires at least one raster input.');
	const assets = await Promise.all(filePaths.map((path) => decodeNodeFile(path)));
	if (assets.length > 1 && !sameDimensions(assets)) throw new Error('LAB intake: AutoStitch requires same-size captures from one device/orientation.');

	const gray = assets.map(toGrayRaster);
	const alreadyCanonicalInput = await detectAlreadyCanonical(filePaths, assets);
	// An already-canonical raster gets NO StripChrome pass -- not even a
	// second "found no chrome" no-op pass, because the point being fixed is
	// that a second pass over a genuinely canonical image is not idempotent
	// (JPEG-derived entropy near the true frame can look like a few more rows
	// of chrome). source: 'none' here is the honest, already-existing
	// "insets: null" shape; alreadyCanonicalInput is the field that
	// distinguishes it from "StripChrome ran and found nothing".
	const stripChrome: StripChromeResult = alreadyCanonicalInput
		? { insets: null, source: 'none' }
		: stripChromeProposal(gray);
	const croppedGray = stripChrome.insets ? gray.map((raster) => cropRaster(raster, stripChrome.insets!)) : gray;

	let placements: readonly Placement[];
	let hadFallback = false;
	if (assets.length === 1) placements = [{ x: 0, y: 0 }];
	else {
		const stitched = solvePixelStitch(croppedGray);
		if (!stitched) throw new Error('LAB intake: AutoStitch failed to produce a placement solution.');
		placements = stitched.placements;
		hadFallback = stitched.hadFallback;
	}

	const composite = await materializeComposite(
		assets.map((asset, index) => ({ rgba: asset.rgba, widthPx: asset.widthPx, heightPx: asset.heightPx, placement: placements[index] })),
		stripChrome.insets
	);

	const entries: LedgerEntry[] = [];
	if (stripChrome.insets) entries.push({ kind: 'crop', insets: stripChrome.insets });
	if (assets.length > 1) for (let index = 0; index < placements.length; index++) entries.push({ kind: 'placement', tileIndex: index, placement: placements[index], source: 'pixel' });
	const ledger = appendEntries(createLedger(), entries);

	const rawShaForTruth = assets.length === 1 ? assets[0].imageId : '';
	const truthMatch = normalizeTruthMatchForInputCount(
		assets.length,
		truth ? matchTruth(rawShaForTruth, { imageId: composite.imageId, widthPx: composite.widthPx, heightPx: composite.heightPx, ledger }, truth) : null
	);
	const left = stripChrome.insets?.left ?? 0;
	const top = stripChrome.insets?.top ?? 0;
	const canonicalTruth =
		assets.length === 1 && truthMatch
			? transformedTruthForSingleSource(truth, composite.imageId, composite.widthPx, composite.heightPx, left, top)
			: truthMatch?.level === 'byte' && truthMatch.matchedAgainst === 'canonical'
				? truth
				: undefined;

	const report: G0Report = {
		shimmed: false,
		filePaths: [...filePaths],
		rawImageIds: assets.map((asset) => asset.imageId),
		imageId: composite.imageId,
		widthPx: composite.widthPx,
		heightPx: composite.heightPx,
		sourceByteLength: assets.reduce((sum, asset) => sum + asset.sourceByteLength, 0),
		stripChrome,
		alreadyCanonicalInput,
		autoStitch: { sourceCount: assets.length, hadFallback, placements },
		ledger,
		singleSourceOffset: assets.length === 1 ? { xPx: -left, yPx: -top } : undefined,
		truthMatch
	};

	return { report, image: { width: composite.widthPx, height: composite.heightPx, data: composite.rgba }, canonicalTruth };
}

export async function decodeInput(filePath: string, truth?: CanonicalTruth): Promise<DecodedInput> {
	return canonicalizeInputs([filePath], truth);
}

export function printG0Report(report: G0Report): void {
	console.log('--- G0 canonical intake ---');
	console.log(`  source(s):    ${report.filePaths.length}`);
	for (const path of report.filePaths) console.log(`                ${path}`);
	console.log(
		`  StripChrome:  ${
			report.alreadyCanonicalInput
				? 'SKIPPED (sidecar provenance proved this input is already a G0 canonical output)'
				: `${report.stripChrome.source}${report.stripChrome.insets ? ` ${JSON.stringify(report.stripChrome.insets)}` : ' (no chrome detected)'}`
		}`
	);
	console.log(`  AutoStitch:   ${report.autoStitch.sourceCount > 1 ? `${report.autoStitch.sourceCount} tiles${report.autoStitch.hadFallback ? ' (fallback used)' : ''}` : 'single source'}`);
	console.log(`  canonical id: ${report.imageId}`);
	console.log(`  canonical:    ${report.widthPx}x${report.heightPx}px`);
	if (report.truthMatch) {
		const m = report.truthMatch;
		console.log(`  truth match:  ${m.level}${m.matchedAgainst ? ` (${m.matchedAgainst})` : ''}`);
		if (m.warning) console.log(`                WARNING: ${m.warning}`);
	} else console.log('  truth match:  (no truth supplied / no match)');
}
