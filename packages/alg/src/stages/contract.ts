import type { InputAsset } from '../g0/inputAsset';
import type { PxC } from '../exec/board';

export interface StagePanel {
	readonly label: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly rgba: Uint8Array | Uint8ClampedArray;
	readonly boxes?: readonly {
		readonly bbox: readonly [number, number, number, number];
		readonly color: readonly [number, number, number, number];
	}[];
}

export interface StageContext {
	readonly source: string;
	readonly inputLabel: string;
	readonly decode: (source: string) => Promise<InputAsset>;
	readonly pxc?: PxC;
}

export interface StageOutput {
	readonly pxc: PxC;
	readonly receiptText: string;
	readonly panels: readonly StagePanel[];
}

/** The executable contract LAB discovers at stages/S<number>/contract.js. */
export interface StageContract {
	readonly id: `S${number}`;
	readonly execute: (context: StageContext) => Promise<StageOutput>;
}
