import type { PxC } from '../exec/board';
import type { StageAssertion, StageContract } from './contract';

export interface StageAssertionReceipt {
	readonly id:string;
	readonly description:string;
	readonly pass:boolean;
	readonly observed:string;
	readonly expected:string;
}

export interface StageContractReceipt {
	readonly stage:string;
	readonly produced:readonly {readonly address:string;readonly summary:string}[];
	readonly assertions:readonly StageAssertionReceipt[];
	readonly pass:boolean;
}

function summary(value:unknown):string {
	if(Array.isArray(value)) return `count=${value.length}`;
	if(value===null)return 'null';
	if(value===undefined)return 'undefined';
	if(typeof value==='object')return `object keys=${Object.keys(value as object).length}`;
	return String(value);
}

export function materializeContractReceipt(contract:StageContract,pxc:PxC):StageContractReceipt {
	const produced=(contract.produces??[]).map(address=>{
		if(!pxc.has(address)) throw new Error(`${contract.id} receipt incomplete: declared output '${address}' is missing`);
		return {address,summary:summary(pxc.get(address))};
	});
	const assertions=(contract.assertions??[]).map((assertion:StageAssertion)=>{
		const result=assertion.evaluate(pxc);
		return {id:assertion.id,description:assertion.description,...result};
	});
	const failed=assertions.filter(x=>!x.pass);
	if(failed.length) throw new Error(
		`${contract.id} assertion failure: ${failed.map(x=>`${x.id} observed ${x.observed}; expected ${x.expected}`).join('; ')}`
	);
	return {stage:contract.id,produced,assertions,pass:true};
}
