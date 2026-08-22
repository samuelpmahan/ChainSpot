// Geographic transforms: pixel space ↔ lat/lng via similarity transform (scale+rotation+translation).
// Fits a 2D similarity mapping from correspondence pairs and provides conversion functions.

export interface Point {
	readonly xPx: number;
	readonly yPx: number;
}

export interface LatLng {
	readonly lat: number;
	readonly lng: number;
}

export interface CorrespondencePair {
	readonly blankPx: Point;
	readonly latLng: LatLng;
}

export interface WorldTransform {
	readonly originLatLng: LatLng; // local-flat projection origin: mean lat/lng of the fitted pairs
	readonly scale: number; // meters per pixel
	readonly rotationRad: number; // rotates a px-space vector into the local east/south-meters plane
	readonly translateM: { readonly x: number; readonly y: number }; // meters, added after rotate+scale
}

const METERS_PER_DEG_LAT = 111_320;
const FT_PER_METER = 3.28084;

// Convert lat/lng to local flat meters relative to an origin, using the SOUTH axis (not north).
function toLocalMeters(ll: LatLng, origin: LatLng): { readonly x: number; readonly y: number } {
	const latRad = origin.lat * (Math.PI / 180);
	const cosLat = Math.cos(latRad);
	const eastM = (ll.lng - origin.lng) * METERS_PER_DEG_LAT * cosLat;
	const southM = -(ll.lat - origin.lat) * METERS_PER_DEG_LAT;
	return { x: eastM, y: southM };
}

// Convert local flat meters to lat/lng relative to an origin.
function fromLocalMeters(m: { readonly x: number; readonly y: number }, origin: LatLng): LatLng {
	const latRad = origin.lat * (Math.PI / 180);
	const cosLat = Math.cos(latRad);
	const lat = origin.lat - m.y / METERS_PER_DEG_LAT;
	const lng = origin.lng + m.x / (METERS_PER_DEG_LAT * cosLat);
	return { lat, lng };
}

// Complex number operations as {re, im} pairs.
interface Complex {
	readonly re: number;
	readonly im: number;
}

function complexMultiply(u: Complex, v: Complex): Complex {
	return {
		re: u.re * v.re - u.im * v.im,
		im: u.re * v.im + u.im * v.re,
	};
}

function complexConj(u: Complex): Complex {
	return { re: u.re, im: -u.im };
}

function complexScale(u: Complex, s: number): Complex {
	return { re: u.re * s, im: u.im * s };
}

function complexAdd(u: Complex, v: Complex): Complex {
	return { re: u.re + v.re, im: u.im + v.im };
}

function complexSubtract(u: Complex, v: Complex): Complex {
	return { re: u.re - v.re, im: u.im - v.im };
}

export function fitTransform(pairs: readonly CorrespondencePair[]): WorldTransform | null {
	if (pairs.length < 2) return null;

	// Compute origin as arithmetic mean of latLng.
	let sumLat = 0;
	let sumLng = 0;
	for (const pair of pairs) {
		sumLat += pair.latLng.lat;
		sumLng += pair.latLng.lng;
	}
	const originLatLng: LatLng = {
		lat: sumLat / pairs.length,
		lng: sumLng / pairs.length,
	};

	// Convert each pair to pixel and meters coordinates, centered at their respective centroids.
	const zp: Complex[] = [];
	const zm: Complex[] = [];

	for (const pair of pairs) {
		zp.push({ re: pair.blankPx.xPx, im: pair.blankPx.yPx });
		const m = toLocalMeters(pair.latLng, originLatLng);
		zm.push({ re: m.x, im: m.y });
	}

	// Compute centroids.
	let cpRe = 0, cpIm = 0, cmRe = 0, cmIm = 0;
	for (let i = 0; i < pairs.length; i++) {
		cpRe += zp[i].re;
		cpIm += zp[i].im;
		cmRe += zm[i].re;
		cmIm += zm[i].im;
	}
	cpRe /= pairs.length;
	cpIm /= pairs.length;
	cmRe /= pairs.length;
	cmIm /= pairs.length;

	const cp: Complex = { re: cpRe, im: cpIm };
	const cm: Complex = { re: cmRe, im: cmIm };

	// Center the points.
	const up: Complex[] = [];
	const um: Complex[] = [];
	for (let i = 0; i < pairs.length; i++) {
		up.push(complexSubtract(zp[i], cp));
		um.push(complexSubtract(zm[i], cm));
	}

	// Compute denom = Σ (up_i.re² + up_i.im²).
	let denom = 0;
	for (const u of up) {
		denom += u.re * u.re + u.im * u.im;
	}

	if (denom === 0) return null;

	// Compute numer = Σ conj(up_i) * um_i.
	let numerRe = 0, numerIm = 0;
	for (let i = 0; i < pairs.length; i++) {
		const conjUp = complexConj(up[i]);
		const prod = complexMultiply(conjUp, um[i]);
		numerRe += prod.re;
		numerIm += prod.im;
	}

	// a = numer / denom (scale * e^{i*rotationRad}).
	const a: Complex = { re: numerRe / denom, im: numerIm / denom };

	const scale = Math.hypot(a.re, a.im);
	const rotationRad = Math.atan2(a.im, a.re);

	// translateM = cm - (a * cp).
	const acp = complexMultiply(a, cp);
	const translateM = complexSubtract(cm, acp);

	return {
		originLatLng,
		scale,
		rotationRad,
		translateM: { x: translateM.re, y: translateM.im },
	};
}

export function toLatLng(t: WorldTransform, p: Point): LatLng {
	// Rotate and scale: a * {re: p.xPx, im: p.yPx}.
	const a: Complex = {
		re: t.scale * Math.cos(t.rotationRad),
		im: t.scale * Math.sin(t.rotationRad),
	};
	const pComplex: Complex = { re: p.xPx, im: p.yPx };
	const rotScaled = complexMultiply(a, pComplex);

	// Add translation (convert from {x, y} to {re, im}).
	const translateComplex: Complex = { re: t.translateM.x, im: t.translateM.y };
	const metersComplex = complexAdd(rotScaled, translateComplex);

	// Convert from meters to lat/lng.
	return fromLocalMeters(
		{ x: metersComplex.re, y: metersComplex.im },
		t.originLatLng
	);
}

export function distanceFt(t: WorldTransform, a: Point, b: Point): number {
	const dx = b.xPx - a.xPx;
	const dy = b.yPx - a.yPx;
	const distanceM = t.scale * Math.hypot(dx, dy);
	return distanceM * FT_PER_METER;
}
