import type { Meta, StoryObj } from '@storybook/sveltekit';
import S0SourceIntakeStory from './S0SourceIntakeStory.svelte';

type S0StoryArgs = {
	maxSidePx: number;
	selectedTick: string;
	zoom: number;
	showReceipt: boolean;
};

const meta = {
	title: 'LAB/PCR/S0 Source Intake',
	component: S0SourceIntakeStory,
	args: {
		maxSidePx: 256,
		selectedTick: 'scout-thumbnails.produce',
		zoom: 2,
		showReceipt: true
	},
	argTypes: {
		maxSidePx: {
			control: 'select',
			options: [256, 512, 1024],
			description: 'Run Arg: crosses the production gateway.'
		},
		selectedTick: {
			control: 'select',
			options: ['capture-source-files.capture', 'scout-thumbnails.produce'],
			description: 'View Arg: selects existing testimony.'
		},
		zoom: {
			control: { type: 'range', min: 1, max: 8, step: 1 },
			description: 'View Arg: projection only.'
		},
		showReceipt: { control: 'boolean', description: 'View Arg: projection only.' }
	}
} satisfies Meta<S0StoryArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultPlan: Story = {};
export const ChallengeAt512: Story = { args: { maxSidePx: 512 } };
