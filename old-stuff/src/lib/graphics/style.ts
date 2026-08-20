/**
 * Hole graphic color themes.
 *
 * A `GraphicStyle` is a plain, JSON-safe color palette applied uniformly to
 * the connecting line, markers, UDisc's walking path (rendered by
 * `buildHoleGraphicMarkup` whenever a hole's plan carries one), and the
 * per-hole info card by `holeGraphics.ts`. Presets only, for now: a freeform
 * style editor is a later increment once the preset set proves the
 * parameterization is right.
 */

export interface GraphicStyle {
	readonly id: string;
	readonly name: string;
	readonly pathColor: string;
	readonly pathHaloColor: string;
	readonly teeColor: string;
	readonly basketColor: string;
	readonly shotColor: string;
	readonly shotStrokeColor: string;
	readonly markerHaloColor: string;
	readonly walkingPathColor: string;
	readonly cardBackground: string;
	readonly cardBorder: string;
	readonly cardText: string;
}

export const GRAPHIC_STYLE_PRESETS: readonly GraphicStyle[] = [
	{
		id: 'classic-blue',
		name: 'Classic Blue',
		pathColor: '#0ea5e9',
		pathHaloColor: 'rgba(255, 255, 255, 0.9)',
		teeColor: '#16a34a',
		basketColor: '#dc2626',
		shotColor: '#f8fafc',
		shotStrokeColor: '#0f172a',
		markerHaloColor: 'rgba(255, 255, 255, 0.9)',
		walkingPathColor: 'rgba(147, 51, 234, 0.6)',
		cardBackground: 'rgba(15, 23, 42, 0.85)',
		cardBorder: '#0ea5e9',
		cardText: '#f8fafc'
	},
	{
		id: 'sunset-orange',
		name: 'Sunset Orange',
		pathColor: '#f97316',
		pathHaloColor: 'rgba(255, 255, 255, 0.9)',
		teeColor: '#f97316',
		basketColor: '#f97316',
		shotColor: '#fff7ed',
		shotStrokeColor: '#7c2d12',
		markerHaloColor: 'rgba(255, 247, 237, 0.9)',
		walkingPathColor: 'rgba(249, 115, 22, 0.55)',
		cardBackground: 'rgba(124, 45, 18, 0.85)',
		cardBorder: '#f97316',
		cardText: '#fff7ed'
	},
	{
		id: 'forest-green',
		name: 'Forest Green',
		pathColor: '#ffffff',
		pathHaloColor: 'rgba(20, 83, 45, 0.7)',
		teeColor: '#4ade80',
		basketColor: '#166534',
		shotColor: '#f0fdf4',
		shotStrokeColor: '#14532d',
		markerHaloColor: 'rgba(240, 253, 244, 0.9)',
		walkingPathColor: 'rgba(74, 222, 128, 0.6)',
		cardBackground: 'rgba(20, 83, 45, 0.85)',
		cardBorder: '#4ade80',
		cardText: '#f0fdf4'
	},
	{
		id: 'midnight-purple',
		name: 'Midnight Purple',
		pathColor: '#c4b5fd',
		pathHaloColor: 'rgba(0, 0, 0, 0.6)',
		teeColor: '#a78bfa',
		basketColor: '#a78bfa',
		shotColor: '#f5f3ff',
		shotStrokeColor: '#312e81',
		markerHaloColor: 'rgba(245, 243, 255, 0.9)',
		walkingPathColor: 'rgba(196, 181, 253, 0.55)',
		cardBackground: 'rgba(49, 46, 129, 0.85)',
		cardBorder: '#a78bfa',
		cardText: '#f5f3ff'
	}
];

export const DEFAULT_GRAPHIC_STYLE: GraphicStyle = GRAPHIC_STYLE_PRESETS[0];

export function findGraphicStyle(id: string): GraphicStyle {
	return GRAPHIC_STYLE_PRESETS.find((style) => style.id === id) ?? DEFAULT_GRAPHIC_STYLE;
}
