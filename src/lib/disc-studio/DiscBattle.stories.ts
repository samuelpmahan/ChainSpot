import type { ComponentProps } from 'svelte';
import type { Meta, StoryObj } from '@storybook/sveltekit';
import BattleView from './BattleView.svelte';
import { createSampleWorkspace } from './samples';
const meta = {
	title: 'Product/DiscBattle',
	component: BattleView,
	args: { workspace: createSampleWorkspace() },
	parameters: { layout: 'padded' }
} satisfies Meta<ComponentProps<typeof BattleView>>;
export default meta;
type Story = StoryObj<typeof meta>;
export const FourCards: Story = {};
const three = createSampleWorkspace();
three.battle.entries = three.battle.entries.slice(0, 3);
export const ThreeCards: Story = { args: { workspace: three } };
const compact = createSampleWorkspace();
compact.cardAppearance.layout = 'compact';
export const ScoreBug: Story = { args: { workspace: compact } };
const emphasis = createSampleWorkspace();
emphasis.battleVisual.emphasizedEntryIds = ['entry-2'];
export const ManualWinner: Story = { args: { workspace: emphasis } };
