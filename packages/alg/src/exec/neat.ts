import type { CalculationAddress } from './contract';

export type NeatLineage='clean'|`exp/${string}`;

export interface NeatCalculation<T=unknown> {
	readonly address:CalculationAddress;
	readonly lineage:NeatLineage;
	readonly calculate:T;
}

/** neat is deliberately tiny: registered work, separated by lineage. */
export class NeatCatalog {
	readonly #work=new Map<string,NeatCalculation>();
	register<T>(work:NeatCalculation<T>):void{
		const key=`${work.lineage}:${work.address}`;
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
