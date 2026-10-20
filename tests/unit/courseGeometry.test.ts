import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createImageAsset, createProjectState } from '../../src/lib/domain/project';
import {
	COURSE_GEOMETRY_FORMAT,
	COURSE_GEOMETRY_VERSION,
	needsReview,
	parseCourseGeometry,
	scaleFromC1Radius
} from '../../src/lib/import/courseGeometry';
import { parseProjectDocument, serializeProjectState } from '../../src/lib/projectSchema';
import { planHoleGraphic } from '../../src/lib/holeGraphics';

/**
 * The toolkit's golden export (chainspot-toolkit ports/export/fixtures/golden.course-geometry.json, produced by
 * `node ports/export/run.mjs --specimen golden`), copied byte for byte. Both repos pin the same sha256; a new file is a new pin
 * in both.
 */
const FIXTURE_PATH = new URL('../fixtures/course-geometry/golden.course-geometry.json', import.meta.url);
const FIXTURE_SHA256 = 'e81cd32fff3e24d690a185457da5f47e41a2f6db766e949cbb6cc9e22d7ffc9b';
const SOURCE_SHA256 = 'e6616738640eee1d05d8cc2b59dd657f24b4a5a01dc2f68571b7e44c6f372b8a';
const text = readFileSync(FIXTURE_PATH, 'utf8');

function loaded() {
	const result = parseCourseGeometry(text);
	if (!result.ok) throw new Error(`fixture must parse: ${result.error.code} ${result.error.message}`);
	return result;
}

describe('parseCourseGeometry: the toolkit golden export', () => {
	it('is the pinned fixture', () => {
		expect(createHash('sha256').update(readFileSync(FIXTURE_PATH)).digest('hex')).toBe(FIXTURE_SHA256);
	});

	it('loads into a ProjectState: 18 holes and 18 number badges against the source screenshot', () => {
		const { state, geometry } = loaded();
		expect(geometry.format).toBe(COURSE_GEOMETRY_FORMAT);
		expect(geometry.version).toBe(COURSE_GEOMETRY_VERSION);
		expect(geometry.source).toMatchObject({ sha256: SOURCE_SHA256, widthPx: 1290, heightPx: 2091, frame: 'original-upload' });
		expect(state.images).toHaveLength(1);
		expect(state.images[0]).toMatchObject({ role: 'source-overview', widthPx: 1290, heightPx: 2091, sha256: SOURCE_SHA256 });
		expect(state.holes.map((hole) => hole.number)).toEqual(Array.from({ length: 18 }, (_, index) => index + 1));
		expect(state.numberBadges).toHaveLength(18);
	});

	it('carries tee, basket, bends and one course corridor width on every hole, with no shots', () => {
		const { state } = loaded();
		for (const hole of state.holes) {
			expect(hole.tee).toBeDefined();
			expect(hole.basket).toBeDefined();
			expect(hole.shots).toEqual([]);
			expect(hole.corridorWidthPx).toBe(41.62);
			expect(Object.keys(hole).sort()).toEqual(['basket', 'corridorBends', 'corridorWidthPx', 'id', 'number', 'shots', 'tee']);
		}
		const bends = state.holes.map((hole) => hole.corridorBends.length);
		expect(bends).toEqual([1, 1, 0, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 2]);
	});

	it('holes and badges are ProjectState v7 exactly: they survive the strict reader as a saved project', () => {
		const { state } = loaded();
		const target = createImageAsset({ id: 'target', role: 'target-basemap', fileName: 'clean.png', mimeType: 'image/png', widthPx: 100, heightPx: 100 });
		const saved = serializeProjectState({ ...state, images: [...state.images, target] });
		const reread = parseProjectDocument(JSON.parse(JSON.stringify(saved)));
		expect(reread.ok).toBe(true);
		if (reread.ok) {
			expect(reread.state.holes).toEqual(state.holes);
			expect(reread.state.numberBadges).toEqual(state.numberBadges);
		}
	});

	it('keeps what the CV is unsure of outside the holes: evidence per hole, none inside AnnotatedHole or the badges', () => {
		const { geometry, state, needsReview: flagged } = loaded();
		expect(geometry.evidence.map((e) => e.holeId)).toEqual(state.holes.map((hole) => hole.id));
		expect(geometry.evidence.filter((e) => e.status === 'resolved')).toHaveLength(9);
		expect(geometry.evidence.filter((e) => e.status === 'straight')).toHaveLength(9);
		for (const badge of state.numberBadges) expect(Object.keys(badge).sort()).toEqual(['confidence', 'number', 'xPx', 'yPx']);
		// golden has no hole the hallway sensor leaves unconfirmed
		expect(flagged).toEqual([]);
	});

	it('plans a hole graphic from a loaded hole with the product renderer (identity transform onto the screenshot)', () => {
		const { state } = loaded();
		const identity = { model: 'similarity', coefficients: [1, 0, 0, 1, 0, 0], isInvertible: true, determinant: 1, orientation: 1, majorAxisScale: 1, minorAxisScale: 1, anisotropy: 1, shear: 0 } as const;
		const plan = planHoleGraphic(state.holes[0], identity, 1290, 2091);
		expect(plan?.centerline).toHaveLength(3);
		expect(plan?.corridorBand).not.toBeNull();
	});
});

