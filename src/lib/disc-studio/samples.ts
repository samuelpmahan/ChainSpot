import { defaultAppearance, type Disc, type Workspace } from './model';
// Manufacturer flight ratings; specimen descriptions are fictional examples.
// No sample is represented as somebody's real disc. See experiments/disc-studio/SOURCES.md for factual sources.
export const sampleDiscs: Disc[] = [
	{
		id: 'sample-buzzz-mint',
		manufacturer: 'Discraft',
		mold: 'Buzzz',
		variant: 'Mint · sample specimen',
		flight: { speed: 5, glide: 4, turn: -1, fade: 1 },
		image: null
	},
	{
		id: 'sample-zone-coral',
		manufacturer: 'Discraft',
		mold: 'Zone',
		variant: 'Coral · sample specimen',
		flight: { speed: 4, glide: 3, turn: 0, fade: 3 },
		image: null
	},
	{
		id: 'sample-destroyer-lilac',
		manufacturer: 'Innova',
		mold: 'Destroyer',
		variant: 'Lilac · sample specimen',
		flight: { speed: 12, glide: 5, turn: -1, fade: 3 },
		image: null
	},
	{
		id: 'sample-leopard-sun',
		manufacturer: 'Innova',
		mold: 'Leopard3',
		variant: 'Sunrise · sample specimen',
		flight: { speed: 7, glide: 5, turn: -2, fade: 1 },
		image: null
	},
	{
		id: 'sample-mako-blue',
		manufacturer: 'Innova',
		mold: 'Mako3',
		variant: 'Blue · sample specimen',
		flight: { speed: 5, glide: 5, turn: 0, fade: 0 },
		image: null
	},
	{
		id: 'sample-teebird-sand',
		manufacturer: 'Innova',
		mold: 'TeeBird3',
		variant: 'Sand · sample specimen',
		flight: { speed: 8, glide: 4, turn: 0, fade: 2 },
		image: null
	},
	{
		id: 'sample-buzzz-rose',
		manufacturer: 'Discraft',
		mold: 'Buzzz',
		variant: 'Rose · second specimen',
		flight: { speed: 5, glide: 4, turn: -1, fade: 1 },
		image: null
	}
];
export function createSampleWorkspace(): Workspace {
	return {
		version: 1,
		discs: structuredClone(sampleDiscs),
		battle: {
			id: 'battle-local',
			title: 'The four-disc test',
			entries: sampleDiscs
				.slice(0, 4)
				.map((d, i) => ({ id: `entry-${i + 1}`, discId: d.id, score: [2, 1, 0, 3][i] }))
		},
		cardAppearance: { ...defaultAppearance },
		battleAppearance: { layout: 'row', showScores: true },
		battleVisual: { highlightedEntryId: 'entry-1', emphasizedEntryIds: [] }
	};
}
