import type { PointTuple, Rect, ScopePanelMeta, ScopeResolvedRequest } from './types';

export interface ScopeTemplateContext {
	readonly imageWidth: number;
	readonly imageHeight: number;
	readonly request: ScopeResolvedRequest;
}

export interface ScopeTemplate {
	readonly id: string;
	readonly description: string;
	panels(ctx: ScopeTemplateContext): readonly ScopePanelMeta[];
}

function clampRect(rect: Rect, width: number, height: number): Rect {
	const w = Math.max(1, Math.min(width, Math.round(rect.w)));
	const h = Math.max(1, Math.min(height, Math.round(rect.h)));
	const x = Math.max(0, Math.min(width - w, Math.round(rect.x)));
	const y = Math.max(0, Math.min(height - h, Math.round(rect.y)));
	return { x, y, w, h };
}

function centeredRect(cx: number, cy: number, w: number, h: number, imageWidth: number, imageHeight: number): Rect {
	return clampRect({ x: cx - w / 2, y: cy - h / 2, w, h }, imageWidth, imageHeight);
}

/** The point an agent is actively inspecting. Context/local may frame the whole
 * request, but forensic views and `pin here` follow this exact anchor. */
export function inspectionAnchor(request: ScopeResolvedRequest): PointTuple {
	if (request.points.length === 0) {
		return [request.focus.x + request.focus.w / 2, request.focus.y + request.focus.h / 2];
	}
	if (request.kind === 'path' || request.kind === 'dots' || request.kind === 'hole') {
		return request.points[Math.max(0, request.points.length - 2)];
	}
	return request.points[request.points.length - 1];
}

export const defaultScopeTemplate: ScopeTemplate = {
	id: 'default',
	description: '1→1→3 crosscheck: one context, one local, then three forensic zooms locked to the previous point.',
	panels({ imageWidth, imageHeight, request }) {
		const cx = request.focus.x + request.focus.w / 2;
		const cy = request.focus.y + request.focus.h / 2;
		const span = Math.max(request.focus.w, request.focus.h, 1);
		const contextSpan = Math.max(256, span * 6);
		const localSpan = Math.max(64, span * 2.5);
		const [fx, fy] = inspectionAnchor(request);
		return [
			{ name: 'context', source: centeredRect(cx, cy, contextSpan, contextSpan, imageWidth, imageHeight), outputPx: 320, nearestNeighbor: true },
			{ name: 'local', source: centeredRect(cx, cy, localSpan, localSpan, imageWidth, imageHeight), outputPx: 320, nearestNeighbor: true },
			{ name: 'forensic-wide', source: centeredRect(fx, fy, 96, 96, imageWidth, imageHeight), outputPx: 160, nearestNeighbor: true },
			{ name: 'forensic-mid', source: centeredRect(fx, fy, 48, 48, imageWidth, imageHeight), outputPx: 160, nearestNeighbor: true },
			{ name: 'forensic-tight', source: centeredRect(fx, fy, 24, 24, imageWidth, imageHeight), outputPx: 160, nearestNeighbor: true }
		];
	}
};

// Extensibility is intentionally this boring: add a ScopeTemplate and register it here.
// Do not build a plugin/config framework until a real second presentation needs one.
export const SCOPE_TEMPLATES: Readonly<Record<string, ScopeTemplate>> = {
	[defaultScopeTemplate.id]: defaultScopeTemplate
};

export function getScopeTemplate(id: string): ScopeTemplate {
	const template = SCOPE_TEMPLATES[id];
	if (!template) throw new Error(`lab scope: unknown template '${id}'. Try: lab scope templates`);
	return template;
}
