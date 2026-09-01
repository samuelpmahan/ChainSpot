declare const require: (id: string) => any;
const { mkdirSync, writeFileSync } = require('node:fs') as {
	mkdirSync(path: string, options?: { recursive?: boolean }): void;
	writeFileSync(path: string, data: string): void;
};

type Kind = 'badge' | 'basket';
type Polarity = 'bright' | 'dark';
type Pt = readonly [number, number];

interface Ref {
	polarity: Polarity;
	label: number;
}

interface Assembly {
	components: readonly Ref[];
}

interface Fixture {
	kind: Kind;
	width: number;
	height: number;
	scene: Set<number>;
	byRef: Map<string, Set<number>>;
	assembly: Assembly;
}

interface ObjectModel {
	kind: Kind;
	assembly: Assembly;
	bright: readonly Ref[];
	dark: readonly Ref[];
	aa: ReadonlySet<number>;
}

const key = (ref: Ref) => `${ref.polarity}:${ref.label}`;
const indexOf = (x: number, y: number, width: number) => y * width + x;

function compose(kind: Kind, assembly: Assembly): ObjectModel {
	return {
		kind,
		assembly,
		bright: assembly.components.filter((part) => part.polarity === 'bright'),
		dark: assembly.components.filter((part) => part.polarity === 'dark'),
		aa: new Set()
	};
}

function bwPixels(object: ObjectModel, fixture: Fixture): Set<number> {
	const out = new Set<number>();
	for (const ref of [...object.bright, ...object.dark]) {
		for (const pixel of fixture.byRef.get(key(ref)) ?? []) out.add(pixel);
	}
	return out;
}

function ownedPixels(object: ObjectModel, fixture: Fixture): Set<number> {
	const out = bwPixels(object, fixture);
	for (const pixel of object.aa) out.add(pixel);
	return out;
}

function subtract(scene: Set<number>, owned: Set<number>): Set<number> {
	return new Set([...scene].filter((pixel) => !owned.has(pixel)));
}

function neighbors(pixel: number, width: number, height: number): number[] {
	const x = pixel % width;
	const y = Math.floor(pixel / width);
	const out: number[] = [];
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			const xx = x + dx;
			const yy = y + dy;
			if (xx >= 0 && xx < width && yy >= 0 && yy < height) {
				out.push(indexOf(xx, yy, width));
			}
		}
	}
	return out;
}

/** Naive floor: any still-unowned support immediately adjacent to hardened B+W ownership. */
function naiveAaCandidates(object: ObjectModel, fixture: Fixture): Set<number> {
	const base = bwPixels(object, fixture);
	const residue = subtract(fixture.scene, base);
	const aa = new Set<number>();
	for (const pixel of base) {
		for (const neighbor of neighbors(pixel, fixture.width, fixture.height)) {
			if (residue.has(neighbor)) aa.add(neighbor);
		}
	}
	return aa;
}

/** Feature OFF returns the exact same object; Feature ON only adds support. */
function refineAa(object: ObjectModel, aa: ReadonlySet<number>, enabled: boolean): ObjectModel {
	return enabled ? { ...object, aa: new Set(aa) } : object;
}

function fixture(kind: Kind): Fixture {
	const width = 18;
	const height = 12;
	const scene = new Set<number>();
	const byRef = new Map<string, Set<number>>();
	const add = (ref: Ref, points: Pt[]) => {
		const set = new Set<number>();
		for (const [x, y] of points) {
			const pixel = indexOf(x, y, width);
			set.add(pixel);
			scene.add(pixel);
		}
		byRef.set(key(ref), set);
	};
	const rect = (x0: number, y0: number, w: number, h: number): Pt[] => {
		const points: Pt[] = [];
		for (let y = y0; y < y0 + h; y++) {
			for (let x = x0; x < x0 + w; x++) points.push([x, y]);
		}
		return points;
	};
	const ring = (x0: number, y0: number, w: number, h: number): Pt[] =>
		rect(x0, y0, w, h).filter(
			([x, y]) => x === x0 || x === x0 + w - 1 || y === y0 || y === y0 + h - 1
		);

	const refs: Ref[] =
		kind === 'badge'
			? [
					{ polarity: 'bright', label: 1 },
					{ polarity: 'dark', label: 2 },
					{ polarity: 'bright', label: 3 }
				]
			: [
					{ polarity: 'bright', label: 10 },
					{ polarity: 'dark', label: 11 }
				];

	if (kind === 'badge') {
		add(refs[0], ring(5, 3, 8, 6));
		add(refs[1], rect(6, 4, 6, 4));
		add(refs[2], rect(8, 5, 2, 2));
	} else {
		add(refs[0], rect(7, 3, 4, 6));
		add(refs[1], ring(6, 2, 6, 8));
	}

	// Synthetic AA halo around B+W ownership, plus a distant distractor that must survive.
	const base = new Set<number>();
	for (const ref of refs) for (const pixel of byRef.get(key(ref)) ?? []) base.add(pixel);
	for (const pixel of [...base]) {
		for (const neighbor of neighbors(pixel, width, height)) {
			if (!base.has(neighbor)) scene.add(neighbor);
		}
	}
	for (const [x, y] of [[1, 1], [1, 2], [2, 1]] as Pt[]) scene.add(indexOf(x, y, width));

	return { kind, width, height, scene, byRef, assembly: { components: refs } };
}

