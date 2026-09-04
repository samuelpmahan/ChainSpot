import type { Meta, StoryObj } from '@storybook/sveltekit';
import S0SourceIntakeStory from './S0SourceIntakeStory.svelte';

type S0StoryArgs = {
	showReceipt: boolean;
};

const meta = {
	title: 'LAB/PCR/S0 Full to Cropped',
	component: S0SourceIntakeStory,
	args: { showReceipt: true },
	argTypes: {
		showReceipt: { control: 'boolean', description: 'View Arg: projection only.' }
	}
} satisfies Meta<S0StoryArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
