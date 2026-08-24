import { resolveScopeView } from './viewOptions';
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

function expandedRect(rect: Rect, extraWidth: number, extraHeight: number, imageWidth: number, imageHeight: number): Rect {
	return clampRect({
		x: rect.x - extraWidth / 2,
		y: rect.y - extraHeight / 2,
		w: rect.w + extraWidth,
		h: rect.h + extraHeight
	}, imageWidth, imageHeight);
}

/** The evidence point being inspected at higher magnification. */
export function inspectionAnchor(request: ScopeResolvedRequest): PointTuple {
	if (request.points.length === 0) return [request.focus.x + request.focus.w / 2, request.focus.y + request.focus.h / 2];
	if (request.kind === 'path' || request.kind === 'dots' || request.kind === 'hole') {
		return request.points[Math.max(0, request.points.length - 2)];
	}
	return request.points[request.points.length - 1];
}

/** Scope's task-aware AutoCrop. This is presentation, AFTER Sweep canonicalization. */
export function autoCropScopePanels(
	imageWidth: number,
	imageHeight: number,
	request: ScopeResolvedRequest
): readonly ScopePanelMeta[] {
	const view = resolveScopeView(request.view);
	const cx = request.focus.x + request.focus.w / 2;
	const cy = request.focus.y + request.focus.h / 2;
	const local = expandedRect(request.focus, view.localExtraWidthPx, view.localExtraHeightPx, imageWidth, imageHeight);
	const contextSpan = Math.max(view.contextSpanPx, local.w, local.h);
	const context = centeredRect(cx, cy, contextSpan, contextSpan, imageWidth, imageHeight);
	const [fx, fy] = inspectionAnchor(request);
	return [
		{
			name: 'context', label: `CONTEXT ${Math.round(context.w)}x${Math.round(context.h)} GRID ${view.grid ? 'ON' : 'OFF'}`,
			source: context, outputPx: view.contextOutputPx, resampling: 'bilinear', nearestNeighbor: false, grid: view.grid
		},
		{
			name: 'local', label: `LOCAL +${view.localExtraWidthPx}W +${view.localExtraHeightPx}H`,
			source: local, outputPx: view.localOutputPx, resampling: 'bilinear', nearestNeighbor: false, grid: view.grid
		},
		{
			name: 'forensic-wide', label: `FORENSIC WIDE ${view.forensicWidePx}px`,
			source: centeredRect(fx, fy, view.forensicWidePx, view.forensicWidePx, imageWidth, imageHeight), outputPx: view.forensicOutputPx, resampling: 'nearest', nearestNeighbor: true, grid: false
		},
		{
			name: 'forensic-mid', label: `FORENSIC MID ${view.forensicMidPx}px`,
			source: centeredRect(fx, fy, view.forensicMidPx, view.forensicMidPx, imageWidth, imageHeight), outputPx: view.forensicOutputPx, resampling: 'nearest', nearestNeighbor: true, grid: false
		},
		{
			name: 'forensic-tight', label: `FORENSIC TIGHT ${view.forensicTightPx}px`,
			source: centeredRect(fx, fy, view.forensicTightPx, view.forensicTightPx, imageWidth, imageHeight), outputPx: view.forensicOutputPx, resampling: 'nearest', nearestNeighbor: true, grid: false
		}
	];
}

export const defaultScopeTemplate: ScopeTemplate = {
	id: 'default',
	description: 'Scope AutoCrop: 800px regional Context, request+100px Local, then three tunable forensic zooms.',
	panels({ imageWidth, imageHeight, request }) {
		return autoCropScopePanels(imageWidth, imageHeight, request);
	}
};

// Extensibility is intentionally this boring: add a ScopeTemplate and register it here.
export const SCOPE_TEMPLATES: Readonly<Record<string, ScopeTemplate>> = {
	[defaultScopeTemplate.id]: defaultScopeTemplate
};

export function getScopeTemplate(id: string): ScopeTemplate {
	const template = SCOPE_TEMPLATES[id];
	if (!template) throw new Error(`lab scope: unknown template '${id}'. Try: lab scope templates`);
	return template;
}
