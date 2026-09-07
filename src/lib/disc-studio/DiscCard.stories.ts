import type { ComponentProps } from 'svelte';
import type { Meta, StoryObj } from '@storybook/sveltekit';
import DiscCardSpecimen from './DiscCardSpecimen.svelte';
import { defaultAppearance } from './model';
import { sampleDiscs } from './samples';
const meta = {
	title: 'Product/DiscCard',
	component: DiscCardSpecimen,
	args: {
		width: 280,
		disc: sampleDiscs[0],
		appearance: { ...defaultAppearance },
		state: { highlighted: false, emphasis: 'none' as const }
	},
	parameters: { layout: 'centered' }
} satisfies Meta<ComponentProps<typeof DiscCardSpecimen>>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Idle: Story = {};
export const Highlighted: Story = { args: { state: { highlighted: true, emphasis: 'none' } } };
export const Winner: Story = { args: { state: { highlighted: false, emphasis: 'winner' } } };
export const Compact: Story = {
	args: { appearance: { ...defaultAppearance, layout: 'compact' }, score: 3 }
};
export const Paper: Story = { args: { appearance: { ...defaultAppearance, theme: 'paper' } } };
export const FlightFirst: Story = {
	args: { appearance: { ...defaultAppearance, hierarchy: 'flight' } }
};
export const UnknownNumbers: Story = {
	args: {
		disc: { ...sampleDiscs[0], flight: { speed: null, glide: null, turn: null, fade: null } }
	}
};
