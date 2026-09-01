import type { Meta, StoryObj } from '@storybook/sveltekit';
import { badgeSpecimenLibrary } from 'virtual:e-badge-specimens';
import M1EvidenceStoryHost from './M1EvidenceStoryHost.svelte';
import { M1_PROJECTIONS, type M1Projection } from './m1Projection';

type M1Args = { subjectId: string; projection: M1Projection; zoom: number; showReceipt: boolean };
const subjectIds = badgeSpecimenLibrary.m1
	? [
			...badgeSpecimenLibrary.m1.objects.map((object) => object.id),
			...badgeSpecimenLibrary.m1.components.map((component) => component.id)
		]
	: ['unavailable'];

const meta = {
	title: 'E/M1/B+W Composition',
	component: M1EvidenceStoryHost,
	args: { subjectId: 'badge-0', projection: 'components', zoom: 6, showReceipt: true },
	argTypes: {
		subjectId: { control: 'select', options: subjectIds },
		projection: { control: 'select', options: M1_PROJECTIONS },
		zoom: { control: { type: 'range', min: 1, max: 16, step: 1 } },
		showReceipt: { control: 'boolean' }
	}
} satisfies Meta<M1Args>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BadgeConstituents: Story = {
	args: { subjectId: 'badge-0', projection: 'components' }
};
export const BadgeAvailable: Story = { args: { subjectId: 'badge-0', projection: 'available' } };
export const BadgeExplained: Story = { args: { subjectId: 'badge-0', projection: 'explained' } };
export const BadgeUnexplained: Story = {
	args: { subjectId: 'badge-0', projection: 'unexplained' }
};
export const BasketRelationships: Story = {
	args: { subjectId: 'basket-0', projection: 'relationships' }
};
export const ComponentConsumers: Story = {
	args: { subjectId: 'component.bright.12', projection: 'consumers' }
};
