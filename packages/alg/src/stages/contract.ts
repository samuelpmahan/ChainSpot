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

export interface StageAssertion {
	readonly id: string;
	readonly description: string;
	readonly evaluate: (pxc: PxC) => {
		readonly pass: boolean;
		readonly observed: string;
		readonly expected: string;
	};
}

export interface StageOutput {
	readonly pxc: PxC;
	readonly receiptText: string;
	readonly panels: readonly StagePanel[];
}

/** The executable contract LAB discovers at stages/S<number>/contract.js. */
export interface StageContract {
	readonly id: `S${number}`;
	/** Semantic Parts this Stage promises to leave materialized. */
	readonly produces?: readonly string[];
	/** Named postconditions evaluated by the generic receipt runner. */
	readonly assertions?: readonly StageAssertion[];
	readonly execute: (context: StageContext) => Promise<StageOutput>;
}
