import type { CalculationAddress } from './contract';

export type NeatLineage='clean'|'work'|`exp/${string}`;

export interface NeatCalculation<T=unknown> {
	readonly address:CalculationAddress;
	readonly lineage:NeatLineage;
	readonly calculate:T;
	/** Repo-relative source that owns this Calculation implementation. */
	readonly source:string;
}

/** neat is deliberately tiny: registered work, separated by lineage. */
export class NeatCatalog {
	readonly #work=new Map<string,NeatCalculation>();
	register<T>(work:NeatCalculation<T>):void{
		const key=`${work.lineage}:${work.address}`;
		if(!work.source||work.source.startsWith('/')||work.source.includes('..'))throw new Error(`neat: source must be repo-relative for ${key}`);
		if(this.#work.has(key))throw new Error(`neat: duplicate registration ${key}`);
		this.#work.set(key,work);
	}
	require(address:CalculationAddress,lineage:NeatLineage='clean'):NeatCalculation{
		const found=this.#work.get(`${lineage}:${address}`);
		if(!found)throw new Error(`neat: missing ${lineage} implementation for ${address}`);
		return found;
	}
	list():readonly NeatCalculation[]{return [...this.#work.values()];}
}
