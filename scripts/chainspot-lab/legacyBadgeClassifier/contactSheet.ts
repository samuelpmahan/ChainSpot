/**
 * Extracts padded, upscaled crops of the disputed badges (OLD-vs-CURRENT
 * disagreements, prioritizing the mission's named failures) from the Dev6
 * canonical renders, and tiles them into one labeled contact sheet via
 * scope/render.ts's makeLabeledContactSheet (reused, not reimplemented).
 *
 * Reads artifacts/orchestration/legacy-badge-classifier/head-to-head.json
 * (written by headToHead.ts) for the disagreement rows.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { makeLabeledContactSheet, type LabeledSheetEntry } from '../scope/render';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const SWEEP_ROOT =
	process.env.LEGACY_SWEEP_ROOT ??
	'/home/user/ChainSpot/artifacts/sweep/dev72-recovered-default/batches';
const OUT_DIR = join(REPO_ROOT, 'artifacts', 'orchestration', 'legacy-badge-classifier');
const CROPS_DIR = join(OUT_DIR, 'crops');

interface Row {
	course: string;
	detId: string;
	bbox: readonly [number, number, number, number];
	currentLabel: string | null;
	currentConfidence: number;
	oldLabel?: number;
	oldBestLabel?: number;
	oldScore: number;
	oldAbstention: string | null;
	oldMargin: number;
	agree: boolean;
}

// Mission-named failing badges, in report order. HeritagePark's dup-17 pair
// is badge-12 (spurious low-confidence "17") + badge-17 (the real "17");
// dup-12 pair is badge-7 (real "12") + badge-9 (spurious low-confidence
// "12"). All four plus the two headline AlexClark/NorthPark garbage reads
// are included so the sheet shows both halves of each disputed pair.
const WANTED: readonly { course: string; detId: string }[] = [
	{ course: 'AlexClark', detId: 'badge-10' },
	{ course: 'AlexClark', detId: 'badge-16' },
	{ course: 'NorthPark', detId: 'badge-2' },
	{ course: 'HeritagePark', detId: 'badge-7' },
	{ course: 'HeritagePark', detId: 'badge-9' },
	{ course: 'HeritagePark', detId: 'badge-12' },
	{ course: 'HeritagePark', detId: 'badge-17' },
	{ course: 'HeritagePark', detId: 'badge-14' }
];

function loadCanonicalPng(course: string): PNG {
	const path = join(SWEEP_ROOT, course, 'full', 'renders', 'input', 'g0.canonical.png');
	return PNG.sync.read(readFileSync(path));
}

function cropUpscaled(png: PNG, bbox: readonly [number, number, number, number], padPx: number, scale: number): PNG {
	const [bx, by, bw, bh] = bbox;
	const x0 = Math.max(0, Math.floor(bx - padPx));
	const y0 = Math.max(0, Math.floor(by - padPx));
	const x1 = Math.min(png.width, Math.ceil(bx + bw + padPx));
	const y1 = Math.min(png.height, Math.ceil(by + bh + padPx));
	const w = x1 - x0;
	const h = y1 - y0;
	const out = new PNG({ width: w * scale, height: h * scale });
	for (let y = 0; y < h * scale; y++) {
		const sy = y0 + Math.floor(y / scale);
		for (let x = 0; x < w * scale; x++) {
			const sx = x0 + Math.floor(x / scale);
			const si = (sy * png.width + sx) * 4;
			const di = (y * w * scale + x) * 4;
			out.data[di] = png.data[si];
			out.data[di + 1] = png.data[si + 1];
			out.data[di + 2] = png.data[si + 2];
			out.data[di + 3] = 255;
		}
	}
	return out;
}

function main(): void {
	const rows: Row[] = JSON.parse(readFileSync(join(OUT_DIR, 'head-to-head.json'), 'utf8'));
	mkdirSync(CROPS_DIR, { recursive: true });

	const entries: LabeledSheetEntry[] = [];
	for (const want of WANTED) {
		const row = rows.find((r) => r.course === want.course && r.detId === want.detId);
		if (!row) {
			console.warn(`[contact-sheet] no row for ${want.course}/${want.detId} — skipping`);
			continue;
		}
		const png = loadCanonicalPng(row.course);
		const crop = cropUpscaled(png, row.bbox, 10, 6);
		const fileName = `${row.course}-${row.detId}.png`;
		const filePath = join(CROPS_DIR, fileName);
		writeFileSync(filePath, PNG.sync.write(crop));
		const oldStr =
			row.oldLabel !== undefined
				? `${row.oldLabel}@${row.oldScore.toFixed(2)}`
				: `ABST->${row.oldBestLabel}@${row.oldScore.toFixed(2)}`;
		const label = `${row.course} ${row.detId} cur=${row.currentLabel ?? 'UNREAD'}@${row.currentConfidence.toFixed(2)} old=${oldStr}`;
		entries.push({ path: filePath, label });
		console.info(`[contact-sheet] wrote ${filePath}`);
	}

	const outputPath = join(OUT_DIR, 'disputed-badges-contact-sheet.png');
	makeLabeledContactSheet(entries, outputPath);
	console.info(`[contact-sheet] wrote ${outputPath} (${entries.length} tiles)`);
}

main();
