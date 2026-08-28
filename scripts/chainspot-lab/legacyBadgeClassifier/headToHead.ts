/**
 * OLD (pre-rebuild badgeGlyphClassifier, pure-ts tier) vs CURRENT
 * (packages/alg readBadges/segment/logisticInference) badge-read head-to-head.
 *
 * Truth-free by construction: OLD's vocabulary is a fixed 1..18 template
 * bank (old-stuff/static/resources/chainspot_cv_templates), so a produced
 * label is always a plausible hole number — never itself a truth source.
 * Both classifiers run on the EXACT SAME canonical raster and the EXACT SAME
 * badge body geometry (CURRENT's own `detectBadges` bbox/cx/cy, since that
 * geometry is what both would be handed downstream — this is an OCR-only
 * A/B, not a localization A/B).
 *
 * Usage:
 *   node --import tsx legacyBadgeClassifier/headToHead.ts <course...>
 * Course names are batch dirs under artifacts/sweep/dev72-recovered-default/batches/.
 * With no args, runs the full Dev6 set.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { detectBadges } from '@chainspot/alg/detectors/threeFactor/measure';
import type { RgbaImage } from '@chainspot/alg/detectors/threeFactor/types';
import {
	classifyKnownBadgeBodiesPureTs,
	loadTemplatesFromDisk,
	type BadgeGlyphClassification
} from './oldClassifier';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const TEMPLATES_DIR = join(REPO_ROOT, 'old-stuff', 'static', 'resources', 'chainspot_cv_templates');
// artifacts/sweep is gitignored build output, so this agent's own worktree
// checkout has none. The Dev6 full-sweep canonical renders this harness
// reads (g0.canonical.png, produced by G0 intake — upstream of and
// unaffected by the digit-OCR code this harness compares) already exist in
// the main checkout from an earlier `lab sweep` run; read-only, never
// written to. Override with LEGACY_SWEEP_ROOT to point at a fresher sweep.
const SWEEP_ROOT =
	process.env.LEGACY_SWEEP_ROOT ??
	'/home/user/ChainSpot/artifacts/sweep/dev72-recovered-default/batches';
const OUT_DIR = join(REPO_ROOT, 'artifacts', 'orchestration', 'legacy-badge-classifier');

const DEV6 = ['DashsTrack', 'Lenard', 'TowneLake', 'NorthPark', 'HeritagePark', 'AlexClark'] as const;

interface BadgeRow {
	course: string;
	detId: string;
	cxPx: number;
	cyPx: number;
	bbox: readonly [number, number, number, number];
	currentLabel: string | null;
	currentConfidence: number;
	oldLabel: number | undefined;
	/** Winning candidate even when abstained — shows what OLD would have said
	 * had the margin gate not fired. */
	oldBestLabel: number | undefined;
	oldScore: number;
	oldAbstention: string | null;
	oldMargin: number;
	agree: boolean;
}

function loadCanonical(course: string): RgbaImage {
	const path = join(SWEEP_ROOT, course, 'full', 'renders', 'input', 'g0.canonical.png');
	const png = PNG.sync.read(readFileSync(path));
	return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
}

function runCourse(course: string, templates: ReturnType<typeof loadTemplatesFromDisk>['templates']): BadgeRow[] {
	const image = loadCanonical(course);
	const current = detectBadges(image);
	// BadgeGlyphRaster (widthPx/heightPx) is a different shape than RgbaImage
	// (width/height) — same bytes, renamed keys, so the OLD classifier reads
	// the identical canonical raster CURRENT ran on.
	const raster = { data: image.data, widthPx: image.width, heightPx: image.height };
	const oldBodies = current.map((b) => ({ xPx: b.cxPx, yPx: b.cyPx, widthPx: b.bbox[2], heightPx: b.bbox[3] }));
	const oldResults: readonly BadgeGlyphClassification[] = classifyKnownBadgeBodiesPureTs(raster, templates, oldBodies);
	return current.map((badge, i) => {
		const old = oldResults[i];
		const oldLabelStr = old.label !== undefined ? String(old.label) : null;
		return {
			course,
			detId: badge.detId,
			cxPx: badge.cxPx,
			cyPx: badge.cyPx,
			bbox: badge.bbox,
			currentLabel: badge.label,
			currentConfidence: badge.confidence,
			oldLabel: old.label,
			oldBestLabel: old.bestLabel,
			oldScore: old.bestScore,
			oldAbstention: old.abstention,
			oldMargin: old.ambiguityMargin,
			agree: oldLabelStr === badge.label
		};
	});
}

function fmtOld(row: BadgeRow): string {
	if (row.oldLabel !== undefined) return `${row.oldLabel}@${row.oldScore.toFixed(3)}`;
	return `ABSTAIN(${row.oldAbstention}, best-guess=${row.oldBestLabel}@${row.oldScore.toFixed(3)}, margin=${row.oldMargin.toFixed(3)})`;
}

function main(): void {
	const args = process.argv.slice(2);
	const courses = args.length ? args : [...DEV6];
	const { templates } = loadTemplatesFromDisk(TEMPLATES_DIR);
	console.info(`[legacy-badge-classifier] loaded ${templates.length} hole-number templates from ${TEMPLATES_DIR}`);

	const allRows: BadgeRow[] = [];
	for (const course of courses) {
		const rows = runCourse(course, templates);
		allRows.push(...rows);
		const disagreements = rows.filter((r) => !r.agree);
		console.info(
			`\n=== ${course}: ${rows.length} badges, ${disagreements.length} disagreement(s) with CURRENT ===`
		);
		for (const row of rows) {
			const mark = row.agree ? '  ' : '**';
			console.info(
				`${mark} ${row.detId.padEnd(9)} cur=${(row.currentLabel ?? 'UNREAD').padEnd(6)}@${row.currentConfidence
					.toFixed(3)
					.padEnd(6)} old=${fmtOld(row)}`
			);
		}
	}

	mkdirSync(OUT_DIR, { recursive: true });
	const outPath = join(OUT_DIR, 'head-to-head.json');
	writeFileSync(outPath, JSON.stringify(allRows, null, 2) + '\n');

	const totalDisagreements = allRows.filter((r) => !r.agree).length;
	console.info(
		`\n[legacy-badge-classifier] TOTAL: ${allRows.length} badges across ${courses.length} course(s), ${totalDisagreements} disagreement(s). Wrote ${outPath}`
	);
}

main();
