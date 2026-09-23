import type { StageContract } from '../contract';
import { S4PxC } from './contract';

export const stageContractAssertions: Pick<StageContract,'produces'|'assertions'> = {
	produces:[S4PxC.badges.address,S4PxC.baskets.address,S4PxC.tees.address],
	assertions:[{
		id:'ObjectFamilyCardinality',
		description:'Every Badge-defined semantic hole has exactly one complete Basket and Tee.',
		evaluate(pxc){
			const badges=pxc.get<readonly unknown[]>(S4PxC.badges.address).length;
			const baskets=pxc.get<readonly unknown[]>(S4PxC.baskets.address).length;
			const tees=pxc.get<readonly unknown[]>(S4PxC.tees.address).length;
			return {
				pass:badges===baskets&&badges===tees,
				observed:`badges=${badges}, baskets=${baskets}, tees=${tees}`,
				expected:'badges == baskets == tees'
			};
		}
	}]
};
