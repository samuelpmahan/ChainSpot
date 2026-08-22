import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { runBadgeStage } from '../../src/lib/nuthing/badgeStage';
import {
	detectTeeRings,
	matchBasketSprites,
	prepareSpriteTemplate,
	type SpriteTemplate
} from '../../src/lib/nuthing/endpoints';
import { collectMeasuredTeeCandidates } from '../../src/lib/nuthing/teeCandidates';
import { cropRows, detectMapViewport } from '../../src/lib/nuthing/viewport';
import { decodeImageFile } from '../nuthing/decode';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function pct(before: number, after: number): string {
	if (before <= 0) return 'n/a';
	return `${(((after - before) / before) * 100).toFixed(1)}%`;
}

function line(name: string, before: number, after: number): void {
	console.log(`${name}: ${before} -> ${after} (delta ${after - before}, ${pct(before, after)})`);
}

function setPixel(png: PNG, x: number, y: number, rgb: [number, number, number]): void {
	if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
	const i = (y * png.width + x) * 4;
	png.data[i] = rgb[0];
	png.data[i + 1] = rgb[1];
	png.data[i + 2] = rgb[2];
	png.data[i + 3] = 255;
}

function circle(png: PNG, cx: number, cy: number, r: number, rgb: [number, number, number]): void {
	for (let a = 0; a < 360; a++) {
		const t = (a * Math.PI) / 180;
		for (let w = 0; w < 3; w++) {
			setPixel(
				png,
				Math.round(cx + (r + w) * Math.cos(t)),
				Math.round(cy + (r + w) * Math.sin(t)),
				rgb
			);
		}
	}
}

function main(): void {
	const [inputPath, outDirArg] = process.argv.slice(2);
	if (!inputPath || !outDirArg) {
		console.error('Usage: npx tsx scripts/chainspot-lab/gate3.ts IMAGE OUT_DIR');
		process.exit(2);
	}
	const outDir = resolve(outDirArg);
	mkdirSync(outDir, { recursive: true });

	const full = decodeImageFile(resolve(inputPath));
	const viewport = detectMapViewport(full);
	const image = cropRows(full, viewport);
	console.log(
		`Gate 0 canonical: ${full.width}x${full.height} -> ${image.width}x${image.height}; rows [${viewport.top},${viewport.bottom})`
	);

	const stage = runBadgeStage(image);
	console.log(`Gate 1 badges: ${stage.badgeCount}`);

	const spriteTemplate = prepareSpriteTemplate(
		JSON.parse(
			readFileSync(join(repoRoot, 'resources/nuthing-p2/endpoints/basket-sprite.json'), 'utf8')
		) as SpriteTemplate
	);
	const sprites = matchBasketSprites(stage.brightMask, spriteTemplate);
	console.log(
		`Gate 2 basket candidates: ${sprites.length}; strong(score>=0.8)=${sprites.filter((s) => s.score >= 0.8).length}`
	);

	const insideBadgeInterior = (x: number, y: number): boolean =>
		stage.badges.some(
			(b) => Math.abs(x - b.cx) <= b.bboxW / 2 - 7 && Math.abs(y - b.cy) <= b.bboxH / 2 - 7
		);
	const ringsRaw = detectTeeRings(stage.brightMask);
	const rings = ringsRaw.filter((r) => !insideBadgeInterior(r.cx, r.cy));

	const insideBadgePt = (x: number, y: number): boolean =>
		stage.badges.some(
			(b) =>
				x >= b.bboxX - 3 &&
				x <= b.bboxX + b.bboxW + 3 &&
				y >= b.bboxY - 3 &&
				y <= b.bboxY + b.bboxH + 3
		);
	const components = stage.brightComponents
		.filter((c) => !insideBadgePt(c.cx, c.cy))
		.map((c) => ({
			label: c.label,
			cx: c.cx,
			cy: c.cy,
			bboxX: c.bboxX,
			bboxY: c.bboxY,
			bboxW: c.bboxW,
			bboxH: c.bboxH,
			area: c.area,
			fill: c.fill
		}));

	const measured = collectMeasuredTeeCandidates(
		rings,
		components,
		sprites,
		stage.brightMask,
		stage.darkMask,
		stage.brightLabels
	);
	const s = measured.stats;

	console.log('\nGATE 3 MEASUREMENTS');
	console.log(`basket black-outline touch samples: ${s.basketOutlineTouchSamples.join(',')}`);
	console.log(
		`basket outline touch median=${s.basketOutlineTouchMedian.toFixed(1)}; component minimum=ceil(0.2*median)=${s.componentDarkTouchMin}`
	);
	line('rings raw -> badge-clean', ringsRaw.length, rings.length);
	console.log(`ring identity: ${s.ringTeeRects} tee-rect / ${s.diamonds} diamond`);
	line('components input -> dimension', s.componentsInput, s.dimensionSurvivors);
	line('dimension -> area', s.dimensionSurvivors, s.areaSurvivors);
	line('area -> fill', s.areaSurvivors, s.fillSurvivors);
	line('fill -> dark-touch', s.fillSurvivors, s.darkTouchSurvivors);
	console.log(
		`post-touch removals: nearRing=${s.removedNearRing} nearDiamond=${s.removedNearDiamond} nearSprite=${s.removedNearSprite}`
	);
	console.log(`component accepted=${s.componentAccepted}`);
	console.log(
		`FINAL TEE CANDIDATES=${s.totalAccepted} (${s.ringTeeRects} ring + ${s.componentAccepted} component)`
	);

	console.log('\nCANDIDATES');
	measured.points
		.slice()
		.sort((a, b) => a.cy - b.cy || a.cx - b.cx)
		.forEach((p, i) => {
			if (p.tier === 'ring') {
				console.log(
					`T${i + 1} ring x=${p.cx.toFixed(1)} y=${p.cy.toFixed(1)} ` +
						`elong=${p.ring?.elongation.toFixed(3)} ringFrac=${p.ring?.ringFrac.toFixed(3)}`
				);
			} else {
				console.log(
					`T${i + 1} component x=${p.cx.toFixed(1)} y=${p.cy.toFixed(1)} ` +
						`label=${p.componentLabel} darkTouch=${p.darkTouch}`
				);
			}
		});

	const png = new PNG({ width: image.width, height: image.height });
	Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).copy(png.data);
	for (const p of measured.points) {
		circle(
			png,
			Math.round(p.cx),
			Math.round(p.cy),
			10,
			p.tier === 'ring' ? [50, 235, 255] : [255, 70, 220]
		);
	}
	const overlay = join(outDir, 'gate3-tees.png');
	writeFileSync(overlay, PNG.sync.write(png));
	console.log(`overlay -> ${overlay}`);
}

main();