describe('parseCourseGeometry: a project already holding the screenshot', () => {
	function projectWith(overrides: Partial<{ sha256: string | null; widthPx: number; heightPx: number }> = {}) {
		const project = createProjectState({ name: 'mine' });
		return {
			...project,
			images: [createImageAsset({ id: 'mine', role: 'source-overview', fileName: 'IMG_5641.jpg', mimeType: 'image/jpeg', widthPx: 1290, heightPx: 2091, sha256: SOURCE_SHA256, ...overrides })]
		};
	}

	it('loads the geometry into a copy of the project, keeping its image and identity', () => {
		const project = projectWith();
		const result = parseCourseGeometry(text, { project });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.project).toEqual(project.project);
		expect(result.state.images).toEqual(project.images);
		expect(result.state.holes).toHaveLength(18);
		expect(project.holes).toEqual([]);
		expect(result.notices).toEqual([]);
	});

	it('a different screenshot is a visible message, not a throw', () => {
		const result = parseCourseGeometry(text, { project: projectWith({ sha256: 'b'.repeat(64) }) });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('source.sha256-mismatch');
			expect(result.error.message).toContain('different screenshot');
		}
	});

	it('a screenshot of another size cannot take the geometry', () => {
		const result = parseCourseGeometry(text, { project: projectWith({ widthPx: 1179, heightPx: 2556 }) });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('source.size-mismatch');
	});

	it('a project image with no sha256 loads, with a notice that it was not verified', () => {
		const result = parseCourseGeometry(text, { project: projectWith({ sha256: null }) });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.notices.map((notice) => notice.code)).toEqual(['source.sha256-unverified']);
	});
});

describe('parseCourseGeometry: bad files are results', () => {
	const edit = (change: (doc: Record<string, any>) => void) => {
		const doc = JSON.parse(text);
		change(doc);
		return parseCourseGeometry(JSON.stringify(doc));
	};
	const code = (result: ReturnType<typeof parseCourseGeometry>) => (result.ok ? 'ok' : result.error.code);

	it('reports malformed JSON, another format and an unsupported version', () => {
		expect(code(parseCourseGeometry('{nope'))).toBe('malformed-json');
		expect(code(edit((doc) => (doc.format = 'something.else')))).toBe('format.unknown');
		expect(code(edit((doc) => (doc.version = 2)))).toBe('version.unsupported');
	});

	it('reports a hole outside the source frame through the strict reader', () => {
		const result = edit((doc) => (doc.holes[0].tee = { xPx: 5000, yPx: 10 }));
		expect(code(result)).toBe('geometry.invalid');
		if (!result.ok) expect(result.error.schemaError?.code).toBe('coordinate.out-of-bounds');
	});

	it('reports a duplicated hole number and a bad confidence', () => {
		expect(code(edit((doc) => (doc.holes[1].number = 1)))).toBe('geometry.invalid');
		expect(code(edit((doc) => (doc.numberBadges[0].confidence = 2)))).toBe('geometry.invalid');
	});

	it('reports a malformed source, evidence for an unknown hole, and a bad candidate', () => {
		expect(code(edit((doc) => (doc.source.sha256 = 'xyz')))).toBe('structure.invalid');
		expect(code(edit((doc) => (doc.evidence[0].holeId = 'hole-99')))).toBe('structure.invalid');
		expect(code(edit((doc) => (doc.candidates = [{ label: 'Basket ca', xPx: 1, yPx: 1, kind: 'flag' }])))).toBe('structure.invalid');
	});
});

describe('needsReview', () => {
	const base = { holeId: 'hole-1', reasons: [] };
	it('flags partial and unresolved holes, and any route the sensor did not confirm', () => {
		expect(needsReview({ ...base, status: 'resolved', confidence: { level: 'confirmed' } })).toBe(false);
		expect(needsReview({ ...base, status: 'straight', confidence: { level: 'confirmed' } })).toBe(false);
		expect(needsReview({ ...base, status: 'partial', confidence: { level: 'unconfirmed' } })).toBe(true);
		expect(needsReview({ ...base, status: 'unresolved', confidence: { level: 'noReading' } })).toBe(true);
		expect(needsReview({ ...base, status: 'resolved', confidence: { level: 'unconfirmed' } })).toBe(true);
	});
});

describe('parseCourseGeometry: the C1 ground scale (10 m = rC1 px)', () => {
	const withScale = (scale: unknown) => JSON.stringify({ ...JSON.parse(text), scale });

	it('is absent from the golden fixture, which predates it', () => {
		expect(loaded().geometry.scale).toBeUndefined();
	});

	it('reads a consistent scale: golden rC1 44.5 px is 10 / 44.5 m/px', () => {
		const result = parseCourseGeometry(withScale({ rC1Px: 44.5, metresPerPx: 0.224719, feetPerPx: 0.737267, rule: 'C1 = 10 m' }));
		if (!result.ok) throw new Error(result.error.message);
		expect(result.geometry.scale).toEqual({ rC1Px: 44.5, metresPerPx: 0.224719, feetPerPx: 0.737267, rule: 'C1 = 10 m' });
		expect(scaleFromC1Radius(44.5).feetPerPx).toBeCloseTo(10 / 44.5 / 0.3048, 12);
	});

	it('rejects a scale whose numbers disagree, as a result', () => {
		const result = parseCourseGeometry(withScale({ rC1Px: 44.5, metresPerPx: 0.5, feetPerPx: 0.737267 }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: 'structure.invalid', path: 'scale' });
	});
});
