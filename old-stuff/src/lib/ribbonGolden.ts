/**
 * Small, deliberately separate contract for hand-authored CV ground truth.
 *
 * This is NOT AnnotatedHole and it intentionally does not carry CV provenance,
 * confidence, or product state. It is a research/evaluation artifact whose job
 * is to preserve the two independently-drawn ribbon gutters so CV probes can
 * optimize against the geometry the user actually meant.
 */
export const RIBBON_GOLDEN_SCHEMA_VERSION = 1 as const;
export const GOLDEN_HOLE_NUMBERS = [1, 2, 3] as const;

export type GoldenHoleNumber = (typeof GOLDEN_HOLE_NUMBERS)[number];
export type RibbonSide = 'left' | 'right';

export interface RibbonPoint {
	readonly xPx: number;
	readonly yPx: number;
}

export interface GoldenRibbonHole {
	readonly number: GoldenHoleNumber;
	readonly leftEdge: readonly RibbonPoint[];
	readonly rightEdge: readonly RibbonPoint[];
}

export interface GoldenRibbonSource {
	readonly fileName: string;
	readonly widthPx: number;
	readonly heightPx: number;
}

export interface GoldenRibbonSet {
	readonly schemaVersion: typeof RIBBON_GOLDEN_SCHEMA_VERSION;
	readonly coordinateSpace: 'source-image-px';
	readonly source: GoldenRibbonSource;
	readonly holes: readonly GoldenRibbonHole[];
}

export function createEmptyGoldenRibbonHoles(): GoldenRibbonHole[] {
	return GOLDEN_HOLE_NUMBERS.map((number) => ({
		number,
		leftEdge: [],
		rightEdge: []
	}));
}

function clonePoint(point: RibbonPoint): RibbonPoint {
	return { xPx: point.xPx, yPx: point.yPx };
}

function updateHole(
	holes: readonly GoldenRibbonHole[],
	holeNumber: GoldenHoleNumber,
	update: (hole: GoldenRibbonHole) => GoldenRibbonHole
): GoldenRibbonHole[] {
	return holes.map((hole) => (hole.number === holeNumber ? update(hole) : hole));
}

function replaceSide(
	hole: GoldenRibbonHole,
	side: RibbonSide,
	points: readonly RibbonPoint[]
): GoldenRibbonHole {
	return side === 'left'
		? { ...hole, leftEdge: points }
		: { ...hole, rightEdge: points };
}

function pointsForSide(hole: GoldenRibbonHole, side: RibbonSide): readonly RibbonPoint[] {
	return side === 'left' ? hole.leftEdge : hole.rightEdge;
}

export function addRibbonPoint(
	holes: readonly GoldenRibbonHole[],
	holeNumber: GoldenHoleNumber,
	side: RibbonSide,
	point: RibbonPoint
): GoldenRibbonHole[] {
	return updateHole(holes, holeNumber, (hole) =>
		replaceSide(hole, side, [...pointsForSide(hole, side), clonePoint(point)])
	);
}

export function moveRibbonPoint(
	holes: readonly GoldenRibbonHole[],
	holeNumber: GoldenHoleNumber,
	side: RibbonSide,
	index: number,
	point: RibbonPoint
): GoldenRibbonHole[] {
	return updateHole(holes, holeNumber, (hole) => {
		const points = pointsForSide(hole, side);
		if (index < 0 || index >= points.length) return hole;
		const next = points.map((existing, pointIndex) =>
			pointIndex === index ? clonePoint(point) : existing
		);
		return replaceSide(hole, side, next);
	});
}

export function removeRibbonPoint(
	holes: readonly GoldenRibbonHole[],
	holeNumber: GoldenHoleNumber,
	side: RibbonSide,
	index: number
): GoldenRibbonHole[] {
	return updateHole(holes, holeNumber, (hole) => {
		const points = pointsForSide(hole, side);
		if (index < 0 || index >= points.length) return hole;
		return replaceSide(
			hole,
			side,
			points.filter((_, pointIndex) => pointIndex !== index)
		);
	});
}

export function removeLastRibbonPoint(
	holes: readonly GoldenRibbonHole[],
	holeNumber: GoldenHoleNumber,
	side: RibbonSide
): GoldenRibbonHole[] {
	return updateHole(holes, holeNumber, (hole) =>
		replaceSide(hole, side, pointsForSide(hole, side).slice(0, -1))
	);
}

export function clearRibbonSide(
	holes: readonly GoldenRibbonHole[],
	holeNumber: GoldenHoleNumber,
	side: RibbonSide
): GoldenRibbonHole[] {
	return updateHole(holes, holeNumber, (hole) => replaceSide(hole, side, []));
}

export function clearRibbonHole(
	holes: readonly GoldenRibbonHole[],
	holeNumber: GoldenHoleNumber
): GoldenRibbonHole[] {
	return updateHole(holes, holeNumber, (hole) => ({
		...hole,
		leftEdge: [],
		rightEdge: []
	}));
}

