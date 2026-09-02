import type { Meta, StoryObj } from '@storybook/sveltekit';
import { badgeSpecimenLibrary } from 'virtual:e-badge-specimens';
import PcrInspectionHost from './PcrInspectionHost.svelte';

type PcrArgs = {
	pcrId: string;
	tickId: string;
	specimenId: string;
	materializationView: string;
	zoom: number;
	showGrid: boolean;
	showReceipt: boolean;
};

const pcrIds = badgeSpecimenLibrary.pcrs.map((pcr) => pcr.id);
const tickIds = [...new Set(badgeSpecimenLibrary.pcrs.flatMap((pcr) => pcr.ticks.map((tick) => tick.operation.id)))];

const meta = {
	title: 'LAB/PCR/Tick Inspection',
	component: PcrInspectionHost,
	args: {
		pcrId: 'badge-pcr',
		tickId: 'badgeStage.masks',
		specimenId: 'badge-0',
		materializationView: 'composed',
		zoom: 6,
		showGrid: false,
		showReceipt: true
	},
	argTypes: {
		pcrId: { control: 'select', options: pcrIds },
		tickId: { control: 'select', options: tickIds },
		specimenId: { table: { disable: true } },
		materializationView: {
			control: 'select',
			options: ['raw', 'bw', 'ownership', 'residue-after', 'composed', 'components', 'available', 'explained', 'unexplained', 'relationships']
		},
		zoom: { control: { type: 'range', min: 1, max: 16, step: 1 } },
		showGrid: { control: 'boolean' },
		showReceipt: { control: 'boolean' }
	},
	render: (args, context) => ({
		Component: PcrInspectionHost,
		props: { ...args, specimenId: String(context.globals.specimen ?? args.specimenId) }
	})
} satisfies Meta<PcrArgs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CanonicalInput: Story = { args: { pcrId: 'intake-pcr', tickId: 'source.decodeCanonicalInput', materializationView: 'raw' } };
export const BadgeMasks: Story = { args: { pcrId: 'badge-pcr', tickId: 'badgeStage.masks', materializationView: 'bw' } };
export const BadgeComponents: Story = { args: { pcrId: 'badge-pcr', tickId: 'badgeStage.components', materializationView: 'ownership' } };
export const BadgeMaterialization: Story = { args: { pcrId: 'badge-pcr', tickId: 'badgeEvidence.materialize', materializationView: 'residue-after' } };
export const BasketDetection: Story = { args: { pcrId: 'basket-pcr', tickId: 'baskets', materializationView: 'components' } };
export const BasketResidue: Story = { args: { pcrId: 'basket-pcr', tickId: 'badgeEvidence.materialize', materializationView: 'unexplained' } };
