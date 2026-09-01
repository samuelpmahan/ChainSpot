import type { Meta, StoryObj } from '@storybook/sveltekit';
import BadgeEvidenceStoryHost from './BadgeEvidenceStoryHost.svelte';
import { BADGE_STORY_PROJECTIONS, type BadgeProjection } from './badgeProjection';

type ProjectionArgs = {
	specimenId: string;
	projection: BadgeProjection;
	zoom: number;
	showGrid: boolean;
	showReceipt: boolean;
	layout: 'single' | 'stack';
};

const meta = {
	title: 'E/Badges/Projections',
	component: BadgeEvidenceStoryHost,
	args: {
		specimenId: 'badge-0',
		projection: 'raw',
		zoom: 8,
		showGrid: false,
		showReceipt: true,
		layout: 'single'
	},
	argTypes: {
		specimenId: { table: { disable: true } },
		layout: { table: { disable: true } },
		projection: {
			control: 'select',
			options: BADGE_STORY_PROJECTIONS
		},
		zoom: { control: { type: 'range', min: 1, max: 16, step: 1 } },
		showGrid: { control: 'boolean' },
		showReceipt: { control: 'boolean' }
	},
	render: (args, context) => ({
		Component: BadgeEvidenceStoryHost,
		props: { ...args, specimenId: String(context.globals.specimen ?? args.specimenId) }
	})
} satisfies Meta<ProjectionArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Raw: Story = { args: { projection: 'raw' } };
export const BrightAndDark: Story = { args: { projection: 'bw' } };
export const Ownership: Story = { args: { projection: 'ownership' } };
export const AaCandidates: Story = { args: { projection: 'aa' } };
export const ResidueBefore: Story = { args: { projection: 'residue-before' } };
export const ResidueAfter: Story = { args: { projection: 'residue-after' } };
export const ComposedLayers: Story = { args: { projection: 'composed' } };

export const PinnedBadgeReceipt: Story = {
	args: { projection: 'composed' },
	globals: { specimen: 'badge-0' }
};

export const RefinementStack: Story = {
	args: { projection: 'composed', zoom: 5, showReceipt: false, layout: 'stack' }
};
