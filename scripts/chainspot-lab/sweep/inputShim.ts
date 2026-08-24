// Sweep canonical raster intake.
//
// Raw capture(s) are decoded, StripChrome removes capture chrome, AutoStitch
// solves multi-tile placement, and only the resulting canonical raster crosses
// the boundary into presentation or algorithm code.

import { decodeNodeFile } from '@chainspot/alg/adapters/node';
import { toGrayRaster, type InputAsset } from '@chainspot/alg/g0/inputAsset';
import { stripChromeProposal, type StripChromeResult } from '@chainspot/alg/g0/stripChrome';
import { cropRaster } from '@chainspot/alg/raster';
import { solvePixelStitch } from '@chainspot/alg/g0/stitchSolve';
import { materializeComposite } from '@chainspot/alg/g0/composite';
import { appendEntries, createLedger, type CoordinateTransformLedger, type LedgerEntry } from '@chainspot/alg/g0/ledger';
import { matchTruth, type AnnotationPoint, type CanonicalTruth, type TruthMatch } from '@chainspot/alg/g0/truth';
import type { RgbaImage } from '@chainspot/alg/detectors/threeFactor';
import type { Placement } from '@chainspot/alg/g0/types';

export interface G0Report {
	readonly shimmed: false;
	readonly filePaths: readonly string[];
	readonly rawImageIds: readonly string[];
	readonly imageId: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly sourceByteLength: number;
	readonly stripChrome: StripChromeResult;
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

export async function canonicalizeInputs(filePaths: readonly string[], truth?: CanonicalTruth): Promise<DecodedInput> {
	if (filePaths.length === 0) throw new Error('LAB intake requires at least one raster input.');
	const assets = await Promise.all(filePaths.map((path) => decodeNodeFile(path)));
	if (assets.length > 1 && !sameDimensions(assets)) throw new Error('LAB intake: AutoStitch requires same-size captures from one device/orientation.');

	const gray = assets.map(toGrayRaster);
	const stripChrome = stripChromeProposal(gray);
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
	const truthMatch = truth ? matchTruth(rawShaForTruth, { imageId: composite.imageId, widthPx: composite.widthPx, heightPx: composite.heightPx, ledger }, truth) : null;
	const left = stripChrome.insets?.left ?? 0;
	const top = stripChrome.insets?.top ?? 0;
	const canonicalTruth = assets.length === 1 ? transformedTruthForSingleSource(truth, composite.imageId, composite.widthPx, composite.heightPx, left, top) : undefined;

	const report: G0Report = {
		shimmed: false,
		filePaths: [...filePaths],
		rawImageIds: assets.map((asset) => asset.imageId),
		imageId: composite.imageId,
		widthPx: composite.widthPx,
		heightPx: composite.heightPx,
		sourceByteLength: assets.reduce((sum, asset) => sum + asset.sourceByteLength, 0),
		stripChrome,
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
	console.log(`  StripChrome:  ${report.stripChrome.source}${report.stripChrome.insets ? ` ${JSON.stringify(report.stripChrome.insets)}` : ' (no chrome detected)'}`);
	console.log(`  AutoStitch:   ${report.autoStitch.sourceCount > 1 ? `${report.autoStitch.sourceCount} tiles${report.autoStitch.hadFallback ? ' (fallback used)' : ''}` : 'single source'}`);
	console.log(`  canonical id: ${report.imageId}`);
	console.log(`  canonical:    ${report.widthPx}x${report.heightPx}px`);
	if (report.truthMatch) {
		const m = report.truthMatch;
		console.log(`  truth match:  ${m.level}${m.matchedAgainst ? ` (${m.matchedAgainst})` : ''}`);
		if (m.warning) console.log(`                WARNING: ${m.warning}`);
	} else console.log('  truth match:  (no truth supplied / no match)');
}