function svgPanel(
	set: Set<number>,
	width: number,
	height: number,
	xOffset: number,
	yOffset: number,
	label: string
): string {
	const cell = 8;
	let svg = `<g transform="translate(${xOffset},${yOffset})"><text x="0" y="-5" font-size="11">${label}</text><rect width="${width * cell}" height="${height * cell}" fill="white" stroke="#999"/>`;
	for (const pixel of set) {
		const x = pixel % width;
		const y = Math.floor(pixel / width);
		svg += `<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="black"/>`;
	}
	return `${svg}</g>`;
}

function runOne(kind: Kind) {
	const input = fixture(kind);
	const bw = compose(kind, input.assembly);
	const off = refineAa(bw, new Set(), false);
	const candidates = naiveAaCandidates(bw, input);
	const on = refineAa(bw, candidates, true);
	const bwOwned = ownedPixels(bw, input);
	const offOwned = ownedPixels(off, input);
	const onOwned = ownedPixels(on, input);
	const before = subtract(input.scene, bwOwned);
	const after = subtract(input.scene, onOwned);
	const distractors = [
		indexOf(1, 1, input.width),
		indexOf(1, 2, input.width),
		indexOf(2, 1, input.width)
	];
	const parity = {
		offIdentity: off === bw,
		offOwned: [...offOwned].join(',') === [...bwOwned].join(','),
		bwSubset: [...bwOwned].every((pixel) => onOwned.has(pixel)),
		residueSubset: [...after].every((pixel) => before.has(pixel)),
		distractorPreserved: distractors.every((pixel) => after.has(pixel))
	};
	if (!Object.values(parity).every(Boolean)) {
		throw new Error(`${kind} parity failed ${JSON.stringify(parity)}`);
	}
	return {
		input,
		candidates,
		bwOwned,
		before,
		after,
		receipt: {
			kind,
			ticks: [
				'compose.bw',
				'subtract.bw',
				'measure.naive-aa',
				'feature.aa:on',
				'subtract.refined'
			],
			featureRuns: { off: { aa: false }, on: { aa: true } },
			bwOwned: bwOwned.size,
			aaCandidates: candidates.size,
			residueBefore: before.size,
			residueAfter: after.size,
			parity
		}
	};
}

const rows = [runOne('badge'), runOne('basket')];
const outDir = 'artifacts/prototypes/object-refinement';
mkdirSync(outDir, { recursive: true });
const cellWidth = 18 * 8;
const gap = 24;
const rowHeight = 12 * 8 + 34;
let body = '';
for (let row = 0; row < rows.length; row++) {
	const result = rows[row];
	const y = 30 + row * rowHeight;
	const panels = [
		['B+W owned', result.bwOwned],
		['B+W residue', result.before],
		['naive AA', result.candidates],
		['refined residue', result.after]
	] as const;
	for (let panel = 0; panel < panels.length; panel++) {
		const [label, pixels] = panels[panel];
		body += svgPanel(
			pixels,
			result.input.width,
			result.input.height,
			20 + panel * (cellWidth + gap),
			y,
			panel === 0 ? `${result.input.kind}: ${label}` : label
		);
	}
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${20 + 4 * (cellWidth + gap)}" height="${30 + 2 * rowHeight}" viewBox="0 0 ${20 + 4 * (cellWidth + gap)} ${30 + 2 * rowHeight}"><rect width="100%" height="100%" fill="#f5f5f5"/><text x="20" y="18" font-family="sans-serif" font-size="14">Object refinement smoke: B+W → subtraction → naive AA → refined subtraction</text><g font-family="sans-serif">${body}</g></svg>`;
writeFileSync(`${outDir}/receipt.svg`, svg);
writeFileSync(`${outDir}/receipt.json`, JSON.stringify(rows.map((row) => row.receipt), null, 2));
console.log(JSON.stringify(rows.map((row) => row.receipt), null, 2));
