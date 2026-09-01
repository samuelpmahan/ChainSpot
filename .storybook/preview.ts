import type { Preview } from '@storybook/sveltekit';
import { badgeSpecimenLibrary } from 'virtual:e-badge-specimens';

const specimenItems = badgeSpecimenLibrary.specimens.map((specimen) => ({
	value: specimen.id,
	title: specimen.title
}));

const preview: Preview = {
	globalTypes: {
		specimen: {
			description: 'Materialized E badge specimen',
			toolbar: {
				icon: 'database',
				items: specimenItems,
				dynamicTitle: true
			}
		}
	},
	initialGlobals: {
		specimen: badgeSpecimenLibrary.specimens[0]?.id ?? 'unavailable'
	},
	parameters: {
		layout: 'fullscreen',
		controls: { expanded: true }
	}
};

export default preview;
