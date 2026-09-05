import type { Meta, StoryObj } from '@storybook/sveltekit';
import StageSweepStory from './StageSweepStory.svelte';

type StageStoryArgs = {
	stage: string;
	runName: string;
	showReceipt: boolean;
};

async function waitForMaterialization(
	canvasElement: HTMLElement,
	expected: 'ready' | 'huh',
	timeoutMs = 10_000
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last = 'missing';
	while (Date.now() < deadline) {
		const main = canvasElement.querySelector('main[data-materialization-state]');
		last = main?.getAttribute('data-materialization-state') ?? 'missing';
		if (last === expected) return;
		if (expected === 'ready' && last === 'huh') {
			const huh = canvasElement.querySelector('[data-materialization-huh]')?.textContent?.trim();
			throw new Error(huh || 'Story materialization entered HUH state');
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Story materialization did not reach ${expected}; last state=${last}`);
}

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

export const Stage: Story = {
	play: async ({ canvasElement, args }) => {
		await waitForMaterialization(canvasElement, 'ready');
		if (args.stage === 'S3') {
			const receipt = canvasElement.querySelector('pre')?.textContent ?? '';
			if (!receipt.includes('Tee family: 16')) {
				throw new Error('S3 Story reached READY without the recognized clean baseline: Tee family: 16');
			}
		}
	}
};

export const MissingMaterializationControl: Story = {
	args: {
		runName: '__missing_materialization_control__',
		showReceipt: true
	},
	play: async ({ canvasElement }) => {
		await waitForMaterialization(canvasElement, 'huh');
	}
};
