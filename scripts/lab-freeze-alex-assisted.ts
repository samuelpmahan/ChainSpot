/**
 * One-off freezer for the AlexClark machine-assisted, still-truth-blind
 * endpoint experiment. It consumes only the frozen visual annotation, the
 * canonical crop, and ./lab check outputs. It does not load registered
 * annotations, course truth, evaluation products, or recovered-tee caches.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

type Point = { xPx: number; yPx: number };
type Outcome = 'AGREES' | 'RESOLVES_BLIND_UNCERTAINTY' | 'CONTRADICTS_BLIND' | 'STILL_UNRESOLVED';
type Color = readonly [number, number, number];

interface Hole {
	id: string;
	number: number;
	shots: unknown[];
	corridorBends: unknown[];
	corridorWidthPx: number;
	tee?: Point;
	basket?: Point;
}

interface Annotation {
	schemaVersion: number;
	sourceImage: Record<string, unknown>;
	holes: Hole[];
}

interface BadgeCandidate {
	plate: { center: { x: number; y: number } };
	decodedLabel: string;
	minimumDigitMargin: number | null;
	digits: unknown[];
}

interface BasketCandidate {
	cx: number;
	cy: number;
	tipX: number;
	tipY: number;
	onFrac: number;
	offFrac: number;
	score: number;
}

interface TeeCandidate {
	center: { x: number; y: number };
	tier: 'ring' | 'component';
	ring?: {
		holeArea: number;
		bboxX: number;
		bboxY: number;
		bboxW: number;
		bboxH: number;
		elongation: number;
		angle: number;
		ringFrac: number;
	};
	component?: unknown;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactDir = join(repoRoot, 'lab-artifacts', 'AlexClark');
const evidenceDir = join(artifactDir, 'sol-assisted-v1-evidence');

const blindBadge: Record<number, Point> = {
	1: { xPx: 696, yPx: 1450 }, 2: { xPx: 559, yPx: 1347 }, 3: { xPx: 326, yPx: 1877 },
	4: { xPx: 492, yPx: 2001 }, 5: { xPx: 621, yPx: 1925 }, 6: { xPx: 578, yPx: 1765 },
	7: { xPx: 484, yPx: 1283 }, 8: { xPx: 490, yPx: 714 }, 9: { xPx: 390, yPx: 509 },
	10: { xPx: 413, yPx: 435 }, 11: { xPx: 496, yPx: 386 }, 12: { xPx: 536, yPx: 158 },
	13: { xPx: 821, yPx: 104 }, 14: { xPx: 824, yPx: 199 }, 15: { xPx: 685, yPx: 226 },
	16: { xPx: 648, yPx: 573 }, 17: { xPx: 578, yPx: 711 }, 18: { xPx: 548, yPx: 1041 },
};

const assistedBasket: Record<number, Point> = {
	1: { xPx: 770, yPx: 1322 }, 2: { xPx: 493, yPx: 1394 }, 3: { xPx: 295, yPx: 2008 },
	4: { xPx: 610, yPx: 1953 }, 5: { xPx: 760, yPx: 1905 }, 6: { xPx: 429, yPx: 1586 },
	7: { xPx: 513, yPx: 1170 }, 8: { xPx: 485, yPx: 870 }, 9: { xPx: 353, yPx: 373 },
	10: { xPx: 438, yPx: 561 }, 11: { xPx: 458, yPx: 275 }, 12: { xPx: 607, yPx: 96 },
	13: { xPx: 1015, yPx: 288 }, 14: { xPx: 752, yPx: 106 }, 15: { xPx: 669, yPx: 334 },
	16: { xPx: 523, yPx: 576 }, 17: { xPx: 864, yPx: 795 }, 18: { xPx: 579, yPx: 1193 },
};

const assistedTee: Record<number, Point | undefined> = {
	1: { xPx: 616, yPx: 1595 }, 2: { xPx: 633, yPx: 1288 }, 3: { xPx: 363, yPx: 1743 },
	4: { xPx: 369, yPx: 2058 }, 5: { xPx: 472, yPx: 1889 }, 6: { xPx: 673, yPx: 1848 },
	7: { xPx: 454, yPx: 1405 }, 8: undefined, 9: { xPx: 429, yPx: 657 },
	10: { xPx: 381, yPx: 304 }, 11: { xPx: 542, yPx: 507 }, 12: { xPx: 604, yPx: 436 },
	13: { xPx: 733, yPx: 68 }, 14: { xPx: 910, yPx: 306 }, 15: { xPx: 706, yPx: 109 },
	16: undefined, 17: { xPx: 675, yPx: 700 }, 18: { xPx: 512, yPx: 1020 },
};

const blindUnstoredTee: Record<number, { estimate: Point | null; judgment: string }> = {
	8: { estimate: { xPx: 500, yPx: 570 }, judgment: 'unresolved; no separable elongated glyph' },
	12: { estimate: { xPx: 604, yPx: 437 }, judgment: 'identified visually but omitted because route geometry was incomplete' },
	13: { estimate: { xPx: 734, yPx: 69 }, judgment: 'rejected as a duplicate view of H15 furniture' },
	16: { estimate: { xPx: 620, yPx: 500 }, judgment: 'unresolved; no unused elongated glyph' },
	17: { estimate: { xPx: 675, yPx: 694 }, judgment: 'rejected as square C1/C2 furniture' },
};

const teeOutcomes: Record<number, Outcome> = {
	1: 'AGREES', 2: 'CONTRADICTS_BLIND', 3: 'CONTRADICTS_BLIND', 4: 'CONTRADICTS_BLIND',
	5: 'AGREES', 6: 'AGREES', 7: 'AGREES', 8: 'STILL_UNRESOLVED', 9: 'AGREES',
	10: 'AGREES', 11: 'AGREES', 12: 'RESOLVES_BLIND_UNCERTAINTY',
	13: 'RESOLVES_BLIND_UNCERTAINTY', 14: 'AGREES', 15: 'AGREES',
	16: 'STILL_UNRESOLVED', 17: 'CONTRADICTS_BLIND', 18: 'AGREES',
};

const basketOutcomes: Record<number, Outcome> = {
	1: 'AGREES', 2: 'AGREES', 3: 'AGREES', 4: 'AGREES', 5: 'AGREES', 6: 'AGREES',
	7: 'AGREES', 8: 'AGREES', 9: 'AGREES', 10: 'AGREES', 11: 'AGREES', 12: 'AGREES',
	13: 'RESOLVES_BLIND_UNCERTAINTY', 14: 'AGREES', 15: 'RESOLVES_BLIND_UNCERTAINTY',
	16: 'STILL_UNRESOLVED', 17: 'AGREES', 18: 'AGREES',
};

function sha256(data: Buffer): string {
	return createHash('sha256').update(data).digest('hex');
}

function nearest<T>(items: T[], point: Point, get: (item: T) => { x: number; y: number }): T {
	return items.reduce((best, item) => {
		const p = get(item);
		const b = get(best);
		return Math.hypot(p.x - point.xPx, p.y - point.yPx) < Math.hypot(b.x - point.xPx, b.y - point.yPx) ? item : best;
	});
}

function setPixel(png: PNG, x: number, y: number, color: Color): void {
	x = Math.round(x); y = Math.round(y);
	if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
	const i = (y * png.width + x) * 4;
	[png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]] = [...color, 255];
}

function line(png: PNG, x0: number, y0: number, x1: number, y1: number, color: Color, width = 2): void {
	const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
	for (let i = 0; i <= n; i++) {
		const x = x0 + (x1 - x0) * i / n;
		const y = y0 + (y1 - y0) * i / n;
		for (let dy = -width; dy <= width; dy++) for (let dx = -width; dx <= width; dx++) setPixel(png, x + dx, y + dy, color);
	}
}

function cross(png: PNG, p: Point, color: Color, radius = 9): void {
	line(png, p.xPx - radius, p.yPx, p.xPx + radius, p.yPx, color, 1);
	line(png, p.xPx, p.yPx - radius, p.xPx, p.yPx + radius, color, 1);
}

function rect(png: PNG, x: number, y: number, w: number, h: number, color: Color, width = 2): void {
	line(png, x, y, x + w, y, color, width); line(png, x + w, y, x + w, y + h, color, width);
	line(png, x + w, y + h, x, y + h, color, width); line(png, x, y + h, x, y, color, width);
}

function crop(source: PNG, x: number, y: number, width: number, height: number, scale = 1): PNG {
	const out = new PNG({ width: width * scale, height: height * scale });
	for (let oy = 0; oy < height; oy++) for (let ox = 0; ox < width; ox++) {
		const sx = Math.min(source.width - 1, Math.max(0, x + ox));
		const sy = Math.min(source.height - 1, Math.max(0, y + oy));
		const si = (sy * source.width + sx) * 4;
		for (let yy = 0; yy < scale; yy++) for (let xx = 0; xx < scale; xx++) {
			const di = (((oy * scale + yy) * out.width) + ox * scale + xx) * 4;
			out.data[di] = source.data[si]; out.data[di + 1] = source.data[si + 1];
			out.data[di + 2] = source.data[si + 2]; out.data[di + 3] = source.data[si + 3];
		}
	}
	return out;
}

function downsample(source: PNG, divisor: number): PNG {
	const width = Math.ceil(source.width / divisor);
	const height = Math.ceil(source.height / divisor);
	const out = new PNG({ width, height });
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const sx = Math.min(source.width - 1, x * divisor);
		const sy = Math.min(source.height - 1, y * divisor);
		const si = (sy * source.width + sx) * 4;
		const di = (y * width + x) * 4;
		out.data[di] = source.data[si]; out.data[di + 1] = source.data[si + 1];
		out.data[di + 2] = source.data[si + 2]; out.data[di + 3] = source.data[si + 3];
	}
	return out;
}

function saveOrientation(source: PNG, hole: number, box: { x: number; y: number; w: number; h: number }, focus: Point): void {
	const dir = join(evidenceDir, `H${hole}`);
	mkdirSync(dir, { recursive: true });
	const locator = downsample(source, 4);
	rect(locator, box.x / 4, box.y / 4, box.w / 4, box.h / 4, [255, 225, 0], 1);
	writeFileSync(join(dir, 'course.png'), PNG.sync.write(locator));
	writeFileSync(join(dir, 'hole.png'), PNG.sync.write(crop(source, box.x, box.y, box.w, box.h)));
	writeFileSync(join(dir, 'evidence.png'), PNG.sync.write(crop(source, focus.xPx - 48, focus.yPx - 48, 96, 96, 4)));
}

function main(): void {
	const blindPath = join(artifactDir, 'sol-blind-v1.annotation.json');
	const blindBytes = readFileSync(blindPath);
	const blind = JSON.parse(blindBytes.toString('utf8')) as Annotation;
	const badgeBytes = readFileSync(join(evidenceDir, 'badges.measurements.json'));
	const basketBytes = readFileSync(join(evidenceDir, 'baskets.measurements.json'));
	const teeBytes = readFileSync(join(evidenceDir, 'tees.measurements.json'));
	const badgeMeasurements = JSON.parse(badgeBytes.toString('utf8')) as { candidates: BadgeCandidate[] };
	const basketMeasurements = JSON.parse(basketBytes.toString('utf8')) as { candidates: BasketCandidate[] };
	const teeMeasurements = JSON.parse(teeBytes.toString('utf8')) as { teeCandidates: TeeCandidate[] };

	const assisted: Annotation = JSON.parse(JSON.stringify(blind)) as Annotation;
	for (const hole of assisted.holes) {
		hole.basket = assistedBasket[hole.number];
		const tee = assistedTee[hole.number];
		if (tee) hole.tee = tee;
		else delete hole.tee;
	}
	const annotationPath = join(artifactDir, 'sol-assisted-v1.annotation.json');
	writeFileSync(annotationPath, `${JSON.stringify(assisted, null, 2)}\n`);

	const deltas: unknown[] = [];
	for (const blindHole of blind.holes) {
		const h = blindHole.number;
		const badgeCandidate = badgeMeasurements.candidates.find((c) => c.decodedLabel === String(h));
		const badgeOutcome: Outcome = !badgeCandidate
			? 'STILL_UNRESOLVED'
			: h === 17 ? 'CONTRADICTS_BLIND' : 'AGREES';
		deltas.push({
			hole: h, stage: 'badge', blind: blindBadge[h],
			machineEvidence: badgeCandidate ?? null,
			assisted: badgeCandidate ? { xPx: badgeCandidate.plate.center.x, yPx: badgeCandidate.plate.center.y } : blindBadge[h],
			outcome: badgeOutcome,
			why: h === 17
				? 'Decoded plate 17 is centered about 76 px below the blind visual coordinate; the plate component geometry caused the correction.'
				: badgeCandidate ? 'Decoded plate geometry reproduces the same visible badge.' : 'No badge-family candidate was produced; visual-only judgment retained without machine confirmation.',
		});

		const basketCandidate = nearest(basketMeasurements.candidates, assistedBasket[h], (c) => ({ x: c.tipX, y: c.tipY }));
		deltas.push({
			hole: h, stage: 'basket', blind: blindHole.basket,
			machineEvidence: basketCandidate,
			assisted: assistedBasket[h], outcome: basketOutcomes[h],
			why: h === 13
				? 'Exact sprite match fixes the pole tip; separate H13/H14/H15 tee inventory removes the duplicate-tee explanation and supports the retained H13 ownership inference.'
				: h === 15 ? 'Near-collinearity of measured H15 tee, badge plate, and sprite resolves the previously weak ownership.'
				: h === 16 ? 'Sprite identity and pole tip are strong, but no tee candidate exists to provide independent ownership evidence.'
				: 'Matched sprite identity agrees; the pole-tip coordinate replaces visual estimation with the renderer-defined template offset.',
		});

		const blindTee = blindHole.tee ?? blindUnstoredTee[h] ?? null;
		const assistedPoint = assistedTee[h];
		const teeCandidate = assistedPoint
			? nearest(teeMeasurements.teeCandidates, assistedPoint, (c) => ({ x: c.center.x, y: c.center.y }))
			: null;
		deltas.push({
			hole: h, stage: 'tee', blind: blindTee,
			machineEvidence: teeCandidate,
			assisted: assistedPoint ?? null, outcome: teeOutcomes[h],
			why: h === 8 || h === 16
				? 'No ring-tier or defensible component-tier candidate separates from nearby basket/furniture pixels; uncertainty remains data.'
				: h === 13 ? 'A distinct enclosed elongated ring at (732.79,67.71) is spatially separate from H15 at (705.89,108.98); this directly defeats the blind duplicate-view hypothesis.'
				: h === 17 ? 'The visually square-looking object has measured hole elongation 1.547, ring fraction 0.754, and hole area 206 px; accepted as a tee despite contradicting the blind classification.'
				: h === 12 ? 'Ring geometry independently reproduces the visually identified tee; endpoint storage is no longer coupled to unresolved bend geometry.'
				: teeOutcomes[h] === 'CONTRADICTS_BLIND' ? 'Measured glyph center lies outside the frozen visual uncertainty interval; component/ring geometry supports the corrected center.'
				: 'Ring/component identity and center agree with the blind visual judgment.',
		});
	}
	const deltaPath = join(artifactDir, 'sol-assisted-v1-delta.json');
	writeFileSync(deltaPath, `${JSON.stringify({ schemaVersion: 1, blindState: '47fd2e97cbaaf40e6288693d716fa0dd3df73245', assistedState: 'pre-commit', records: deltas }, null, 2)}\n`);

	const source = PNG.sync.read(readFileSync(join(artifactDir, 'AlexClark-cropped.png')));
	const overlay = PNG.sync.read(PNG.sync.write(source));
	for (let h = 1; h <= 18; h++) {
		cross(overlay, assistedBasket[h], [255, 225, 0], 9);
		const tee = assistedTee[h];
		if (tee) cross(overlay, tee, [60, 255, 100], 9);
		const badgeCandidate = badgeMeasurements.candidates.find((c) => c.decodedLabel === String(h));
		if (badgeCandidate) cross(overlay, { xPx: badgeCandidate.plate.center.x, yPx: badgeCandidate.plate.center.y }, [0, 240, 255], 5);
	}
	writeFileSync(join(artifactDir, 'sol-assisted-v1-overlay.png'), PNG.sync.write(overlay));

	saveOrientation(source, 13, { x: 620, y: 0, w: 480, h: 360 }, { xPx: 733, yPx: 68 });
	saveOrientation(source, 17, { x: 500, y: 610, w: 430, h: 320 }, { xPx: 675, yPx: 700 });
	saveOrientation(source, 8, { x: 350, y: 500, w: 300, h: 430 }, { xPx: 455, yPx: 865 });
	saveOrientation(source, 16, { x: 450, y: 390, w: 360, h: 330 }, { xPx: 620, yPx: 500 });
	saveOrientation(source, 2, { x: 430, y: 1120, w: 360, h: 360 }, { xPx: 633, yPx: 1288 });

	const notes = `# AlexClark Sol machine-assisted blind endpoints v1

## Boundary and vocabulary

- **PIXEL OBSERVATION**: visible raster structure, without assigning semantic identity.
- **MEASUREMENT**: a reproduced output of the existing detector implementation.
- **INFERENCE**: Sol's assignment of a measured candidate to a hole.
- **HYPOTHESIS**: an explanation not established by the current pixels or measurements.
- **ORACLE OBSERVATION**: none; Alex truth remained sealed.
- Canonical frame: 1290 x 2082 production-auto-cropped raster; origin top-left, +x right, +y down.
- Geometry boundary: endpoints only. Existing corridorBends and corridorWidthPx fields were copied unchanged from state A and were not re-evaluated.

## BADGES

- MEASUREMENT: 16 badge-family plates; decoded labels 1-4 and 6-17. Every produced label had minimum per-digit probability margin >= 0.9787.
- AGREES: 15. CONTRADICTS_BLIND: H17 coordinate. STILL_UNRESOLVED by machine: H5 and H18, whose visual judgments are retained.
- H17 changed from visual center (578,711) to measured plate center (574.27,787.53). This is a coordinate correction, not an Oracle ruling.
- LIMIT: the logistic model and segmentation were developed from labeled dev data. Runtime inputs are truth-free, but the model is not provenance-clean enough to make its label an Oracle-like fact.

## BASKETS

- MEASUREMENT: 20 sprite matches. Eighteen correspond to visible course sprites; two low-score matches terminate at the bottom boundary and were rejected as boundary artifacts.
- Useful fields: template bbox, onFrac, offFrac, score, and the fixed pole-tip transform tip=(center.x, bbox.bottom+4).
- All 18 blind sprite identities were reproduced. Exact pole tips replaced visual center estimation.
- RESOLVES_BLIND_UNCERTAINTY: H13 and H15 ownership. H13 resolution is an INFERENCE from distinct H13/H14/H15 tee inventory plus the sprite inventory, not a basket-detector ownership output.
- STILL_UNRESOLVED: H16 ownership. The sprite is real (score 0.9747), but the basket detector supplies no hole label and no independent H16 tee was measured.
- LIMIT: the committed basket template metadata says 66 observations, and source comments describe truth-guided dev contact-sheet derivation. Runtime matching is truth-free; historical calibration is not fully clean-room.

## TEES

- MEASUREMENT: 25 tee candidates: ring and component tiers. Candidate count is not hole count; several component candidates are basket residues or screen furniture.
- AGREES: H1, H5-H7, H9-H11, H14-H15, H18 (10).
- CONTRADICTS_BLIND: H2, H3, H4 center estimates; H17 identity (4).
- RESOLVES_BLIND_UNCERTAINTY: H12 and H13 (2).
- STILL_UNRESOLVED: H8 and H16 (2).
- Assisted annotation stores 16 tees. H12 is now stored as an endpoint even though its route geometry remains unresolved; endpoint identity and bend geometry are separate questions.

## Causal cases

- H13 tee — BLIND: (734,69) rejected as a duplicate view of H15. MEASUREMENT: ring center (732.79,67.71), elongation 1.661, ringFrac 0.603, area 77; H15 is a separate ring at (705.89,108.98), elongation 1.587, ringFrac 0.885, area 206. ASSISTED INFERENCE: accept H13 tee at (733,68).
- H17 tee — BLIND: (675,694) rejected as square C1/C2 furniture. MEASUREMENT: center (675.07,700.05), elongation 1.547, ringFrac 0.754, area 206, angle 2.450 rad. ASSISTED INFERENCE: accept H17 tee at (675,700). Difficulty: at course scale the bright outer glyph looks square; enclosed-hole covariance preserves the elongation hidden by the outline.
- H8 tee — component candidates near (446.47,862.80) and (459.18,866.66) overlap basket pixels and lack enclosing-ring evidence. ASSISTED: unresolved.
- H16 tee — no ring/component candidate near the visual search region. ASSISTED: unresolved.
- H2/H3/H4 — detector identity is useful mainly as a center measurement: corrections of about 50, 19, and 20 px respectively exceed the frozen visual uncertainty.

## Instrument quality

- Helpful: enclosing-hole elongation, ring fraction, ring/component tier, exact sprite template offset, and explicit on/off fractions.
- Persuasive-looking but insufficient: decoded badge label without acknowledging labeled-model provenance; basket score as if it assigned ownership; component-tier tee candidates without enclosing-ring evidence.
- Missing: truth-independent recovered-tee evidence, hole ownership scores for baskets/tees, and a negative-evidence record explaining rejected component candidates.
- Recovered tier was not used. The available recovery probe consumes truth basket coordinates and hard-coded course answers; its Alex outputs were refused.
`;
	writeFileSync(join(artifactDir, 'sol-assisted-v1-notes.md'), notes);

	const seal = `# AlexClark assisted blind-pass seal

State A commit: \`47fd2e97cbaaf40e6288693d716fa0dd3df73245\`.

## Inputs admitted

- Frozen \`sol-blind-v1.annotation.json\` and blind notes.
- Canonical \`AlexClark-cropped.png\`.
- Truth-free outputs from \`./lab check badges AlexClark\`, \`baskets\`, and \`tees\`.
- Existing runtime implementations named in each measurement JSON.

## Inputs refused

- AlexClark source annotation/truth and registered annotation resources.
- Alex evaluation reports, pair-matrix/evaluation output, GT-derived caches, endpoint pools produced by truth-loading scripts, and prior evidence-store answers.
- \`scripts/cv-probes/hole_path_tee_recovery.py\` output and recovered-tee resources: the inspected source consumes truth basket coordinates and contains hard-coded course answers.

## Integrity

- Blind annotation SHA-256: \`${sha256(blindBytes)}\`.
- Badge measurement SHA-256: \`${sha256(badgeBytes)}\`.
- Basket measurement SHA-256: \`${sha256(basketBytes)}\`.
- Tee measurement SHA-256: \`${sha256(teeBytes)}\`.
- Oracle observations: none.
- Frozen does not mean Oracle-approved. These outputs are structured so a future \`--gate\` can compare them to a separately approved state.
`;
	writeFileSync(join(artifactDir, 'sol-assisted-v1-seal.md'), seal);

	console.log(`annotation: ${annotationPath}`);
	console.log(`delta: ${deltaPath}`);
	console.log(`overlay: ${join(artifactDir, 'sol-assisted-v1-overlay.png')}`);
	console.log(`notes: ${join(artifactDir, 'sol-assisted-v1-notes.md')}`);
	console.log(`seal: ${join(artifactDir, 'sol-assisted-v1-seal.md')}`);
}

main();
