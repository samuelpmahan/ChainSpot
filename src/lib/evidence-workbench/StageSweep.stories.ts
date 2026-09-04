import type { Meta, StoryObj } from '@storybook/sveltekit';
import StageSweepStory from './StageSweepStory.svelte';

type StageStoryArgs = {
	stage: string;
	runName: string;
	showReceipt: boolean;
};

const meta = {
	title: 'LAB/Stages',
	component: StageSweepStory,
	args: {
		stage: import.meta.env.VITE_CHAINSPOT_STORY_STAGE ?? 'S0',
		runName: import.meta.env.VITE_CHAINSPOT_STORY_RUN_NAME ?? 'NorthPark-full(1)',
		showReceipt: (import.meta.env.VITE_CHAINSPOT_STORY_SHOW_RECEIPT ?? 'true') === 'true'
	},
	argTypes: {
		stage: { control: false, description: 'Run binding: discovered Stage selected by LAB.' },
		runName: { control: false, description: 'Run binding: produced by the bound Stage Sweep.' },
		showReceipt: { control: 'boolean', description: 'View Arg: projection only.' }
	}
} satisfies Meta<StageStoryArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Stage: Story = {};