export function reverseRibbonSide(
	holes: readonly GoldenRibbonHole[],
	holeNumber: GoldenHoleNumber,
	side: RibbonSide
): GoldenRibbonHole[] {
	return updateHole(holes, holeNumber, (hole) =>
		replaceSide(hole, side, [...pointsForSide(hole, side)].reverse())
	);
}

/**
 * Closed-polygon vertex order for preview/mask construction:
 * tee->basket on the left gutter, then basket->tee on the right gutter.
 * The first point is not repeated.
 */
export function ribbonPolygon(hole: GoldenRibbonHole): RibbonPoint[] {
	return [
		...hole.leftEdge.map(clonePoint),
		...[...hole.rightEdge].reverse().map(clonePoint)
	];
}

export function isRibbonReady(hole: GoldenRibbonHole): boolean {
	return hole.leftEdge.length >= 2 && hole.rightEdge.length >= 2;
}

function assertSource(source: GoldenRibbonSource): void {
	if (!source.fileName) throw new Error('Ribbon golden source file name is required.');
	if (
		!Number.isFinite(source.widthPx) ||
		!Number.isFinite(source.heightPx) ||
		source.widthPx <= 0 ||
		source.heightPx <= 0
	) {
		throw new Error('Ribbon golden source dimensions must be positive finite numbers.');
	}
}

function assertPoint(point: RibbonPoint, source: GoldenRibbonSource, context: string): void {
	if (
		!Number.isFinite(point.xPx) ||
		!Number.isFinite(point.yPx) ||
		point.xPx < 0 ||
		point.yPx < 0 ||
		point.xPx >= source.widthPx ||
		point.yPx >= source.heightPx
	) {
		throw new Error(`${context} is outside the source image bounds.`);
	}
}

function normalizeHole(value: unknown, source: GoldenRibbonSource): GoldenRibbonHole {
	if (!value || typeof value !== 'object') throw new Error('Ribbon golden hole must be an object.');
	const record = value as Record<string, unknown>;
	const number = record.number;
	if (number !== 1 && number !== 2 && number !== 3) {
		throw new Error(`Ribbon golden hole number must be 1, 2, or 3; got ${String(number)}.`);
	}

	const normalizeEdge = (edgeValue: unknown, label: string): RibbonPoint[] => {
		if (!Array.isArray(edgeValue)) throw new Error(`Hole ${number} ${label} must be an array.`);
		return edgeValue.map((rawPoint, index) => {
			if (!rawPoint || typeof rawPoint !== 'object') {
				throw new Error(`Hole ${number} ${label}[${index}] must be a point.`);
			}
			const pointRecord = rawPoint as Record<string, unknown>;
			const point = {
				xPx: Number(pointRecord.xPx),
				yPx: Number(pointRecord.yPx)
			};
			assertPoint(point, source, `Hole ${number} ${label}[${index}]`);
			return point;
		});
	};

	return {
		number,
		leftEdge: normalizeEdge(record.leftEdge, 'leftEdge'),
		rightEdge: normalizeEdge(record.rightEdge, 'rightEdge')
	};
}

export function createGoldenRibbonSet(
	source: GoldenRibbonSource,
	holes: readonly GoldenRibbonHole[]
): GoldenRibbonSet {
	assertSource(source);
	const byNumber = new Map<GoldenHoleNumber, GoldenRibbonHole>();

	for (const hole of holes) {
		const normalized = normalizeHole(hole, source);
		if (byNumber.has(normalized.number)) {
			throw new Error(`Duplicate ribbon golden for hole ${normalized.number}.`);
		}
		byNumber.set(normalized.number, normalized);
	}

	const normalizedHoles = GOLDEN_HOLE_NUMBERS.map((number) => {
		const hole = byNumber.get(number);
		if (!hole) throw new Error(`Ribbon golden is missing hole ${number}.`);
		return hole;
	});

	return {
		schemaVersion: RIBBON_GOLDEN_SCHEMA_VERSION,
		coordinateSpace: 'source-image-px',
		source: { ...source },
		holes: normalizedHoles
	};
}

export function parseGoldenRibbonSet(value: unknown): GoldenRibbonSet {
	if (!value || typeof value !== 'object') throw new Error('Ribbon golden JSON must be an object.');
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== RIBBON_GOLDEN_SCHEMA_VERSION) {
		throw new Error(
			`Unsupported ribbon golden schema version ${String(record.schemaVersion)}; expected ${RIBBON_GOLDEN_SCHEMA_VERSION}.`
		);
	}
	if (record.coordinateSpace !== 'source-image-px') {
		throw new Error('Ribbon golden coordinateSpace must be "source-image-px".');
	}
	if (!record.source || typeof record.source !== 'object') {
		throw new Error('Ribbon golden source metadata is required.');
	}
	const sourceRecord = record.source as Record<string, unknown>;
	const source: GoldenRibbonSource = {
		fileName: String(sourceRecord.fileName ?? ''),
		widthPx: Number(sourceRecord.widthPx),
		heightPx: Number(sourceRecord.heightPx)
	};
	assertSource(source);

	if (!Array.isArray(record.holes)) throw new Error('Ribbon golden holes must be an array.');
	return createGoldenRibbonSet(source, record.holes as GoldenRibbonHole[]);
}
