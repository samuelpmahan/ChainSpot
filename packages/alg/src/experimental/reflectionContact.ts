/**
 * Source-contact reflection diagnostic.
 *
 * This is measurement-only: it never changes a path or invents a normal when
 * the raster has no measured boundary contact.
 */

export type ReflectionPoint = { readonly x: number; readonly y: number };
export type ReflectionVector = { readonly x: number; readonly y: number };

export type RgbaReflectionRaster = {
	readonly widthPx: number;
	readonly heightPx: number;
	readonly rgba: Uint8Array | Uint8ClampedArray;
};

export type SourceFrameRay = {
	readonly origin: ReflectionPoint;
	readonly direction: ReflectionVector;
	/** Distance available for the reflected diagnostic segment. */
	readonly lengthPx: number;
};

/** A boundary contact measured in the source image frame. */
export type MeasuredBoundaryContact = {
	readonly point: ReflectionPoint;
	/** Signed local gradient. Its sign is retained; its unit normal is derived. */
	readonly signedGradient: ReflectionVector;
	/** Measured local boundary width in source-image pixels. */
	readonly widthPx: number;
};

export type UnexplainedLengthClassification =
	| 'none'
	| 'grazing'
	| 'straight-parallel';

export type ReflectionRaySegment = {
	readonly start: ReflectionPoint;
	readonly end: ReflectionPoint;
	readonly direction: ReflectionVector;
	readonly lengthPx: number;
};

export type ReflectionContactInput = {
	readonly raster: RgbaReflectionRaster;
	readonly ray: SourceFrameRay;
	readonly contact?: MeasuredBoundaryContact;
	/** Angle from a tangent at which a contact is considered grazing. */
	readonly grazingToleranceRadians?: number;
};

export type ReflectionContactUnsupported = {
	readonly status: 'unsupported';
	readonly reason:
		| 'no-contact'
		| 'invalid-raster'
		| 'invalid-ray'
		| 'invalid-contact';
	readonly unexplainedLength: 0;
};

export type ReflectionContactSupported = {
	readonly status: 'supported';
	readonly measuredNormal: ReflectionVector;
	readonly incidenceRadians: number;
	readonly incidenceDegrees: number;
	readonly widthPx: number;
	readonly reflectedRay: ReflectionRaySegment;
	readonly unexplainedLength: UnexplainedLengthClassification;
};

export type ReflectionContactDiagnostic = ReflectionContactSupported | ReflectionContactUnsupported;

const DEFAULT_GRAZING_TOLERANCE_RADIANS = Math.PI / 180;
const DIRECTION_EPSILON = 1e-9;

function finite(value: number): boolean {
	return Number.isFinite(value);
}

function length(vector: ReflectionVector): number {
	return Math.hypot(vector.x, vector.y);
}

function unit(vector: ReflectionVector): ReflectionVector | null {
	const magnitude = length(vector);
	return magnitude > 0 && finite(magnitude)
		? { x: vector.x / magnitude, y: vector.y / magnitude }
		: null;
}

function validPoint(point: ReflectionPoint): boolean {
	return finite(point.x) && finite(point.y);
}

function validRaster(raster: RgbaReflectionRaster): boolean {
	return Number.isInteger(raster.widthPx) && raster.widthPx > 0
		&& Number.isInteger(raster.heightPx) && raster.heightPx > 0
		&& raster.rgba.length === raster.widthPx * raster.heightPx * 4;
}

function validRay(ray: SourceFrameRay): boolean {
	return validPoint(ray.origin) && finite(ray.lengthPx) && ray.lengthPx >= 0 && unit(ray.direction) !== null;
}

/**
 * Measure a reflected ray from an observed local boundary contact.
 *
 * v' = v - 2(v·n)n. The incidence angle is the acute angle to the measured
 * normal (the sign of the gradient still determines the reported normal).
 */
export function diagnoseReflectionContact(input: ReflectionContactInput): ReflectionContactDiagnostic {
	if (!validRaster(input.raster)) return { status: 'unsupported', reason: 'invalid-raster', unexplainedLength: 0 };
	if (!validRay(input.ray)) return { status: 'unsupported', reason: 'invalid-ray', unexplainedLength: 0 };
	if (!input.contact) return { status: 'unsupported', reason: 'no-contact', unexplainedLength: 0 };
	const { contact } = input;
	if (!validPoint(contact.point) || !finite(contact.widthPx) || contact.widthPx < 0) {
		return { status: 'unsupported', reason: 'invalid-contact', unexplainedLength: 0 };
	}
	const normal = unit(contact.signedGradient);
	if (!normal) return { status: 'unsupported', reason: 'invalid-contact', unexplainedLength: 0 };

	const direction = unit(input.ray.direction)!;
	const dot = direction.x * normal.x + direction.y * normal.y;
	const clampedDot = Math.max(-1, Math.min(1, dot));
	const incidenceRadians = Math.acos(Math.abs(clampedDot));
	const reflectedDirection = unit({
		x: direction.x - 2 * dot * normal.x,
		y: direction.y - 2 * dot * normal.y
	})!;
	const reflectedRay: ReflectionRaySegment = {
		start: { ...contact.point },
		end: {
			x: contact.point.x + reflectedDirection.x * input.ray.lengthPx,
			y: contact.point.y + reflectedDirection.y * input.ray.lengthPx
		},
		direction: reflectedDirection,
		lengthPx: input.ray.lengthPx
	};
	const tolerance = input.grazingToleranceRadians ?? DEFAULT_GRAZING_TOLERANCE_RADIANS;
	const grazing = finite(tolerance) && tolerance >= 0 && Math.abs(Math.PI / 2 - incidenceRadians) <= tolerance;
	const parallel = Math.hypot(reflectedDirection.x - direction.x, reflectedDirection.y - direction.y) <= DIRECTION_EPSILON;
	const unexplainedLength: UnexplainedLengthClassification = grazing ? 'grazing' : parallel ? 'straight-parallel' : 'none';

	return {
		status: 'supported',
		measuredNormal: normal,
		incidenceRadians,
		incidenceDegrees: incidenceRadians * 180 / Math.PI,
		widthPx: contact.widthPx,
		reflectedRay,
		unexplainedLength
	};
}
